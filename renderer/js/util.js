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

  /** 任务到期时间的友好标签：今天 (2026/9/7) 18:00 / 明天 (2026/9/8) 09:00 / 后天 (2026/9/9) 18:00 /
   *  本周三 (2026/9/9) 14:30 / 下周二 (2026/9/15) 09:00 / 上周五 (2026/9/4) 18:00 / 2026年9月30日 */
  function fmtDueLabel(ts) {
    if (ts == null) return '';
    const d = new Date(ts);
    const now = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const md = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const dayAt = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);

    // 1-2 天粒度的相对日：同样括号标注具体日期
    if (sameDay(d, now)) return `今天 (${md}) ${hm}`;
    if (sameDay(d, dayAt(-1))) return `昨天 (${md}) ${hm}`;
    if (sameDay(d, dayAt(1))) return `明天 (${md}) ${hm}`;
    if (sameDay(d, dayAt(2))) return `后天 (${md}) ${hm}`;

    // 周次判断（周一为一周起始）：本周 / 下周 / 上周，
    // 星期不带周次会有「下周二还是这周二」的歧义
    const weekStart = (x) => {
      const w = new Date(x.getFullYear(), x.getMonth(), x.getDate());
      w.setDate(w.getDate() - (w.getDay() + 6) % 7); // 周一=0 回退到本周周一
      return w.getTime();
    };
    const thisWeek = weekStart(now);
    const wk = weekStart(d);
    const dow = days[d.getDay()].slice(1); // 「周三」→「三」
    if (wk === thisWeek) return `本周${dow} (${md}) ${hm}`;
    if (wk === thisWeek + 7 * 86400000) return `下周${dow} (${md}) ${hm}`;
    if (wk === thisWeek - 7 * 86400000) return `上周${dow} (${md}) ${hm}`;

    // 更远的日期：完整年月日
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${d.getHours() === 0 && d.getMinutes() === 0 ? '' : ' ' + hm}`;
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
