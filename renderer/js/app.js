/* global window, document, Storage, DetailEditor, Util, Urgency */
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
    quick: { urgency: 1, dueAt: null, groupOverride: null }, // null=跟随当前视图
    pinLocal: false
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
    t.completed = !t.completed;
    t.completedAt = t.completed ? Date.now() : null;
    t.updatedAt = Date.now();
    if (!t.completed) t.notifiedDue = false;
    persist();
    renderAll();
  }

  /** 带撤销的删除（5 秒内可恢复，图片 GC 在主进程延迟执行，不会误删） */
  function deleteTask(id) {
    const idx = tasks().findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [t] = tasks().splice(idx, 1);
    if (state.expandedId === id) state.expandedId = null;
    persist();
    renderAll();
    showToast(`已删除「${U.truncate(t.title, 14)}」`, {
      actionLabel: '撤销',
      onAction: () => { tasks().push(t); persist(); renderAll(); }
    });
  }

  function clearCompleted() {
    const removed = tasks().filter((t) => t.completed);
    if (!removed.length) return;
    state.doc.tasks = tasks().filter((t) => !t.completed);
    persist();
    renderAll();
    showToast(`已清除 ${removed.length} 项已完成`, {
      actionLabel: '撤销',
      onAction: () => { state.doc.tasks.push(...removed); persist(); renderAll(); }
    });
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

    return `
<article class="task u${t.urgency}${overdue ? ' is-overdue' : ''}${open ? ' open' : ''}" data-id="${t.id}">
  <span class="rail" ${grp ? `style="background:${grp.color}"` : ''}></span>
  <button class="check" data-act="toggle" title="完成 / 取消完成" aria-label="完成"></button>
  <div class="task-main">
    <div class="task-head" data-act="expand">
      <div class="title-wrap">
        <h3 class="task-title">${esc(t.title)}</h3>
        <div class="task-meta">
          <span class="urg-chip u${t.urgency}">${level.label}</span>
          ${grp ? `<span class="grp-chip" style="--g-color:${grp.color}">${esc(grp.name)}</span>` : ''}
          ${t.dueAt != null ? `<span class="due-chip">${esc(U.fmtDueLabel(t.dueAt))}</span>` : ''}
          ${nImg > 0 ? `<span class="img-chip">${ICON.image}${nImg}</span>` : ''}
          ${excerpt}
        </div>
      </div>
      <div class="task-side">
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
    return `
<div class="detail-controls">
  <div class="urg-selector" data-act="urg-selector">
    ${urg.LEVELS.map((lv, i) => `<button data-urg="${i}" class="urg-opt u${i}${i === t.urgency ? ' active' : ''}">${lv.label}</button>`).join('')}
  </div>
  <button class="due-edit-btn" data-act="due-edit">${ICON.clock}<span>${esc(dueLabel)}</span></button>
  <button class="grp-edit-btn${grp ? ' has' : ''}" data-act="group-edit"${grp ? ` style="--g-color:${grp.color}"` : ''} title="移动到分组">
    <span class="grp-edit-dot"></span><span>${grp ? esc(grp.name) : '分组'}</span>
  </button>
  <span class="flex-fill"></span>
  <span class="created-at" title="创建时间">建于 ${created}</span>
  <button class="icon-btn danger" data-act="delete" title="删除任务">${ICON.trash}</button>
</div>
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
  <button class="check checked" data-act="toggle" title="取消完成"></button>
  <div class="task-main">
    <div class="task-head">
      <div class="title-wrap">
        <h3 class="task-title">${esc(t.title)}</h3>
        <div class="task-meta">
          ${t.dueAt != null ? `<span class="due-chip">${esc(U.fmtDueLabel(t.dueAt))}</span>` : ''}
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
  }

  function bindQuickAdd() {
    const input = $('#qa-input');
    const pill = $('#qa-urg');
    const dueBtn = $('#qa-due-btn');

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
      const t = addTask(title, { urgency: state.quick.urgency, dueAt: state.quick.dueAt, groupId: resolveQuickGroup() });
      input.value = '';
      state.quick.dueAt = null;
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

    // 自动聚焦
    setTimeout(() => input.focus(), 60);
  }

  function quickAdd() {
    const input = $('#qa-input');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const t = addTask(title, { urgency: state.quick.urgency, dueAt: state.quick.dueAt, groupId: resolveQuickGroup() });
    input.value = '';
    state.quick.dueAt = null;
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
          <div class="dp-stepper" data-unit="h">
            <button data-d="-1" title="减 1 小时">−</button><b>${U.pad2(st.h)}</b><button data-d="1" title="加 1 小时">＋</button>
          </div>
          <span class="dp-colon">:</span>
          <div class="dp-stepper" data-unit="min">
            <button data-d="-1" title="减 5 分钟">−</button><b>${U.pad2(st.min)}</b><button data-d="1" title="加 5 分钟">＋</button>
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
    $('#data-path').textContent = `数据目录：${state.appInfo.userData || '本机'}`;
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
      const inPop = e.target.closest('.due-pop') || e.target.closest('.g-pop');
      const inAnchor = e.target.closest('[data-act="due-edit"]') || e.target.closest('[data-act="group-edit"]')
        || e.target.closest('#qa-due-btn') || e.target.closest('#qa-group') || e.target.closest('.g-chip');
      if (inPop || inAnchor) return;
      closeDuePopover();
      closeGroupPopover();
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
    renderAll();
    setInterval(updateCountdowns, 20000);
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
    state.doc.tasks = [
      { id: U.uuid(), title: '回复客户报价邮件', detailHtml: '<p>报价单见截图，抄送王经理</p>', urgency: 3, dueAt: now + 1.5 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 3 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '项目周会材料', detailHtml: '<p>整理本周进展 + 风险清单</p>', urgency: 2, dueAt: now + 26 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 5 * H, updatedAt: now, notifiedDue: false },
      { id: U.uuid(), title: '季度报表核对', detailHtml: '<p>核对 Q3 数字</p>', urgency: 1, dueAt: now - 2 * H, groupId: gWork.id, completed: false, completedAt: null, createdAt: now - 26 * H, updatedAt: now, notifiedDue: false },
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
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  init();
})();
