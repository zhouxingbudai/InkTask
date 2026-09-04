/* global window */
/**
 * recur.js — 重复任务引擎（每天签退 / 周期打卡类事务）
 *
 * 模型（完成制）：重复任务平时与普通任务一致 ——
 *   点完成 → 进入已完成区（completed = true），
 *   同时 dueAt 推进到下一次出现时刻、streak 连击 +1；
 *   到下一次出现所在的自然日开始时（如每天 18:00 的任务次日 0 点），
 *   任务自动复活为待办，带着新的到期时间再次出现在列表里。
 *
 * 频率：每天 / 工作日 / 每周 / 每月 / 每 N 天。
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

  /** ts 所在自然日的 0 点（本地时区） */
  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * 完成一次：与普通任务一样置 completed = true，
   * 同时推进 dueAt 到下一次出现、连击 +1、记录完成时间。
   * 返回完成前的快照，供撤销恢复。
   */
  function completeOccurrence(t, now) {
    const prev = {
      dueAt: t.dueAt == null ? null : Number(t.dueAt),
      streak: t.streak || 0,
      lastDoneAt: t.lastDoneAt == null ? null : Number(t.lastDoneAt),
      lastDoneOccur: t.lastDoneOccur == null ? null : Number(t.lastDoneOccur),
      completed: !!t.completed,
      completedAt: t.completedAt == null ? null : Number(t.completedAt),
      notifiedDue: !!t.notifiedDue
    };
    const r = normalize(t.recur);
    if (!r) {
      t.completed = true;
      t.completedAt = now;
      t.updatedAt = now;
      return prev;
    }

    const anchor = prev.dueAt != null ? prev.dueAt : now; // 无到期时以当前时刻为锚
    const iv = intervalMs(r);
    // 连击：本次完成的周期与上次完成的周期相邻（间隔 ≤ 1.5 个周期）则累计，否则重新计数
    const consecutive = prev.lastDoneOccur != null && (anchor - prev.lastDoneOccur) <= iv * 1.5;

    t.dueAt = nextDue(anchor, r, now);
    t.streak = consecutive ? (t.streak || 0) + 1 : 1;
    t.lastDoneAt = now;
    t.lastDoneOccur = anchor;
    t.completed = true;
    t.completedAt = now;
    t.notifiedDue = false;
    t.updatedAt = now;
    return prev;
  }

  /** 撤销完成：恢复快照字段（回到点击完成前的状态） */
  function undoComplete(t, prev) {
    if (!prev) return;
    t.dueAt = prev.dueAt;
    t.streak = prev.streak;
    t.lastDoneAt = prev.lastDoneAt;
    t.lastDoneOccur = prev.lastDoneOccur;
    t.completed = !!prev.completed;
    t.completedAt = prev.completedAt != null ? prev.completedAt : null;
    t.notifiedDue = !!prev.notifiedDue;
    t.updatedAt = Date.now();
  }

  /**
   * 周期复活：已完成的重复任务，当下一次出现所在的自然日开始时
   * （每天 18:00 的任务 → 次日 0 点）回到待办，带着新的到期时间。
   *
   * 兜底与对齐：
   * - dueAt 缺失（旧数据、后补重复）→ 从最后完成记录推一个；
   * - dueAt 落在过去的日期（离开多日 / 第二天过了到期时刻才打开应用）
   *   → 逐周期推进到「今天或之后」的第一次出现（保留时分锚点），
   *     然后立刻复活为待办：没到点显示「今天 HH:MM」，过了点显示「已逾期」，
   *     绝不因打开晚了就把当天的出现静默跳过。
   * 返回任务是否发生变化。
   */
  function refresh(t, now) {
    const r = normalize(t.recur);
    if (!r || !t.completed) return false;

    let changed = false;
    // 兜底：dueAt 缺失时从最后完成记录推一个
    if (t.dueAt == null) {
      const anchor = t.lastDoneOccur != null ? t.lastDoneOccur
        : (t.completedAt != null ? t.completedAt : now);
      t.dueAt = nextDue(anchor, r, now);
      changed = true;
    }
    // 对齐：把停留在过去日期的 dueAt 推进到「今天或之后」的第一次出现
    const today = startOfDay(now);
    let guard = 0;
    while (startOfDay(t.dueAt) < today && guard < 1000) {
      t.dueAt = nextOccurrence(t.dueAt, r);
      guard += 1;
      changed = true;
    }
    // 下一次出现所在日的 0 点已到 → 复活为待办（即使该时刻已过，也以逾期形式出现）
    if (now >= startOfDay(t.dueAt)) {
      t.completed = false;
      t.completedAt = null;
      t.notifiedDue = false;
      t.updatedAt = now;
      return true;
    }
    return changed;
  }

  /** 批量复活，任一任务变化即返回 true */
  function refreshAll(list, now) {
    let changed = false;
    (list || []).forEach((t) => {
      if (refresh(t, now)) changed = true;
    });
    return changed;
  }

  global.Recur = {
    DAY,
    KINDS,
    normalize,
    labelOf,
    intervalMs,
    nextOccurrence,
    nextDue,
    startOfDay,
    completeOccurrence,
    undoComplete,
    refresh,
    refreshAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
