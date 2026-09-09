'use strict';
/**
 * store.js — 纯 Node 存储层（不依赖 electron，可被单元测试直接加载）
 *
 * 目录结构（默认 %APPDATA%/inktask/）：
 *   tasks.json      任务数据（原子写入：tmp + rename）
 *   settings.json   应用设置
 *   images/         内嵌图片库（按 id 存放）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TASKS_FILE = 'tasks.json';
const SETTINGS_FILE = 'settings.json';
const IMAGES_DIR = 'images';

const DEFAULT_SETTINGS = {
  hotkeys: { toggle: 'Control+Shift+Space', pin: 'Control+Shift+P' },
  autoStart: false,
  blurHide: false,
  notifyDue: true,
  accent: 'gold',
  showCompleted: true
};

const IMG_NAME_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp|bmp)$/i;

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function isValidTasksDoc(data) {
  return !!data && typeof data === 'object' && Array.isArray(data.tasks);
}

function isValidSettings(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data);
}

class Store {
  /** @param {string} dir 数据目录（由调用方注入，便于测试） */
  constructor(dir) {
    this.dir = dir;
    this._tasks = { meta: { version: 1 }, tasks: [] };
    this._settings = clone(DEFAULT_SETTINGS);
  }

  init() {
    fs.mkdirSync(path.join(this.dir, IMAGES_DIR), { recursive: true });
    this._tasks = this._load(TASKS_FILE, { meta: { version: 1 }, tasks: [], groups: [] }, isValidTasksDoc);
    this._tasks.tasks = (this._tasks.tasks || []).filter((t) => t && typeof t === 'object' && t.id);
    // 旧版数据没有 groups 字段；读入后统一补齐，保证内存结构完整
    if (!Array.isArray(this._tasks.groups)) this._tasks.groups = [];
    if (!this._tasks.meta || typeof this._tasks.meta !== 'object') this._tasks.meta = { version: 1 };
    this._settings = this._load(SETTINGS_FILE, DEFAULT_SETTINGS, isValidSettings);
    this._settings = this._mergeSettings(this._settings);
    return this;
  }

  /** 合并新增默认键，保留用户已保存的值 */
  _mergeSettings(saved) {
    const s = { ...clone(DEFAULT_SETTINGS), ...clone(saved) };
    s.hotkeys = { ...clone(DEFAULT_SETTINGS.hotkeys), ...(saved.hotkeys || {}) };
    return s;
  }

  /** 读取并校验；损坏时自动备份原文件（绝不静默丢数据） */
  _load(file, fallback, validate) {
    const p = path.join(this.dir, file);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return clone(fallback);
      throw err;
    }
    try {
      const data = JSON.parse(raw);
      if (!validate(data)) throw new Error('schema mismatch');
      return data;
    } catch (err) {
      try {
        fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
      } catch (_) { /* 尽力而为 */ }
      return clone(fallback);
    }
  }

  _atomicWrite(file, data) {
    const p = path.join(this.dir, file);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }

  imagesDir() {
    return path.join(this.dir, IMAGES_DIR);
  }

  getTasks() {
    return this._tasks;
  }

  /**
   * 保存任务文档。
   * @param {Array}    tasks  任务数组
   * @param {object}   meta   元信息
   * @param {Array}    [groups] 分组定义；缺省时保留内存中的现有分组，
   *                           避免遗漏传参的调用点把分组意外清空
   */
  saveTasks(tasks, meta, groups) {
    const keep = Array.isArray(groups)
      ? groups
      : (Array.isArray(this._tasks.groups) ? this._tasks.groups : []);
    this._tasks = { meta: meta || { version: 1 }, tasks: tasks || [], groups: keep };
    this._atomicWrite(TASKS_FILE, this._tasks);
  }

  getSettings() {
    return this._settings;
  }

  saveSettings(settings) {
    this._settings = this._mergeSettings(settings);
    this._atomicWrite(SETTINGS_FILE, this._settings);
  }

  /** 保存一张内嵌图片，返回 { id, url }；url 供渲染层 <img> 直接使用 */
  saveImage(buffer, ext) {
    const safeExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const id = `${crypto.randomUUID().replace(/-/g, '')}.${safeExt}`;
    fs.writeFileSync(path.join(this.imagesDir(), id), Buffer.from(buffer));
    return { id, url: `inkimg://img/${id}` };
  }

  /** 读取图片二进制（导出备份用） */
  readImage(id) {
    if (!IMG_NAME_RE.test(String(id))) throw new Error('invalid image id');
    return fs.readFileSync(path.join(this.imagesDir(), id));
  }

  /** 物理删除一张图片 */
  deleteImage(id) {
    if (!IMG_NAME_RE.test(String(id))) return false;
    try {
      fs.unlinkSync(path.join(this.imagesDir(), id));
      return true;
    } catch (_) {
      return false;
    }
  }

  listImages() {
    try {
      return fs.readdirSync(this.imagesDir()).filter((f) => IMG_NAME_RE.test(f));
    } catch (_) {
      return [];
    }
  }

  /** 清理未被任何任务引用的孤儿图片，返回删除数量 */
  gcImages(usedIds) {
    const used = new Set(usedIds || []);
    let removed = 0;
    for (const f of this.listImages()) {
      if (!used.has(f)) {
        if (this.deleteImage(f)) removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, IMG_NAME_RE };
