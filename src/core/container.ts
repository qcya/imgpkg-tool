// ============================================================
// 图片尾部容器读写：在 PNG 的 IEND 之后 / JPG 的 EOI(FFD9) 之后
// 追加自定义尾部，解码器会忽略这些多余字节。
// ============================================================
import {
  HEADER_SIZE, IMGPKG_MAGIC, IMGPKG_END_MAGIC,
  FORMAT_VERSION, FORMAT_VERSION_LEGACY, ALG_AES_GCM_PBKDF2, ALG_NONE,
  KDF_SALT_LEN, GCM_NONCE_LEN,
  type ImgPkgHeader, type ImgPkgDescription,
} from './types';

export type { ImgPkgHeader, ImgPkgDescription } from './types';

/** 拼接多段 Uint8Array */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer:
  for (let i = haystack.length - needle.length; i >= from; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}
function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * 构建尾部字节（不含图片原始字节）。
 * 描述/MIME/压缩包三段明文先拼接为整体，再按加密算法处理：
 *   ALG_AES_GCM_PBKDF2 —— 单次 AES-GCM 加密；
 *   ALG_NONE           —— 明文直接存入（纯隐藏，不加密）。
 * 每次加密生成携带全新的随机 盐值 + Nonce。
 */
export function buildTail(opts: {
  algorithm?: number;
  kdfSalt: Uint8Array;
  nonce: Uint8Array;
  encrypted: Uint8Array;          // 加密后密文，或纯隐藏时为拼接明文
  descriptionJsonLen: number;     // 明文段长度
  mimeTypeLen: number;            // 明文段长度
  archiveLen: number;             // 明文段长度
}): Uint8Array {
  const algorithm = opts.algorithm ?? ALG_AES_GCM_PBKDF2;
  const { kdfSalt, nonce, encrypted, descriptionJsonLen, mimeTypeLen, archiveLen } = opts;
  if (kdfSalt.length !== KDF_SALT_LEN) throw new Error(`KDF 盐值必须为 ${KDF_SALT_LEN} 字节`);
  if (nonce.length !== GCM_NONCE_LEN) throw new Error(`GCM Nonce 必须为 ${GCM_NONCE_LEN} 字节`);

  const ciphertextLength = encrypted.length;
  const tailLen = HEADER_SIZE + ciphertextLength + IMGPKG_END_MAGIC.length;
  const tail = new Uint8Array(tailLen);
  const view = new DataView(tail.buffer);

  // 头部
  for (let i = 0; i < IMGPKG_MAGIC.length; i++) tail[i] = IMGPKG_MAGIC.charCodeAt(i);
  tail[8] = FORMAT_VERSION;
  tail[9] = algorithm;
  tail.set(kdfSalt, 10);
  tail.set(nonce, 26);
  writeU32(view, 38, ciphertextLength);
  writeU32(view, 42, archiveLen);           // originalSize = 压缩包明文长度
  writeU32(view, 46, descriptionJsonLen);   // 描述 JSON 明文长度
  writeU32(view, 50, mimeTypeLen);          // MIME 明文长度

  tail.set(encrypted, HEADER_SIZE);

  // 末尾魔数
  const off = HEADER_SIZE + ciphertextLength;
  for (let i = 0; i < IMGPKG_END_MAGIC.length; i++) tail[off + i] = IMGPKG_END_MAGIC.charCodeAt(i);

  return tail;
}

/** 将尾部追加到图片原始字节之后 */
export function assembleEncodedImage(originalImage: Uint8Array, tail: Uint8Array): Uint8Array {
  return concat([originalImage, tail]);
}

/**
 * 从一张可能含尾部的图片中扫描出尾部。
 * 先找末尾 "PKGEND01"，再向前定位 "IMGPKG01"。若扫描到头部，则返回 [cleanImage, tail]。
 */
export function locateTail(bytes: Uint8Array): { tail: Uint8Array } | null {
  const endMagic = new Uint8Array(IMGPKG_END_MAGIC.length);
  for (let i = 0; i < IMGPKG_END_MAGIC.length; i++) endMagic[i] = IMGPKG_END_MAGIC.charCodeAt(i);

  const endIdx = findSequence(bytes, endMagic);
  if (endIdx < 0) return null;
  const tailStart = findSequence(bytes, new Uint8Array(IMGPKG_MAGIC.length).map((_, i) => IMGPKG_MAGIC.charCodeAt(i)));
  if (tailStart < 0) return null;

  // 确保尾部结构自洽
  const tail = bytes.subarray(tailStart, endIdx + endMagic.length);
  if (tail.length < HEADER_SIZE + endMagic.length) return null;

  const parsed = parseHeader(tail);
  const expectedEnd = HEADER_SIZE + parsed.header.ciphertextLength + IMGPKG_END_MAGIC.length;
  if (expectedEnd !== tail.length) return null;

  return { tail };
}

