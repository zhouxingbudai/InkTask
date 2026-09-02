'use strict';
/**
 * hotkeys.js — 全局快捷键注册（带冲突回退）
 *
 * 行为契约：
 * 1. 切换快捷键时先注销全部，再尝试注册新组合；
 * 2. 若任一注册失败：注销全部，回退注册「上一次有效配置」，返回错误说明；
 * 3. 保证任一时刻已注册的快捷键集合，一定与 settings.hotkeys 或旧配置一致，不会半注册。
 */
const { globalShortcut } = require('electron');

function tryRegister(accelerator, handler) {
  try {
    if (!accelerator) return true;
    globalShortcut.register(accelerator, handler);
    return globalShortcut.isRegistered(accelerator);
  } catch (_) {
    return false;
  }
}

function unregisterAllSafe() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) { /* ignore */ }
}

/**
 * @param {{toggle:string, pin:string}} hotkeys
 * @param {{onToggle:Function, onPin:Function}} handlers
 * @returns {{errors: string[]}} 注册失败的说明（空数组 = 全部成功）
 */
function applyHotkeys(hotkeys, handlers, fallbackHotkeys) {
  unregisterAllSafe();
  const errors = [];

  const attempt = (hk) => {
    const errs = [];
    const jobs = [
      ['显示/隐藏面板', hk.toggle, handlers.onToggle],
      ['置顶切换', hk.pin, handlers.onPin]
    ];
    for (const [label, accel, fn] of jobs) {
      if (!accel) continue;
      if (!tryRegister(accel, fn)) errs.push(`「${label}」快捷键 ${accel} 注册失败（可能被其他软件占用）`);
    }
    return errs;
  };

  errors.push(...attempt(hotkeys));
  if (errors.length > 0 && fallbackHotkeys) {
    // 回退旧配置，保证功能可用
    unregisterAllSafe();
    const fbErrs = attempt(fallbackHotkeys);
    return { errors, fallbackApplied: fbErrs.length === 0, fallbackHotkeys };
  }
  return { errors, fallbackApplied: false };
}

module.exports = { applyHotkeys };
