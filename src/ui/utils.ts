// 小组件工具：元素工厂、Toast、主题、可点击上传区
export type Theme = 'light' | 'dark' | 'pink';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer: number | null = null;
export function toast(msg: string, kind: 'ok' | 'err' = 'ok', ms = 2600): void {
  let box = document.getElementById('g-toast') as HTMLElement | null;
  if (!box) {
    box = el('div');
    box.id = 'g-toast';
    box.className = 'toast';
    document.body.appendChild(box);
  }
  box.className = `toast ${kind}`;
  box.textContent = msg;
  requestAnimationFrame(() => box!.classList.add('show'));
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box!.classList.remove('show'), ms);
}

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem('imgpkg-theme');
    return t === 'light' || t === 'dark' ? t : 'pink';
  } catch { return 'pink'; }
}
export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem('imgpkg-theme', t); } catch { /* 临时存储不可用时仍可切换主题 */ }
}

export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  // 优先 FileReader（对大多数文件稳定）；若触发 Electron 渲染进程的
  // "permission problems" 权限错误，则回退到主进程按真实路径读取。
  try {
    return await readViaFileReader(file);
  } catch {
    return readViaBridge(file);
  }
}

function readViaFileReader(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 通过 preload 暴露的 getPathForFile + 主进程 fs 读取，绕开 sandbox 渲染进程的文件访问权限 */
async function readViaBridge(file: File): Promise<Uint8Array> {
  const bridge = (window as any)?.imgpkg as { getPathForFile?: (f: File) => string; readFile?: (p: string) => Promise<ArrayBuffer | Uint8Array> } | undefined;
  if (!bridge?.getPathForFile || !bridge?.readFile) throw new Error('路径读取不可用');
  const filePath = bridge.getPathForFile(file);
  if (!filePath) throw new Error('无法获取文件路径');
  const buf = await bridge.readFile(filePath);
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

export function observeBytes(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}

export const previewBytes = observeBytes;

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 标题/描述里的换行转义显示 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
}

/** 密码强度 0-3 */
export function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

export const STRENGTH_COLOR = [
  ['22%', 'var(--danger)'],
  ['48%', '#ff9f43'],
  ['75%', '#ffca3a'],
  ['100%', 'var(--ok)'],
] as const;

/** 建立可点击/拖拽的文件上传区 */
export function bindDropzone(
  zone: HTMLElement,
  accept: string,
  onFile: (file: File) => void | Promise<void>,
): void {
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.setAttribute('aria-label', zone.textContent?.trim() || '选择文件');
  const receive = (file: File) => {
    if (accept !== '*' && !accept.split(',').some((ext) => file.name.toLowerCase().endsWith(ext.trim()))) {
      toast('文件格式不支持，请选择提示中的图片或视频格式', 'err'); return;
    }
    Promise.resolve(onFile(file)).catch(() => toast('读取文件失败，请重试', 'err'));
  };
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept === '*' ? '' : accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) receive(f);
    };
    input.click();
  };
  zone.addEventListener('click', choose);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    const f = Array.from(e.dataTransfer?.files ?? []).find((x) => x);
    if (f) receive(f);
  });
}

/** 移除预览时及时释放 Blob URL，尤其是仍在播放的视频。 */
export function clearPreview(box: HTMLElement): void {
  box.querySelectorAll<HTMLMediaElement | HTMLImageElement>('video, img').forEach((media) => {
    const src = media.getAttribute('src');
    if (media instanceof HTMLMediaElement) { media.pause(); media.removeAttribute('src'); media.load(); }
    if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
  });
  box.replaceChildren();
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const url = observeBytes(bytes, mime);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
