// recur.test.mjs — 重复任务引擎测试（完成制：完成 → 已完成 → 下一周期自动复活）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../renderer/js/recur.js');
const Recur = globalThis.Recur;

const DAY = 24 * 3600000;
const T = (s) => new Date(s).getTime();

test('normalize 非法输入返回 null，interval 天数钳制', () => {
  assert.equal(Recur.normalize(null), null);
  assert.equal(Recur.normalize({ kind: 'nope' }), null);
  assert.equal(Recur.normalize({ kind: 'interval', every: 0 }).every, 2);
  assert.equal(Recur.normalize({ kind: 'interval', every: 999 }).every, 2);
  assert.equal(Recur.normalize({ kind: 'interval', every: 3 }).every, 3);
});

test('labelOf 展示标签', () => {
  assert.equal(Recur.labelOf(null), '');
  assert.equal(Recur.labelOf({ kind: 'daily' }), '每天');
  assert.equal(Recur.labelOf({ kind: 'weekdays' }), '工作日');
  assert.equal(Recur.labelOf({ kind: 'interval', every: 3 }), '每 3 天');
});

test('每天：到期时刻整体 +1 天，保持时分锚点', () => {
  const from = T('2026-09-04T09:00:00');
  const at = Recur.nextOccurrence(from, { kind: 'daily' });
  assert.equal(new Date(at).getDate(), 5);
  assert.equal(new Date(at).getHours(), 9);
});

test('工作日：跳过周末（周五 → 下周一）', () => {
  const fri = T('2026-09-04T18:00:00'); // 周五
  const at = Recur.nextOccurrence(fri, { kind: 'weekdays' });
  assert.equal(new Date(at).getDay(), 1);
  assert.equal(new Date(at).getDate(), 7); // 下周一
});

test('每月：月末钳制（1月31日 → 2月28日）', () => {
  const jan31 = T('2026-01-31T10:00:00');
  const at = Recur.nextOccurrence(jan31, { kind: 'monthly' });
  assert.equal(new Date(at).getMonth(), 1);
  assert.equal(new Date(at).getDate(), 28);
});

test('nextDue 自动跳过错过的周期', () => {
  const was = T('2026-09-01T09:00:00');
  const now = T('2026-09-04T20:00:00');
  const at = Recur.nextDue(was, { kind: 'daily' }, now);
  assert.equal(new Date(at).getDate(), 5); // 推进到明天 09:00
  assert.equal(new Date(at).getHours(), 9);
});

test('nextDue 未来锚点（提前完成）直接推进一个周期', () => {
  const future = T('2026-09-04T21:00:00');
  const now = T('2026-09-04T08:00:00');
  const at = Recur.nextDue(future, { kind: 'daily' }, now);
  assert.equal(new Date(at).getDate(), 5);
  assert.equal(new Date(at).getHours(), 21);
});

test('startOfDay 返回本地自然日 0 点', () => {
  const at = Recur.startOfDay(T('2026-09-04T23:59:59'));
  assert.equal(at, T('2026-09-04T00:00:00'));
});

test('完成：置 completed、推进 dueAt 到下次出现、连击累计', () => {
  const t = {
    dueAt: T('2026-09-04T18:00:00'),
    recur: { kind: 'daily' },
    streak: 3,
    lastDoneAt: T('2026-09-03T18:30:00'),
    lastDoneOccur: T('2026-09-03T18:00:00'),
    completed: false
  };
  const now = T('2026-09-04T18:30:00');
  const prev = Recur.completeOccurrence(t, now);
  assert.equal(t.completed, true);
  assert.equal(t.completedAt, now);
  assert.equal(new Date(t.dueAt).getDate(), 5); // 明天 18:00
  assert.equal(new Date(t.dueAt).getHours(), 18);
  assert.equal(t.streak, 4);
  assert.equal(t.lastDoneOccur, T('2026-09-04T18:00:00'));
  assert.equal(t.lastDoneAt, now);
  assert.equal(prev.dueAt, T('2026-09-04T18:00:00')); // 快照记录完成前状态
});

test('完成：错过一个周期后连击重新计数', () => {
  const t = {
    dueAt: T('2026-09-04T18:00:00'),
    recur: { kind: 'daily' },
    streak: 5,
    lastDoneAt: T('2026-09-02T18:30:00'),
    lastDoneOccur: T('2026-09-02T18:00:00'), // 中间断了一天
    completed: false
  };
  Recur.completeOccurrence(t, T('2026-09-04T20:00:00'));
  assert.equal(t.streak, 1);
});

test('完成：无到期任务以当前时刻为锚', () => {
  const t = { dueAt: null, recur: { kind: 'daily' }, streak: 0, completed: false };
  const now = T('2026-09-04T12:00:00');
  Recur.completeOccurrence(t, now);
  assert.equal(new Date(t.dueAt).getDate(), 5);
  assert.equal(new Date(t.dueAt).getHours(), 12);
  assert.equal(t.streak, 1);
});

