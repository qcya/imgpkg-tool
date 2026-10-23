import { contextBridge, ipcRenderer, webUtils } from 'electron';

// 预加载：仅暴露只读版本信息与"按真实路径读文件"能力，不向页面暴露完整 Node 能力。
// 读取文件经主进程 fs 完成，规避渲染进程(sandbox)读取用户文件时的权限错误。
contextBridge.exposeInMainWorld('imgpkg', {
  desktop: true,
  platform: process.platform,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  readFile: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('imgpkg:read-file', path),
});