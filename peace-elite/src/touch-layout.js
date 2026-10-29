const STORE = 'peace_elite_touch_layout_v1';
const MIN_SCALE = 60;
const MAX_SCALE = 160;
const SCALE_STEP = 5;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validEntry(value) {
  return value && typeof value === 'object' &&
    finite(value.x) && value.x >= 0 && value.x <= 1 &&
    finite(value.bottom) && value.bottom >= 0 && value.bottom <= 1 &&
    finite(value.scale) && value.scale >= MIN_SCALE / 100 && value.scale <= MAX_SCALE / 100;
}

export class TouchLayout {
  constructor(input, { onClose } = {}) {
    this.input = input;
    this.onClose = onClose;
    this.enabled = input.touch;
    this.root = document.querySelector('.touch-controls');
    // 摇杆是 div（非 button），与按键一起参与自定义布局。
    // data-layout-skip 的控件（如只在空中出现的跳伞按钮）不参与，避免量不到尺寸。
    this.controls = this.root ? [...this.root.querySelectorAll('button[data-touch]:not([data-layout-skip]),[data-touch].touch-stick')] : [];
    this.layout = this.readLayout();
    this.draft = null;
    this.selected = this.controls[0]?.dataset.touch || null;
    this.drag = null;
    this.editing = false;
    this.metrics = new Map();
    this.defaults = {};
    this.editor = null;
    if (!this.enabled || !this.root || !this.controls.length) return;

    for (const button of this.controls) {
      button.addEventListener('pointerdown', event => this.startDrag(event, button));
      button.addEventListener('pointermove', event => this.moveDrag(event));
      button.addEventListener('pointerup', event => this.endDrag(event));
      button.addEventListener('pointercancel', event => this.endDrag(event));
      button.addEventListener('lostpointercapture', event => this.endDrag(event));
    }
    window.addEventListener('resize', () => {
      this.endDrag();
      // 默认布局是 CSS 响应式的，尺寸变化后必须重新量取，否则自定义坐标会错位。
      if (!this.measureDefaults()) return;
      this.placeAll();
      if (this.editing) this.syncEditor();
    });
    this.buildEditor();
  }

