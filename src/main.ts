import './styles/themes.css';
import './styles/compact.css';

import logoUrl from './assets/logo.png';
import { zip } from 'fflate';

import {
  el, toast, getTheme, setTheme, readFileAsBytes,
  humanSize, passwordStrength, STRENGTH_COLOR, bindDropzone, downloadBytes,
  clearPreview, type Theme,
} from './ui/utils';
import { encodeAttachment, encodeAttachmentPlain, generateRandomPassword } from './core/encoder';
import { inspectImage, extractAttachment, unwrapSingle } from './core/decoder';
import { algorithmNeedsPassword } from './core/types';
import { listArchiveFiles, guessMimeFromName } from './core/zip';

const app = document.querySelector<HTMLElement>('#app')!;

function busy(on: boolean, txt = '', pct?: number): void {
  const b = document.getElementById('g-busy')!;
  b.classList.toggle('show', on);
  app.inert = on;
  app.setAttribute('aria-busy', String(on));
  b.querySelector('.txt')!.textContent = txt;
  const fill = b.querySelector('.progbar-fill') as HTMLElement;
  if (fill) {
    if (pct === undefined) { fill.style.width = ''; fill.classList.add('indet'); }
    else { fill.classList.remove('indet'); fill.style.width = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`; }
  }
}

interface FileState { bytes: Uint8Array; name: string; mime: string; fileList: string[]; autoZipped?: boolean; }
function newFs(): FileState { return { bytes: new Uint8Array(), name: '', mime: '', fileList: [] }; }

/** 单文件体积上限：整个文件需先读进内存加密，超过上限会命中 2GiB 读取错误或内存不足 */
const MAX_FILE_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB

/** 是否为直接加密的压缩包：仅支持 .zip（按扩展名或文件头判断）。
 * 7z/rar/tar/gz 等一律视为普通文件，自动打包进 zip，不再按压缩包保留。 */
function looksLikeArchive(name: string, b: Uint8Array): boolean {
  const n = name.toLowerCase();
  if (/\.zip$/.test(n)) return true;
  if (b[0] === 0x50 && b[1] === 0x4b) return true; // zip PK 文件头
  return false;
}

/** 非压缩文件：一键打包成一个 zip（把原文件作为唯一条目），异步不阻塞 UI */
async function oneClickZip(origName: string, data: Uint8Array): Promise<Uint8Array> {
  const out = await new Promise<Uint8Array>((resolve, reject) => {
    zip({ [origName]: data as unknown as Uint8Array }, { level: 6 }, (err, zdata) => {
      if (err) reject(err); else resolve(new Uint8Array(zdata));
    });
  });
  return out;
}

function blobUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || 'image/png' }));
}

/** 按文件名推断图片/视频 MIME（f.type 为空时的兜底） */
function guessMediaMime(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.mp4')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.avi')) return 'video/x-msvideo';
  if (n.endsWith('.3gp') || n.endsWith('.3gpp')) return 'video/3gpp';
  return 'application/octet-stream';
}

/** 载体原始扩展名（含点）；不在本工具支持范围则返回 '' */
function origExt(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[0].toLowerCase() : '';
}

// ---------------- 制作卡 ----------------
function buildMakeCard(): HTMLElement {
  const card = el('div', 'card');
  const title = el('div', 'card-title');
  title.append(el('span', 'ic', '▼'), el('span', undefined, '制作'));
  card.append(title);
  card.append(el('p', 'card-intro', '把文件藏进图片或视频，分享外观如常，提取完整还原。'));

  const fs = newFs();
  const fa = newFs();

  // 载体类型：图片 / 视频（默认图片）
  const carrierSeg = el('div', 'seg seg-carrier');
  const imgCarBtn = el('button', 'active', '🖼️ 图片载体') as HTMLButtonElement;
  const vidCarBtn = el('button', '', '🎬 视频载体') as HTMLButtonElement;
  carrierSeg.append(imgCarBtn, vidCarBtn);
  card.append(carrierSeg);
  let carrier: 'image' | 'video' = 'image';

  // 载体（图片或视频）+ 压缩包（右）
  const drops = el('div', 'drops');
  const imgBox = el('div');
  const imgZone = el('div', 'dropzone');
  const setCarrierUI = () => {
    imgZone.innerHTML = carrier === 'video'
      ? `<div class="ic">🎬</div><div class="ttl">视频</div><div class="sub">MP4 / MOV / AVI / MKV / WEBM</div>`
      : `<div class="ic">🖼️</div><div class="ttl">图片</div><div class="sub">PNG / JPG / GIF</div>`;
  };
  setCarrierUI();
  const renderCarrier = () => {
    result.replaceChildren(); result.className = 'result';
    clearPreview(imgBox);
    // 切换载体后，若残留的载体字节类型与当前载体不符（如视频切到图片），清空该状态，
    // 否则会用 <img> 去渲染上一张视频的字节 → 出现无背景的破图
    if (fs.bytes.length && fs.mime) {
      const matches = carrier === 'video' ? fs.mime.startsWith('video/') : fs.mime.startsWith('image/');
      if (!matches) { fs.bytes = new Uint8Array(); fs.name = ''; fs.mime = ''; }
    }
    if (!fs.bytes.length) { imgBox.append(imgZone); return; }
    const prev = el('div', 'img-preview');
    if (carrier === 'video') {
      const v = document.createElement('video');
      v.src = blobUrl(fs.bytes, fs.mime);
      v.controls = true;
      v.classList.add('vid-thumb');
      v.onerror = () => URL.revokeObjectURL(v.src);
      prev.append(v);
    } else {
      const img = el('img', 'thumb') as HTMLImageElement;
      img.src = blobUrl(fs.bytes, fs.mime);
      img.onload = () => URL.revokeObjectURL(img.src);
      prev.append(img);
    }
    const close = el('button', 'close-chip', '✕') as HTMLButtonElement;
    close.onclick = () => { fs.bytes = new Uint8Array(); renderCarrier(); };
    close.setAttribute('aria-label', '移除载体');
    prev.append(close);
    imgBox.append(prev);
  };
  bindDropzone(imgZone, '.png,.jpg,.jpeg,.gif,.mp4,.mov,.avi,.mkv,.webm,.3gp', async (f) => {
    if (f.size > MAX_FILE_SIZE) { toast(`文件过大（${humanSize(f.size)}），载体超过 ${humanSize(MAX_FILE_SIZE)} 上限，请换较小的文件`, 'err'); return; }
    const mime = f.type || guessMediaMime(f.name);
    if (!mime.startsWith(carrier === 'image' ? 'image/' : 'video/')) {
      toast(carrier === 'image' ? '请选择图片' : '请选择视频', 'err'); return;
    }
    busy(true, '正在读取载体…');
    try {
      const b = await readFileAsBytes(f);
      if (!b.length) throw new Error('文件为空');
      fs.bytes = b; fs.name = f.name;
      fs.mime = mime;
      renderCarrier();
    } catch { toast('读取载体失败', 'err'); }
    finally { busy(false); }
  });
  imgCarBtn.onclick = () => {
    if (carrier === 'image') return;
    carrier = 'image';
    imgCarBtn.classList.add('active'); vidCarBtn.classList.remove('active');
    setCarrierUI(); renderCarrier();
    genBtn.textContent = '藏图';
  };
  vidCarBtn.onclick = () => {
    if (carrier === 'video') return;
    carrier = 'video';
    vidCarBtn.classList.add('active'); imgCarBtn.classList.remove('active');
    setCarrierUI(); renderCarrier();
    genBtn.textContent = '藏视频';
  };
  imgBox.append(imgZone);
  drops.append(imgBox);

  const arkBox = el('div');
  const arkZone = el('div', 'dropzone');
  arkZone.innerHTML = `<div class="ic">🗜️</div><div class="ttl">上传压缩包</div><div class="sub">仅 .zip 直接加密 · 其它任意文件（含 .7z/.rar）将自动打包为 zip</div>`;
  const renderArk = () => {
    result.replaceChildren(); result.className = 'result';
    arkBox.innerHTML = '';
    if (!fa.bytes.length) { arkBox.append(arkZone); return; }
    const chip = el('div', 'file-chip');
    const info = el('div');
    info.style.flex = '1';
    info.append(el('div', 'nm', fa.name), el('div', 'mt', fa.autoZipped ? `已自动打包 ${fa.fileList.length} 个文件 · ${humanSize(fa.bytes.length)}` : `${fa.fileList.length} 个文件 · ${humanSize(fa.bytes.length)}`));
    const close = el('button', 'close-chip', '✕') as HTMLButtonElement;
    close.onclick = () => { fa.bytes = new Uint8Array(); fa.fileList = []; fa.autoZipped = false; renderArk(); };
    close.setAttribute('aria-label', '移除附件');
    info.style.minWidth = '0';
    chip.append(el('div', 'zip-ic', '🗜️'), info, close);
    arkBox.append(chip);
  };
  bindDropzone(arkZone, '*', async (f) => {
    if (f.name.toLowerCase().endsWith('.lnk')) { toast('不支持快捷方式', 'err'); return; }
    if (f.size > MAX_FILE_SIZE) { toast(`文件过大（${humanSize(f.size)}），超过单文件加密上限 ${humanSize(MAX_FILE_SIZE)}，请先用压缩软件拆分后再试`, 'err'); return; }
    // 大文件读取/打包可能耗时数秒到数十秒：整个过程显示进度浮层，避免“没反应”
    busy(true, '正在读取文件…');
    try {
      const b = await readFileAsBytes(f);
      if (!b.length) { toast('不支持文件夹（内容为空）', 'err'); return; }
      if (looksLikeArchive(f.name, b)) {
        fa.autoZipped = false;
        fa.bytes = b; fa.name = f.name; fa.mime = guessMimeFromName(f.name);
        fa.fileList = listArchiveFiles(b, fa.mime, f.name);
      } else {
        busy(true, '正在打包大文件…');
        fa.autoZipped = true;
        const z = await oneClickZip(f.name, b);
        fa.bytes = z; fa.name = f.name; fa.mime = 'application/zip';
        fa.fileList = listArchiveFiles(z, 'application/zip', `${f.name}.zip`);
      }
      renderArk();
    } catch (err) {
      // 把底层报错（如 2GiB 读取限制、权限）转成用户能看懂的提示
      let reason = '';
      if (err instanceof RangeError) reason = '（文件过大，内存不足）';
      else if (err instanceof Error && /too large|ERR_FS|permission/i.test(err.message)) reason = '（文件过大或读取受限，建议缩小文件或用 .zip）';
      else reason = err instanceof Error ? `（${err.message}）` : '';
      toast(`读取文件失败${reason}`, 'err');
      console.error('[encrypt] 归档读取失败', f.name, humanSize(f.size), reason);
    } finally {
      busy(false);
    }
  });
  arkBox.append(arkZone);
  drops.append(arkBox);
  card.append(drops);

  // 加密后文件名（必填）
  const nameField = el('div', 'field');
  nameField.append(el('label', undefined, '加密后文件名（必填）'));
  const nameInput = el('input', 'input') as HTMLInputElement;
  nameInput.id = 'output-name';
  nameField.querySelector('label')!.htmlFor = nameInput.id;
  nameInput.placeholder = '例如：旅行照片（自动保留载体后缀）';
  nameInput.maxLength = 180;
  nameField.append(nameInput);
  card.append(nameField);

  // 密码：不设密码（软件封装，免密取图）/ 设密码
  const encWrap = el('div', 'field');
  encWrap.append(el('label', undefined, '密码'));
  const encSeg = el('div', 'seg');
  const encNo = el('button', 'active', '不设密码') as HTMLButtonElement;
  const encYes = el('button', '', '设密码') as HTMLButtonElement;
  encSeg.append(encNo, encYes);
  encWrap.append(encSeg);
  const noPwHint = el('div', 'hint', '收包方可用本软件免密提取。需要保护附件内容时，请选择“设密码”。');
  encWrap.append(noPwHint);
  card.append(encWrap);

  // 密码细节（仅加密时显示）
  const pwWrap = el('div', 'pw-wrap');
  pwWrap.style.display = 'none';
  const pwSeg = el('div', 'seg');
  const pwAuto = el('button', 'active', '自动生成密码') as HTMLButtonElement;
  const pwManual = el('button', '', '自己输入') as HTMLButtonElement;
  pwSeg.append(pwAuto, pwManual);
  pwWrap.append(pwSeg);
  pwWrap.append(el('div', 'hint', ''));

  const pwRow = el('div', 'pw-row');
  pwRow.style.display = 'none';
  const pwInput = el('input', 'input') as HTMLInputElement;
  pwInput.type = 'password';
  pwInput.setAttribute('aria-label', '设置解压密码');
  pwInput.autocomplete = 'new-password';
  pwInput.placeholder = '设置解压密码（留给收包方）';
  const strength = el('div', 'strength'); strength.innerHTML = '<i></i>';
  pwRow.append(pwInput, strength);
  pwInput.oninput = () => {
    const lv = passwordStrength(pwInput.value);
    const bar = strength.firstElementChild as HTMLElement;
    const [w, c] = STRENGTH_COLOR[lv];
    bar.style.width = w; bar.style.background = c;
  };
  pwWrap.append(pwRow);
  card.append(pwWrap);

  const setEnc = (encrypt: boolean) => {
    encNo.classList.toggle('active', !encrypt);
    encYes.classList.toggle('active', encrypt);
    noPwHint.style.display = encrypt ? 'none' : 'block';
    pwWrap.style.display = encrypt ? 'flex' : 'none';
  };
  const setPwMethod = (auto: boolean) => {
    pwAuto.classList.toggle('active', auto);
    pwManual.classList.toggle('active', !auto);
    pwRow.style.display = auto ? 'none' : 'flex';
    pwWrap.querySelector('.hint')!.textContent = auto
      ? '自动生成一串很长的随机密码。收包方拿到载体和这串密码，在“提取”里输入这串密码才能解开；不出本机、不联网。'
      : '设置你的专属密码。收包方必须知道密码并通过本软件才能解开（即使对方也装了软件）。';
  };
  encNo.onclick = () => setEnc(false);
  encYes.onclick = () => setEnc(true);
  pwAuto.onclick = () => setPwMethod(true);
  pwManual.onclick = () => setPwMethod(false);
  setPwMethod(true);

  // 生成按钮
  const genBtn = el('button', 'btn btn-primary btn-block', '藏图');
  const result = el('div', 'result');
  genBtn.onclick = () => runMake(fs, fa, nameInput, encYes, pwAuto, pwInput, genBtn, result, carrier);
  card.append(genBtn, result);
  result.setAttribute('aria-live', 'polite');
  const clearMade = () => { result.replaceChildren(); result.className = 'result'; };
  nameInput.addEventListener('input', clearMade);
  pwInput.addEventListener('input', clearMade);
  const configuration = () => `${carrier}:${encYes.classList.contains('active')}:${pwAuto.classList.contains('active')}`;
  let previousConfiguration = configuration();
  card.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('.seg button')) {
      const current = configuration();
      if (current !== previousConfiguration) clearMade();
      previousConfiguration = current;
    }
  });

  return card;
}

async function runMake(
  image: FileState, archive: FileState,
  nameInput: HTMLInputElement,
  encryptBtn: HTMLButtonElement, pwAutoBtn: HTMLButtonElement, pwInput: HTMLInputElement,
  btn: HTMLButtonElement, result: HTMLElement,
  carrier: 'image' | 'video',
): Promise<void> {
  const encrypted = encryptBtn.classList.contains('active');
  const autoPw = pwAutoBtn.classList.contains('active');
  const isVideo = carrier === 'video';

  if (!image.bytes.length) { toast(isVideo ? '请先选择视频' : '请先选择图片', 'err'); return; }
  if (!archive.bytes.length) { toast('请先选择压缩包', 'err'); return; }
  const outName = nameInput.value.trim();
  if (!outName) { toast('请填写加密后文件名', 'err'); return; }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(outName) || /[. ]$/.test(outName)) {
    toast('文件名不能包含特殊字符或以点、空格结尾', 'err'); nameInput.focus(); return;
  }
  if (encrypted && !autoPw && !pwInput.value) { toast('请输入解压密码', 'err'); return; }
  // 输出自动补扩展名：保留载体原始扩展名（GIF 保动画），图片兜底 .png，视频兜底 .mp4
  const dlName = !outName.includes('.')
    ? outName + (origExt(image.name) || (isVideo ? '.mp4' : '.png'))
    : outName;

  const base = {
    imageBytes: image.bytes, archiveBytes: archive.bytes,
    archiveName: archive.name, mimeType: archive.mime,
    title: outName, description: '', fileList: archive.fileList,
    singleFile: Boolean(archive.autoZipped),
  };

  btn.disabled = true;
  try {
    const onProg = (ratio: number): void => busy(true, '加密中…', ratio);
    if (!encrypted) {
      busy(true, '加密中…', 0);
      const r = await encodeAttachmentPlain({ ...base, password: '' }, onProg);
      showMade(result, r.outputBytes, image.mime, dlName, isVideo);
    } else if (autoPw) {
      busy(true, '生成随机密码并加密…', 0);
      const rpw = generateRandomPassword();
      const r = await encodeAttachment({ ...base, password: rpw }, onProg);
      showRandomMade(result, r.outputBytes, image.mime, rpw, dlName, isVideo);
    } else {
      busy(true, '加密中…', 0);
      const r = await encodeAttachment({ ...base, password: pwInput.value }, onProg);
      showMade(result, r.outputBytes, image.mime, dlName, isVideo);
    }
  } catch (e) {
    result.className = 'result result-err show';
    result.innerHTML = '';
    result.append(el('div', 'rt', '生成失败'), el('div', 'rs', e instanceof Error ? e.message : '未知错误'));
  } finally {
    btn.disabled = false;
    busy(false);
  }
}

function showMade(result: HTMLElement, bytes: Uint8Array, mime: string, dlName: string, isVideo: boolean): void {
  result.className = 'result result-ok show';
  result.innerHTML = '';
  result.append(el('div', 'rt', '已生成'));
  const act = el('div', 'result-actions');
  const dl = el('button', 'btn btn-primary', isVideo ? '⬇️ 下载视频' : '⬇️ 下载图片');
  dl.onclick = () => downloadBytes(bytes, dlName, mime);
  act.append(dl);
  result.append(el('div', 'rs', isVideo
    ? `大小 ${humanSize(bytes.length)}，外观与原视频一致、能照常播放；改后缀也解不出压缩包，只能用本软件提取。`
    : `大小 ${humanSize(bytes.length)}，外观与原图一致；改后缀也解不出压缩包，只能用本软件提取。`), act);
}

function showRandomMade(result: HTMLElement, bytes: Uint8Array, mime: string, rpw: string, dlName: string, isVideo: boolean): void {
  result.className = 'result result-ok show';
  result.innerHTML = '';
  result.append(el('div', 'rt', '已生成，保存好这串密码'));
  const gp = el('div', 'generated-pwd', '');
  gp.append('本次密码：', el('span', 'pw', rpw));
  const act = el('div', 'result-actions');
  const dl = el('button', 'btn btn-primary', isVideo ? '⬇️ 下载视频' : '⬇️ 下载图片');
  dl.onclick = () => downloadBytes(bytes, dlName, mime);
  const copy = el('button', 'btn btn-ghost', '复制密码');
  copy.onclick = () => { navigator.clipboard.writeText(rpw).then(() => toast('密码已复制')).catch(() => toast('复制失败，请选中密码手动复制', 'err')); };
  act.append(dl, copy);
  result.append(el('div', 'rs', '载体 + 这串密码一并发给收包方，对方在本工具“提取”里输入这串密码才能解开；本工具解压带密码的文件也必须再次输入密码。'), gp, act);
}

// ---------------- 提取卡 ----------------
function buildExtractCard(): HTMLElement {
  const card = el('div', 'card');
  const title = el('div', 'card-title');
  title.append(el('span', 'ic', '⌗'), el('span', undefined, '提取'));
  card.append(title);
  card.append(el('p', 'card-intro', '选择收到的图片或视频，提取其中保存的附件。'));

  const imgBox = el('div');
  const zone = el('div', 'dropzone');
  zone.innerHTML = `<div class="ic">🔍</div><div class="ttl">拖入文件</div><div class="sub">图片或视频</div>`;
  imgBox.append(zone);
  card.append(imgBox);

  const pwField = el('div', 'pw-wrap');
  pwField.style.display = 'none';
  pwField.append(el('label', undefined, '解压密码'));
  const pwInput = el('input', 'input') as HTMLInputElement;
  pwInput.type = 'password';
  pwInput.id = 'extract-password';
  pwField.querySelector('label')!.htmlFor = pwInput.id;
  pwInput.autocomplete = 'off';
  pwInput.placeholder = '输入发件人提供的密码';
  pwField.append(pwInput);
  card.append(pwField);

  const btn = el('button', 'btn btn-primary btn-block', '提取');
  btn.disabled = true;
  card.append(btn);

  const result = el('div', 'result');
  card.append(result);

  let currentBytes: Uint8Array | null = null;
  let currentMime = 'image/png';
  const renderPreview = (bytes: Uint8Array | null) => {
    clearPreview(imgBox);
    if (!bytes) { imgBox.append(zone); return; }
    const prev = el('div', 'img-preview');
    const isVideo = currentMime.startsWith('video/');
    if (isVideo) {
      const v = document.createElement('video');
      v.src = blobUrl(bytes, currentMime);
      v.controls = true;
      v.classList.add('vid-thumb');
      prev.append(v);
    } else {
      const img = el('img', 'thumb') as HTMLImageElement;
      img.src = blobUrl(bytes, currentMime);
      img.onload = () => URL.revokeObjectURL(img.src);
      prev.append(img);
    }
    const close = el('button', 'close-chip', '✕') as HTMLButtonElement;
    close.setAttribute('aria-label', '移除待提取文件');
    close.onclick = () => {
      currentBytes = null; btn.disabled = true; pwInput.value = ''; pwField.style.display = 'none';
      result.replaceChildren(); result.className = 'result'; renderPreview(null);
    };
    prev.append(close);
    imgBox.append(prev);
  };

  btn.onclick = () => runExtract(currentBytes, pwInput.value, btn, result);

  // 历史版本允许任意输出后缀，提取以容器内容识别而非文件名过滤。
  bindDropzone(zone, '*', async (f) => {
    if (f.size > MAX_FILE_SIZE * 2 + 1024 * 1024) { toast('文件过大，请选择较小的文件', 'err'); return; }
    busy(true, '正在检查附件…');
    try {
      const bytes = await readFileAsBytes(f);
      const info = inspectImage(bytes);
      if (!info) { toast('文件里没有本工具生成的附件', 'err'); return; }
      currentBytes = bytes;
      result.replaceChildren(); result.className = 'result';
      currentMime = f.type || guessMediaMime(f.name);
      renderPreview(bytes);
      const needsPw = algorithmNeedsPassword(info.header.algorithm);
      pwInput.value = '';
      pwField.style.display = needsPw ? 'flex' : 'none';
      pwInput.placeholder = '输入发件人提供的密码';
      btn.disabled = false;
    } catch {
      toast('读取文件失败', 'err');
    } finally { busy(false); }
  });
  pwInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !btn.disabled) btn.click(); });
  result.setAttribute('aria-live', 'polite');

  return card;
}

async function runExtract(bytes: Uint8Array | null, pw: string, btn: HTMLButtonElement, result: HTMLElement): Promise<void> {
  if (!bytes) { toast('请先选择文件', 'err'); return; }
  const info = inspectImage(bytes);
  if (!info) { toast('文件里没有附件', 'err'); return; }
  const needsPw = algorithmNeedsPassword(info.header.algorithm);
  if (needsPw && !pw) { toast('请输入解压密码', 'err'); return; }

  btn.disabled = true;
  try {
    busy(true, needsPw ? '解密…' : '提取…', 0);
    const r = await extractAttachment(bytes, pw, (ratio) => busy(true, needsPw ? '解密…' : '提取…', ratio));
    renderExtractResult(result, r);
  } catch {
    result.className = 'result result-err show';
    result.innerHTML = '';
    result.append(el('div', 'rt', '提取失败'), el('div', 'rs', '密码不正确，或图片已被改动。'));
  } finally {
    btn.disabled = false;
    busy(false);
  }
}

function renderExtractResult(result: HTMLElement, r: Awaited<ReturnType<typeof extractAttachment>>): void {
  result.className = 'result result-ok show';
  result.innerHTML = '';
  const act = el('div', 'result-actions');
  const head = el('div', 'rt', `📦 ${r.title || r.originalName || '未命名'}${r.encrypted ? ' · 加密' : ''}`);

  // 单个非压缩文件被自动打包（singleFile）时，把唯一文件解出直接还原给用户，
  // 而不是给一个包着一层的 zip
  const single = unwrapSingle(r);
  if (single) {
    const mime = guessMediaMime(single.name) || 'application/octet-stream';
    const body = el('div', 'rs', `已还原为单个文件：${single.name} · ${humanSize(single.data.length)}`);
    const dl = el('button', 'btn btn-primary', '⬇️ 下载文件');
    dl.onclick = () => downloadBytes(single.data, single.name, mime);
    act.append(dl);
    result.append(head, body, act);
    return;
  }

  // 压缩包：按原样下载（自动打包过的旧文件无 singleFile 标记，这里兜底补 .zip）
  const body = el('div', 'rs', `${r.originalName} · ${humanSize(r.archiveBytes)} · ${r.fileList.length} 个文件`);
  if (r.description) body.append(el('div', undefined, r.description));
  let dlName = r.originalName || 'archive';
  if (r.mimeType === 'application/zip' && !/\.zip$/i.test(dlName)) dlName += '.zip';
  const dl = el('button', 'btn btn-primary', '⬇️ 下载压缩包');
  dl.onclick = () => downloadBytes(r.archive, dlName, r.mimeType);
  act.append(dl);
  result.append(head, body, act);
  const archiveNames = listArchiveFiles(r.archive, r.mimeType, dlName);
  const titles = archiveNames.length ? archiveNames : r.fileList;
  if (titles.length) {
    const fl = el('div', 'file-list');
    titles.slice(0, 60).forEach((n) => fl.append(el('span', 'file-tag', n)));
    result.append(fl);
  }
}

// ---------------- 顶栏 ----------------
type ViewKey = 'make' | 'extract';
const VIEW_LABEL: Record<ViewKey, string> = { make: '制作', extract: '提取' };
const viewOrder: ViewKey[] = ['make', 'extract'];

function buildTopbar(): HTMLElement {
  const bar = el('div', 'topbar');

  const brand = el('div', 'brand');
  const logo = document.createElement('img');
  logo.className = 'logo-img';
  logo.src = logoUrl;
  logo.alt = '加密压缩';
  const nw = el('div');
  nw.append(el('div', undefined, '加密压缩'));
  brand.append(logo, nw);
  bar.append(brand);

  const modebar = el('div', 'modebar');
  const btns: Record<ViewKey, HTMLButtonElement> = {} as any;
  viewOrder.forEach((k) => {
    const b = el('button', '', VIEW_LABEL[k]) as HTMLButtonElement;
    b.onclick = () => {
      (Object.keys(btns) as ViewKey[]).forEach((kk) => btns[kk].classList.toggle('active', kk === k));
      setActiveView(k);
    };
    btns[k] = b;
    modebar.append(b);
  });
  btns['make'].classList.add('active');
  bar.append(modebar);

  bar.append(el('div', 'spacer'));

  const tools = el('div', 'top-tools');
  const seg = el('div', 'seg');
  const mk = (id: Theme, label: string) => {
    const b = el('button', '', label) as HTMLButtonElement;
    b.dataset.theme = id;
    b.onclick = () => {
      setTheme(id);
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    };
    if (id === getTheme()) b.classList.add('active');
    seg.append(b);
  };
  mk('light', '浅色'); mk('dark', '深色'); mk('pink', '淡粉');
  tools.append(seg);

  bar.append(tools);
  return bar;
}

function setActiveView(k: ViewKey): void {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${k}`)!.classList.add('active');
}

// ---------------- 面板 ----------------
function buildPanels(): void {
  const main = el('main');

  const makePanel = el('div', 'panel'); makePanel.id = 'panel-make';
  const makeStage = el('div', 'stage');
  makeStage.append(buildMakeCard());
  makePanel.append(makeStage);
  makePanel.classList.add('active');

  const extPanel = el('div', 'panel'); extPanel.id = 'panel-extract';
  const extStage = el('div', 'stage');
  extStage.append(buildExtractCard());
  extPanel.append(extStage);

  main.append(makePanel, extPanel);
  app.appendChild(main);
}

// ---------------- 启动 ----------------
function boot(): void {
  setTheme(getTheme());

  const aurora = el('div', 'aurora');
  aurora.innerHTML = '<i></i><i></i><i></i>';
  app.appendChild(aurora);

  const busyBox = el('div', 'busy');
  busyBox.id = 'g-busy';
  busyBox.setAttribute('role', 'status');
  busyBox.setAttribute('aria-live', 'polite');
  busyBox.append(
    el('div', 'spinner'),
    el('div', 'txt', ''),
    (() => { const p = el('div', 'progbar'); p.append(el('div', 'progbar-fill indet')); return p; })(),
  );
  document.body.appendChild(busyBox);

  buildPanels();
  app.insertBefore(buildTopbar(), app.querySelector('main'));
  const syncPressed = () => app.querySelectorAll<HTMLButtonElement>('.seg button, .modebar button')
    .forEach((button) => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
  syncPressed();
  app.addEventListener('click', syncPressed);
  // 阻止未落在上传区的拖拽把当前页面导航到本地文件。
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

boot();
