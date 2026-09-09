import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * 用 JSDOM + 假 inktask 桥（模拟 preload/main 进程）启动完整渲染层。
 * 桥上捕获渲染层注册的事件监听；saveTasks 捕获每次防抖落盘的完整载荷（含 groups）。
 */
async function bootApp(mainDoc) {
  const listeners = {};
  const saved = [];

  const bridge = {
    isElectron: true,
    platform: 'win32',
    getTasks: async () => clone(mainDoc),
    saveTasks: async (payload) => { saved.push(clone(payload)); return { ok: true }; },
    saveImage: async () => ({ id: 'img1.png', url: 'inkimg://img/img1.png' }),
    getSettings: async () => ({ notifyDue: true, accent: 'gold', showCompleted: true }),
    saveSettings: async () => ({ ok: true }),
    exportBackup: async () => ({ saved: false }),
    importBackup: async () => ({ canceled: true }),
    changeDataDir: async () => ({ canceled: true }),
    resetDataDir: async () => ({ canceled: true }),
    getAppInfo: async () => ({ version: 'test', platform: 'win32', dataDir: 'C:\\d', dataDirCustom: false }),
    getPin: async () => false,
    togglePin: async () => false,
    hideWindow: async () => ({}),
    minimizeWindow: async () => ({}),
    on(channel, fn) { (listeners[channel] = listeners[channel] || []).push(fn); return () => {}; }
  };

  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // JSDOM 未实现 CSS.escape（app.js quickAdd 使用），测试环境补齐
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  Object.defineProperty(window, 'inktask', { value: bridge, configurable: true });

  const run = (rel) => window.eval(fs.readFileSync(path.join(ROOT, 'renderer', rel), 'utf8'));
  run('js/util.js');
  run('js/urgency.js');
  run('js/recur.js');
  run('js/storage.js');
  run('js/editor.js');
  run('js/app.js');

  await sleep(80); // 等 init() 异步链完成
  const fire = (channel, data) => (listeners[channel] || []).forEach((fn) => fn(data));
  return { window, document: window.document, fire, saved, close: () => window.close() };
}

function legacyDoc() {
  // 模拟旧版数据：tasks 带 groupId 引用，但 groups 从未落盘（旧版 IPC 边界丢弃）
  return {
    meta: { version: 1, updatedAt: 1000 },
    tasks: [{
      id: 't1', title: '回复客户报价邮件', detailHtml: '', urgency: 2, dueAt: null,
      groupId: 'gX', recur: null, streak: 0, lastDoneAt: null, lastDoneOccur: null,
      completed: false, completedAt: null, createdAt: 1, updatedAt: 1, notifiedDue: false
    }],
    groups: []
  };
}

function cleanDoc() {
  // 模拟新版正常数据：分组定义已落盘
  return {
    meta: { version: 1, updatedAt: 1000 },
    tasks: [{
      id: 't1', title: '回复客户报价邮件', detailHtml: '', urgency: 2, dueAt: null,
      groupId: 'gX', recur: null, streak: 0, lastDoneAt: null, lastDoneOccur: null,
      completed: false, completedAt: null, createdAt: 1, updatedAt: 1, notifiedDue: false
    }],
    groups: [{ id: 'gX', name: '工作', color: '#e8b34b', createdAt: 1 }]
  };
}

test('孤儿分组恢复后落盘：数据记录连分组一起保存', async () => {
  const app = await bootApp(legacyDoc());
  try {
    assert.ok(app.document.querySelector('.g-chip[data-g="gX"]'), '占位分组应出现在分组条');
    await sleep(500); // 防抖 400ms 落盘
    assert.ok(app.saved.length >= 1, '孤儿恢复应触发保存');
    const last = app.saved[app.saved.length - 1];
    assert.equal(last.groups.filter((g) => g.id === 'gX').length, 1, '落盘载荷必须包含分组定义');
    assert.equal(last.tasks[0].groupId, 'gX', '任务的分组归属保持');
  } finally {
    app.close();
  }
});

