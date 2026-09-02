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
const os = require('node:os');
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
const POINTER_FILE = 'data-dir.txt'; // 始终存放于默认 userData，指向自定义数据目录

/* ------------------------------------------------------------------ */
/* 自定义数据目录（指针文件方案）                                        */
/* ------------------------------------------------------------------ */
let dataDirWarning = null; // 自定义目录失效时的回退提示
let dataDirMigratedFrom = null; // 旧版数据首次自动迁移到便携目录时记录来源

function defaultUserData() {
  return app.getPath('userData');
}

function readCustomDataDir() {
  try {
    const raw = fs.readFileSync(path.join(defaultUserData(), POINTER_FILE), 'utf8').trim();
    return raw || null;
  } catch (_) {
    return null;
  }
}

function isUnderTemp(dir) {
  try {
    const tmp = fs.realpathSync(os.tmpdir()).toLowerCase();
    const d = fs.realpathSync(dir).toLowerCase();
    return d === tmp || d.startsWith(tmp + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * 计算默认数据目录（便携优先）：
 * - 打包运行：exe 同级 data/（7z SFX 自解压到临时目录的情况回退 AppData，避免数据被清理）
 * - 开发运行：项目根 data/
 */
function defaultDataDir() {
  if (!app.isPackaged) return path.join(ROOT, 'data');
  const exeDir = path.dirname(app.getPath('exe'));
  if (isUnderTemp(exeDir)) return defaultUserData();
  return path.join(exeDir, 'data');
}

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.inktask-probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 升级到便携默认目录的首次运行：旧版数据在 AppData，目标 data/ 还没有数据，
 * 则把任务 / 设置 / 图片整体复制过去（原位置保留不动）。
 */
function migrateFromAppDataIfFirstRun(targetDir) {
  if (path.normalize(targetDir) === path.normalize(defaultUserData())) return;
  if (fs.existsSync(path.join(targetDir, 'tasks.json'))) return;
  const srcDir = defaultUserData();
  if (!fs.existsSync(path.join(srcDir, 'tasks.json'))) return;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(srcDir, 'tasks.json'), 'utf8'));
    if (!doc || !Array.isArray(doc.tasks) || doc.tasks.length === 0) return;
  } catch (_) { return; }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const f of ['tasks.json', 'settings.json']) {
      const src = path.join(srcDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, f));
    }
    const imgSrc = path.join(srcDir, 'images');
    if (fs.existsSync(imgSrc)) fs.cpSync(imgSrc, path.join(targetDir, 'images'), { recursive: true });
    dataDirMigratedFrom = srcDir;
  } catch (err) {
    console.warn('[data-dir] 旧数据迁移失败:', err.message);
  }
}

/** 启动时解析实际数据目录：自定义指针优先，否则用便携默认目录（必要时自动迁移旧数据） */
function resolveDataDir() {
  const def = defaultDataDir();
  const custom = readCustomDataDir();
  if (custom && path.normalize(custom) !== path.normalize(def)) {
    try {
      if (fs.statSync(custom).isDirectory()) return { dir: custom, warning: null };
    } catch (_) { /* 目录不存在或不可访问 */ }
    return {
      dir: def,
      warning: `上次设置的数据目录不可用（${custom}），已临时回退到默认目录。可在设置中重新选择。`
    };
  }
  if (!ensureWritable(def)) {
    if (path.normalize(def) === path.normalize(defaultUserData())) return { dir: def, warning: null };
    return {
      dir: defaultUserData(),
      warning: `默认数据目录不可写（${def}），已回退到系统目录。可在设置中另选位置。`
    };
  }
  migrateFromAppDataIfFirstRun(def);
  return { dir: def, warning: null };
}

function writeDataDirPointer(dir) {
  fs.mkdirSync(defaultUserData(), { recursive: true });
  fs.writeFileSync(path.join(defaultUserData(), POINTER_FILE), dir, 'utf8');
}

