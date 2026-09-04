// recur.test.mjs — 重复任务引擎测试
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

test('打卡：推进 dueAt、连击累计、任务保持未完成', () => {
  const t = {
    dueAt: T('2026-09-04T09:00:00'),
    recur: { kind: 'daily' },
    streak: 3,
    lastDoneAt: T('2026-09-03T20:00:00'),
    lastDoneOccur: T('2026-09-03T09:00:00'),
    completed: false
  };
  const now = T('2026-09-04T20:00:00');
  Recur.applyComplete(t, now);
  assert.equal(t.completed, false);
  assert.equal(new Date(t.dueAt).getDate(), 5);
  assert.equal(t.streak, 4);
  assert.equal(t.lastDoneOccur, T('2026-09-04T09:00:00'));
  assert.equal(t.lastDoneAt, now);
});

test('打卡：错过一个周期后连击重新计数', () => {
  const t = {
    dueAt: T('2026-09-04T09:00:00'),
    recur: { kind: 'daily' },
    streak: 5,
    lastDoneAt: T('2026-09-02T20:00:00'),
    lastDoneOccur: T('2026-09-02T09:00:00'), // 中间断了一天
    completed: false
  };
  Recur.applyComplete(t, T('2026-09-04T20:00:00'));
  assert.equal(t.streak, 1);
});

test('打卡：无到期任务以当前时刻为锚', () => {
  const t = { dueAt: null, recur: { kind: 'daily' }, streak: 0, completed: false };
  const now = T('2026-09-04T12:00:00');
  Recur.applyComplete(t, now);
  assert.equal(new Date(t.dueAt).getDate(), 5);
  assert.equal(new Date(t.dueAt).getHours(), 12);
  assert.equal(t.streak, 1);
});

test('撤销打卡恢复快照', () => {
  const t = {
    dueAt: T('2026-09-04T09:00:00'),
    recur: { kind: 'daily' },
    streak: 2,
    lastDoneAt: T('2026-09-03T20:00:00'),
    lastDoneOccur: T('2026-09-03T09:00:00'),
    completed: false
  };
  const prev = Recur.applyComplete(t, T('2026-09-04T20:00:00'));
  Recur.undoComplete(t, prev);
  assert.equal(t.dueAt, T('2026-09-04T09:00:00'));
  assert.equal(t.streak, 2);
  assert.equal(t.lastDoneOccur, T('2026-09-03T09:00:00'));
});

test('doneCurrentPeriod：打卡后为 true，下个周期到期后为 false', () => {
  const t = { dueAt: T('2026-09-04T09:00:00'), recur: { kind: 'daily' }, streak: 0, completed: false };
  Recur.applyComplete(t, T('2026-09-04T10:00:00'));
  assert.equal(Recur.doneCurrentPeriod(t), true);
  // 时间过去，dueAt 早已到期又未打卡
  t.dueAt = T('2026-09-06T09:00:00');
  assert.equal(Recur.doneCurrentPeriod(t), false);
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
  Recur.applyComplete(t, T('2026-09-07T20:00:00'));
  assert.equal(t.streak, 5);
  assert.equal(new Date(t.dueAt).getDate(), 14); // 下周一
});
