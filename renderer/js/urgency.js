/* global window */
/**
 * urgency.js — 紧迫度引擎（纯函数，渲染层与 Node 单测共用）
 *
 * 排序规则（紧急程度自动排序，最紧急在最上面）：
 *   1) 已逾期任务单独置顶层，逾期越久越靠前；
 *   2) 未逾期任务按「紧急度等级 + 到期临近程度」加权得分降序；
 *   3) 同分时：到期更早者在前，其次新创建者在前；
 *   4) 已完成任务沉底，按完成时间新→旧。
 *
 * 计分（可解释、单调）：
 *   等级权重：低 100 / 中 200 / 高 300 / 紧急 400
 *   时间权重：≤1h 1800 / ≤4h 1500 / ≤24h 1200 / ≤72h 800 / ≤7天 500 / ≤30天 250 / 更远 100
 *   逾期层：100000 + min(10000, 逾期小时×10) + 等级权重
 */
(function (factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    window.Urgency = factory();
  }
})(function () {
  'use strict';

  const HOUR = 3600000;
  const DAY = 24 * HOUR;

  const LEVELS = [
    { key: 'low', label: '低', weight: 100 },
    { key: 'mid', label: '中', weight: 200 },
    { key: 'high', label: '高', weight: 300 },
    { key: 'urgent', label: '紧急', weight: 400 }
  ];

  function clampUrgency(u) {
    if (u == null) return 1; // 默认「中」
    const n = Math.round(Number(u));
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(3, n));
  }

  function levelInfo(u) {
    return LEVELS[clampUrgency(u)];
  }

  function urgencyScore(task, now) {
    now = now == null ? Date.now() : now;
    if (!task || task.completed) return -Infinity;
    const level = levelInfo(task.urgency);
    if (task.dueAt == null) return level.weight;
    const diff = task.dueAt - now;
    if (diff < 0) {
      return 100000 + Math.min(10000, (-diff) / HOUR * 10) + level.weight;
    }
    const h = diff / HOUR;
    let timeWeight;
    if (h <= 1) timeWeight = 1800;
    else if (h <= 4) timeWeight = 1500;
    else if (h <= 24) timeWeight = 1200;
    else if (h <= 72) timeWeight = 800;
    else if (h <= 7 * 24) timeWeight = 500;
    else if (h <= 30 * 24) timeWeight = 250;
    else timeWeight = 100;
    return level.weight + timeWeight;
  }

  /** 返回 { active, done } 两个已排序数组 */
  function sortTasks(tasks, now) {
    now = now == null ? Date.now() : now;
    const list = Array.isArray(tasks) ? tasks.slice() : [];
    const active = list.filter((t) => t && !t.completed);
    const done = list.filter((t) => t && t.completed);
    active.sort((a, b) => {
      const sa = urgencyScore(a, now);
      const sb = urgencyScore(b, now);
      if (sa !== sb) return sb - sa;
      const da = a.dueAt == null ? Infinity : a.dueAt;
      const db = b.dueAt == null ? Infinity : b.dueAt;
      if (da !== db) return da - db;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    return { active, done };
  }

  function fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return h % 24 > 0 ? `${d}天${h % 24}小时` : `${d}天`;
    if (h > 0) return m % 60 > 0 ? `${h}小时${m % 60}分` : `${h}小时`;
    return `${Math.max(1, m)}分钟`;
  }

  /**
   * 到期倒计时徽标
   * @returns {{text:string, cls:string}|null} cls ∈ is-overdue/is-now/is-soon/is-today/is-later
   */
  function formatCountdown(dueAt, now) {
    now = now == null ? Date.now() : now;
    if (dueAt == null) return null;
    const diff = dueAt - now;
    if (diff < 0) return { text: `逾期 ${fmtDuration(-diff)}`, cls: 'is-overdue' };
    if (diff < 60000) return { text: '即将到期', cls: 'is-now' };
    if (diff < 3600000) return { text: `剩 ${fmtDuration(diff)}`, cls: 'is-soon' };
    if (diff <= 4 * HOUR) return { text: `剩 ${fmtDuration(diff)}`, cls: 'is-soon' };
    if (diff <= 24 * HOUR) return { text: `剩 ${fmtDuration(diff)}`, cls: 'is-today' };
    if (diff <= 7 * DAY) return { text: `剩 ${fmtDuration(diff)}`, cls: 'is-later' };
    return { text: `剩 ${fmtDuration(diff)}`, cls: 'is-later' };
  }

  /** 统计：未完成 / 今日到期 / 已逾期 */
  function stats(tasks, now) {
    now = now == null ? Date.now() : now;
    let open = 0;
    let todayDue = 0;
    let overdue = 0;
    for (const t of tasks || []) {
      if (!t || t.completed) continue;
      open += 1;
      if (t.dueAt == null) continue;
      if (t.dueAt <= now) overdue += 1;
      else if (t.dueAt - now <= 24 * HOUR) todayDue += 1;
    }
    return { open, todayDue, overdue };
  }

  return { LEVELS, HOUR, DAY, clampUrgency, levelInfo, urgencyScore, sortTasks, fmtDuration, formatCountdown, stats };
});
