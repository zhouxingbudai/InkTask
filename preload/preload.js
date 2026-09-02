'use strict';
/**
 * preload.js — contextBridge 白名单桥
 * 渲染层只能通过 window.inktask.* 与主进程通信，无法直接访问 Node/Electron API。
 */
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = ['pin-changed', 'tasks-changed', 'action', 'hotkey-errors'];

contextBridge.exposeInMainWorld('inktask', {
  isElectron: true,
  platform: process.platform,

  // 数据
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  saveTasks: (payload) => ipcRenderer.invoke('tasks:save', payload),
  saveImage: (base64, ext) => ipcRenderer.invoke('image:save', { base64, ext }),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // 窗口
  togglePin: () => ipcRenderer.invoke('win:togglePin'),
  getPin: () => ipcRenderer.invoke('win:getPin'),
  hideWindow: () => ipcRenderer.invoke('win:hide'),
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),

  // 备份
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),

  // 自定义数据目录
  changeDataDir: () => ipcRenderer.invoke('data:changeDir'),
  resetDataDir: () => ipcRenderer.invoke('data:resetDir'),

  // 其他
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // 主进程 → 渲染层事件（仅白名单频道）
  on(channel, callback) {
    if (!ALLOWED_CHANNELS.includes(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
