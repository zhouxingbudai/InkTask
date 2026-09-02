import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Urgency = require('../renderer/js/urgency.js');

const NOW = 1760000000000; // 固定基准时间
const HOUR = 3600000;
const DAY = 24 * HOUR;

const task = (over) => ({
  id: 't' + Math.random().toString(36).slice(2),
  title: 'x',
  detailHtml: '',
  completed: false,
  completedAt: null,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  notifiedDue: false,
  ...over
});

/* ---------------- urgencyScore ---------------- */

test('逾期任务得分恒高于一切未逾期任务', () => {
  const overdue = task({ dueAt: NOW - 30 * 1000, urgency: 0 }); // 逾期30秒，低
  const imminent = task({ dueAt: NOW + 50 * 60 * 1000, urgency: 3 }); // 50分钟后到期，紧急
  assert.ok(Urgency.urgencyScore(overdue, NOW) > Urgency.urgencyScore(imminent, NOW));
});

test('逾期越久得分越高', () => {
  const a = task({ dueAt: NOW - 2 * HOUR });
  const b = task({ dueAt: NOW - 30 * DAY });
  assert.ok(Urgency.urgencyScore(b, NOW) > Urgency.urgencyScore(a, NOW));
});

test('同到期时间下等级越高越紧急', () => {
  const due = NOW + 3 * DAY;
  const low = task({ dueAt: due, urgency: 0 });
  const urgent = task({ dueAt: due, urgency: 3 });
  assert.ok(Urgency.urgencyScore(urgent, NOW) > Urgency.urgencyScore(low, NOW));
});

test('到期临近的权重足以越过等级差距（1小时内 > 下周到期的紧急任务）', () => {
  const soon = task({ dueAt: NOW + 30 * 60000, urgency: 0 }); // 低 + 30分钟 → 100+1800
  const later = task({ dueAt: NOW + 5 * DAY, urgency: 3 }); // 紧急 + 5天 → 400+500
  assert.ok(Urgency.urgencyScore(soon, NOW) > Urgency.urgencyScore(later, NOW));
});

test('无到期任务仅按等级计分，低于任何临近到期任务', () => {
  const none = task({ dueAt: null, urgency: 3 }); // 400
  const near = task({ dueAt: NOW + 12 * HOUR, urgency: 0 }); // 100 + 1200
  assert.ok(Urgency.urgencyScore(near, NOW) > Urgency.urgencyScore(none, NOW));
});

test('已完成任务得分为 -Infinity', () => {
  assert.equal(Urgency.urgencyScore(task({ completed: true, dueAt: NOW - HOUR }), NOW), -Infinity);
});

/* ---------------- sortTasks ---------------- */

test('排序：逾期最久者第一，已完成沉底', () => {
  const tasks = [
    task({ title: '完成', completed: true, completedAt: NOW }),
    task({ title: '明天到期', dueAt: NOW + DAY, urgency: 1 }),
    task({ title: '逾期1天', dueAt: NOW - DAY, urgency: 1 }),
    task({ title: '逾期3天', dueAt: NOW - 3 * DAY, urgency: 0 })
  ];
  const { active, done } = Urgency.sortTasks(tasks, NOW);
  assert.equal(active.length, 3);
  assert.equal(done.length, 1);
  assert.equal(active[0].title, '逾期3天');
  assert.equal(active[1].title, '逾期1天');
  assert.equal(done[0].title, '完成');
});

test('排序：紧急+临期在前，无到期在中，远期在后', () => {
  const tasks = [
    task({ title: '远期紧急', dueAt: NOW + 20 * DAY, urgency: 3 }),
    task({ title: '无到期低', dueAt: null, urgency: 0 }),
    task({ title: '2小时后到期中', dueAt: NOW + 2 * HOUR, urgency: 1 })
  ];
  const { active } = Urgency.sortTasks(tasks, NOW);
  assert.deepEqual(active.map((t) => t.title), ['2小时后到期中', '远期紧急', '无到期低']);
});

test('同分任务按到期更早在前', () => {
  const tasks = [
    task({ dueAt: NOW + 2 * HOUR, urgency: 1 }),
    task({ dueAt: NOW + HOUR, urgency: 1 })
  ];
  const { active } = Urgency.sortTasks(tasks, NOW);
  assert.ok(active[0].dueAt < active[1].dueAt);
});

test('非法 urgency 值被钳制，不抛异常', () => {
  assert.equal(Urgency.clampUrgency(9), 3);
  assert.equal(Urgency.clampUrgency(-4), 0);
  assert.equal(Urgency.clampUrgency('x'), 1);
  assert.equal(Urgency.clampUrgency(null), 1);
  const s = Urgency.urgencyScore(task({ urgency: 99, dueAt: null }), NOW);
  assert.ok(Number.isFinite(s));
});

/* ---------------- formatCountdown ---------------- */

test('倒计时：逾期文案与分级', () => {
  const cd = Urgency.formatCountdown(NOW - 5 * 60000, NOW);
  assert.equal(cd.text, '逾期 5分钟');
  assert.equal(cd.cls, 'is-overdue');
});

test('倒计时：一小时内显示分钟', () => {
  const cd = Urgency.formatCountdown(NOW + 42 * 60000, NOW);
  assert.equal(cd.text, '剩 42分钟');
  assert.equal(cd.cls, 'is-soon');
});

test('倒计时：不足一分钟', () => {
  const cd = Urgency.formatCountdown(NOW + 20000, NOW);
  assert.equal(cd.text, '即将到期');
  assert.equal(cd.cls, 'is-now');
});

test('倒计时：小时+天分级', () => {
  assert.equal(Urgency.formatCountdown(NOW + 3 * HOUR, NOW).cls, 'is-soon');
  assert.equal(Urgency.formatCountdown(NOW + 20 * HOUR, NOW).cls, 'is-today');
  assert.equal(Urgency.formatCountdown(NOW + 5 * DAY, NOW).cls, 'is-later');
  assert.match(Urgency.formatCountdown(NOW + 5 * DAY, NOW).text, /剩 5天/);
});

test('倒计时：无到期返回 null', () => {
  assert.equal(Urgency.formatCountdown(null, NOW), null);
});

/* ---------------- fmtDuration ---------------- */

test('时长格式化：天/小时/分钟组合', () => {
  assert.equal(Urgency.fmtDuration(90 * 60000), '1小时30分');
  assert.equal(Urgency.fmtDuration(2 * HOUR), '2小时');
  assert.equal(Urgency.fmtDuration(50 * HOUR), '2天2小时');
  assert.equal(Urgency.fmtDuration(3 * DAY), '3天');
  assert.equal(Urgency.fmtDuration(0), '1分钟');
});

/* ---------------- stats ---------------- */

test('统计：待办 / 今日到期 / 逾期', () => {
  const s = Urgency.stats([
    task({ dueAt: NOW + 2 * HOUR }),
    task({ dueAt: NOW - HOUR }),
    task({ dueAt: NOW + 30 * DAY }),
    task({ dueAt: NOW + 2 * HOUR, completed: true }),
    task({ dueAt: null })
  ], NOW);
  assert.equal(s.open, 4);
  assert.equal(s.todayDue, 1);
  assert.equal(s.overdue, 1);
});

test('紧急度等级定义完整', () => {
  assert.deepEqual(Urgency.LEVELS.map((l) => l.label), ['低', '中', '高', '紧急']);
  assert.ok(Urgency.LEVELS[3].weight > Urgency.LEVELS[2].weight);
});
