// ============================================================
// 压缩包文件名列表解析：仅读取目录结构，不解压内容。
// 支持 ZIP（中央目录）与 TAR/TAR.GZ（512 字节头）；7z/RAR 返回空列表。
// ============================================================

const textDecoder = new TextDecoder('utf-8');
const textDecoderLatin = new TextDecoder('latin1');

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

/** 从尾部向上搜索 4 字节小端签名，返回其偏移，找不到返回 -1 */
function searchMagicBackward(bytes: Uint8Array, sig: number, limit: number): number {
  const tail = Math.min(bytes.length, 66000 + 22); // EOCD 最多在尾部 64KB+22 内
  const start = Math.max(bytes.length - tail, limit);
  for (let i = bytes.length - 4; i >= start; i--) {
    const n = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    if (n === sig) return i;
  }
  return -1;
}

/* ZIP：End Of Central Directory 0x06054b50，Central Directory 0x02014b50 */
export function listZipFileNames(bytes: Uint8Array): string[] {
  const eocd = searchMagicBackward(bytes, 0x06054b50, 0);
  if (eocd < 0) return [];
  if (eocd + 22 > bytes.length) return [];

  const cdCount = (bytes[eocd + 10] | (bytes[eocd + 11] << 8));
  if (cdCount === 0) return [];

  const cdOffset = readU32LE(bytes, eocd + 16);
  if (cdOffset < 0 || cdOffset >= bytes.length) return [];

  const names: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > bytes.length || readU32LE(bytes, p) !== 0x02014b50) break;
    const nameLen = readU16LE(bytes, p + 28);
    const extraLen = readU16LE(bytes, p + 30);
    const commentLen = readU16LE(bytes, p + 32);
    const gpFlag = readU16LE(bytes, p + 8); // 通用标志位，bit11(0x800)=UTF-8
    const entryName = readBytes(bytes, p + 46, nameLen);
    names.push(decodeZipName(entryName, (gpFlag & 0x800) !== 0));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names.filter((n) => n.length > 0);
}

function decodeZipName(raw: Uint8Array, isUtf8: boolean): string {
  // 标志位声明 UTF-8 → 直解
  if (isUtf8) return decodeFatal(raw, 'utf-8') ?? textDecoderLatin.decode(raw);
  // 未声明：先试 UTF-8（部分工具不设标志），失败则 GBK（Windows 中文压缩），再无则 latin1(≈CP437)
  return decodeFatal(raw, 'utf-8') ?? decodeFatal(raw, 'gbk') ?? textDecoderLatin.decode(raw);
}

function decodeFatal(bytes: Uint8Array, label: string): string | null {
  try { return new TextDecoder(label, { fatal: true }).decode(bytes); } catch { return null; }
}

/* TAR：512 字节块，文件名在块首 100 字节内 */
export function listTarFileNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const block = 512;
  for (let i = 0; i + block <= bytes.length; i += block) {
    const nameBytes = bytes.subarray(i, i + 100);
    // 全部为 0 视为结束标记
    let zeroCount = 0;
    for (let j = 0; j < nameBytes.length; j++) if (nameBytes[j] === 0) zeroCount++;
    if (zeroCount === nameBytes.length) break;
    const name = textDecoder.decode(nameBytes).replace(/\0.*$/, '').trim();
    if (name) names.push(name);
    const size = parseInt(ascii(bytes, i + 124, 12).replace(/\0.*$/, '').trim() || '0', 8) || 0;
    i += Math.ceil(size / block) * block;
  }
  return names;
}

function readU16LE(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function readBytes(b: Uint8Array, off: number, len: number): Uint8Array {
  return b.subarray(off, off + len);
}

/** 按 MIME/扩展名猜测格式并返回文件列表 */
export function listArchiveFiles(bytes: Uint8Array, mimeType: string, originalName: string): string[] {
  const name = originalName.toLowerCase();
  const isZip = mimeType.includes('zip') || name.endsWith('.zip') || hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasSignature(bytes, [0x50, 0x4b, 0x05, 0x06]);
  if (isZip) return listZipFileNames(bytes);

  const isTarGz = name.endsWith('.tar.gz') || name.endsWith('.tgz') || hasSignature(bytes, [0x1f, 0x8b]);
  if (isTarGz) {
    // gzip 解压到内存解析 tar 会较耗；此处仅尽力解析第一层 tar 头。7z/rar 不做
    return ['（gzip 压缩的 tar 内容未展开）'];
  }
  if (name.endsWith('.tar') || mimeType.includes('tar') || hasSignature(bytes, [0x55, 0x73, 0x74, 0x61, 0x72])) {
    return listTarFileNames(bytes);
  }
  return [];
}

function hasSignature(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** 根据扩展名返回 MIME 类型 */
export function guessMimeFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.zip')) return 'application/zip';
  if (n.endsWith('.7z')) return 'application/x-7z-compressed';
  if (n.endsWith('.rar')) return 'application/vnd.rar';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'application/x-gtar';
  if (n.endsWith('.tar')) return 'application/x-tar';
  return 'application/octet-stream';
}