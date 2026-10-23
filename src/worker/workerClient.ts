// 主线程侧 Worker 封装：提供 Promise 化的 encrypt/decrypt，自动 lazy 起线程。
import CryptoWorker from './crypto.worker?worker';

type WorkerResponse = { id: number } & (
  | { ok: true; data: ArrayBuffer }
  | { ok: false; error: string }
  | { progress: number });

export type ProgressFn = (ratio: number) => void;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { reject: (reason: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new CryptoWorker();
    const fail = () => terminateWorker('加密线程异常，请重试');
    worker.addEventListener('error', fail);
    worker.addEventListener('messageerror', fail);
  }
  return worker;
}

function run(
  job: { type: 'encrypt' | 'decrypt'; password: string; salt: Uint8Array; nonce: Uint8Array; data: Uint8Array; chunked: boolean },
  onProgress?: ProgressFn,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++nextId;
    const cleanup = () => {
      w.removeEventListener('message', handler);
      pending.delete(id);
    };
    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if ('progress' in msg) {
        if (onProgress) onProgress(msg.progress);
        return;
      }
      cleanup();
      if (msg.ok) {
        resolve(new Uint8Array(msg.data));
      } else {
        reject(new Error(msg.error));
      }
    };
    w.addEventListener('message', handler);
    pending.set(id, { reject: (reason) => { cleanup(); reject(reason); } });
    // 转移缓冲区所有权以避免拷贝大文件
    const salt = job.salt.slice();
    const nonce = job.nonce.slice();
    const data = job.data.slice();
    const payload = job.type === 'encrypt'
      ? { plaintext: data }
      : { ciphertext: data };
    try {
      w.postMessage(
        { id, type: job.type, password: job.password, salt, nonce, chunked: job.chunked, ...payload },
        [salt.buffer, nonce.buffer, data.buffer],
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function workerEncrypt(
  password: string, salt: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array,
  onProgress?: ProgressFn, chunked = true,
): Promise<Uint8Array> {
  return run({ type: 'encrypt', password, salt, nonce, data: plaintext, chunked }, onProgress);
}

export function workerDecrypt(
  password: string, salt: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array,
  onProgress?: ProgressFn, chunked = true,
): Promise<Uint8Array> {
  return run({ type: 'decrypt', password, salt, nonce, data: ciphertext, chunked }, onProgress);
}

export function terminateWorker(message = '加密任务已终止'): void {
  if (worker) { worker.terminate(); worker = null; }
  for (const task of pending.values()) task.reject(new Error(message));
}