test('复活：完成当晚保持已完成，次日 0 点回到待办', () => {
  const t = {
    dueAt: T('2026-09-04T18:00:00'),
    recur: { kind: 'daily' },
    streak: 4,
    lastDoneAt: T('2026-09-04T18:30:00'),
    lastDoneOccur: T('2026-09-04T18:00:00'),
    completed: true,
    completedAt: T('2026-09-04T18:30:00')
  };
  // 完成后的 dueAt 已推进到明天
  t.dueAt = T('2026-09-05T18:00:00');
  // 当晚 23:00：仍已完成
  assert.equal(Recur.refresh(t, T('2026-09-04T23:00:00')), false);
  assert.equal(t.completed, true);
  // 次日 00:30：复活为待办，dueAt 保持明天的 18:00
  assert.equal(Recur.refresh(t, T('2026-09-05T00:30:00')), true);
  assert.equal(t.completed, false);
  assert.equal(t.completedAt, null);
  assert.equal(t.notifiedDue, false);
  assert.equal(t.dueAt, T('2026-09-05T18:00:00'));
});

test('复活：非重复任务与未完成任务不受影响', () => {
  const plain = { recur: null, completed: true, dueAt: T('2026-09-01T09:00:00') };
  assert.equal(Recur.refresh(plain, T('2026-09-04T09:00:00')), false);
  const open = { recur: { kind: 'daily' }, completed: false, dueAt: T('2026-09-01T09:00:00') };
  assert.equal(Recur.refresh(open, T('2026-09-04T09:00:00')), false);
  assert.equal(open.completed, false);
});

test('补完成逾期任务：下一周期当天已开始时立刻复活', () => {
  const t = {
    dueAt: T('2026-09-03T18:00:00'), // 昨天到期，逾期未完成
    recur: { kind: 'daily' },
    streak: 2,
    lastDoneAt: T('2026-09-02T18:30:00'),
    lastDoneOccur: T('2026-09-02T18:00:00'),
    completed: false
  };
  // 今天 09:00 补完成 → 下次出现 = 今天 18:00
  Recur.completeOccurrence(t, T('2026-09-04T09:00:00'));
  assert.equal(t.dueAt, T('2026-09-04T18:00:00'));
  assert.equal(t.completed, true);
  // 复活点（今天 0 点）已过 → 立刻回到待办，等今天 18:00 再完成
  assert.equal(Recur.refresh(t, T('2026-09-04T09:00:00')), true);
  assert.equal(t.completed, false);
  assert.equal(t.dueAt, T('2026-09-04T18:00:00'));
});

test('工作日：周五完成后下次周一，复活点为周一 0 点', () => {
  const t = {
    dueAt: T('2026-09-04T18:00:00'), // 周五
    recur: { kind: 'weekdays' },
    streak: 1,
    lastDoneAt: null,
    lastDoneOccur: null,
    completed: false
  };
  Recur.completeOccurrence(t, T('2026-09-04T18:30:00'));
  assert.equal(new Date(t.dueAt).getDay(), 1); // 下周一
  // 周六、周日整天保持已完成
  assert.equal(Recur.refresh(t, T('2026-09-06T12:00:00')), false);
  assert.equal(t.completed, true);
  // 周一 0 点复活
  assert.equal(Recur.refresh(t, T('2026-09-07T00:10:00')), true);
  assert.equal(t.completed, false);
});

test('旧数据兜底：已完成但 dueAt 过期时先校正再判定', () => {
  const t = {
    dueAt: T('2026-09-01T18:00:00'), // 过期的旧值
    recur: { kind: 'daily' },
    streak: 1,
    lastDoneAt: T('2026-09-01T18:30:00'),
    lastDoneOccur: T('2026-09-01T18:00:00'),
    completed: true,
    completedAt: T('2026-09-01T18:30:00')
  };
  assert.equal(Recur.refresh(t, T('2026-09-04T09:00:00')), true);
  assert.equal(t.completed, false);
  assert.equal(t.dueAt, T('2026-09-04T18:00:00')); // 校正为今天 18:00
});

test('复活：第二天过了到期时刻才打开应用，仍以逾期待办出现（不静默跳过）', () => {
  // 每天 18:00 签退：昨天 18:30 完成，dueAt 推进到今天 18:00
  const t = {
    dueAt: T('2026-09-04T18:00:00'),
    recur: { kind: 'daily' },
    streak: 3,
    lastDoneAt: T('2026-09-03T18:30:00'),
    lastDoneOccur: T('2026-09-03T18:00:00'),
    completed: true,
    completedAt: T('2026-09-03T18:30:00')
  };
  // 第二天 19:00 才打开应用（已过 18:00）→ 必须复活为待办，显示已逾期 1 小时
  assert.equal(Recur.refresh(t, T('2026-09-04T19:00:00')), true);
  assert.equal(t.completed, false);
  assert.equal(t.dueAt, T('2026-09-04T18:00:00')); // 保持今天 18:00，逾期可见
  // 逾期后补点完成 → 正常推进到明天
  Recur.completeOccurrence(t, T('2026-09-04T19:05:00'));
  assert.equal(t.completed, true);
  assert.equal(t.dueAt, T('2026-09-05T18:00:00'));
  assert.equal(t.streak, 4); // 昨天相邻，连击继续
});