test('核心竞态：防抖窗口内的分组编辑不被主进程旧广播冲掉', async () => {
  const app = await bootApp(cleanDoc());
  try {
    // 1. 用户切到「工作」分组视图（此后快速新增的任务自动归入该组）
    app.document.querySelector('.g-chip[data-g="gX"]').dispatchEvent(
      new app.window.MouseEvent('click', { bubbles: true })
    );
    // 2. 防抖窗口内新增任务（persist 已入队、尚未落盘）
    const input = app.document.querySelector('#qa-input');
    input.value = '竞态窗口内新增的任务';
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(app.document.querySelectorAll('.task').length, 2, '新任务应出现在列表中');

    // 3. 主进程此刻推送旧文档（updatedAt=1000，早于刚才 persist 打的时间戳；
    //    旧实现会整体替换 state.doc，把未落盘的分组归属冲回 null）
    app.fire('tasks-changed', cleanDoc());

    await sleep(60);
    const cards = app.document.querySelectorAll('.task');
    assert.equal(cards.length, 2, '旧广播不得冲掉未落盘的新任务');

    await sleep(500); // 等防抖落盘，验证持久化载荷同样保留分组
    const saved = app.saved[app.saved.length - 1];
    const newTask = saved.tasks.find((t) => t.title === '竞态窗口内新增的任务');
    assert.ok(newTask, '新任务应进入保存载荷');
    assert.equal(newTask.groupId, 'gX', '新任务的分组归属必须保留（本次丢分组的根因）');
    assert.ok(saved.groups.some((g) => g.id === 'gX'), '保存载荷必须连分组定义一起记录');
  } finally {
    app.close();
  }
});

test('到期补丁（tasks-patch）：只原位改 notifiedDue，不动其他数据', async () => {
  const doc = cleanDoc();
  doc.tasks[0].dueAt = 1; // 早已过期
  const app = await bootApp(doc);
  try {
    // 主进程到期检查推送补丁
    app.fire('tasks-patch', { notifiedDue: [{ id: 't1', notifiedDue: true }] });
    await sleep(30);

    // 之后用户任意编辑触发落盘：载荷里补丁标志已生效且分组数据原封未动
    const input = app.document.querySelector('#qa-input');
    input.value = '补丁之后的普通编辑';
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(500);

    const saved = app.saved[app.saved.length - 1];
    const t1 = saved.tasks.find((t) => t.id === 't1');
    assert.equal(t1.notifiedDue, true, '补丁标志应合并进后续保存');
    assert.equal(t1.groupId, 'gX', '补丁不得改动任务的分组归属');
    assert.ok(saved.groups.some((g) => g.id === 'gX'), '补丁不得改动分组定义');
  } finally {
    app.close();
  }
});

test('新文档广播（updatedAt 更新，如备份导入）正常采纳', async () => {
  const app = await bootApp(cleanDoc());
  try {
    const newer = cleanDoc();
    newer.meta.updatedAt = 9999999999;
    newer.tasks.push({
      id: 't9', title: '导入进来的任务', detailHtml: '', urgency: 1, dueAt: null,
      groupId: null, recur: null, streak: 0, lastDoneAt: null, lastDoneOccur: null,
      completed: false, completedAt: null, createdAt: 2, updatedAt: 2, notifiedDue: false
    });
    app.fire('tasks-changed', newer);
    await sleep(60);
    assert.equal(app.document.querySelectorAll('.task[data-id="t9"]').length, 1, '更新的外部文档应被采纳');
  } finally {
    app.close();
  }
});

test('等时戳广播视为陈旧：不采纳、不破坏当前状态', async () => {
  const app = await bootApp(cleanDoc());
  try {
    const same = cleanDoc();
    same.tasks[0].title = '被篡改的旧标题';
    app.fire('tasks-changed', same); // updatedAt 相同（1000）
    await sleep(60);
    assert.ok(app.document.querySelector('.task[data-id="t1"] .task-title').textContent.includes('回复客户报价邮件'),
      '等时戳（非更新）文档不得覆盖本地状态');
  } finally {
    app.close();
  }
});