  readLayout() {
    let raw;
    try { raw = localStorage.getItem(STORE); } catch { return {}; }
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => validEntry(value) && this.controls.some(button => button.dataset.touch === key)));
    } catch { return {}; }
  }

  /**
   * 量取按键在 CSS 响应式布局下的默认位置与尺寸。
   * 先清空内联样式再测量：否则会把已套用的缩放尺寸当成默认值，反复放大。
   */
  measureDefaults() {
    const saved = this.controls.map(button => button.style.cssText);
    for (const button of this.controls) {
      button.style.position = '';
      button.style.left = '';
      button.style.bottom = '';
      button.style.width = '';
      button.style.height = '';
    }
    const rects = this.controls.map(button => button.getBoundingClientRect());
    const usable = rects.every(rect => rect.width > 0 && rect.height > 0);
    if (usable) {
      // 记录宽高两个维度：功能键是正方形，但道具键是 39×27 的长方形，不能强行拉成方形。
      this.metrics = new Map(this.controls.map((button, index) => [button.dataset.touch, {
        width: rects[index].width,
        height: rects[index].height,
      }]));
      this.defaults = Object.fromEntries(this.controls.map((button, index) => [button.dataset.touch, {
        x: clamp(rects[index].left / innerWidth, 0, 1),
        bottom: clamp((innerHeight - rects[index].bottom) / innerHeight, 0, 1),
        scale: 1,
      }]));
    }
    saved.forEach((cssText, index) => { this.controls[index].style.cssText = cssText; });
    return usable;
  }

  /** 游戏 HUD 可见后调用：量取默认布局，并套用已保存的自定义布局。 */
  apply() {
    if (!this.enabled || this.editing) return;
    if (!this.measureDefaults()) return;
    this.placeAll();
  }

  buttonFor(key) {
    return this.controls.find(button => button.dataset.touch === key);
  }

  sizeFor(key) {
    return this.metrics.get(key) || { width: 44, height: 44 };
  }
  /** 缩放后的宽高（保持各控件原始长宽比）。 */
  scaledSize(key, scale = 1) {
    const base = this.sizeFor(key);
    return { width: base.width * scale, height: base.height * scale };
  }

  configFor(key) {
    return (this.editing ? this.draft : this.layout)[key];
  }

  placeAll() {
    if (!this.metrics.size) return;
    const configs = this.editing ? this.draft : this.layout;
    for (const button of this.controls) {
      const key = button.dataset.touch;
      const config = configs[key];
      if (!config) {
        button.style.position = '';
        button.style.left = '';
        button.style.bottom = '';
        button.style.width = '';
        button.style.height = '';
        continue;
      }      const { width, height } = this.scaledSize(key, config.scale);
      // 坐标以视口为基准换算，再扣掉包含块原点：祖先带 transform 等属性时会取代视口
      // 成为 position:fixed 的包含块，不补偿就会整体错位。
      const cb = this.containingBlockFor(button);
      const targetLeft = config.x * innerWidth;
      const targetBottom = innerHeight - config.bottom * innerHeight;
      button.style.position = 'fixed';
      button.style.left = `${targetLeft - cb.left}px`;
      button.style.bottom = `${cb.top + cb.height - targetBottom}px`;
      button.style.width = `${width}px`;
      button.style.height = `${height}px`;
    }
  }

  /**
   * 返回该控件所在包含块的 padding box（视口坐标）。
   * 祖先带 transform / filter / perspective / backdrop-filter / will-change / contain 时，
   * 它会取代视口成为 position:fixed 后代的包含块；否则包含块就是视口本身。
   */
  containingBlockFor(button) {
    for (let el = button.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const traps = style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none' ||
        (style.backdropFilter && style.backdropFilter !== 'none') ||
        (style.willChange && /transform|filter|perspective/.test(style.willChange)) ||
        (style.contain && /paint|layout|strict|content/.test(style.contain));
      if (!traps) continue;
      const rect = el.getBoundingClientRect();
      return { left: rect.left + el.clientLeft, top: rect.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
    }
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  startDrag(event, button) {
    if (!this.editing) return;
    event.preventDefault();
    event.stopPropagation();
    const key = button.dataset.touch;
    const rect = button.getBoundingClientRect();
    this.selected = key;
    this.syncEditor();
    this.drag = {
      key,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    button.setPointerCapture?.(event.pointerId);
    for (const item of this.controls) item.classList.toggle('is-layout-selected', item === button);
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!this.editing || !drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const scale = this.draft[drag.key]?.scale || 1;
    const { width, height } = this.scaledSize(drag.key, scale);
    // 归一化坐标一律以视口为基准存储；包含块补偿只发生在 placeAll 写入样式时。
    const left = clamp(event.clientX - drag.offsetX, 0, innerWidth - width);
    const top = clamp(event.clientY - drag.offsetY, 0, innerHeight - height);
    this.draft = {
      ...this.draft,
      [drag.key]: {
        x: left / innerWidth,
        bottom: (innerHeight - top - height) / innerHeight,
        scale,
      },
    };
    this.placeAll();
  }

  endDrag(event) {
    if (!this.drag || (event && event.pointerId !== this.drag.pointerId)) return;
    this.drag = null;
  }

  buildEditor() {
    const editor = document.createElement('div');
    editor.className = 'touch-layout-editor';
    editor.hidden = true;
    editor.innerHTML = `<div class="touch-layout-head"><strong>自定义按键布局</strong><span>拖动按键调整位置</span></div><div class="touch-layout-controls"><label>按键 <select aria-label="选择按键"></select></label><label>大小 <input type="range" min="${MIN_SCALE}" max="${MAX_SCALE}" step="${SCALE_STEP}" value="100" aria-label="按键大小"><output>100%</output></label></div><div class="touch-layout-actions"><button type="button" data-layout-action="save">保存</button><button type="button" data-layout-action="reset">恢复默认</button><button type="button" data-layout-action="cancel">取消</button></div><p class="touch-layout-message" role="status"></p>`;
    // 挂到 body：.touch-controls 在非触屏媒体查询下是 display:none，挂在里面会让编辑器一起消失。
    document.body.appendChild(editor);
    this.editor = editor;
    this.select = editor.querySelector('select');
    this.slider = editor.querySelector('input');
    this.output = editor.querySelector('output');
    this.message = editor.querySelector('.touch-layout-message');
    for (const button of this.controls) {
      const option = document.createElement('option');
      option.value = button.dataset.touch;
      option.textContent = button.getAttribute('aria-label') || button.textContent.trim() || button.dataset.touch;      this.select.appendChild(option);
    }
    this.select.addEventListener('change', () => {
      this.selected = this.select.value;
      this.syncEditor();
    });
    this.slider.addEventListener('input', () => this.resizeSelected(Number(this.slider.value)));
    editor.addEventListener('pointerdown', event => event.stopPropagation());
    editor.addEventListener('click', event => {
      const action = event.target.closest('[data-layout-action]')?.dataset.layoutAction;
      if (action === 'save') this.save();
      if (action === 'reset') this.reset();
      if (action === 'cancel') this.close(false);
    });
  }

  syncEditor() {
    if (!this.editor || !this.selected) return;
    const config = this.draft?.[this.selected] || this.defaults[this.selected];
    const scale = Math.round((config?.scale || 1) * 100);
    this.select.value = this.selected;
    this.slider.value = String(scale);
    this.output.textContent = `${scale}% · ${Math.round(this.sizeFor(this.selected).width * scale / 100)}px`;
    for (const button of this.controls) button.classList.toggle('is-layout-selected', button.dataset.touch === this.selected);
  }

  resizeSelected(scale) {
    if (!this.selected || !this.editing || !this.baseReady()) return;
    const button = this.buttonFor(this.selected);
    const rect = button.getBoundingClientRect();
    // 与 moveDrag 一致：rect 已是视口坐标，直接归一化，无需再减包含块。
    const nextScale = scale / 100;
    this.draft = {
      ...this.draft,
      [this.selected]: {
        x: clamp(rect.left / innerWidth, 0, 1),
        bottom: clamp((innerHeight - rect.bottom) / innerHeight, 0, 1),
        scale: nextScale,
      },
    };
    this.placeAll();
    this.syncEditor();
  }

  baseReady() {
    return this.metrics.size > 0 && Object.keys(this.defaults).length === this.controls.length;
  }
  /** 进入编辑模式。返回 false 表示当前环境拿不到按键尺寸（例如桌面端强制 ?touch）。 */
  open() {
    if (!this.enabled || this.editing || !this.measureDefaults()) return false;
    this.input.setTouchEditing(true);
    this.input.reset();
    this.draft = { ...this.defaults, ...this.layout };
    this.editing = true;
    document.body.classList.add('touch-layout-editing');
    this.editor.hidden = false;
    this.message.textContent = '';
    this.placeAll();
    this.syncEditor();
    return true;
  }

  /** next 传入自定义布局；省略时保存当前草稿。 */
  close(save, next) {
    if (!this.editing) return;
    this.endDrag();
    if (save) this.layout = next || this.draft;
    this.editing = false;
    this.draft = null;
    document.body.classList.remove('touch-layout-editing');
    this.editor.hidden = true;
    this.input.setTouchEditing(false);
    this.input.reset();
    this.placeAll();
    this.onClose?.();
  }

  /** 草稿与默认布局一致时不写存储，让按键回到 CSS 原生响应式布局。 */
  isDefaultLayout() {
    return this.controls.every(button => {
      const base = this.defaults[button.dataset.touch];
      const draft = this.draft[button.dataset.touch];
      return base && draft &&
        Math.abs(base.x - draft.x) < 1e-6 &&
        Math.abs(base.bottom - draft.bottom) < 1e-6 &&
        Math.abs(base.scale - draft.scale) < 1e-6;
    });
  }

  save() {
    const unchanged = this.isDefaultLayout();
    try {
      if (unchanged) localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, JSON.stringify(this.draft));
    } catch (error) {
      this.message.textContent = '保存失败，请检查浏览器存储权限。';
      console.error('触控布局保存失败', error);
      return;
    }
    this.close(true, unchanged ? {} : this.draft);
  }

  reset() {
    this.endDrag();
    this.draft = { ...this.defaults };
    this.placeAll();
    this.syncEditor();
    this.message.textContent = '已恢复默认布局，点击保存后生效。';
  }
}