test('复活：离开多日重新打开，dueAt 对齐到今天、只此一条待办', () => {
  const t = {
    dueAt: T('2026-09-01T18:00:00'), // 出差前最后周期
    recur: { kind: 'daily' },
    streak: 6,
    lastDoneAt: T('2026-09-01T18:30:00'),
    lastDoneOccur: T('2026-09-01T18:00:00'),
    completed: true,
    completedAt: T('2026-09-01T18:30:00')
  };
  // 三天后的晚上打开：对齐到今天 18:00 并复活（逾期 1 小时），不攒补打卡
  assert.equal(Recur.refresh(t, T('2026-09-04T19:00:00')), true);
  assert.equal(t.completed, false);
  assert.equal(t.dueAt, T('2026-09-04T18:00:00'));
  // 补完成一次 → 落到明天 18:00，连击因断档重新计数
  Recur.completeOccurrence(t, T('2026-09-04T19:10:00'));
  assert.equal(t.dueAt, T('2026-09-05T18:00:00'));
  assert.equal(t.streak, 1);
});

test('工作日：周末不对齐到周末日，保持已完成到周一', () => {
  // 周五完成后 dueAt=下周一 18:00；周六打开 → 不复活
  const t = {
    dueAt: T('2026-09-07T18:00:00'), // 周一
    recur: { kind: 'weekdays' },
    streak: 1,
    lastDoneAt: T('2026-09-04T18:30:00'),
    lastDoneOccur: T('2026-09-04T18:00:00'),
    completed: true,
    completedAt: T('2026-09-04T18:30:00')
  };
  assert.equal(Recur.refresh(t, T('2026-09-05T12:00:00')), false); // 周六
  assert.equal(Recur.refresh(t, T('2026-09-06T23:00:00')), false); // 周日
  assert.equal(t.completed, true);
  assert.equal(Recur.refresh(t, T('2026-09-07T00:05:00')), true); // 周一 0 点复活
  assert.equal(t.completed, false);
});

test('refreshAll：任一任务复活即返回 true', () => {
  const mk = (dueAt, completed, completedAt) => ({
    dueAt, recur: { kind: 'daily' }, streak: 1, lastDoneAt: null, lastDoneOccur: null,
    completed, completedAt: completed ? completedAt : null
  });
  const a = mk(T('2026-09-05T18:00:00'), true, T('2026-09-04T18:30:00')); // 明天出现 → 保持已完成
  const b = mk(T('2026-09-03T18:00:00'), true, T('2026-09-03T18:30:00')); // 前天完成、dueAt 停留旧值 → 复活
  const c = mk(null, false); // 普通待办
  assert.equal(Recur.refreshAll([a, b, c], T('2026-09-04T09:00:00')), true);
  assert.equal(a.completed, true);
  assert.equal(b.completed, false);
  assert.equal(b.dueAt, T('2026-09-04T18:00:00'));
});

test('撤销完成恢复快照（回到点击完成前）', () => {
  const t = {
    dueAt: T('2026-09-04T18:00:00'),
    recur: { kind: 'daily' },
    streak: 2,
    lastDoneAt: T('2026-09-03T18:30:00'),
    lastDoneOccur: T('2026-09-03T18:00:00'),
    completed: false
  };
  const prev = Recur.completeOccurrence(t, T('2026-09-04T20:00:00'));
  Recur.undoComplete(t, prev);
  assert.equal(t.dueAt, T('2026-09-04T18:00:00'));
  assert.equal(t.streak, 2);
  assert.equal(t.lastDoneOccur, T('2026-09-03T18:00:00'));
  assert.equal(t.completed, false);
  assert.equal(t.completedAt, null);
});

test('每周：跳过整周连击判定', () => {
  const t = {
    dueAt: T('2026-09-07T09:00:00'), // 周一
    recur: { kind: 'weekly' },
    streak: 4,
    lastDoneAt: T('2026-09-05T20:00:00'),
    lastDoneOccur: T('2026-08-31T09:00:00'), // 上周一，连续
    completed: false
  };
  Recur.completeOccurrence(t, T('2026-09-07T20:00:00'));
  assert.equal(t.streak, 5);
  assert.equal(new Date(t.dueAt).getDate(), 14); // 下周一
});
