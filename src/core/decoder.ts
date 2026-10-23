// 解码编排：输入"带尾部的图片" + 密码 → 提取描述/文件列表/原始压缩包
import { splitImage, parseHeader, splitPlaintext, parseDescription, type ImgPkgHeader } from './container';
import { algorithmNeedsPassword, ALG_AES_GCM_PBKDF2 } from './types';
import { decodeUtf8 } from './crypto';
import { unzipSync } from 'fflate';
import { workerDecrypt } from '../worker/workerClient';

export interface PreviewResult {
  title: string;
  description: string;
  originalName: string;
  fileList: string[];
  createdAt: string;
  mimeType: string;
  archiveBytes: number;
  singleFile: boolean;
}

export interface DecodeResult extends PreviewResult {
  archive: Uint8Array;      // 压缩包明文（供下载）
  cleanImage: Uint8Array;   // 剥离尾部后的干净图片
  header: ImgPkgHeader;
  encrypted: boolean;       // 该文件是否加密（纯隐藏模式为 false）
}

/** 第一步：只读头部（不涉及密码），判断文件是否含加密附件 */
export function inspectImage(bytes: Uint8Array): { header: ImgPkgHeader } | null {
  try {
    const { tail } = splitImage(bytes);
    const { header } = parseHeader(tail);
    return { header };
  } catch {
    return null;
  }
}

/** 第二步：提取附件。带密码模式必须传对密码；不设密码模式无需密码（软件内置密钥） */
export async function extractAttachment(bytes: Uint8Array, password: string, onProgress?: (r: number) => void): Promise<DecodeResult> {
  const { clean, tail } = splitImage(bytes);
  const { header, encrypted } = parseHeader(tail);

  const needsPassword = algorithmNeedsPassword(header.algorithm);
  const chunked = header.version >= 2;
  let plaintext: Uint8Array;
  if (header.algorithm === ALG_AES_GCM_PBKDF2) {
    plaintext = await workerDecrypt(password, header.kdfSalt, header.nonce, encrypted, onProgress, chunked);
  } else {
    // ALG_NONE：先用软件内置空密钥解密；失败则兼容旧版明文尾部
    try {
      plaintext = await workerDecrypt('', header.kdfSalt, header.nonce, encrypted, onProgress, chunked);
    } catch {
      plaintext = encrypted;
    }
  }

  const { description: descBytes, mimeType: mimeBytes, archive } = splitPlaintext(
    plaintext, header.descriptionLength, header.mimeTypeLength,
  );
  const descJson = decodeUtf8(descBytes);
  const desc = parseDescription(descJson);

  return {
    ...desc,
    singleFile: Boolean(desc.singleFile),
    mimeType: decodeUtf8(mimeBytes),
    archiveBytes: archive.length,
    archive,
    cleanImage: clean,
    header,
    encrypted: needsPassword,
  };
}

/**
 * 若为"单文件自动打包"（singleFile），把压缩包里唯一的那个文件解出返回；
 * 否则返回 null（保持压缩包原样）。
 */
export function unwrapSingle(r: DecodeResult): { name: string; data: Uint8Array } | null {
  if (!r.singleFile) return null;
  try {
    const files = unzipSync(r.archive);
    const names = Object.keys(files).filter((n) => n.length > 0);
    if (names.length !== 1) return null;
    return { name: names[0], data: new Uint8Array(files[names[0]]) };
  } catch {
    return null;
  }
}

export function downloadBlob(bytes: Uint8Array, filename: string, mime?: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function previewImageUrl(bytes: Uint8Array): string {
  const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
  return URL.createObjectURL(blob);
}