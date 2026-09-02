/* global window */
/**
 * util.js — 渲染层通用工具（无依赖）
 */
(function (global) {
  'use strict';

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  function truncate(s, n) {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** 任务到期时间的友好标签：今天 18:00 / 明天 09:00 / 周五 14:30 / 9月30日 */
  function fmtDueLabel(ts) {
    if (ts == null) return '';
    const d = new Date(ts);
    const now = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    if (sameDay(d, now)) return `今天 ${hm}`;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (sameDay(d, tomorrow)) return `明天 ${hm}`;
    const weekLater = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
    if (d <= weekLater) return `${days[d.getDay()]} ${hm}`;
    const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}年` : '';
    return `${y}${d.getMonth() + 1}月${d.getDate()}日${d.getHours() === 0 && d.getMinutes() === 0 ? '' : ' ' + hm}`;
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** datetime-local 输入框的值（本地时区） */
  function toLocalInputValue(ts) {
    if (ts == null) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  global.Util = { uuid, escapeHtml, debounce, truncate, stripHtml, fmtDueLabel, fmtClock, toLocalInputValue, pad2 };
})(typeof window !== 'undefined' ? window : globalThis);
