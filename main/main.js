'use strict';
/**
 * main.js — 墨办 InkTask 主进程
 * 职责：窗口(无边框/置顶/隐藏)、托盘、全局快捷键、IPC、原子存储、
 *       内嵌图片协议(inkimg://)、到期通知、备份导入导出、开机自启。
 */
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
  dialog, protocol, net, Notification, nativeImage
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Store, DEFAULT_SETTINGS } = require('./store');
const { applyHotkeys } = require('./hotkeys');

// 自定义图片协议必须在 app ready 之前注册特权
protocol.registerSchemesAsPrivileged([
  { scheme: 'inkimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let win = null;
let tray = null;
let store = null;
let quitting = false;
let pinned = false;
let hotkeyErrors = [];
let dialogOpen = 0; // 有原生对话框打开时不执行失焦自动隐藏
let blurHideTimer = null;
let gcTimer = null;

const ROOT = path.join(__dirname, '..');
const ICON_PATH = path.join(ROOT, 'build', 'icon.png');
const TRAY_ICON_PATH = path.join(ROOT, 'build', 'tray.png');

/* ------------------------------------------------------------------ */
/* 单实例：重复启动时唤起已有面板                                        */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('启动失败:', err);
    app.quit();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
}

async function bootstrap() {
  store = new Store(app.getPath('userData')).init();
  createWindow();
  createTray();
  registerProtocol();
  registerIpc();
  applySettingsHotkeys(store.getSettings().hotkeys, DEFAULT_SETTINGS.hotkeys);
  applyAutoStart(store.getSettings().autoStart);
  startDueWatcher();
  scheduleGc();
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 360,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: '#0b0d12',
    title: '墨办',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.once('ready-to-show', () => showPanel());

  // 关闭按钮 = 隐藏到托盘（真正退出走托盘菜单）
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      sendToRenderer('action', 'close-hint');
    }
  });

  // 置顶状态双向同步（用户也可能用第三方工具切换置顶）
  win.on('always-on-top-changed', (_e, isTop) => {
    pinned = isTop;
    rebuildTrayMenu();
    sendToRenderer('pin-changed', pinned);
  });

  // 失焦自动隐藏（默认关闭；打开原生对话框时跳过）
  win.on('blur', () => {
    if (!store.getSettings().blurHide || dialogOpen > 0) return;
    clearTimeout(blurHideTimer);
    blurHideTimer = setTimeout(() => {
      if (win && !win.isFocused() && store.getSettings().blurHide && dialogOpen === 0) {
        win.hide();
      }
    }, 400);
  });
  win.on('focus', () => clearTimeout(blurHideTimer));
}

function showPanel() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function togglePanel() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showPanel();
  }
}

