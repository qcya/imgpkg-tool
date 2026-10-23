// ============================================================
// 二进制尾部格式类型定义
// 布局（小端序，位于图片 IEND/EOI 之后）：
//   0     8B  魔数 "IMGPKG01"
//   8     1B  版本号 (0x01)
//   9     1B  加密算法标识 (0x01 = AES-256-GCM + PBKDF2)
//   10    16B PBKDF2 盐值
//   26    12B AES-GCM Nonce
//   38    4B  密文总长度 (uint32)
//   42    4B  原始压缩包大小 (uint32, 明文长度)
//   46    4B  描述 JSON 密文长度 (uint32)
//   50    4B  MIME 类型密文长度 (uint32)
//   54    N   描述 JSON 密文
//   54+N  M   压缩包 MIME 类型密文
//   ...   K   压缩包密文
//   末尾  8B  尾部读出魔数 "PKGEND01"
// ============================================================

export const IMGPKG_MAGIC = 'IMGPKG01';
export const IMGPKG_END_MAGIC = 'PKGEND01';
export const FORMAT_VERSION = 0x02;    // 当前格式：大文件分块 AES-GCM（加密可回报进度）
export const FORMAT_VERSION_LEGACY = 0x01; // 旧格式：单次 AES-GCM
export const ALG_AES_GCM_PBKDF2 = 0x01; // 用户密码加密（PBDKF2 派生密钥）
export const ALG_NONE = 0x00;           // 不设密码：软件内置密钥加密，提取免密码

/** 布局用途：该模式是否真正加密（决定提取时是否需要派生/解密） */
export function algorithmIsEncrypted(algo: number): boolean {
  return algo === ALG_AES_GCM_PBKDF2 || algo === ALG_NONE;
}

/** 提取时是否需要用户输入密码（ALG_NONE 是软件内置密钥，无需密码） */
export function algorithmNeedsPassword(algo: number): boolean {
  return algo === ALG_AES_GCM_PBKDF2;
}

export const HEADER_SIZE = 54;
export const KDF_SALT_LEN = 16;
export const GCM_NONCE_LEN = 12;
export const GCM_TAG_LEN = 16;

// MIME 密文 + 描述密文 + 压缩包密文拼接布局里各分段长度
//   seg0: 描述 JSON 密文字节
//   seg1: MIME 类型密文字节
//   seg2: 压缩包密文字节 (含 GCM tag)
export type PayloadSegment = 'description' | 'mimeType' | 'archive';

export interface ImgPkgHeader {
  magic: string;             // 'IMGPKG01'
  version: number;           // 0x01
  algorithm: number;         // 0x01
  kdfSalt: Uint8Array;       // 16B
  nonce: Uint8Array;         // 12B
  ciphertextLength: number;  // 总密文(三段拼接)长度
  originalSize: number;      // 压缩包明文长度
  descriptionLength: number; // 描述 JSON 密文长度
  mimeTypeLength: number;    // MIME 密文长度
}

export interface ImgPkgDescription {
  title: string;
  description: string;
  originalName: string;
  fileList: string[];
  createdAt: string;
  version: number;
  /** 单文件自动打包标记：用户放进来的是单个非压缩文件（如图片/视频），取出时应还原成该文件 */
  singleFile?: boolean;
}

/**
 * 描述 JSON + MIME 类型 + 压缩包原始字节「拼接后整体」做一次 AES-256-GCM。
 * descriptionLength / mimeTypeLength 记录的是各明文段长度，解密后用其把
 * 拼接明文拆回三段。模式：assert 单次加密始终满足。
 */
export interface ImgPkgPayload {
  description: string;                 // 描述 JSON 原文
  mimeType: string;                    // 压缩包 MIME 类型
  archiveBytes: Uint8Array;            // 压缩包明文
}

export interface BuildOptions {
  /** 三段拼接后的明文（desc || mime || archive），其各段长度另用字节存储 */
  plaintext: Uint8Array;
  descriptionJsonLen: number;
  mimeTypeLen: number;
  archiveLen: number;
  kdfSalt: Uint8Array;
  nonce: Uint8Array;
  encrypted: Uint8Array;               // 单次 AES-GCM 后的整体密文(含16B tag)
}

export interface BuildResult {
  /** 追加在原始图片字节之后的完整尾部字节 */
  tail: Uint8Array;
}

/** 简单 base64 助手（与 btoa 兼容，支持 Uint8Array） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}