test('删除分组带撤销：恢复分组定义与任务归属', async () => {
  const app = await bootApp(cleanDoc());
  try {
    // 打开分组管理弹层并点击删除
    app.document.querySelector('.g-chip[data-g="__manage"]').dispatchEvent(
      new app.window.MouseEvent('click', { bubbles: true })
    );
    await sleep(30);
    const delBtn = app.document.querySelector('.g-man-del[data-del="gX"]');
    assert.ok(delBtn, '分组管理弹层应出现删除按钮');
    delBtn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    assert.ok(!app.document.querySelector('.g-chip[data-g="gX"]'), '删除后分组条不应再有该分组');
    assert.ok(app.document.querySelector('.task[data-id="t1"]'), '任务本体保留');

    // 点击 toast 上的「撤销」
    const undoBtn = app.document.querySelector('.toast-act');
    assert.ok(undoBtn, '删除分组应出现带撤销按钮的 toast');
    undoBtn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    assert.ok(app.document.querySelector('.g-chip[data-g="gX"]'), '撤销后分组定义恢复');

    await sleep(500); // 等防抖落盘
    const saved = app.saved[app.saved.length - 1];
    const t1 = saved.tasks.find((t) => t.id === 't1');
    assert.equal(t1.groupId, 'gX', '撤销后任务归属恢复（连分组一起记录）');
    assert.ok(saved.groups.some((g) => g.id === 'gX'), '撤销后分组定义进入保存载荷');
  } finally {
    app.close();
  }
});

test('孤儿恢复的一键重命名：toast 直达管理器，笔形按钮改回原名', async () => {
  const app = await bootApp(legacyDoc());
  try {
    await sleep(30);
    const goBtn = app.document.querySelector('.toast-act');
    assert.ok(goBtn, '孤儿恢复 toast 应带「去重命名」直达按钮');
    assert.match(goBtn.textContent, /去重命名/, '按钮文案明确引导');
    goBtn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert.ok(app.document.querySelector('.g-pop.manage'), '点击后直接打开分组管理器');

    // 笔形重命名按钮（不再依赖双击这种隐蔽交互）
    const renBtn = app.document.querySelector('.g-man-ren[data-ren="gX"]');
    assert.ok(renBtn, '每行应有显式重命名按钮');
    renBtn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const input = app.document.querySelector('.g-man-rename');
    assert.ok(input, '点击笔形按钮进入行内重命名');
    input.value = '工作';
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(500); // 等防抖落盘
    const saved = app.saved[app.saved.length - 1];
    assert.equal(saved.groups.find((g) => g.id === 'gX').name, '工作', '占位名改回「工作」并落盘');
  } finally {
    app.close();
  }
});

test('已完成任务可展开编辑：详情编辑器与优先级修改均生效', async () => {
  const doc = cleanDoc();
  doc.tasks[0].completed = true;
  doc.tasks[0].completedAt = 2000;
  const app = await bootApp(doc);
  try {
    // 点击已完成卡片头部 → 展开
    const doneCard = app.document.querySelector('.task.done[data-id="t1"]');
    assert.ok(doneCard, '已完成任务应渲染在已完成区');
    doneCard.querySelector('.task-head').dispatchEvent(
      new app.window.MouseEvent('click', { bubbles: true })
    );
    await sleep(60);
    const openCard = app.document.querySelector('.task.done[data-id="t1"]');
    assert.ok(openCard.classList.contains('open'), '已完成任务展开');
    assert.ok(openCard.querySelector('.ink-editor-body'), '展开后挂载详情编辑器');
    assert.ok(openCard.querySelector('[data-act="urg-selector"]'), '展开后有优先级选择器');

    // 修改已完成任务的优先级 → 落盘生效（完成后仍可编辑）
    openCard.querySelector('.urg-opt[data-urg="2"]').dispatchEvent(
      new app.window.MouseEvent('click', { bubbles: true })
    );
    await sleep(500);
    const saved = app.saved[app.saved.length - 1];
    assert.equal(saved.tasks.find((t) => t.id === 't1').urgency, 2, '已完成任务的编辑应落盘');
  } finally {
    app.close();
  }
});

test('完成任务时保持展开：勾选后无需重新点开即可补写详情', async () => {
  const app = await bootApp(cleanDoc());
  try {
    // 展开待办任务 → 点完成 → 应在已完成区保持展开
    const card = app.document.querySelector('.task[data-id="t1"]');
    card.querySelector('.task-head').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    app.document.querySelector('.task[data-id="t1"] [data-act="toggle"]').dispatchEvent(
      new app.window.MouseEvent('click', { bubbles: true })
    );
    await sleep(60);
    const doneCard = app.document.querySelector('.task.done[data-id="t1"]');
    assert.ok(doneCard, '任务完成后移入已完成区');
    assert.ok(doneCard.classList.contains('open'), '完成时保持展开状态');
    assert.ok(doneCard.querySelector('.ink-editor-body'), '完成后编辑器继续在线可编辑');
  } finally {
    app.close();
  }
});
