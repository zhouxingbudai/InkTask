/* global window, document, Storage, DetailEditor, Util, Urgency, Recur */
/**
 * app.js — 墨办渲染层主逻辑
 * 数据流：state.doc（内存单一事实源）→ 渲染；所有变更 persist() 防抖落盘。
 */
(function () {
  'use strict';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const U = window.Util;
  const urg = window.Urgency;
  const rec = window.Recur;

  /* ================= 状态 ================= */
  const state = {
    doc: { meta: { version: 1 }, tasks: [], groups: [] },
    settings: {
      hotkeys: { toggle: 'Control+Shift+Space', pin: 'Control+Shift+P' },
      autoStart: false, blurHide: false, notifyDue: true, accent: 'gold', showCompleted: true
    },
    filter: '',
    activeGroup: 'all',  // 'all' | groupId
    expandedId: null,
    editors: new Map(),   // taskId -> DetailEditor
    editing: false,        // 详情编辑中，暂缓外部数据覆盖
    pendingExternalDoc: null,
    appInfo: { version: 'dev', platform: 'web', userData: '' },
    quick: { urgency: 1, dueAt: null, recur: null, groupOverride: null }, // null=跟随当前视图
    pinLocal: false,
    recurSnaps: new Map() // 重复任务 id -> 完成前快照，供「取消完成」精确回滚
  };

  /* ================= 数据操作 ================= */
  function tasks() { return state.doc.tasks; }
  function findTask(id) { return tasks().find((t) => t.id === id) || null; }
  function groups() { return state.doc.groups || (state.doc.groups = []); }
  function findGroup(id) { return groups().find((g) => g.id === id) || null; }

  /** 分组配色（自动循环分配），与深色主题协调 */
  const GROUP_PALETTE = ['#e8b34b', '#4fd1c5', '#7ea6ff', '#c39dfb', '#f79ac0', '#6fd68f', '#ff9345', '#8fd3f4'];

  function makeGroup(name) {
    const g = {
      id: U.uuid(),
      name: String(name || '').trim().slice(0, 16) || '新分组',
      color: GROUP_PALETTE[groups().length % GROUP_PALETTE.length],
      createdAt: Date.now()
    };
    groups().push(g);
    persist();
    return g;
  }

  function renameGroup(id, name) {
    const g = findGroup(id);
    if (!g) return;
    g.name = String(name || '').trim().slice(0, 16) || g.name;
    persist();
  }

  /** 删除分组：任务移入未分组（不删任务）；若正浏览该分组则回到全部 */
  function deleteGroup(id) {
    const idx = groups().findIndex((g) => g.id === id);
    if (idx < 0) return;
    const [g] = groups().splice(idx, 1);
    tasks().forEach((t) => { if (t.groupId === id) t.groupId = null; });
    if (state.activeGroup === id) state.activeGroup = 'all';
    if (state.quick.groupOverride === id) state.quick.groupOverride = null;
    persist();
    renderAll();
    showToast(`已删除分组「${U.truncate(g.name, 10)}」，其任务已移入未分组`);
  }

  function groupCount(id) {
    return tasks().filter((t) => !t.completed && t.groupId === id).length;
  }

  /** 新任务实际归入的分组 id：手动覆盖优先，否则跟随当前浏览的分组 */
  function resolveQuickGroup() {
    if (state.quick.groupOverride === 'none') return null;
    if (state.quick.groupOverride) return findGroup(state.quick.groupOverride) ? state.quick.groupOverride : null;
    return state.activeGroup !== 'all' && findGroup(state.activeGroup) ? state.activeGroup : null;
  }

  function makeTask(title, opts) {
    opts = opts || {};
    const now = Date.now();
    return {
      id: U.uuid(),
      title: String(title || '').trim() || '未命名任务',
      detailHtml: opts.detailHtml || '',
      urgency: urg.clampUrgency(opts.urgency == null ? 1 : opts.urgency),
      dueAt: opts.dueAt == null ? null : Number(opts.dueAt),
      groupId: opts.groupId || null,
      recur: rec.normalize(opts.recur),
      streak: 0,
      lastDoneAt: null,
      lastDoneOccur: null,
      completed: false,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      notifiedDue: false
    };
  }

  function persist() {
    state.doc.meta.updatedAt = Date.now();
    Storage.saveDoc(state.doc);
  }

  function addTask(title, opts) {
    const t = makeTask(title, opts);
    tasks().unshift(t);
    persist();
    return t;
  }

  function completeToggle(id) {
    const t = findTask(id);
    if (!t) return;
    if (!t.completed) {
      // 完成：普通任务直接置完成；重复任务同时推进到下一周期
      let prev = null;
      if (t.recur) {
        prev = rec.completeOccurrence(t, Date.now());
        state.recurSnaps.set(id, prev);
      } else {
        t.completed = true;
        t.completedAt = Date.now();
        t.updatedAt = Date.now();
      }
      // 若补完成的是更早的周期且下一周期已经开始，立刻复活为待办
      refreshRecurring();
      persist();
      renderAll();
      if (prev && t.dueAt != null) {
        showToast(`已完成「${U.truncate(t.title, 14)}」 · 下次 ${U.fmtDueLabel(t.dueAt)}`, {
          actionLabel: '撤销',
          onAction: () => undoCompleteRecurring(t, prev)
        });
      }
    } else {
      // 取消完成
      if (t.recur) undoCompleteRecurring(t, state.recurSnaps.get(id) || null);
      else {
        t.completed = false;
        t.completedAt = null;
        t.updatedAt = Date.now();
        t.notifiedDue = false;
      }
      persist();
      renderAll();
    }
  }

  /** 取消完成重复任务：优先用完成时快照精确回滚；快照缺失（重启后）按最近完成周期近似回退 */
  function undoCompleteRecurring(t, prev) {
    if (prev) {
      rec.undoComplete(t, prev);
      state.recurSnaps.delete(t.id);
    } else {
      t.completed = false;
      t.completedAt = null;
      t.updatedAt = Date.now();
      if (t.lastDoneOccur != null) t.dueAt = t.lastDoneOccur;
      t.streak = Math.max(0, (t.streak || 0) - 1);
    }
    persist();
    renderAll();
  }

  /** 周期复活检查：跨过复活点的已完成重复任务回到待办（编辑中暂缓，避免打断输入） */
  function refreshRecurring() {
    if (state.editing) return;
    if (!rec.refreshAll(tasks(), Date.now())) return;
    persist();
    renderAll();
  }

  /** 带撤销的删除（5 秒内可恢复，图片 GC 在主进程延迟执行，不会误删） */
  function deleteTask(id) {
    const idx = tasks().findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [t] = tasks().splice(idx, 1);
    if (state.expandedId === id) state.expandedId = null;
    state.recurSnaps.delete(id);
    persist();
    renderAll();
    showToast(`已删除「${U.truncate(t.title, 14)}」`, {
      actionLabel: '撤销',
      onAction: () => { tasks().push(t); persist(); renderAll(); }
    });
  }

  /** 重命名任务：空值 / 未变化不落盘，避免无意义的 updatedAt 抖动 */
  function renameTask(id, title) {
    const t = findTask(id);
    if (!t) return;
    const v = String(title || '').trim();
    if (!v || v === t.title) return false;
    t.title = v;
    t.updatedAt = Date.now();
    persist();
    return true;
  }

  function clearCompleted() {
    // 普通已完成任务直接清除（可撤销）；已完成的重复任务默认保留
    // （下一周期还要回来），但 toast 上提供「一并清除」选项让用户决定去留
    const removed = tasks().filter((t) => t.completed && !t.recur);
    const keptRec = tasks().filter((t) => t.completed && t.recur);
    if (!removed.length && !keptRec.length) return;
    if (removed.length) state.doc.tasks = tasks().filter((t) => !(t.completed && !t.recur));
    persist();
    renderAll();
    if (removed.length) {
      showToast(`已清除 ${removed.length} 项已完成`, {
        actionLabel: '撤销',
        onAction: () => { state.doc.tasks.push(...removed); persist(); renderAll(); }
      });
    }
    if (keptRec.length) {
      showToast(`${keptRec.length} 项重复任务保留，到期自动回到待办`, {
        actionLabel: '一并清除',
        duration: 8000, // 决定去留的选项多留几秒反应时间
        onAction: () => {
          // 以点击时的实时状态为准（期间可能手动改过完成状态）
          const del = tasks().filter((t) => t.completed && t.recur);
          if (!del.length) return;
          state.doc.tasks = tasks().filter((t) => !(t.completed && t.recur));
          persist();
          renderAll();
          showToast(`已清除 ${del.length} 项重复任务`, {
            actionLabel: '撤销',
            onAction: () => { state.doc.tasks.push(...del); persist(); renderAll(); }
          });
        }
      });
    }
  }

  /* ================= 渲染 ================= */
  function esc(s) { return U.escapeHtml(s); }

  function imgCountOf(t) {
    return String(t.detailHtml || '').match(/data-ink-img=/g)?.length || 0;
  }

  function renderAll() {
    renderGroups();
    renderList();
    renderFooter();
  }

  /* ---------- 分组条 ---------- */
  function renderGroups() {
    const bar = $('#groups-bar');
    if (!bar) return;
    const gs = groups();
    const openAll = tasks().filter((t) => !t.completed).length;
    let html = `<button class="g-chip${state.activeGroup === 'all' ? ' active' : ''}" data-g="all">
      <span class="g-name">全部</span><span class="g-count">${openAll}</span></button>`;
    html += gs.map((g) => `
      <button class="g-chip${state.activeGroup === g.id ? ' active' : ''}" data-g="${g.id}" style="--g-color:${g.color}">
        <span class="g-dot"></span><span class="g-name">${esc(g.name)}</span><span class="g-count">${groupCount(g.id)}</span>
      </button>`).join('');
    html += `<button class="g-chip add" data-g="__manage" title="管理分组">＋</button>`;
    bar.innerHTML = html;
    // 快速新增 pill 同步
    updateQuickGroupUI();
  }

  function updateQuickGroupUI() {
    const gid = resolveQuickGroup();
    const g = gid ? findGroup(gid) : null;
    const label = $('#qa-group-label');
    const dot = $('#qa-group-dot');
    if (!label || !dot) return;
    label.textContent = g ? g.name : '未分组';
    dot.style.background = g ? g.color : 'transparent';
    dot.style.boxShadow = g ? `0 0 6px ${g.color}` : 'inset 0 0 0 1.5px rgba(102, 112, 137, 0.8)';
    $('#qa-group').classList.toggle('has-group', !!g);
    $('#qa-group').title = g ? `任务将加入「${g.name}」（点击更改）` : '任务未分组（点击选择分组）';
  }

  function renderList() {
    const listEl = $('#task-list');
    const now = Date.now();
    const { active, done } = urg.sortTasks(tasks(), now);
    const f = state.filter.trim().toLowerCase();
    const gFilter = state.activeGroup !== 'all' ? state.activeGroup : null;
    const match = (t) => (!gFilter || t.groupId === gFilter)
      && (!f
        || (t.title || '').toLowerCase().includes(f)
        || U.stripHtml(t.detailHtml).toLowerCase().includes(f));
    const act = active.filter(match);

    // 展开的任务被删/被筛掉时收起
    if (state.expandedId && !act.find((t) => t.id === state.expandedId)) {
      destroyEditor(state.expandedId);
      state.expandedId = null;
    }

    if (act.length === 0) {
      const g = gFilter ? findGroup(gFilter) : null;
      const sub = f ? `没有匹配「${esc(state.filter)}」的任务` : (g ? `「${esc(g.name)}」分组下暂无待办` : null);
      listEl.innerHTML = emptyHtml(sub);
    } else {
      listEl.innerHTML = act.map(cardHtml).join('');
      if (state.expandedId) mountEditor(state.expandedId, { focus: false });
    }

    renderDoneSection(done.filter(match));
  }

  function emptyHtml(subText) {
    return [
      '<div class="empty">',
      '  <div class="empty-drop"><i></i></div>',
      `  <p class="empty-title">${subText ? '没有结果' : '空空如也'}</p>`,
      `  <p class="empty-sub">${subText ? esc(subText) : '在上方写下第一件事，回车创建<br>详情里 Ctrl+V 可直接粘贴图片'}</p>`,
      '</div>'
    ].join('');
  }

  function cardHtml(t) {
    const now = Date.now();
    const open = t.id === state.expandedId;
    const cd = urg.formatCountdown(t.dueAt, now);
    const level = urg.levelInfo(t.urgency);
    const nImg = imgCountOf(t);
    const overdue = t.dueAt != null && t.dueAt < now && !t.completed;
    const excerpt = !open ? `<span class="excerpt">${esc(U.truncate(U.stripHtml(t.detailHtml), 46))}</span>` : '';
    const grp = state.activeGroup === 'all' && t.groupId ? findGroup(t.groupId) : null;
    const isRec = !!t.recur;

    return `
<article class="task u${t.urgency}${overdue ? ' is-overdue' : ''}${open ? ' open' : ''}${isRec ? ' is-recur' : ''}" data-id="${t.id}">
  <span class="rail" ${grp ? `style="background:${grp.color}"` : ''}></span>
  <button class="check" data-act="toggle" title="${isRec ? '完成（下一周期自动恢复）/ 取消完成' : '完成 / 取消完成'}" aria-label="完成"></button>
  <div class="task-main">
    <div class="task-head" data-act="expand">
      <div class="title-wrap">
        <h3 class="task-title" title="双击重命名">${esc(t.title)}</h3>
        <div class="task-meta">
          <span class="urg-chip u${t.urgency}">${level.label}</span>
          ${grp ? `<span class="grp-chip" style="--g-color:${grp.color}">${esc(grp.name)}</span>` : ''}
          ${isRec ? `<span class="recur-chip" title="重复任务：完成进入已完成，下一周期自动恢复">${ICON.repeat}<i>${esc(rec.labelOf(t.recur))}</i></span>` : ''}
          ${t.dueAt != null ? `<span class="due-chip">${esc(U.fmtDueLabel(t.dueAt))}</span>` : ''}
          ${nImg > 0 ? `<span class="img-chip">${ICON.image}${nImg}</span>` : ''}
          ${excerpt}
        </div>
      </div>
      <div class="task-side">
        ${isRec && t.streak > 1 ? `<span class="streak-chip" title="连续完成 ${t.streak} 个周期">连续 ${t.streak} 次</span>` : ''}
        ${cd ? `<span class="countdown ${cd.cls}" data-cd="${t.dueAt}" title="到期时间">${esc(cd.text)}</span>` : ''}
        <span class="chev">${ICON.chevron}</span>
      </div>
    </div>
    <div class="task-detail"><div class="task-detail-inner">${open ? detailHtml(t) : ''}</div></div>
  </div>
</article>`;
  }

  function detailHtml(t) {
    const level = urg.levelInfo(t.urgency);
    const dueLabel = t.dueAt != null ? U.fmtDueLabel(t.dueAt) : '设置到期';
    const grp = t.groupId ? findGroup(t.groupId) : null;
    const d = new Date(t.createdAt);
    const created = `${d.getMonth() + 1}月${d.getDate()}日 ${U.fmtClock(t.createdAt)}`;
    const recurLabel = t.recur ? rec.labelOf(t.recur) : '不重复';
    return `
<div class="detail-controls">
  <div class="urg-selector" data-act="urg-selector">
    ${urg.LEVELS.map((lv, i) => `<button data-urg="${i}" class="urg-opt u${i}${i === t.urgency ? ' active' : ''}">${lv.label}</button>`).join('')}
  </div>
  <button class="due-edit-btn" data-act="due-edit">${ICON.clock}<span>${esc(dueLabel)}</span></button>
  <button class="recur-edit-btn${t.recur ? ' has' : ''}" data-act="recur-edit" title="重复频率">
    ${ICON.repeat}<span>${esc(recurLabel)}</span>
  </button>
  <button class="grp-edit-btn${grp ? ' has' : ''}" data-act="group-edit"${grp ? ` style="--g-color:${grp.color}"` : ''} title="移动到分组">
    <span class="grp-edit-dot"></span><span>${grp ? esc(grp.name) : '分组'}</span>
  </button>
  <span class="flex-fill"></span>
  <span class="created-at" title="创建时间">建于 ${created}</span>
  <button class="icon-btn danger" data-act="delete" title="删除任务">${ICON.trash}</button>
</div>
${t.recur ? `<div class="recur-stat">
  <span class="rs-streak">连续 <b>${t.streak || 0}</b> 次</span>
  ${t.completed && t.dueAt != null ? `<span class="rs-next">${ICON.repeat}下次 ${esc(U.fmtDueLabel(t.dueAt))}</span>` : ''}
  ${t.lastDoneAt ? `<span class="rs-last">上次完成 ${esc(U.fmtDueLabel(t.lastDoneAt))}</span>` : '<span class="rs-last">尚未完成过</span>'}
  <span class="rs-tip">完成进入已完成，下一周期自动回到待办</span>
</div>` : ''}
<div class="editor-slot"></div>`;
  }

  function renderDoneSection(done) {
    const listEl = $('#task-list');
    const show = state.settings.showCompleted && done.length > 0;
    $('#btn-show-done').classList.toggle('hidden', done.length === 0);
    $('#btn-clear-done').classList.toggle('hidden', done.length === 0);
    $('#btn-show-done').textContent = `已完成 (${done.length})`;
    if (!show) return;
    const wrap = document.createElement('div');
    wrap.className = 'done-section';
    wrap.innerHTML = done.map((t) => `
<article class="task done" data-id="${t.id}">
  <span class="rail"></span>
  <button class="check checked" data-act="toggle" title="${t.recur ? '取消完成（重复任务）' : '取消完成'}"></button>
  <div class="task-main">
    <div class="task-head">
      <div class="title-wrap">
        <h3 class="task-title" title="双击重命名">${esc(t.title)}</h3>
        <div class="task-meta">
          ${t.dueAt != null ? `<span class="due-chip">${esc(U.fmtDueLabel(t.dueAt))}</span>` : ''}
          ${t.recur ? `<span class="recur-chip" title="下一周期自动回到待办">${ICON.repeat}<i>下次 ${esc(U.fmtDueLabel(t.dueAt))}</i></span>` : ''}
        </div>
      </div>
    </div>
  </div>
</article>`).join('');
    listEl.appendChild(wrap);
  }

  function renderFooter() {
    const s = urg.stats(tasks(), Date.now());
    const parts = [`<b>${s.open}</b> 项待办`];
    if (s.todayDue > 0) parts.push(`今日到期 <b>${s.todayDue}</b>`);
    if (s.overdue > 0) parts.push(`逾期 <b class="bad">${s.overdue}</b>`);
    $('#stats').innerHTML = parts.join('<span class="dot">·</span>');
  }

  /* ---------- 倒计时低频刷新（不打断编辑） ---------- */
  function updateCountdowns() {
    const now = Date.now();
    $$('.countdown[data-cd]').forEach((el) => {
      const dueAt = Number(el.dataset.cd);
      const cd = urg.formatCountdown(dueAt, now);
      if (!cd) return;
      el.textContent = cd.text;
      el.className = `countdown ${cd.cls}`;
    });
    // 跨过阈值时顺序可能变化：非编辑状态下重排
    if (!state.editing) maybeReorder();
    renderFooter();
  }

  function maybeReorder() {
    const { active } = urg.sortTasks(tasks(), Date.now());
    const newOrder = active.map((t) => t.id).join(',');
    const curOrder = $$('#task-list > .task:not(.done)').map((el) => el.dataset.id).join(',');
    if (newOrder !== curOrder) renderList();
  }

  /* ================= 编辑器挂载 ================= */
  function mountEditor(taskId, opts) {
    const t = findTask(taskId);
    const slot = $(`.task[data-id="${CSS.escape(taskId)}"] .editor-slot`);
    if (!t || !slot) return;
    destroyEditor(taskId);
    const editor = new DetailEditor({
      mount: slot,
      html: t.detailHtml,
      debounceMs: 600,
      onChange: (html) => {
        t.detailHtml = html;
        t.updatedAt = Date.now();
        persist();
      },
      onFocusChange: (editing) => {
        state.editing = editing;
        if (!editing) adoptPendingExternal();
      }
    });
    state.editors.set(taskId, editor);
    if (opts && opts.focus) editor.focus();
  }

  function destroyEditor(taskId) {
    const editor = state.editors.get(taskId);
    if (editor) {
      editor.destroy();
      state.editors.delete(taskId);
    }
  }

  function expandTask(id, focusEditor) {
    if (state.expandedId === id) return;
    if (state.expandedId) destroyEditor(state.expandedId);
    state.expandedId = id;
    renderList();
    const el = $(`.task[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (focusEditor) {
      const editor = state.editors.get(id);
      if (editor) editor.focus();
    }
  }

  function collapseTask() {
    if (!state.expandedId) return;
    destroyEditor(state.expandedId);
    state.expandedId = null;
    renderList();
  }

  /* ================= 快速新增 ================= */
  function duePresets() {
    const now = new Date();
    const at = (dayOffset, h, m) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m || 0, 0, 0);
      return d.getTime();
    };
    const nextMonday = () => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((8 - now.getDay()) % 7 || 7), 9, 0, 0, 0);
      return d.getTime();
    };
    return [
      { label: '今天 18:00', at: at(0, 18) },
      { label: '今晚 21:00', at: at(0, 21) },
      { label: '明天 09:00', at: at(1, 9) },
      { label: '明天 18:00', at: at(1, 18) },
      { label: '后天 09:00', at: at(2, 9) },
      { label: '下周一 09:00', at: nextMonday() }
    ];
  }

  function updateQuickUI() {
    const lv = urg.levelInfo(state.quick.urgency);
    const pill = $('#qa-urg');
    pill.textContent = lv.label;
    pill.className = `urg-pill u${state.quick.urgency}`;
    pill.title = `紧急度：${lv.label}（点击切换）`;
    const lbl = $('#qa-due-label');
    lbl.textContent = state.quick.dueAt != null ? U.fmtDueLabel(state.quick.dueAt) : '到期';
    $('#qa-due-btn').classList.toggle('has-due', state.quick.dueAt != null);
    const rlbl = $('#qa-recur-label');
    if (rlbl) {
      rlbl.textContent = state.quick.recur ? rec.labelOf(state.quick.recur) : '重复';
      $('#qa-recur-btn').classList.toggle('has-recur', !!state.quick.recur);
      $('#qa-recur-btn').title = state.quick.recur
        ? `重复频率：${rec.labelOf(state.quick.recur)}（点击更改）`
        : '设置重复频率（如每天签退）';
    }
  }

  function bindQuickAdd() {
    const input = $('#qa-input');
    const pill = $('#qa-urg');
    const dueBtn = $('#qa-due-btn');
    const recurBtn = $('#qa-recur-btn');

    pill.addEventListener('click', () => {
      state.quick.urgency = (state.quick.urgency + 1) % 4;
      updateQuickUI();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        quickAdd();
      }
    });

    // 快速新增框里直接粘贴图片：创建任务并展开详情贴图
    input.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const files = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type))
        .map((it) => it.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      const title = input.value.trim() || '图片任务';
      const t = addTask(title, { urgency: state.quick.urgency, dueAt: state.quick.dueAt, recur: state.quick.recur, groupId: resolveQuickGroup() });
      input.value = '';
      state.quick.dueAt = null;
      state.quick.recur = null;
      updateQuickUI();
      renderAll();
      expandTask(t.id, true);
      const editor = state.editors.get(t.id);
      if (editor) editor.insertFiles(files);
    });

    dueBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDuePopover(dueBtn, state.quick.dueAt, (at) => {
        state.quick.dueAt = at;
        updateQuickUI();
        closeDuePopover();
        input.focus();
      });
    });

    // 创建时直接设定重复频率（如每天 18:00 签退）
    if (recurBtn) {
      recurBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRecurPopover(recurBtn, state.quick.recur, (r) => {
          state.quick.recur = r;
          updateQuickUI();
          closeRecurPopover();
          input.focus();
        });
      });
    }

    // 自动聚焦
    setTimeout(() => input.focus(), 60);
  }

  function quickAdd() {
    const input = $('#qa-input');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const t = addTask(title, { urgency: state.quick.urgency, dueAt: state.quick.dueAt, recur: state.quick.recur, groupId: resolveQuickGroup() });
    input.value = '';
    state.quick.dueAt = null;
    state.quick.recur = null;
    updateQuickUI();
    renderAll();
    // 新任务高亮一瞬
    const el = $(`.task[data-id="${CSS.escape(t.id)}"]`);
    if (el) {
      el.classList.add('just-added');
      setTimeout(() => el.classList.remove('just-added'), 900);
    }
    input.focus();
  }

  /* ================= 到期时间弹出层（自绘日历 + 步进器） ================= */
  /**
   * 在锚点下方弹出到期时间选择层：快捷预设 + 迷你日历 + 时/分步进器。
   * @param {HTMLElement} anchor 锚点按钮
   * @param {number|null} current 当前到期时间
   * @param {(at:number|null)=>void} cb 选择回调
   */
  function toggleDuePopover(anchor, current, cb) {
    closeDuePopover();

    const init = new Date(current != null ? current : Date.now());
    if (current == null) { init.setHours(18, 0, 0, 0); }
    const st = {
      y: init.getFullYear(),          // 日历显示年
      m: init.getMonth(),            // 日历显示月
      selY: init.getFullYear(),      // 选中日期
      selM: init.getMonth(),
      selD: init.getDate(),
      h: init.getHours(),
      min: init.getMinutes() - (init.getMinutes() % 5)
    };

    const pop = document.createElement('div');
    pop.className = 'due-pop';
    document.body.appendChild(pop);

    function selTime() { return new Date(st.selY, st.selM, st.selD, st.h, st.min, 0, 0).getTime(); }

    function render() {
      const now = new Date();
      const isSelMonth = st.selY === st.y && st.selM === st.m;
      const first = new Date(st.y, st.m, 1);
      // 周一开头：JS getDay 周日=0 → 转成 周一=0
      const lead = (first.getDay() + 6) % 7;
      const daysInMonth = new Date(st.y, st.m + 1, 0).getDate();
      const daysPrev = new Date(st.y, st.m, 0).getDate();

      let cells = '';
      for (let i = 0; i < 42; i++) {
        const dayNum = i - lead + 1;
        let d, cls = 'dp-day', out = '';
        if (dayNum < 1) { d = dayNum + daysPrev; cls += ' out'; out = 'prev'; }
        else if (dayNum > daysInMonth) { d = dayNum - daysInMonth; cls += ' out'; out = 'next'; }
        else {
          d = dayNum;
          if (isSelMonth && d === st.selD) cls += ' sel';
          if (d === now.getDate() && st.m === now.getMonth() && st.y === now.getFullYear()) cls += ' today';
        }
        cells += `<button class="${cls}" data-d="${d}"${out ? ` data-out="${out}"` : ''}>${d}</button>`;
      }

      pop.innerHTML = `
        <div class="dp-presets">
          ${duePresets().map((p) => `<button class="dp-chip" data-at="${p.at}">${p.label}</button>`).join('')}
        </div>
        <div class="dp-cal">
          <div class="dp-nav">
            <button class="dp-nav-btn" data-nav="-1" title="上个月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>
            <span class="dp-title">${st.y}年${st.m + 1}月</span>
            <button class="dp-nav-btn" data-nav="1" title="下个月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>
          </div>
          <div class="dp-week">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span>${w}</span>`).join('')}</div>
          <div class="dp-grid">${cells}</div>
        </div>
        <div class="dp-time">
          <div class="dp-time-row">
            <div class="dp-stepper" data-unit="h">
              <button data-d="-1" title="减 1 小时">−</button><input class="dp-iv" data-unit="h" value="${U.pad2(st.h)}" inputmode="numeric" maxlength="2" autocomplete="off" title="直接输入小时（0-23）"><button data-d="1" title="加 1 小时">＋</button>
            </div>
            <span class="dp-colon">:</span>
            <div class="dp-stepper" data-unit="min">
              <button data-d="-1" title="减 5 分钟">−</button><input class="dp-iv" data-unit="min" value="${U.pad2(st.min)}" inputmode="numeric" maxlength="2" autocomplete="off" title="直接输入分钟（0-59）"><button data-d="1" title="加 5 分钟">＋</button>
            </div>
          </div>
          <div class="dp-quick-times">
            ${[9, 12, 18, 21].map((h) => `<button class="dp-tq" data-h="${h}" title="${U.pad2(h)}:00">${U.pad2(h)}:00</button>`).join('')}
          </div>
        </div>
        <div class="dp-actions">
          <button class="dp-act ghost" data-act="clear">清除到期</button>
          <button class="dp-act primary" data-act="ok">确定</button>
        </div>`;
    }

    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('button');
      if (!btn) return;

      if (btn.dataset.at != null) { cb(Number(btn.dataset.at)); closeDuePopover(); return; }
      if (btn.dataset.nav != null) {
        const nm = st.m + Number(btn.dataset.nav);
        st.y += Math.floor(nm / 12); st.m = ((nm % 12) + 12) % 12;
        render(); return;
      }
      if (btn.classList.contains('dp-day')) {
        const d = Number(btn.dataset.d);
        const out = btn.dataset.out;
        if (out === 'prev') { const nm = st.m - 1; st.y += Math.floor(nm / 12); st.m = ((nm % 12) + 12) % 12; }
        else if (out === 'next') { const nm = st.m + 1; st.y += Math.floor(nm / 12); st.m = ((nm % 12) + 12) % 12; }
        st.selY = st.y; st.selM = st.m; st.selD = d;
        render(); return;
      }
      if (btn.dataset.h != null) { st.h = Number(btn.dataset.h); st.min = 0; render(); return; }
      if (btn.dataset.d != null && btn.closest('.dp-stepper')) {
        const unit = btn.closest('.dp-stepper').dataset.unit;
        const delta = Number(btn.dataset.d);
        if (unit === 'h') st.h = (st.h + delta + 24) % 24;
        else st.min = (st.min + delta * 5 + 60) % 60;
        render(); return;
      }
      if (btn.dataset.act === 'clear') { cb(null); closeDuePopover(); return; }
      if (btn.dataset.act === 'ok') { cb(selTime()); closeDuePopover(); return; }
    });

    /* 时间可直接键入：聚焦全选覆盖，输入实时同步（不重渲染避免打断输入），
       失焦规范化（补零 / 越界钳制 / 空值回退），回车等价于「确定」 */
    pop.addEventListener('focusin', (e) => {
      const iv = e.target.closest('.dp-iv');
      if (iv) requestAnimationFrame(() => iv.select());
    });

    pop.addEventListener('input', (e) => {
      const iv = e.target.closest('.dp-iv');
      if (!iv) return;
      const unit = iv.dataset.unit;
      const max = unit === 'h' ? 23 : 59;
      const v = parseInt(iv.value.replace(/\D/g, ''), 10);
      if (Number.isNaN(v)) return; // 清空等中间态：保留内存原值，失焦时回退
      if (unit === 'h') st.h = Math.min(v, max);
      else st.min = Math.min(v, max);
    });

    pop.addEventListener('focusout', (e) => {
      const iv = e.target.closest('.dp-iv');
      if (!iv) return;
      const unit = iv.dataset.unit;
      const max = unit === 'h' ? 23 : 59;
      const cur = unit === 'h' ? st.h : st.min;
      let v = parseInt(iv.value.replace(/\D/g, ''), 10);
      if (Number.isNaN(v)) v = cur; // 空 / 非法输入回退原值
      v = Math.max(0, Math.min(v, max));
      if (unit === 'h') st.h = v; else st.min = v;
      // 只规范化自身显示，不重渲染整个弹层——焦点切到其他控件时若
      // 重建 DOM，紧随其后的 click（如选中日期、点确定）会因 target
      // 被移除而丢失
      iv.value = U.pad2(v);
    });

    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const iv = e.target.closest('.dp-iv');
      if (!iv) return;
      e.preventDefault();
      iv.blur(); // 触发失焦规范化同步
      cb(selTime());
      closeDuePopover();
    });

    render();
    requestAnimationFrame(() => positionPopover(pop, anchor));
  }

  function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom + 6}px`;
  }

  function closeDuePopover() {
    $$('.due-pop').forEach((p) => p.remove());
  }

  /* ================= 分组弹出层 ================= */
  /** 分组选择器：把任务加入哪个分组（未分组 / 各分组 / 新建） */
  function toggleGroupPicker(anchor, current, cb) {
    closeGroupPopover();
    const pop = document.createElement('div');
    pop.className = 'g-pop';
    document.body.appendChild(pop);

    function render() {
      pop.innerHTML = `
        <button class="g-opt${current == null ? ' cur' : ''}" data-gid="">
          <span class="g-opt-dot none"></span>未分组
          ${ICON.check}
        </button>
        ${groups().map((g) => `
          <button class="g-opt${current === g.id ? ' cur' : ''}" data-gid="${g.id}" style="--g-color:${g.color}">
            <span class="g-opt-dot"></span>${esc(g.name)}<span class="g-opt-count">${groupCount(g.id)}</span>
            ${ICON.check}
          </button>`).join('')}
        <div class="g-pop-new">
          <input type="text" maxlength="16" placeholder="新建分组，回车确认" data-g-new>
          <button class="g-new-btn" data-g-add title="创建">${ICON.plus}</button>
        </div>`;
    }

    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const addBtn = e.target.closest('[data-g-add]');
      if (addBtn) {
        const input = $('[data-g-new]', pop);
        if (input && input.value.trim()) { const g = makeGroup(input.value.trim()); cb(g.id); renderAll(); closeGroupPopover(); }
        return;
      }
      const opt = e.target.closest('.g-opt');
      if (opt) {
        cb(opt.dataset.gid || null);
        renderAll();
        closeGroupPopover();
      }
    });

    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target.closest('[data-g-new]');
      if (!input) return;
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const g = makeGroup(name);
      cb(g.id);
      renderAll();
      closeGroupPopover();
    });

    render();
    requestAnimationFrame(() => {
      positionPopover(pop, anchor);
      const input = $('[data-g-new]', pop);
      if (input) input.focus({ preventScroll: true });
    });
  }

  /* ================= 重复频率弹出层 ================= */
  /**
   * 重复频率选择器：不重复 / 每天 / 工作日 / 每周 / 每月 / 自定义每 N 天。
   * @param {HTMLElement} anchor 锚点按钮
   * @param {object|null} current 当前 recur
   * @param {(recur:object|null)=>void} cb 选择回调
   */
  function toggleRecurPopover(anchor, current, cb) {
    closeRecurPopover();
    const pop = document.createElement('div');
    pop.className = 'r-pop';
    document.body.appendChild(pop);
    let every = current && current.kind === 'interval' ? (current.every || 2) : 2;

    function render() {
      const isCur = (k) => current && current.kind === k;
      pop.innerHTML = `
        <button class="r-opt${!current ? ' cur' : ''}" data-r="">
          <span class="r-opt-ico">${ICON.repeatOff}</span><span class="r-opt-name">不重复</span>${ICON.check}
        </button>
        <div class="r-sep"></div>
        ${rec.KINDS.filter((k) => k.kind !== 'interval').map((k) => `
          <button class="r-opt${isCur(k.kind) ? ' cur' : ''}" data-r="${k.kind}">
            <span class="r-opt-ico">${ICON.repeat}</span><span class="r-opt-name">${k.label}</span>${ICON.check}
          </button>`).join('')}
        <div class="r-sep"></div>
        <div class="r-custom${isCur('interval') ? ' cur' : ''}">
          <div class="r-custom-row">
            <span class="r-opt-ico">${ICON.repeat}</span>
            <span class="r-opt-name">每</span>
            <span class="dp-stepper r-iv-stepper" data-unit="iv">
              <button data-d="-1" title="减 1 天">−</button><b>${every}</b><button data-d="1" title="加 1 天">＋</button>
            </span>
            <span class="r-opt-name">天一次</span>
          </div>
          <button class="r-iv-ok${isCur('interval') && current.every === every ? ' same' : ''}" data-iv-ok>设为此频率</button>
        </div>`;
    }

    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const step = e.target.closest('.r-iv-stepper button');
      if (step) {
        every = Math.min(365, Math.max(2, every + Number(step.dataset.d)));
        render();
        return;
      }
      if (e.target.closest('[data-iv-ok]')) {
        cb({ kind: 'interval', every });
        closeRecurPopover();
        return;
      }
      const opt = e.target.closest('.r-opt');
      if (opt) {
        // data-r 为字符串 kind（'' = 不重复），统一包装成对象再回调，
        // 否则 normalize 会把字符串当非法值丢弃，重复设置静默失效
        cb(opt.dataset.r ? { kind: opt.dataset.r } : null);
        closeRecurPopover();
      }
    });

    render();
    requestAnimationFrame(() => positionPopover(pop, anchor));
  }

  function closeRecurPopover() {
    $$('.r-pop').forEach((p) => p.remove());
  }

  /** 分组管理器：新建 / 重命名 / 删除 */
  function toggleGroupManager(anchor) {
    closeGroupPopover();
    const pop = document.createElement('div');
    pop.className = 'g-pop manage';
    document.body.appendChild(pop);

    function render() {
      pop.innerHTML = `
        <div class="g-pop-new">
          <input type="text" maxlength="16" placeholder="新建分组，回车确认" data-g-new>
          <button class="g-new-btn" data-g-add title="创建">${ICON.plus}</button>
        </div>
        ${groups().length ? `<div class="g-man-list">` : '<p class="g-man-empty">还没有分组</p>'}
        ${groups().map((g) => `
          <div class="g-man-row" data-gid="${g.id}" style="--g-color:${g.color}">
            <span class="g-opt-dot"></span>
            <span class="g-man-name" title="双击重命名">${esc(g.name)}</span>
            <span class="g-opt-count">${groupCount(g.id)}</span>
            <button class="g-man-del" data-del="${g.id}" title="删除分组（任务移入未分组）">${ICON.trash}</button>
          </div>`).join('')}
        ${groups().length ? '</div>' : ''}`;
    }

    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const addBtn = e.target.closest('[data-g-add]');
      if (addBtn) {
        const input = $('[data-g-new]', pop);
        if (input && input.value.trim()) { makeGroup(input.value.trim()); renderAll(); render(); }
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) { deleteGroup(del.dataset.del); render(); return; }
    });

    pop.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('.g-man-name');
      if (!nameEl) return;
      const row = nameEl.closest('.g-man-row');
      const gid = row.dataset.gid;
      const g = findGroup(gid);
      if (!g) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = g.name;
      input.maxLength = 16;
      input.className = 'g-man-rename';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const v = input.value.trim();
        if (v && v !== g.name) { renameGroup(gid, v); renderAll(); }
        render();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') render();
      });
    });

    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.closest('[data-g-new]')) return;
      e.preventDefault();
      const input = $('[data-g-new]', pop);
      const name = input.value.trim();
      if (!name) return;
      makeGroup(name);
      renderAll();
      render();
    });

    render();
    requestAnimationFrame(() => {
      positionPopover(pop, anchor);
      const input = $('[data-g-new]', pop);
      if (input) input.focus({ preventScroll: true });
    });
  }

  function closeGroupPopover() {
    $$('.g-pop').forEach((p) => p.remove());
  }

  function bindGroupsBar() {
    $('#groups-bar').addEventListener('click', (e) => {
      const chip = e.target.closest('.g-chip');
      if (!chip) return;
      if (chip.dataset.g === '__manage') { toggleGroupManager(chip); return; }
      state.activeGroup = chip.dataset.g || 'all';
      state.quick.groupOverride = null; // 回到跟随视图
      renderGroups();
      renderList();
    });
  }

  function bindQuickGroup() {
    $('#qa-group').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGroupPicker(e.currentTarget, resolveQuickGroup(), (gid) => {
        state.quick.groupOverride = gid == null ? 'none' : gid;
        updateQuickGroupUI();
      });
    });
  }

  /* ================= 列表事件（委托） ================= */

  /** 双击标题 → 行内重命名。Enter/失焦保存，Esc 取消；期间置 editing 暂缓后台刷新覆盖输入框 */
  function beginTitleEdit(titleEl, t) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-title-input';
    input.value = t.title;
    input.maxLength = 500;
    input.autocomplete = 'off';
    input.spellcheck = false;
    titleEl.replaceWith(input);

    state.editing = true;
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const changed = save && renameTask(t.id, input.value);

      // 原地换回 h3：不重建兄弟节点，紧随 blur 的那一次点击（如勾选完成）不会被吞掉
      const h = document.createElement('h3');
      h.className = 'task-title';
      h.title = '双击重命名';
      h.textContent = t.title; // renameTask 成功时已是新名；取消 / 空值时保持原值
      input.replaceWith(h);

      state.editing = false;
      // 排序与统计都不依赖标题，无需整表重渲染；仅当筛选词不再匹配时才需要移除该卡片（稍延迟让点击先落地）
      const f = state.filter.trim().toLowerCase();
      if (f && !(t.title.toLowerCase().includes(f) || U.stripHtml(t.detailHtml).toLowerCase().includes(f))) {
        setTimeout(renderList, 180);
      } else if (state.pendingExternalDoc) {
        adoptPendingExternal(); // 改名期间收到外部数据，编辑结束后采纳
      }
      if (changed) showToast('已重命名', { duration: 1800 });
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
  }

  function bindListEvents() {
    $('#task-list').addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-act="toggle"]');
      if (toggleBtn) { completeToggle(toggleBtn.closest('.task').dataset.id); return; }

      const delBtn = e.target.closest('[data-act="delete"]');
      if (delBtn) { deleteTask(delBtn.closest('.task').dataset.id); return; }

      const urgBtn = e.target.closest('.urg-opt');
      if (urgBtn) {
        const id = urgBtn.closest('.task').dataset.id;
        const t = findTask(id);
        if (t) {
          t.urgency = urg.clampUrgency(urgBtn.dataset.urg);
          t.updatedAt = Date.now();
          persist();
          renderList();
        }
        return;
      }

      const dueBtn = e.target.closest('[data-act="due-edit"]');
      if (dueBtn) {
        const id = dueBtn.closest('.task').dataset.id;
        const t = findTask(id);
        if (t) {
          toggleDuePopover(dueBtn, t.dueAt, (at) => {
            t.dueAt = at;
            t.notifiedDue = false;
            t.updatedAt = Date.now();
            persist();
            renderList();
          });
        }
        return;
      }

      const recurBtn = e.target.closest('[data-act="recur-edit"]');
      if (recurBtn) {
        const id = recurBtn.closest('.task').dataset.id;
        const t = findTask(id);
        if (t) {
          toggleRecurPopover(recurBtn, t.recur, (r) => {
            t.recur = r;
            if (!r) { t.streak = 0; t.lastDoneAt = null; t.lastDoneOccur = null; } // 停止重复：清理打卡痕迹
            t.updatedAt = Date.now();
            persist();
            renderList();
          });
        }
        return;
      }

      const grpBtn = e.target.closest('[data-act="group-edit"]');
      if (grpBtn) {
        const id = grpBtn.closest('.task').dataset.id;
        const t = findTask(id);
        if (t) {
          toggleGroupPicker(grpBtn, t.groupId, (gid) => {
            t.groupId = gid;
            t.updatedAt = Date.now();
            persist();
            renderGroups();
            renderList();
          });
        }
        return;
      }

      const head = e.target.closest('[data-act="expand"]');
      if (head) {
        const id = head.closest('.task').dataset.id;
        if (state.expandedId === id) collapseTask(); else expandTask(id, false);
        return;
      }

      // 图片点击放大（编辑器内外均可）
      const img = e.target.closest('img.ink-img');
      if (img) { e.preventDefault(); openLightbox(img.getAttribute('src') || Storage.imageUrl(img.getAttribute('data-ink-img'))); }
    });

    // 双击任务标题 → 行内重命名（待办 / 已完成均可）
    $('#task-list').addEventListener('dblclick', (e) => {
      const titleEl = e.target.closest('.task-title');
      if (!titleEl) return;
      const taskEl = titleEl.closest('.task');
      const t = taskEl && findTask(taskEl.dataset.id);
      if (!t) return;
      e.preventDefault();
      beginTitleEdit(titleEl, t);
    });
  }

  function bindFooter() {
    $('#btn-show-done').addEventListener('click', async () => {
      state.settings.showCompleted = !state.settings.showCompleted;
      try { await Storage.saveSettings(state.settings); } catch (_) { /* */ }
      renderList();
    });
    $('#btn-clear-done').addEventListener('click', clearCompleted);
  }

  /* ================= 标题栏 ================= */
  function bindTitlebar() {
    $('#btn-pin').addEventListener('click', async () => {
      if (Storage.isElectron) {
        const pinned = await window.inktask.togglePin();
        setPinUI(pinned);
      } else {
        state.pinLocal = !state.pinLocal;
        setPinUI(state.pinLocal);
        showToast(state.pinLocal ? '已置顶（浏览器预览仅为视觉演示）' : '已取消置顶');
      }
    });
    $('#btn-min').addEventListener('click', () => {
      if (Storage.isElectron) window.inktask.minimizeWindow();
    });
    $('#btn-hide').addEventListener('click', () => {
      if (Storage.isElectron) window.inktask.hideWindow();
      else showToast('Electron 中此按钮会隐藏到托盘');
    });
    $('#btn-search').addEventListener('click', toggleSearch);
    $('#btn-settings').addEventListener('click', openSettings);
  }

  function setPinUI(pinned) {
    $('#btn-pin').classList.toggle('active', !!pinned);
    $('#btn-pin').title = pinned ? '已置顶 · 点击取消 (Ctrl+Shift+P)' : '窗口置顶 (Ctrl+Shift+P)';
  }

  function toggleSearch() {
    const bar = $('#search-bar');
    const input = $('#search-input');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) input.focus();
    else { input.value = ''; state.filter = ''; renderList(); }
  }

  function bindSearchInput() {
    const input = $('#search-input');
    input.addEventListener('input', () => { state.filter = input.value; renderList(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; state.filter = ''; toggleSearch(); }
    });
  }

  /* ================= 灯箱（图片放大） ================= */
  function openLightbox(src) {
    if (!src) return;
    const lb = $('#lightbox');
    $('img', lb).src = src;
    lb.classList.remove('hidden');
  }

  function bindLightbox() {
    const lb = $('#lightbox');
    lb.addEventListener('click', () => lb.classList.add('hidden'));
    const img = $('img', lb);
    img.addEventListener('click', (e) => e.stopPropagation());
    let scale = 1;
    img.addEventListener('wheel', (e) => {
      e.preventDefault();
      scale = Math.max(0.3, Math.min(5, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
      img.style.transform = `scale(${scale})`;
    }, { passive: false });
    new MutationObserver(() => { scale = 1; img.style.transform = ''; })
      .observe(lb, { attributes: true, attributeFilter: ['class'] });
  }

  /* ================= Toast ================= */
  function showToast(msg, opts) {
    opts = opts || {};
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>`;
    if (opts.actionLabel) {
      const btn = document.createElement('button');
      btn.className = 'toast-act';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', () => { dismiss(); opts.onAction && opts.onAction(); });
      el.appendChild(btn);
    }
    box.appendChild(el);
    const dismiss = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    };
    setTimeout(dismiss, opts.duration || 5000);
  }

  /* ================= 设置面板 ================= */
  function openSettings() {
    const m = $('#modal-settings');
    fillSettingsForm();
    m.classList.remove('hidden');
  }

  function closeSettings() {
    $('#modal-settings').classList.add('hidden');
    $('#hk-error').classList.add('hidden');
  }

  function fillSettingsForm() {
    const s = state.settings;
    $('#hk-toggle').value = s.hotkeys.toggle || '';
    $('#hk-pin').value = s.hotkeys.pin || '';
    $('#set-autostart').checked = !!s.autoStart;
    $('#set-blurhide').checked = !!s.blurHide;
    $('#set-notify').checked = !!s.notifyDue;
    $('#set-showdone').checked = !!s.showCompleted;
    $$('#modal-settings .swatch').forEach((b) => b.classList.toggle('active', b.dataset.accent === s.accent));
    $('#ver').textContent = state.appInfo.version || '-';
    const dir = state.appInfo.dataDir || state.appInfo.userData || '本机';
    $('#data-path').textContent = `数据目录：${dir}`;
    $('#btn-reset-dir').classList.toggle('hidden', !state.appInfo.dataDirCustom);
    const warn = $('#data-dir-warning');
    if (state.appInfo.dataDirWarning) {
      warn.textContent = state.appInfo.dataDirWarning;
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
  }

  /** 数据目录切换后：拉取新数据/设置/路径信息并整体刷新（编辑中则放弃未保存的外部覆盖） */
  async function reloadFromMain() {
    state.pendingExternalDoc = null;
    state.doc = await Storage.getDoc();
    state.settings = { ...state.settings, ...(await Storage.getSettings()) };
    state.appInfo = await Storage.getAppInfo();
    applyAccent();
    renderAll();
  }

  function accelFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let key = '';
    const c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
    else if (/^Digit\d$/.test(c)) key = c.slice(5);
    else if (/^Numpad\d$/.test(c)) key = c.slice(6);
    else if (/^F\d{1,2}$/.test(c)) key = c;
    else if (c === 'Space') key = 'Space';
    else if (/^Arrow(Up|Down|Left|Right)$/.test(c)) key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[c];
    else if (c === 'PageUp' || c === 'PageDown') key = c;
    if (!mods.length || !key) return null;
    return `${mods.join('+')}+${key}`;
  }

  function bindHotkeyInput(input) {
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { input.value = input.dataset.orig || ''; input.blur(); return; }
      const accel = accelFromEvent(e);
      if (!accel) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 350); return; }
      input.value = accel;
      input.blur();
    });
    input.addEventListener('focus', () => { input.dataset.orig = input.value; });
  }

  function bindSettings() {
    $('#modal-settings').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target.classList.contains('modal-mask')) closeSettings();
    });

    bindHotkeyInput($('#hk-toggle'));
    bindHotkeyInput($('#hk-pin'));

    $('#btn-save-settings').addEventListener('click', async () => {
      const next = {
        ...state.settings,
        hotkeys: {
          toggle: $('#hk-toggle').value.trim(),
          pin: $('#hk-pin').value.trim()
        },
        autoStart: $('#set-autostart').checked,
        blurHide: $('#set-blurhide').checked,
        notifyDue: $('#set-notify').checked,
        showCompleted: $('#set-showdone').checked,
        accent: state.settings.accent
      };
      if (next.hotkeys.toggle && next.hotkeys.pin && next.hotkeys.toggle === next.hotkeys.pin) {
        const errEl = $('#hk-error');
        errEl.textContent = '两个快捷键不能相同';
        errEl.classList.remove('hidden');
        return;
      }
      const res = await Storage.saveSettings(next);
      if (res && res.ok === false) {
        const errEl = $('#hk-error');
        errEl.textContent = (res.errors || []).join('；');
        errEl.classList.remove('hidden');
        if (res.settings) state.settings = { ...state.settings, ...res.settings };
        fillSettingsForm();
        return;
      }
      state.settings = { ...state.settings, ...(res.settings || next) };
      applyAccent();
      renderList();
      closeSettings();
      showToast('设置已保存');
    });

    $$('#modal-settings .swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#modal-settings .swatch').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.settings.accent = btn.dataset.accent;
        applyAccent();
      });
    });

    $('#btn-export').addEventListener('click', async () => {
      await Storage.flush();
      const res = await Storage.exportBackup();
      if (res && res.saved) showToast(`已导出 ${res.count || ''} 项任务到备份文件`);
      else if (res && res.unsupported) showToast('浏览器预览不支持导出，请在应用中使用');
    });

    $('#btn-import').addEventListener('click', async () => {
      const res = await Storage.importBackup();
      if (!res || res.canceled) return;
      if (res.ok === false) { showToast(res.error || '导入失败'); return; }
      showToast(`导入完成：新增 ${res.added} 项，更新 ${res.updated} 项，图片 ${res.imagesRestored} 张`);
    });

    /* ---- 自定义数据目录 ---- */
    $('#btn-change-dir').addEventListener('click', async () => {
      await Storage.flush(); // 先落盘当前数据，避免切目录后旧队列覆盖新目录
      const res = await Storage.changeDataDir();
      if (!res || res.canceled || res.same || res.unsupported) {
        if (res && res.unsupported) showToast('浏览器预览不支持自定义数据目录');
        return;
      }
      if (res.ok === false) { showToast(res.error || '切换失败'); return; }
      await reloadFromMain();
      fillSettingsForm();
      showToast(res.migrated ? `已切换数据目录并迁移：${U.truncate(res.dataDir, 34)}` : `已切换数据目录：${U.truncate(res.dataDir, 34)}`);
    });

    $('#btn-reset-dir').addEventListener('click', async () => {
      await Storage.flush();
      const res = await Storage.resetDataDir();
      if (!res || res.canceled || res.same || res.unsupported) return;
      if (res.ok === false) { showToast(res.error || '切换失败'); return; }
      await reloadFromMain();
      fillSettingsForm();
      showToast(res.migrated ? `已恢复默认目录并迁移：${U.truncate(res.dataDir, 34)}` : `已恢复默认目录`);
    });
  }

  function applyAccent() {
    document.body.dataset.accent = state.settings.accent || 'gold';
  }

  /* ================= 主进程事件 ================= */
  function listenMain() {
    if (!Storage.isElectron || !window.inktask) return;
    window.inktask.on('pin-changed', (v) => setPinUI(v));
    window.inktask.on('tasks-changed', (doc) => {
      if (state.editing) state.pendingExternalDoc = doc;
      else adoptExternal(doc);
    });
    window.inktask.on('action', (a) => {
      if (a === 'new-task') {
        showSelf();
        $('#qa-input').focus();
      } else if (a === 'pin-on' || a === 'pin-off') {
        showToast(a === 'pin-on' ? '窗口已置顶' : '已取消置顶');
      } else if (a === 'close-hint') {
        let shown = false;
        try { shown = localStorage.getItem('inktask.closeHint') === '1'; } catch (_) { /* */ }
        if (!shown) {
          showToast('已隐藏到托盘，Ctrl+Shift+Space 可随时呼出', { duration: 6500 });
          try { localStorage.setItem('inktask.closeHint', '1'); } catch (_) { /* */ }
        }
      } else if (typeof a === 'string' && a.startsWith('data-migrated:')) {
        showToast(`默认数据目录已改为程序目录下的 data 文件夹，原 ${U.truncate(a.slice('data-migrated:'.length), 30)} 的数据已自动迁移`, { duration: 6500 });
      } else if (typeof a === 'string' && a.startsWith('focus-task:')) {
        const id = a.slice('focus-task:'.length);
        if (findTask(id)) {
          showSelf();
          expandTask(id, false);
          const el = $(`.task[data-id="${CSS.escape(id)}"]`);
          if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
        }
      }
    });
    window.inktask.getPin().then((p) => setPinUI(p)).catch(() => { /* */ });
  }

  function showSelf() {
    // 主进程负责 show/focus，这里仅处理面板内逻辑
  }

  function adoptExternal(doc) {
    if (!doc || !Array.isArray(doc.tasks)) return;
    state.doc = doc;
    renderAll();
  }

  function adoptPendingExternal() {
    if (state.pendingExternalDoc) {
      const doc = state.pendingExternalDoc;
      state.pendingExternalDoc = null;
      adoptExternal(doc);
    }
  }

  /* ================= 全局键盘 ================= */
  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#lightbox').classList.contains('hidden')) { $('#lightbox').classList.add('hidden'); return; }
        if (!$('#modal-settings').classList.contains('hidden')) { closeSettings(); return; }
        if ($('.g-pop')) { closeGroupPopover(); return; }
        if ($('.r-pop')) { closeRecurPopover(); return; }
        if ($('.due-pop')) { closeDuePopover(); return; }
        if (!$('#search-bar').classList.contains('hidden')) toggleSearch();
        else if (state.expandedId) collapseTask();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if ($('#search-bar').classList.contains('hidden')) toggleSearch();
      }
    });
    // 点击空白处关闭弹层
    document.addEventListener('mousedown', (e) => {
      const inPop = e.target.closest('.due-pop') || e.target.closest('.g-pop') || e.target.closest('.r-pop');
      const inAnchor = e.target.closest('[data-act="due-edit"]') || e.target.closest('[data-act="group-edit"]') || e.target.closest('[data-act="recur-edit"]')
        || e.target.closest('#qa-due-btn') || e.target.closest('#qa-recur-btn') || e.target.closest('#qa-group') || e.target.closest('.g-chip');
      if (inPop || inAnchor) return;
      closeDuePopover();
      closeGroupPopover();
      closeRecurPopover();
    });
    window.addEventListener('beforeunload', () => { Storage.flush(); });
  }

  /* ================= 启动 ================= */
  async function init() {
    state.doc = await Storage.getDoc();
    const settings = await Storage.getSettings();
    state.settings = { ...state.settings, ...settings };
    state.appInfo = await Storage.getAppInfo();
    applyAccent();
    updateQuickUI();
    bindQuickAdd();
    bindQuickGroup();
    bindGroupsBar();
    bindListEvents();
    bindTitlebar();
    bindFooter();
    bindSearchInput();
    bindSettings();
    bindLightbox();
    bindGlobalKeys();
    listenMain();
    // 启动即复活：应用未运行期间跨过复活点的重复任务回到待办
    if (rec.refreshAll(tasks(), Date.now())) persist();
    renderAll();
    setInterval(updateCountdowns, 20000);
    // 周期复活巡检：已完成重复任务到下一周期所在日 0 点自动回到待办
    setInterval(refreshRecurring, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshRecurring();
    });
    window.addEventListener('focus', () => refreshRecurring());
    if (Storage.isElectron && window.inktask) {
      window.inktask.getPin().then(setPinUI).catch(() => { /* */ });
    }
    // 浏览器预览：?demo=1 注入示例数据
    if (!Storage.isElectron && /[?&]demo=1/.test(location.search)) seedDemo();
  }

  function seedDemo() {
    if (tasks().length) return;
    const now = Date.now();
    const H = 3600000;
    const gWork = makeGroup('工作');
    const gLife = makeGroup('生活');
    // 每日签退：本周期到期 = 最近的 18:00（已过则为明天）
    const signOut = new Date(now);
    signOut.setHours(18, 0, 0, 0);
    if (signOut.getTime() <= now) signOut.setDate(signOut.getDate() + 1);
    const signDue = signOut.getTime();
    state.doc.tasks = [
      { id: U.uuid(), title: '回复客户报价邮件', detailHtml: '<p>报价单见截图，抄送王经理</p>', urgency: 3, dueAt: now + 1.5 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 3 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '项目周会材料', detailHtml: '<p>整理本周进展 + 风险清单</p>', urgency: 2, dueAt: now + 26 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 5 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '季度报表核对', detailHtml: '<p>核对 Q3 数字</p>', urgency: 1, dueAt: now - 2 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 26 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '下班签退', detailHtml: '<p>每天 18:00 下班打卡签退；完成后进入已完成，第二天自动回来</p>', urgency: 1, dueAt: signDue, groupId: gWork.id, recur: { kind: 'daily' }, streak: 4, lastDoneAt: signDue - 24 * H + 30 * 60000, lastDoneOccur: signDue - 24 * H, completed: false, completedAt: null, createdAt: now - 5 * 24 * 3600000, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '预订团建餐厅', detailHtml: '', urgency: 1, dueAt: now + 5 * 24 * 3600000, groupId: gLife.id, completed: false, completedAt: null, createdAt: now - 24 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '买咖啡豆', detailHtml: '', urgency: 0, dueAt: null, groupId: gLife.id, completed: false, completedAt: null, createdAt: now - 30 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '整理桌面文件', detailHtml: '', urgency: 1, dueAt: null, groupId: null, completed: true, completedAt: now - 4 * H, createdAt: now - 28 * H, updatedAt: now - 4 * H, notifiedDue: false }
    ];
    persist();
    renderAll();
  }

  /* ================= 图标 ================= */
  const ICON = {
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.8l3 1.8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M20.5 6H8.5A5 5 0 0 0 3.5 11v1"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M3.5 18h12a5 5 0 0 0 5-5v-1"/></svg>',
    repeatOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M20.5 6H8.5A5 5 0 0 0 3.5 11v1"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M3.5 18h12a5 5 0 0 0 5-5v-1"/><path d="M4 4l16 16" class="r-slash"/></svg>'
  };

  init();
})();