/** 从图片中提取干净图片字节（剥离尾部）+ 尾部信息 */
export function splitImage(bytes: Uint8Array): { clean: Uint8Array; tail: Uint8Array } {
  const found = locateTail(bytes);
  if (!found) throw new Error('该文件中未包含加密附件，或文件已损坏');
  // 干净图片 = 到尾部开始前的全部字节
  const tailMagic = new Uint8Array(IMGPKG_MAGIC.length).map((_, i) => IMGPKG_MAGIC.charCodeAt(i));
  const tailStart = findSequence(bytes, tailMagic);
  return { clean: bytes.subarray(0, tailStart), tail: found.tail };
}

class TailCursor {
  private view: DataView;
  private off: number;
  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.off = 0;
  }
  readU8(): number { return this.bytes[this.off++]; }
  readAscii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.off + i]);
    this.off += n;
    return s;
  }
  readBytes(n: number): Uint8Array {
    const b = this.bytes.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

export function parseHeader(tail: Uint8Array): { header: ImgPkgHeader; encrypted: Uint8Array } {
  if (tail.length < HEADER_SIZE + IMGPKG_END_MAGIC.length) {
    throw new Error('尾部长度不足，文件可能已损坏');
  }
  const c = new TailCursor(tail);
  const magic = c.readAscii(8);
  if (magic !== IMGPKG_MAGIC) throw new Error('尾部魔数校验失败，文件可能已被篡改');
  const version = c.readU8();
  if (version !== FORMAT_VERSION && version !== FORMAT_VERSION_LEGACY) {
    throw new Error(`不支持的版本号 0x${version.toString(16)}`);
  }
  const algorithm = c.readU8();
  if (algorithm !== ALG_AES_GCM_PBKDF2 && algorithm !== ALG_NONE) {
    throw new Error(`不支持的加密算法标识 0x${algorithm.toString(16)}`);
  }

  const kdfSalt = c.readBytes(KDF_SALT_LEN);
  const nonce = c.readBytes(GCM_NONCE_LEN);

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let off = 38;
  const ciphertextLength = readU32(view, off); off += 4;
  const originalSize    = readU32(view, off); off += 4;
  const descriptionLength = readU32(view, off); off += 4;
  const mimeTypeLength  = readU32(view, off); off += 4;

  // 校验长度自洽
  if (HEADER_SIZE + ciphertextLength + IMGPKG_END_MAGIC.length > tail.length) {
    throw new Error('密文长度字段异常，文件可能已损坏');
  }
  const encrypted = tail.subarray(HEADER_SIZE, HEADER_SIZE + ciphertextLength);

  const header: ImgPkgHeader = {
    magic, version, algorithm, kdfSalt, nonce,
    ciphertextLength, originalSize, descriptionLength, mimeTypeLength,
  };
  return { header, encrypted };
}

/** 将解密后的整体明文按各段明文长度拆回三段 */
export function splitPlaintext(plain: Uint8Array, descriptionLen: number, mimeLen: number): {
  description: Uint8Array; mimeType: Uint8Array; archive: Uint8Array;
} {
  const minLen = descriptionLen + mimeLen;
  if (plain.length < minLen) throw new Error('解密结果长度异常');
  const description = plain.subarray(0, descriptionLen);
  const mimeType = plain.subarray(descriptionLen, descriptionLen + mimeLen);
  const archive = plain.subarray(descriptionLen + mimeLen);
  return { description, mimeType, archive };
}

/** 解析描述 JSON 密文解密后得到的明文 */
export function parseDescription(jsonText: string): ImgPkgDescription {
  try {
    const obj = JSON.parse(jsonText);
    if (typeof obj !== 'object' || obj === null) throw new Error('invalid');
    return {
      title: String(obj.title ?? ''),
      description: String(obj.description ?? ''),
      originalName: String(obj.originalName ?? ''),
      fileList: Array.isArray(obj.fileList) ? obj.fileList.map(String) : [],
      createdAt: String(obj.createdAt ?? ''),
      version: Number(obj.version ?? 1),
      singleFile: Boolean(obj.singleFile),
    };
  } catch {
    throw new Error('描述信息解析失败');
  }
}

// 供 locateTail 内部换算尾部总长
export function headerTotalLen(h: ImgPkgHeader): number {
  return HEADER_SIZE + h.ciphertextLength + IMGPKG_END_MAGIC.length;
}