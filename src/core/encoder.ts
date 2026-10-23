// ============================================================
// 编码编排：输入图片+压缩包+描述 → 输出"带尾部的图片"
// ============================================================
import { buildTail, assembleEncodedImage, type ImgPkgDescription } from './container';
import { ALG_NONE, ALG_AES_GCM_PBKDF2, KDF_SALT_LEN } from './types';
import { randomBytes, concatBytes } from './crypto';
import { GCM_IV_LEN } from './kdf';
import { workerEncrypt, type ProgressFn } from '../worker/workerClient';

export interface EncodeInput {
  imageBytes: Uint8Array;          // 载体（图片或视频）原始字节
  archiveBytes: Uint8Array;        // 压缩包原始字节
  archiveName: string;
  mimeType: string;
  title: string;
  description: string;
  fileList: string[];
  password: string;                // 用户密码（不设密码时为空字符串，走软件内置密钥）
  singleFile?: boolean;            // 单个非压缩文件被自动打包：取出时还原成该文件
}

export interface EncodeResult {
  outputBytes: Uint8Array;         // 图片 + 尾部
  payloadBytes: Uint8Array;        // 尾部
  meta: {
    title: string;
    originalName: string;
    fileCount: number;
    archiveBytes: number;
    encrypted: boolean;
  };
}

const encoder = new TextEncoder();
function utf8(s: string): Uint8Array { return encoder.encode(s); }

function buildDescriptionJson(input: EncodeInput): string {
  const desc: ImgPkgDescription = {
    title: input.title,
    description: input.description,
    originalName: input.archiveName,
    fileList: input.fileList,
    createdAt: new Date().toISOString(),
    version: 1,
    singleFile: Boolean(input.singleFile),
  };
  return JSON.stringify(desc);
}

/** 三段明文拼接（desc || mime || archive），长度在头部记录供拆分 */
function joinPayload(descBytes: Uint8Array, mimeBytes: Uint8Array, archive: Uint8Array): Uint8Array {
  return concatBytes([descBytes, mimeBytes, archive]);
}

function buildEncoded(input: EncodeInput, onProgress?: ProgressFn): Promise<Uint8Array> {
  const descBytes = utf8(buildDescriptionJson(input));
  const mimeBytes = utf8(input.mimeType);
  const plaintext = joinPayload(descBytes, mimeBytes, input.archiveBytes);
  const salt = randomBytes(KDF_SALT_LEN);
  const nonce = randomBytes(GCM_IV_LEN);

  // 有密码 → ALG_AES_GCM_PBKDF2：提取需输入密码
  // 无密码 → ALG_NONE：软件内置密钥加密，提取免密码，且改后缀解不出压缩包
  const password = input.password || '';
  return workerEncrypt(password, salt, nonce, plaintext, onProgress).then((ct) => buildTail({
    algorithm: input.password ? ALG_AES_GCM_PBKDF2 : ALG_NONE,
    kdfSalt: salt,
    nonce,
    encrypted: ct,
    descriptionJsonLen: descBytes.length,
    mimeTypeLen: mimeBytes.length,
    archiveLen: input.archiveBytes.length,
  }));
}

/** 不设密码：软件内置密钥加密（提取免密码、改后缀无效） */
export async function encodeAttachmentPlain(input: EncodeInput, onProgress?: ProgressFn): Promise<EncodeResult> {
  const tail = await buildEncoded(input, onProgress);
  return finish(input, tail, false);
}

/** 指定密码加密；或供随机密码用 */
export async function encodeAttachment(input: EncodeInput, onProgress?: ProgressFn): Promise<EncodeResult> {
  const tail = await buildEncoded(input, onProgress);
  return finish(input, tail, true);
}

async function finish(input: EncodeInput, tail: Uint8Array, encrypted: boolean): Promise<EncodeResult> {
  const outputBytes = assembleEncodedImage(input.imageBytes, tail);
  return {
    outputBytes,
    payloadBytes: tail,
    meta: {
      title: input.title,
      originalName: input.archiveName,
      fileCount: input.fileList.length,
      archiveBytes: input.archiveBytes.length,
      encrypted,
    },
  };
}

const PWD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** 生成高强度随机密码（用完即忘，需上云保存以便跨设备恢复） */
export function generateRandomPassword(len = 26): string {
  const out: string[] = [];
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out.push(PWD_ALPHABET[arr[i] % PWD_ALPHABET.length]);
  return out.join('');
}