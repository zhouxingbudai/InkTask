import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { Store, DEFAULT_SETTINGS } = require('../main/store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inktask-test-'));
}

/* ---------------- 基本读写 ---------------- */

test('init 创建目录结构，空状态可读', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  assert.deepEqual(store.getTasks().tasks, []);
  assert.equal(store.getTasks().meta.version, 1);
  assert.equal(store.getSettings().hotkeys.toggle, DEFAULT_SETTINGS.hotkeys.toggle);
  assert.ok(fs.existsSync(path.join(dir, 'images')));
});

test('saveTasks → 重新 init 后数据一致（落盘往返）', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const tasks = [{ id: 'a', title: '写周报', completed: false, urgency: 2, dueAt: 123 }];
  store.saveTasks(tasks, { version: 1 });
  const again = new Store(dir).init();
  assert.deepEqual(again.getTasks().tasks, tasks);
});

test('saveSettings 合并新增默认键，保留用户旧值', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  store.saveSettings({ hotkeys: { toggle: 'Alt+Q' }, notifyDue: false });
  const s = new Store(dir).init().getSettings();
  assert.equal(s.hotkeys.toggle, 'Alt+Q');
  assert.equal(s.hotkeys.pin, DEFAULT_SETTINGS.hotkeys.pin); // 新键取默认
  assert.equal(s.notifyDue, false); // 用户值保留
  assert.equal(s.accent, 'gold');
});

/* ---------------- 损坏恢复 ---------------- */

test('tasks.json 损坏时：改名备份并重置，不抛异常', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{broken json!!!', 'utf8');
  const store = new Store(dir).init();
  assert.deepEqual(store.getTasks().tasks, []);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('tasks.json.corrupt-'));
  assert.equal(files.length, 1, '损坏文件应被保留为 .corrupt-*');
});

test('tasks.json 结构不符（tasks 非数组）时同样恢复', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ meta: {}, tasks: 'nope' }), 'utf8');
  const store = new Store(dir).init();
  assert.deepEqual(store.getTasks().tasks, []);
});

test('损坏的 settings.json 回退默认值', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), 'not-json', 'utf8');
  const store = new Store(dir).init();
  assert.deepEqual(store.getSettings().hotkeys, DEFAULT_SETTINGS.hotkeys);
});

test('无效任务条目（缺 id）被过滤', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
    meta: { version: 1 },
    tasks: [{ id: 'ok', title: 'x' }, { title: 'no-id' }, null, 42]
  }), 'utf8');
  const store = new Store(dir).init();
  assert.equal(store.getTasks().tasks.length, 1);
});

/* ---------------- 图片库 ---------------- */

test('saveImage / readImage / deleteImage 往返', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { id, url } = store.saveImage(buf, 'png');
  assert.match(id, /\.png$/);
  assert.equal(url, `inkimg://img/${id}`);
  assert.deepEqual(store.readImage(id), buf);
  assert.equal(store.deleteImage(id), true);
  assert.equal(store.listImages().includes(id), false);
});

test('非法图片名被拒绝（防路径穿越）', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  assert.throws(() => store.readImage('../../etc/passwd'));
  assert.equal(store.deleteImage('..%2Fsecret.png'), false);
});

test('gcImages 只删除未引用图片', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const a = store.saveImage(Buffer.from('a'), 'png').id;
  const b = store.saveImage(Buffer.from('b'), 'png').id;
  const c = store.saveImage(Buffer.from('c'), 'png').id;
  const removed = store.gcImages([a, b]);
  assert.equal(removed, 1);
  const left = store.listImages();
  assert.ok(left.includes(a));
  assert.ok(left.includes(b));
  assert.ok(!left.includes(c));
});

/* ---------------- 原子性 ---------------- */

test('原子写入后目录中不残留 tmp 文件', () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const acc = [];
  for (let i = 0; i < 5; i += 1) {
    acc.push({ id: 't' + i, title: 'x' + i });
    store.saveTasks(acc.slice(), { version: 1 });
  }
  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.includes('.tmp-')), '不应有 tmp 残留');
  assert.equal(new Store(dir).init().getTasks().tasks.length, 5);
});
