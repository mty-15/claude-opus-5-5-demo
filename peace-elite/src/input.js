const KEYS = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back', KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
  ShiftLeft:'sprint', ShiftRight:'sprint', ControlLeft:'walk', ControlRight:'walk', Space:'jump', KeyC:'crouch', KeyZ:'prone',
  KeyF:'interact', KeyB:'fireMode', KeyR:'reload', Digit1:'slot1', Digit2:'slot2', KeyG:'grenade', Digit7:'heal', Digit8:'boost',
  KeyM:'map', Tab:'inventory', KeyV:'view', KeyH:'help', Escape:'pause', KeyQ:'leanLeft', KeyE:'leanRight',
};
// 侧身与开火一样是「按住生效、松手复位」的持续动作，需登记为 held。
const TOUCH_HELD = new Set(['fire','leanLeft','leanRight']);
// 摇杆死区与满速行程（相对摇杆直径的比例）。
// 行程取 0.44 而不是更小的值：手机上拇指的实际可动半径有限，行程太大就永远推不满，
// 速度会卡在 60%~80%。同时 STICK_DEADZONE 降到 0.10，减少「推了没反应」的空走段。
const STICK_DEADZONE = .10;
const STICK_TRAVEL = .44;

export class Input {
  constructor(canvas, { onPause, onError }) {
    this.canvas = canvas;
    this.onPause = onPause;
    this.onError = onError;
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.active = false;
    this.layoutEditing = false;
    this.keys = new Map();
    this.touchKeys = new Set();
    this.edges = new Set();
    this.dx = 0; this.dy = 0;
    this.aim = false;
    // 移动摇杆：move 为 -1..1 的归一化位移（move.x 右为正，move.y 前为正）。
    this.move = { x: 0, y: 0 };
    this.stickPointer = undefined;
    this.stickCentre = null;
    this.stickRoot = document.querySelector('.touch-stick');
    this.controller = new AbortController();
    const on = (target, name, fn, extra={}) => target.addEventListener(name, fn, { ...extra, signal:this.controller.signal });
    on(document, 'keydown', e => {
      if (!this.active || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const action = KEYS[e.code];
      if (!action) return;
      e.preventDefault();
      if (!e.repeat) this.edges.add(action);
      this.keys.set(e.code, action);
    });
    on(document, 'keyup', e => { this.keys.delete(e.code); });
    on(window, 'blur', () => { if (this.active) this.onPause(); this.reset(); });
    on(document, 'visibilitychange', () => { if (document.hidden && this.active) this.onPause(); });
    on(document, 'pointerlockchange', () => {
      if(!document.pointerLockElement&&this.intentionalUnlock){this.intentionalUnlock=false;return;}
      if (!document.pointerLockElement && this.active && !this.touch && !this.cursorMode) this.onPause();
    });
    on(document, 'mousemove', e => {
      if (this.active && document.pointerLockElement === canvas) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    on(document, 'mousedown', e => {
      if (!this.active || document.pointerLockElement !== canvas) return;
      if (e.button === 0) { this.keys.set('mouse0','fire'); this.edges.add('fire'); }
      if (e.button === 2) this.aim = true;
    });
    on(document, 'mouseup', e => { if(e.button===0) this.keys.delete('mouse0'); if(e.button===2) this.aim=false; });
    on(canvas, 'contextmenu', e => e.preventDefault());
    on(canvas, 'pointerdown', e => {
      if (!this.active || this.layoutEditing) return;
      if (!this.touch) { if(!this.cursorMode) this.lock(); return; }
      if (this.lookPointer !== undefined) return;
      this.lookPointer=e.pointerId; this.lookX=e.clientX; this.lookY=e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    on(canvas,'pointermove', e => {
      if(e.pointerId!==this.lookPointer || !this.active) return;
      this.dx+=(e.clientX-this.lookX)*1.7; this.dy+=(e.clientY-this.lookY)*1.7;
      this.lookX=e.clientX; this.lookY=e.clientY;
    });
    const endLook=e=>{if(e.pointerId===this.lookPointer) this.lookPointer=undefined;};
    on(canvas,'pointerup',endLook); on(canvas,'pointercancel',endLook);
    // 移动摇杆自己处理指针：拖动时旋钮跟手，松手回中。
    if(this.stickRoot) {
      on(this.stickRoot,'pointerdown',e=>{
        if(!this.active || this.layoutEditing || this.stickPointer!==undefined) return;
        e.preventDefault(); e.stopPropagation();
        this.stickRoot.setPointerCapture(e.pointerId);
        this.beginStick(e.pointerId);
      });
      on(this.stickRoot,'pointermove',e=>{
        if(e.pointerId!==this.stickPointer || !this.active || this.layoutEditing) return;
        e.preventDefault(); this.updateStick(e.clientX,e.clientY);
      });
      const endStick=e=>{if(e.pointerId===this.stickPointer) this.endStick();};
      on(this.stickRoot,'pointerup',endStick);
      on(this.stickRoot,'pointercancel',endStick);
      on(this.stickRoot,'lostpointercapture',endStick);
    }
    for(const button of document.querySelectorAll('button[data-touch]')) {
      const action=button.dataset.touch;
      on(button,'pointerdown',e=>{
        if(!this.active || this.layoutEditing) return;
        e.preventDefault(); button.setPointerCapture(e.pointerId);
        if(TOUCH_HELD.has(action)) this.touchKeys.add(action);
        else if(action==='aim') this.aim=!this.aim;
        this.edges.add(action); button.classList.add('pressed');
      });
      const release=()=>{this.touchKeys.delete(action);button.classList.remove('pressed');};
      on(button,'pointerup',release); on(button,'pointercancel',release); on(button,'lostpointercapture',release);
    }
    on(canvas,'wheel',e=>{
      if(!this.active || this.cursorMode) return;
      e.preventDefault(); this.edges.add('nextSlot');
    },{passive:false});
  }
  // 布局编辑期间屏蔽游戏输入：按键与画面拖动只服务于拖动定位。
  setTouchEditing(value) { this.layoutEditing = !!value; }
  /** 摇杆圆心固定在控件自身中心，触点无需落在圆内，靠指针捕获跟手。 */
  beginStick(pointerId) {
    const rect = this.stickRoot.getBoundingClientRect();
    this.stickPointer = pointerId;
    this.stickCentre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, travel: rect.width * STICK_TRAVEL };
    this.stickRoot.classList.add('is-active');
    this.move = { x: 0, y: 0 };
    const knob = this.stickRoot.querySelector('.touch-stick-knob');
    if (knob) knob.style.transform = '';
  }
  updateStick(clientX, clientY) {
    const centre = this.stickCentre;
    if (!centre) return;
    let dx = clientX - centre.x, dy = clientY - centre.y;
    const length = Math.hypot(dx, dy);
    if (length > centre.travel) { dx *= centre.travel / length; dy *= centre.travel / length; }
    const knob = this.stickRoot.querySelector('.touch-stick-knob');
    if (knob) knob.style.transform = `translate(${dx}px,${dy}px)`;
    // 死区内视为静止，避免手指微抖导致角色缓慢漂移。
    // 死区外线性映射到 0..1（与 cf-transport-ship 的 dx/travel 一致）：不做 (raw-deadzone)/(1-deadzone)
    // 的重新归一化，否则轻推的增益会被放大，推杆前段立刻满速、失去「轻推慢走」的层次。
    const raw = length ? Math.min(1, length / centre.travel) : 0;
    const scaled = raw <= STICK_DEADZONE ? 0 : raw;
    const unit = length ? 1 / length : 0;
    this.move = { x: dx * unit * scaled, y: -dy * unit * scaled };
  }
  endStick() {
    this.stickPointer = undefined;
    this.stickCentre = null;
    this.move = { x: 0, y: 0 };
    const knob = this.stickRoot?.querySelector('.touch-stick-knob');
    if (knob) knob.style.transform = '';
    this.stickRoot?.classList.remove('is-active');
  }
  setActive(value) {
    this.active=value;
    if(!value) {this.reset();this.cursorMode=false;if(document.pointerLockElement===this.canvas) document.exitPointerLock();}
  }
  async lock() {
    if(this.touch || document.pointerLockElement===this.canvas || !this.active) return;
    this.cursorMode=false;
    try { await this.canvas.requestPointerLock(); }
    catch(error) { this.onError(`鼠标锁定失败：${error.message}。请点击游戏画面重试。`); }
  }
  setCursor(value) {
    this.cursorMode=value;this.reset();
    if(value) {if(document.pointerLockElement===this.canvas){this.intentionalUnlock=true;document.exitPointerLock();}}
    else this.lock();
  }
  reset() { this.keys.clear();this.touchKeys.clear();this.edges.clear();this.dx=0;this.dy=0;this.aim=false;this.lookPointer=undefined;this.endStick(); }
  sample() {
    const held=new Set([...this.keys.values(),...this.touchKeys]);
    const value={held,pressed:new Set(this.edges),dx:this.dx,dy:this.dy,aim:this.aim,move:this.move};
    this.edges.clear();this.dx=0;this.dy=0;
    return value;
  }
  dispose() {this.setActive(false);this.controller.abort();}
}
