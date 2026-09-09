/* global window */
/**
 * storage.js — 存储适配层
 * Electron：走 preload 白名单桥（window.inktask）；
 * 浏览器（预览/开发）：localStorage + 内存图片降级，便于独立打开 UI 调试。
 *
 * 写入统一防抖 400ms；flush() 供导出等需要落盘的场景显式等待。
 */
(function (global) {
  'use strict';

  const api = global.inktask;
  const isElectron = !!(api && api.isElectron);

  /* ---------------- 浏览器降级实现 ---------------- */
  const WEB_KEY = 'inktask.tasks';
  const WEB_SETTINGS_KEY = 'inktask.settings';
  const webImages = new Map(); // id -> dataURL（仅当前会话）
  let webImageSeq = 0;

  function webLoadDoc() {
    try {
      const raw = global.localStorage.getItem(WEB_KEY);
      if (raw) {
        const doc = JSON.parse(raw);
        if (doc && Array.isArray(doc.tasks)) {
          if (!Array.isArray(doc.groups)) doc.groups = [];
          return doc;
        }
      }
    } catch (_) { /* ignore */ }
    return { meta: { version: 1 }, tasks: [], groups: [] };
  }

  function webLoadSettings() {
    try {
      const raw = global.localStorage.getItem(WEB_SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return null;
  }

  function webBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function fileExt(file) {
    const t = String(file.type || 'image/png');
    return (t.split('/')[1] || 'png').replace('jpeg', 'jpg');
  }

  /* ---------------- 防抖持久化 ---------------- */
  let pendingDoc = null;
  let timer = null;
  let flushPromise = null;
  const SAVE_DEBOUNCE = 400;

  function doSave() {
    const doc = pendingDoc;
    pendingDoc = null;
    if (!doc) return Promise.resolve();
    if (isElectron) return api.saveTasks(doc);
    try {
      global.localStorage.setItem(WEB_KEY, JSON.stringify(doc));
    } catch (_) { /* ignore */ }
    return Promise.resolve();
  }

  function queueSave(doc) {
    pendingDoc = doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      doSave().catch(() => { /* 保存失败时静默，下次写入再试 */ });
    }, SAVE_DEBOUNCE);
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pendingDoc) return;
    if (!flushPromise) {
      const p = doSave().finally(() => { flushPromise = null; });
      flushPromise = p;
    }
    await flushPromise;
  }

  /* ---------------- 适配器 ---------------- */
  const Storage = {
    isElectron,

    async getDoc() {
      if (isElectron) return api.getTasks();
      return webLoadDoc();
    },

    saveDoc(doc) {
      queueSave(doc);
    },

    flush,

    /** 保存一张图片，返回 { id, url } */
    async saveImage(base64, ext) {
      if (isElectron) return api.saveImage(base64, ext || 'png');
      const id = `web-${++webImageSeq}.png`;
      const url = `data:image/${ext || 'png'};base64,${base64}`;
      webImages.set(id, url);
      return { id, url };
    },

    async saveImageFile(file) {
      const base64 = await webBase64(file);
      return this.saveImage(base64, fileExt(file));
    },

    /** 根据图片 id 得到可用的 src */
    imageUrl(id) {
      if (!id) return '';
      if (isElectron) return `inkimg://img/${id}`;
      return webImages.get(id) || '';
    },

    async getSettings() {
      if (isElectron) return api.getSettings();
      return webLoadSettings() || {
        hotkeys: { toggle: 'Control+Shift+Space', pin: 'Control+Shift+P' },
        autoStart: false, blurHide: false, notifyDue: true, accent: 'gold', showCompleted: true
      };
    },

    async saveSettings(settings) {
      if (isElectron) return api.saveSettings(settings);
      try {
        global.localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(settings));
      } catch (_) { /* ignore */ }
      return { ok: true, errors: [], settings };
    },

    async exportBackup() {
      if (isElectron) return api.exportBackup();
      return { saved: false, unsupported: true };
    },

    async importBackup() {
      if (isElectron) return api.importBackup();
      return { canceled: true };
    },

    /** 自定义数据目录（仅 Electron；主进程负责弹目录选择/迁移确认） */
    async changeDataDir() {
      if (isElectron) return api.changeDataDir();
      return { unsupported: true };
    },

    async resetDataDir() {
      if (isElectron) return api.resetDataDir();
      return { unsupported: true };
    },

    async getAppInfo() {
      if (isElectron) return api.getAppInfo();
      return { version: 'dev', platform: 'web', userData: '(浏览器预览)', dataDir: '(浏览器预览)', dataDirCustom: false };
    },

    webImages
  };

  global.Storage = Storage;
})(typeof window !== 'undefined' ? window : globalThis);
