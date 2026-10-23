// ============================================================
// PBKDF2 密钥派生（Web Crypto）
// ============================================================

export const PBKDF2_ITERATIONS = 600_000;
export const KEY_BYTES = 32; // AES-256
export const GCM_IV_LEN = 12;

const appSalt = new TextEncoder().encode('imgpkg-app-v1');
const FIXED_EMPTY_PASSWORD = new TextEncoder().encode('imgpkg-empty-password-v1');

/** 附件文件密钥（加密/解密尾部用）：直接得到 AES-256-GCM CryptoKey */
export async function deriveFileKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = password.length ? new TextEncoder().encode(password) : FIXED_EMPTY_PASSWORD;
  return deriveAesKey(base, salt);
}

/** 空密码固定派生密钥（不安全，UI 需提醒） */
export async function deriveEmptyPasswordKey(salt: Uint8Array): Promise<CryptoKey> {
  return deriveAesKey(FIXED_EMPTY_PASSWORD, salt);
}

async function deriveAesKey(baseKey: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const imported = await crypto.subtle.importKey('raw', baseKey, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    imported,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 账户 Master Key：PBKDF2(登录密码, 用户KDF Salt, 600000) -> 32 字节原始密钥。
 * 以 raw bytes 保存，因为后续既要用它派生 Auth Hash，也要作为 AES 密钥加密密码密文。
 */
export async function deriveMasterKey(loginPassword: string, kdfSalt: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', new TextEncoder().encode(loginPassword), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: kdfSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    imported,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** 认证哈希：PBKDF2(MasterKey原始字节, 固定应用盐, 600000) */
export async function deriveAuthHash(masterKeyBytes: Uint8Array, fixedSalt = appSalt): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', masterKeyBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fixedSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    imported,
    KEY_BYTES * 8,
  );
  return toHex(new Uint8Array(bits));
}

/** 将 Master Key 原始字节导入为 AES-256-GCM 密钥（仅内存，可提取以便跨设备重派生） */
export async function importMasterKeyAsAes(masterKeyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', masterKeyBytes.slice(), { name: 'AES-GCM', length: 256 },
    true, ['encrypt', 'decrypt'],
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('非法 hex 串');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}