function togglePin() {
  if (!win) return;
  pinned = !pinned;
  win.setAlwaysOnTop(pinned, 'screen-saver');
  sendToRenderer('pin-changed', pinned);
  sendToRenderer('action', pinned ? 'pin-on' : 'pin-off');
  rebuildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */
function createTray() {
  const img = fs.existsSync(TRAY_ICON_PATH)
    ? nativeImage.createFromPath(TRAY_ICON_PATH)
    : nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(img);
  tray.setToolTip('墨办 InkTask');
  rebuildTrayMenu();
  tray.on('click', () => togglePanel());
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏面板', click: () => togglePanel() },
    { label: pinned ? '取消置顶' : '窗口置顶', type: 'checkbox', checked: pinned, click: () => togglePin() },
    { label: '新建任务', click: () => { showPanel(); sendToRenderer('action', 'new-task'); } },
    { type: 'separator' },
    { label: '退出墨办', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function updateTrayStats() {
  if (!tray) return;
  const tasks = store.getTasks().tasks || [];
  const open = tasks.filter((t) => !t.completed).length;
  tray.setToolTip(`墨办 InkTask · ${open} 项未完成`);
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */
function applySettingsHotkeys(newHotkeys, fallbackHotkeys) {
  const result = applyHotkeys(newHotkeys, {
    onToggle: togglePanel,
    onPin: togglePin
  }, fallbackHotkeys);
  hotkeyErrors = result.errors;
  if (result.errors.length > 0) console.warn('[hotkeys]', result.errors.join('；'));
  return result;
}

function applyAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch (err) {
    console.warn('设置开机自启失败:', err);
  }
}

/* ------------------------------------------------------------------ */
/* 图片协议 inkimg://img/<id>                                          */
/* ------------------------------------------------------------------ */
function registerProtocol() {
  protocol.handle('inkimg', (request) => {
    let name = '';
    try {
      const u = new URL(request.url);
      name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch (_) { /* fallthrough */ }
    if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      return new Response('bad request', { status: 400 });
    }
    const file = path.join(store.imagesDir(), name);
    return net.fetch(pathToFileURL(file).toString());
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, data);
  }
}

function collectUsedImageIds(tasks) {
  const ids = new Set();
  const re = /data-ink-img="([^"]+)"/g;
  for (const t of tasks || []) {
    const html = String(t.detailHtml || '');
    let m;
    while ((m = re.exec(html)) !== null) ids.add(m[1]);
  }
  return [...ids];
}

function registerIpc() {
  ipcMain.handle('tasks:get', () => store.getTasks());

  ipcMain.handle('tasks:save', (_e, payload) => {
    store.saveTasks(payload.tasks, payload.meta);
    updateTrayStats();
    return { ok: true };
  });

  ipcMain.handle('image:save', (_e, { base64, ext }) => {
    const buffer = Buffer.from(String(base64), 'base64');
    return store.saveImage(buffer, ext);
  });

  ipcMain.handle('settings:get', () => ({
    ...store.getSettings(),
    hotkeyErrors
  }));

  ipcMain.handle('settings:save', (_e, settings) => {
    const prev = store.getSettings();
    const next = { ...settings };
    // 热键：注册失败则保留旧配置，避免磁盘与实际注册状态漂移
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      const result = applySettingsHotkeys(next.hotkeys, prev.hotkeys);
      if (result.errors.length > 0) {
        next.hotkeys = prev.hotkeys; // 回退到旧配置
        store.saveSettings(next);
        return { ok: false, errors: result.errors, settings: store.getSettings() };
      }
    }
    store.saveSettings(next);
    if (next.autoStart !== prev.autoStart) applyAutoStart(next.autoStart);
    return { ok: true, errors: [], settings: store.getSettings() };
  });

  ipcMain.handle('win:togglePin', () => { togglePin(); return pinned; });
  ipcMain.handle('win:getPin', () => pinned);
  ipcMain.handle('win:hide', () => win && win.hide());
  ipcMain.handle('win:minimize', () => win && win.minimize());

  ipcMain.handle('backup:export', async () => {
    dialogOpen += 1;
    try {
      const doc = store.getTasks();
      const images = {};
      for (const id of collectUsedImageIds(doc.tasks)) {
        try {
          images[id] = store.readImage(id).toString('base64');
        } catch (_) { /* 缺失则跳过 */ }
      }
      const backup = {
        meta: { app: 'inktask', version: 1, exportedAt: Date.now() },
        tasks: doc.tasks,
        images
      };
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog(win, {
        title: '导出备份',
        defaultPath: `inktask-backup-${stamp}.json`,
        filters: [{ name: 'JSON 备份', extensions: ['json'] }]
      });
      if (r.canceled || !r.filePath) return { saved: false };
      fs.writeFileSync(r.filePath, JSON.stringify(backup, null, 2), 'utf8');
      return { saved: true, path: r.filePath, count: doc.tasks.length };
    } finally {
      dialogOpen -= 1;
    }
  });

  ipcMain.handle('backup:import', async () => {
    dialogOpen += 1;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '导入备份',
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      let data;
      try {
        data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      } catch (_) {
        return { ok: false, error: '备份文件解析失败（不是有效的 JSON）' };
      }
      if (!data || !Array.isArray(data.tasks)) {
        return { ok: false, error: '备份文件格式不正确' };
      }

      // 恢复图片（存在则跳过）
      let imagesRestored = 0;
      for (const [id, b64] of Object.entries(data.images || {})) {
        try {
          const p = path.join(store.imagesDir(), id);
          if (!fs.existsSync(p)) {
            fs.writeFileSync(p, Buffer.from(b64, 'base64'));
            imagesRestored += 1;
          }
        } catch (_) { /* 跳过坏图 */ }
      }

      // 按 id 合并：较新 updatedAt 胜出，不丢本地数据
      const doc = store.getTasks();
      const map = new Map(doc.tasks.map((t) => [t.id, t]));
      let added = 0;
      let updated = 0;
      for (const t of data.tasks) {
        if (!t || typeof t !== 'object' || !t.id) continue;
        const local = map.get(t.id);
        if (!local) {
          map.set(t.id, t);
          added += 1;
        } else if ((t.updatedAt || 0) > (local.updatedAt || 0)) {
          map.set(t.id, t);
          updated += 1;
        }
      }
      const merged = [...map.values()];
      store.saveTasks(merged, doc.meta);
      updateTrayStats();
      sendToRenderer('tasks-changed', store.getTasks());
      return { ok: true, added, updated, imagesRestored };
    } finally {
      dialogOpen -= 1;
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData')
  }));
}

/* ------------------------------------------------------------------ */
/* 到期通知                                                            */
/* ------------------------------------------------------------------ */
function startDueWatcher() {
  const tick = () => {
    try {
      checkDue();
    } catch (err) {
      console.warn('到期检查失败:', err);
    }
  };
  setInterval(tick, 20000);
  setTimeout(tick, 2500); // 启动后先安静一会儿再查
}

function checkDue() {
  if (!store.getSettings().notifyDue) return;
  const doc = store.getTasks();
  const now = Date.now();
  let dirty = false;
  for (const t of doc.tasks) {
    if (!t.dueAt) continue;
    const overdue = !t.completed && t.dueAt <= now;
    if (overdue && !t.notifiedDue) {
      t.notifiedDue = true;
      dirty = true;
      notifyDue(t);
    } else if (!overdue && t.notifiedDue) {
      // 到期时间被改到未来：允许下次再次提醒
      t.notifiedDue = false;
      dirty = true;
    }
  }
  if (dirty) {
    store.saveTasks(doc.tasks, doc.meta);
    sendToRenderer('tasks-changed', store.getTasks());
  }
}

function notifyDue(task) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: '任务已到期',
    body: task.title || '一个任务到期了',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    silent: false
  });
  n.on('click', () => {
    showPanel();
    sendToRenderer('action', `focus-task:${task.id}`);
  });
  n.show();
}

/* ------------------------------------------------------------------ */
/* 孤儿图片回收（低频，避开撤销窗口）                                    */
/* ------------------------------------------------------------------ */
function scheduleGc() {
  const run = () => {
    try {
      const doc = store.getTasks();
      store.gcImages(collectUsedImageIds(doc.tasks));
    } catch (_) { /* ignore */ }
  };
  gcTimer = setInterval(run, 10 * 60 * 1000);
  setTimeout(run, 30000); // 启动 30s 后先清一次
}
