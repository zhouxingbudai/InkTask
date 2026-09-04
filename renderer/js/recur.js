/* global window */
/**
 * recur.js — 重复任务引擎（打卡 / 签退 / 周期性事务）
 *
 * 模型：任务带 recur 描述（每天 / 工作日 / 每周 / 每月 / 每 N 天）。
 * 完成一次 = 打卡：dueAt 推进到下一次出现，streak 连击计数 +1，
 * 任务保持未完成状态持续留在列表里。
 */
(function (global) {
  'use strict';

  const DAY = 24 * 3600000;

  /** 可选频率（interval 为自定义间隔，搭配 every 天数） */
  const KINDS = [
    { kind: 'daily', label: '每天' },
    { kind: 'weekdays', label: '工作日' },
    { kind: 'weekly', label: '每周' },
    { kind: 'monthly', label: '每月' },
    { kind: 'interval', label: '每 N 天' }
  ];

  function normalize(recur) {
    if (!recur || typeof recur !== 'object') return null;
    const k = KINDS.find((x) => x.kind === recur.kind);
    if (!k) return null;
    const r = { kind: k.kind };
    if (k.kind === 'interval') {
      const n = Math.round(Number(recur.every));
      r.every = Number.isFinite(n) && n >= 2 && n <= 365 ? n : 2;
    }
    return r;
  }

  /** 展示标签，如「每天」「每 3 天」 */
  function labelOf(recur) {
    const r = normalize(recur);
    if (!r) return '';
    if (r.kind === 'interval') return `每 ${r.every} 天`;
    return KINDS.find((x) => x.kind === r.kind).label;
  }

  /** 近似周期毫秒数（用于连击判定与展示，月按 30.44 天） */
  function intervalMs(recur) {
    const r = normalize(recur);
    if (!r) return DAY;
    switch (r.kind) {
      case 'daily': return DAY;
      case 'weekdays': return DAY;
      case 'weekly': return 7 * DAY;
      case 'monthly': return Math.round(30.44 * DAY);
      case 'interval': return r.every * DAY;
      default: return DAY;
    }
  }

  /** 单次推进：from 之后的一个出现时刻（保持原时刻的时分秒锚点） */
  function nextOccurrence(from, recur) {
    const r = normalize(recur);
    const d = new Date(from);
    if (!r) return from + DAY;
    switch (r.kind) {
      case 'daily':
        d.setDate(d.getDate() + 1);
        return d.getTime();
      case 'weekdays':
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
        return d.getTime();
      case 'weekly':
        d.setDate(d.getDate() + 7);
        return d.getTime();
      case 'monthly': {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
        const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, daysInMonth)); // 月末钳制（1月31日 → 2月28日）
        return d.getTime();
      }
      case 'interval':
        d.setDate(d.getDate() + (r.every || 2));
        return d.getTime();
      default:
        return d.getTime() + DAY;
    }
  }

  /**
   * 计算下一次到期：从 from 起不断推进，直到超过 now（自动跳过错过的周期）。
   * from 在未来（提前完成）时，直接推进一个周期。
   */
  function nextDue(from, recur, now) {
    let at = from;
    let guard = 0;
    do {
      at = nextOccurrence(at, recur);
      guard += 1;
    } while (at <= now && guard < 1000);
    return at;
  }

  /**
   * 打卡：推进 dueAt 到下一次出现、更新连击。
   * 返回打卡前的快照，供撤销恢复。
   */
  function applyComplete(t, now) {
    const prev = {
      dueAt: t.dueAt == null ? null : Number(t.dueAt),
      streak: t.streak || 0,
      lastDoneAt: t.lastDoneAt == null ? null : Number(t.lastDoneAt),
      lastDoneOccur: t.lastDoneOccur == null ? null : Number(t.lastDoneOccur)
    };
    const r = normalize(t.recur);
    if (!r) return prev;

    const anchor = prev.dueAt != null ? prev.dueAt : now; // 无到期时以当前时刻为锚
    const iv = intervalMs(r);
    // 连击：上次打卡对应的周期与本次相邻（间隔 ≤ 1.5 个周期）则累计，否则重新计数
    const consecutive = prev.lastDoneOccur != null && (anchor - prev.lastDoneOccur) <= iv * 1.5;

    t.dueAt = nextDue(anchor, r, now);
    t.streak = consecutive ? (t.streak || 0) + 1 : 1;
    t.lastDoneAt = now;
    t.lastDoneOccur = anchor;
    t.completed = false;
    t.completedAt = null;
    t.notifiedDue = false;
    t.updatedAt = now;
    return prev;
  }

  /** 撤销打卡：恢复快照字段 */
  function undoComplete(t, prev) {
    t.dueAt = prev.dueAt;
    t.streak = prev.streak;
    t.lastDoneAt = prev.lastDoneAt;
    t.lastDoneOccur = prev.lastDoneOccur;
    t.completed = false;
    t.completedAt = null;
    t.updatedAt = Date.now();
  }

  /**
   * 当前周期是否已打卡（连击徽章旁的今日状态）：
   * 上次打卡对应的周期紧邻当前 dueAt 即视为已完成本周期。
   */
  function doneCurrentPeriod(t) {
    const r = normalize(t.recur);
    if (!r || t.lastDoneOccur == null || t.dueAt == null) return false;
    return (t.dueAt - t.lastDoneOccur) <= intervalMs(r) * 1.5;
  }

  global.Recur = {
    DAY,
    KINDS,
    normalize,
    labelOf,
    intervalMs,
    nextOccurrence,
    nextDue,
    applyComplete,
    undoComplete,
    doneCurrentPeriod
  };
})(typeof window !== 'undefined' ? window : globalThis);
