// Run real TypeScript core/crypto code with a browser Worker boundary in Node.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
function loader(extras = {}) {
  const cache = new Map();
  return function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id) => id.endsWith('?worker') ? BrowserWorker
      : id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id);
    vm.runInNewContext(code, { exports: mod.exports, module: mod, require: localRequire,
      Uint8Array, Uint32Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
      crypto: webcrypto, console, ...extras }, { filename: file });
    return mod.exports;
  };
}
class BrowserWorker {
  listeners = new Map();
  stopped = false;
  constructor() {
    BrowserWorker.latest = this;
    const self = { postMessage: (data) => queueMicrotask(() => {
      if (!this.stopped) this.emit('message', { data });
    }) };
    loader({ self })(path.join(root, 'src/worker/crypto.worker.ts'));
    this.self = self;
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  postMessage(data, transfer) { this.self.onmessage({ data: structuredClone(data, { transfer }) }); }
  terminate() { this.stopped = true; }
}
const load = loader();
const client = load(path.join(root, 'src/worker/workerClient.ts'));
const encoder = load(path.join(root, 'src/core/encoder.ts'));
const decoder = load(path.join(root, 'src/core/decoder.ts'));
afterEach(() => client.terminateWorker());
const salt = new Uint8Array(16), nonce = new Uint8Array(12);
test('concurrent crypto jobs return their own plaintext', async () => {
  const a = new TextEncoder().encode('first attachment');
  const b = new TextEncoder().encode('second, different attachment');
  const [ca, cb] = await Promise.all([
    client.workerEncrypt('alpha', salt, nonce, a),
    client.workerEncrypt('beta', salt, nonce, b),
  ]);
  const [pa, pb] = await Promise.all([
    client.workerDecrypt('alpha', salt, nonce, ca),
    client.workerDecrypt('beta', salt, nonce, cb),
  ]);
  assert.deepEqual(pa, a); assert.deepEqual(pb, b);
});
test('image/video carrier bytes and attachment survive password and passwordless round trips', async () => {
  for (const password of ['', '测试密码-123']) {
    const input = { imageBytes: Uint8Array.of(137,80,78,71,13,10), archiveBytes: Uint8Array.of(1,2,3,4),
      archiveName: '资料.zip', mimeType: 'application/zip', title: '资料', description: '', fileList: ['a.txt'], password };
    const made = await encoder.encodeAttachment(input);
    const got = await decoder.extractAttachment(made.outputBytes, password);
    assert.deepEqual(got.archive, input.archiveBytes);
    assert.deepEqual(got.cleanImage, input.imageBytes);
    assert.equal(got.originalName, '资料.zip');
    assert.equal(got.encrypted, Boolean(password));
    if (password) await assert.rejects(decoder.extractAttachment(made.outputBytes, 'wrong'));
  }
});
test('legacy single AES-GCM attachments still decrypt', async () => {
  const { buildTail, assembleEncodedImage } = load(path.join(root, 'src/core/container.ts'));
  const desc = new TextEncoder().encode(JSON.stringify({ originalName: 'old.zip' }));
  const plain = new Uint8Array([...desc, 4, 5, 6]);
  const ct = await client.workerEncrypt('legacy', salt, nonce, plain, undefined, false);
  const tail = buildTail({ algorithm: 1, kdfSalt: salt, nonce, encrypted: ct, descriptionJsonLen: desc.length, mimeTypeLen: 0, archiveLen: 3 });
  tail[8] = 1;
  const result = await decoder.extractAttachment(assembleEncodedImage(Uint8Array.of(9), tail), 'legacy');
  assert.deepEqual(result.archive, Uint8Array.of(4,5,6));
});
test('worker crashes reject pending jobs and a new job can recover', async () => {
  const job = client.workerEncrypt('crash', salt, nonce, Uint8Array.of(1));
  const rejected = assert.rejects(job, /线程异常/);
  BrowserWorker.latest.emit('error', {});
  await rejected;
  const ct = await client.workerEncrypt('retry', salt, nonce, Uint8Array.of(2));
  assert.deepEqual(await client.workerDecrypt('retry', salt, nonce, ct), Uint8Array.of(2));
});
test('terminating worker rejects outstanding jobs', async () => {
  const job = client.workerEncrypt('cancel', salt, nonce, Uint8Array.of(1));
  const rejected = assert.rejects(job, /终止/);
  client.terminateWorker(); await rejected;
});
test('multi-chunk attachment decrypts intact and rejects tampering', async () => {
  const plain = new Uint8Array(8 * 1024 * 1024 + 123);
  plain[0] = 17; plain[plain.length - 1] = 42;
  const progress = [];
  const ct = await client.workerEncrypt('large', salt, nonce, plain, (r) => progress.push(r));
  assert.deepEqual(await client.workerDecrypt('large', salt, nonce, ct), plain);
  assert.ok(progress.length >= 2); assert.equal(progress.at(-1), 1);
  ct[0] ^= 1;
  await assert.rejects(client.workerDecrypt('large', salt, nonce, ct));
});