function clearDataDirPointer() {
  try {
    fs.rmSync(path.join(defaultUserData(), POINTER_FILE), { force: true });
  } catch (_) { /* ignore */ }
}

/** 把当前数据复制到目标目录（tasks.json / settings.json / images/） */
function migrateDataTo(targetDir) {
  for (const f of ['tasks.json', 'settings.json']) {
    const src = path.join(store.dir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, f));
  }
  const imgSrc = store.imagesDir();
  if (fs.existsSync(imgSrc)) {
    fs.cpSync(imgSrc, path.join(targetDir, 'images'), { recursive: true });
  }
}

/** 切换 store 到新目录后：重应用设置并通知渲染层 */
function afterDataDirSwitch() {
  dataDirWarning = null;
  const s = store.getSettings();
  applySettingsHotkeys(s.hotkeys, DEFAULT_SETTINGS.hotkeys);
  applyAutoStart(s.autoStart);
  updateTrayStats();
  sendToRenderer('tasks-changed', store.getTasks());
}

/**
 * 通用切换流程：选目录 → 校验可写 → 询问是否迁移 → 落盘切换
 * @param {string|null} toDir null = 弹目录选择框由用户挑；传路径 = 直接切到该路径（恢复默认用）
 */
async function switchDataDir(toDir) {
  dialogOpen += 1;
  try {
    let target = toDir;
    if (target == null) {
      const r = await dialog.showOpenDialog(win, {
        title: '选择新的数据目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      target = path.resolve(r.filePaths[0]);
    }
    if (path.normalize(target) === path.normalize(store.dir)) return { same: true };

    // 可写性探测
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, `.inktask-probe-${Date.now()}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
    } catch (err) {
      return { ok: false, error: `目录不可写：${err.message}` };
    }

    const targetHasData = fs.existsSync(path.join(target, 'tasks.json'));
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      title: '切换数据目录',
      message: `切换数据目录到：${target}`,
      detail: targetHasData
        ? '目标目录已存在墨办数据。\n· 迁移并切换：用当前数据覆盖目标目录\n· 直接切换：载入目标目录的现有数据'
        : '· 迁移并切换：把当前全部数据（任务、设置、内嵌图片）复制过去\n· 直接切换：从空目录重新开始',
      buttons: ['迁移并切换', '直接切换', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (choice.response === 2) return { canceled: true };
    const migrate = choice.response === 0;

    if (migrate) {
      try {
        migrateDataTo(target);
      } catch (err) {
        return { ok: false, error: `数据迁移失败：${err.message}` };
      }
    }

    // 指针文件：切回默认目录 → 清除指针；切到自定义目录 → 写入指针
    const isDefault = path.normalize(target) === path.normalize(defaultDataDir());
    if (isDefault) clearDataDirPointer();
    else writeDataDirPointer(target);

    store = new Store(target).init();
    afterDataDirSwitch();
    return { ok: true, dataDir: target, migrated: migrate };
  } finally {
    dialogOpen -= 1;
  }
}

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
  const resolved = resolveDataDir();
  store = new Store(resolved.dir).init();
  dataDirWarning = resolved.warning;
  if (dataDirWarning) console.warn('[data-dir]', dataDirWarning);
  createWindow();
  // 旧数据自动迁移到便携 data/ 目录时，告知用户去向
  if (dataDirMigratedFrom) {
    win.webContents.once('did-finish-load', () => {
      sendToRenderer('action', `data-migrated:${dataDirMigratedFrom}`);
    });
  }
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
    userData: app.getPath('userData'),
    dataDir: store.dir,
    dataDirCustom: path.normalize(store.dir) !== path.normalize(defaultDataDir()),
    dataDirWarning
  }));

  // 自定义数据目录
  ipcMain.handle('data:changeDir', () => switchDataDir(null));
  ipcMain.handle('data:resetDir', () => switchDataDir(defaultDataDir()));
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
