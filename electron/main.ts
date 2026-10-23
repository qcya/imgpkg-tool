import { app, BrowserWindow, shell, nativeTheme, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const readFileAsync = promisify(fs.readFile);

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'electron', 'resources', 'icon.png');
}

function createWindow(): void {
  // 窗口本体放大 1.5 倍：宽 520→780，高 850→1275；但高度不超出屏幕可用区，
  // 否则底部"藏图/提取"按钮会顶出屏幕看不到。
  const targetW = Math.round(520 * 1.5);
  const targetH = Math.round(850 * 1.5);
  const work = screen.getPrimaryDisplay().workArea;
  const h = Math.min(targetH, work.height - 24);
  const w = Math.min(targetW, work.width - 24);
  const minW = Math.min(564, w);
  const minH = Math.min(620, h);
  const win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: minW,
    minHeight: minH,
    title: '加密压缩',
    icon: iconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1117' : '#f6f8fc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外部链接走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  // 渲染进程读取用户文件若受沙箱权限限制，回退到主进程按真实路径读取
  ipcMain.handle('imgpkg:read-file', async (_e, filePath: string) => {
    const buf = await readFileAsync(filePath);
    return new Uint8Array(buf);
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
