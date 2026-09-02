/* global window, document, Storage */
/**
 * editor.js — 任务详情富文本编辑器
 *
 * 关键能力：剪贴板图片 **内嵌** 到详情正文（非附件）：
 *   - Ctrl+V：拦截 paste 事件的 image/* items
 *   - 拖放：dataTransfer.files 中的图片
 *   - 工具栏图片按钮：文件选择
 * 三条通道统一走 Storage.saveImage → 插入 <img data-ink-img="id">，
 * 通过白名单 sanitize 保证落盘 HTML 只含安全标签。
 */
(function (global) {
  'use strict';

  const ALLOWED_TAGS = new Set([
    'P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'UL', 'OL', 'LI', 'IMG', 'SPAN', 'CODE', 'PRE', 'H2', 'H3', 'H4', 'BLOCKQUOTE'
  ]);
  const IMG_ID_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp|bmp)$/i;

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function extOf(file) {
    const t = String(file.type || 'image/png');
    return (t.split('/')[1] || 'png').replace('jpeg', 'jpg');
  }

  class DetailEditor {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.mount      挂载容器（编辑器内部结构会填入）
     * @param {string} opts.html            初始（已 sanitize 过的）HTML
     * @param {(html:string)=>void} opts.onChange 内容变更回调（已防抖、已 sanitize）
     * @param {(editing:boolean)=>void} opts.onFocusChange 编辑焦点变化
     */
    constructor(opts) {
      this.mount = opts.mount;
      this.onChange = opts.onChange || (() => {});
      this.onFocusChange = opts.onFocusChange || (() => {});
      this._notify = opts.debounceMs == null ? 600 : opts.debounceMs;
      this._boundPaste = this._onPaste.bind(this);
      this._boundDrop = this._onDrop.bind(this);
      this._boundInput = this._scheduleNotify.bind(this);
      this._boundFocus = () => this.onFocusChange(true);
      this._boundBlur = () => { this._flushNotify(); this.onFocusChange(false); };
      this._build();
      this.setHTML(opts.html || '');
    }

    _build() {
      this.mount.classList.add('ink-editor');
      this.mount.innerHTML = [
        '<div class="ink-editor-toolbar">',
        '  <button type="button" data-cmd="bold" title="加粗 (Ctrl+B)"><b>B</b></button>',
        '  <button type="button" data-cmd="italic" title="斜体 (Ctrl+I)"><i>I</i></button>',
        '  <button type="button" data-cmd="underline" title="下划线 (Ctrl+U)"><u>U</u></button>',
        '  <button type="button" data-cmd="strikeThrough" title="删除线"><s>S</s></button>',
        '  <span class="ink-tb-sep"></span>',
        '  <button type="button" data-cmd="insertUnorderedList" title="无序列表">•≡</button>',
        '  <button type="button" data-cmd="insertOrderedList" title="有序列表">1≡</button>',
        '  <span class="ink-tb-sep"></span>',
        '  <button type="button" data-act="image" title="插入图片（也可以直接 Ctrl+V 粘贴）">🖼</button>',
        '  <button type="button" data-cmd="removeFormat" title="清除格式">⌫格式</button>',
        '</div>',
        '<div class="ink-editor-body" contenteditable="true" spellcheck="false"',
        '     data-placeholder="任务详情… 支持 Ctrl+V 粘贴剪贴板图片、拖入图片文件"></div>',
        '<input type="file" accept="image/*" multiple hidden class="ink-editor-file">'
      ].join('');

      this.toolbar = this.mount.querySelector('.ink-editor-toolbar');
      this.body = this.mount.querySelector('.ink-editor-body');
      this.fileInput = this.mount.querySelector('.ink-editor-file');

      this.toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // 保持选区
      this.toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        this.body.focus();
        if (btn.dataset.cmd) {
          document.execCommand(btn.dataset.cmd, false, null);
        } else if (btn.dataset.act === 'image') {
          this.fileInput.click();
        }
        this._scheduleNotify();
      });

      this.fileInput.addEventListener('change', async () => {
        const files = [...this.fileInput.files || []];
        this.fileInput.value = '';
        if (files.length) await this.insertFiles(files);
      });

      this.body.addEventListener('paste', this._boundPaste);
      this.body.addEventListener('drop', this._boundDrop);
      this.body.addEventListener('dragover', (e) => e.preventDefault());
      this.body.addEventListener('input', this._boundInput);
      this.body.addEventListener('focus', this._boundFocus);
      this.body.addEventListener('blur', this._boundBlur);
    }

    destroy() {
      this._flushNotify();
      try { this.body.removeEventListener('paste', this._boundPaste); } catch (_) { /* */ }
      try { this.body.removeEventListener('drop', this._boundDrop); } catch (_) { /* */ }
    }

    focus() {
      this.body.focus();
      // 光标移到末尾
      try {
        const r = document.createRange();
        r.selectNodeContents(this.body);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (_) { /* */ }
    }

    /* ---------------- 剪贴板 / 拖放 ---------------- */

    _onPaste(e) {
      const items = [...(e.clipboardData && e.clipboardData.items) || []];
      const images = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (images.length) {
        e.preventDefault();
        this.insertFiles(images);
        return;
      }
      // 其余内容一律按纯文本粘贴，避免外部富文本污染
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (text) document.execCommand('insertText', false, text);
      this._scheduleNotify();
    }

    _onDrop(e) {
      const files = [...(e.dataTransfer && e.dataTransfer.files) || []]
        .filter((f) => /^image\//.test(f.type));
      if (files.length) {
        e.preventDefault();
        this.insertFiles(files);
      }
    }

    async insertFiles(files) {
      for (const file of files) {
        try {
          const base64 = await fileToBase64(file);
          const { id, url } = await global.Storage.saveImage(base64, extOf(file));
          this.insertHTML(`<img class="ink-img" src="${url}" data-ink-img="${id}" alt="图片">`);
        } catch (err) {
          console.warn('插入图片失败:', err);
        }
      }
      this._scheduleNotify();
    }

    insertHTML(html) {
      this.body.focus();
      document.execCommand('insertHTML', false, html);
    }

    /* ---------------- 取值 / 存值（白名单净化） ---------------- */

    getHTML() {
      return sanitizeHTML(this.body.innerHTML);
    }

    setHTML(html) {
      this.body.innerHTML = sanitizeHTML(String(html || ''), { resolve: true });
    }

    _scheduleNotify() {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = setTimeout(() => {
        this._notifyTimer = null;
        this.onChange(this.getHTML());
      }, this._notify);
    }

    _flushNotify() {
      if (this._notifyTimer) {
        clearTimeout(this._notifyTimer);
        this._notifyTimer = null;
        this.onChange(this.getHTML());
      }
    }
  }

  /**
   * 白名单净化：
   * - 只保留 ALLOWED_TAGS；
   * - 清除全部属性，img 仅保留 data-ink-img / alt（src 由 imageUrl 重算，杜绝任意来源图片）；
   * - 文本节点原样保留。
   */
  function sanitizeHTML(html, opts) {
    const resolve = !!(opts && opts.resolve);
    const doc = new DOMParser().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
    const root = doc.body;

    const walk = (startNode) => {
      const stack = [startNode];
      while (stack.length) {
        const node = stack.pop();
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        for (const child of [...node.childNodes]) {
          if (child.nodeType === Node.TEXT_NODE) continue;
          if (child.nodeType !== Node.ELEMENT_NODE) {
            node.removeChild(child);
            continue;
          }
          if (!ALLOWED_TAGS.has(child.tagName)) {
            // 非白名单元素：内容上提（保留文字/子结构），标签丢弃
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
            stack.push(node); // 重新扫一遍，处理被上提的节点
            continue;
          }
          if (child.tagName === 'IMG') {
            const id = child.getAttribute('data-ink-img') || '';
            const alt = child.getAttribute('alt') || '图片';
            if (!IMG_ID_RE.test(id)) {
              node.removeChild(child);
              continue;
            }
            while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
            child.setAttribute('data-ink-img', id);
            child.setAttribute('alt', alt);
            child.className = 'ink-img';
            if (resolve) child.setAttribute('src', global.Storage.imageUrl(id));
          } else {
            while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
          }
          stack.push(child);
        }
      }
    };

    walk(root);
    return root.innerHTML;
  }

  global.DetailEditor = DetailEditor;
  global.sanitizeHTML = sanitizeHTML;
})(typeof window !== 'undefined' ? window : globalThis);
