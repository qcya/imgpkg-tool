// Web Worker：在独立线程中执行 PBKDF2 + AES-256-GCM，避免阻塞主线程。
// 大文件分块处理，逐块回报进度（progress 在 0~1）。
import { deriveFileKey } from '../core/kdf';
import { aesGcmEncrypt, aesGcmDecrypt, concatBytes } from '../core/crypto';

export interface EncryptJob {
  id: number;
  type: 'encrypt';
  password: string;
  salt: ArrayBuffer;
  nonce: ArrayBuffer;
  plaintext: ArrayBuffer;
  chunked: boolean;
}
export interface DecryptJob {
  id: number;
  type: 'decrypt';
  password: string;
  salt: ArrayBuffer;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
  chunked: boolean;
}
export type CryptoJob = EncryptJob | DecryptJob;

const CHUNK = 8 * 1024 * 1024; // 8 MB

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function u64be(n: number): Uint8Array {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return Uint8Array.from([(hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255]);
}

/** AAD：认证总明文长度 + 块序号，防止缺块/乱序与长度篡改 */
function chunkAad(totalLen: number, index: number): Uint8Array {
  return concatBytes([u64be(totalLen), u32be(index)]);
}

self.onmessage = async (ev: MessageEvent<CryptoJob>) => {
  const job = ev.data;
  const post = (msg: object): void => (self as unknown as Worker).postMessage({ ...msg, id: job.id });
  try {
    const salt = new Uint8Array(job.salt);
    const nonce = new Uint8Array(job.nonce);
    const key = await deriveFileKey(job.password, salt);

    if (job.type === 'encrypt') {
      const plain = new Uint8Array(job.plaintext);
      if (!job.chunked) {
        // 旧格式 v1：单次 AES-GCM
        const ct = await aesGcmEncrypt(key, nonce, plain);
        post({ ok: true, data: ct.buffer.slice(0) as ArrayBuffer });
        return;
      }
      const nChunks = Math.max(1, Math.ceil(plain.length / CHUNK));
      const totalLen = plain.length;
      const parts: Uint8Array[] = new Array(nChunks);
      for (let i = 0; i < nChunks; i++) {
        const off = i * CHUNK;
        const chunk = plain.subarray(off, Math.min(off + CHUNK, totalLen));
        const iv = nonce.slice();
        iv.set(u32be(i), iv.length - 4);
        parts[i] = await aesGcmEncrypt(key, iv, chunk, chunkAad(totalLen, i));
        postProgress(post, off + chunk.length, totalLen);
      }
      const buf = concatBytes(parts).buffer;
      post({ ok: true, data: buf });
    } else {
      const ct = new Uint8Array(job.ciphertext);
      if (!job.chunked) {
        // 旧格式 v1：单次 AES-GCM 解密
        const pt = await aesGcmDecrypt(key, nonce, ct);
        post({ ok: true, data: pt.buffer.slice(0) as ArrayBuffer });
        return;
      }
      const nChunks = Math.max(1, Math.ceil(ct.length / (CHUNK + 16)));
      const totalLen = ct.length - nChunks * 16;
      const parts: Uint8Array[] = new Array(nChunks);
      for (let i = 0; i < nChunks; i++) {
        const base = i * (CHUNK + 16);
        const segLen = Math.min(CHUNK, totalLen - i * CHUNK);
        const seg = ct.subarray(base, base + segLen + 16);
        const iv = nonce.slice();
        iv.set(u32be(i), iv.length - 4);
        parts[i] = await aesGcmDecrypt(key, iv, seg, chunkAad(totalLen, i));
        postProgress(post, base + segLen + 16, ct.length);
      }
      const buf = concatBytes(parts).buffer;
      post({ ok: true, data: buf });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '加密处理失败';
    post({ ok: false, error: msg });
  }
};

function postProgress(post: (m: object) => void, done: number, total: number): void {
  if (!total) return;
  post({ progress: Math.min(1, done / total) });
}
