// ============================================================
// AES-256-GCM 加解密封装与随机数
// ============================================================
import { GCM_IV_LEN } from './kdf';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/** 加密：返回 密文（含末尾16字节 GCM tag），与 Web Crypto 输出语义一致 */
export async function aesGcmEncrypt(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== GCM_IV_LEN) throw new Error(`GCM Nonce 必须为 ${GCM_IV_LEN} 字节`);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

/** 解密：认证失败会抛错 */
export async function aesGcmDecrypt(key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== GCM_IV_LEN) throw new Error(`GCM Nonce 必须为 ${GCM_IV_LEN} 字节`);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
  return new Uint8Array(pt);
}

export function encodeUtf8(s: string): Uint8Array { return encoder.encode(s); }
export function decodeUtf8(b: Uint8Array): string { return decoder.decode(b); }

/** 拼接多个字节段 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}