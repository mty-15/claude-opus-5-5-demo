const KEYS = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back', KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
  ShiftLeft:'sprint', ShiftRight:'sprint', ControlLeft:'walk', ControlRight:'walk', Space:'jump', KeyC:'crouch', KeyZ:'prone',
  KeyF:'interact', KeyB:'fireMode', KeyR:'reload', Digit1:'slot1', Digit2:'slot2', KeyG:'grenade', Digit7:'heal', Digit8:'boost',
  KeyM:'map', Tab:'inventory', KeyV:'view', KeyH:'help', Escape:'pause', KeyQ:'leanLeft', KeyE:'leanRight',
};
const TOUCH_HELD = new Set(['forward','back','left','right','fire']);

export class Input {
  constructor(canvas, { onPause, onError }) {
    this.canvas = canvas;
    this.onPause = onPause;
    this.onError = onError;
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.active = false;
    this.keys = new Map();
    this.touchKeys = new Set();
    this.edges = new Set();
    this.dx = 0; this.dy = 0;
    this.aim = false;
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
      if (!this.active) return;
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
    for(const button of document.querySelectorAll('[data-touch]')) {
      const action=button.dataset.touch;
      on(button,'pointerdown',e=>{
        if(!this.active) return;
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
  reset() { this.keys.clear();this.touchKeys.clear();this.edges.clear();this.dx=0;this.dy=0;this.aim=false;this.lookPointer=undefined; }
  sample() {
    const held=new Set([...this.keys.values(),...this.touchKeys]);
    const value={held,pressed:new Set(this.edges),dx:this.dx,dy:this.dy,aim:this.aim};
    this.edges.clear();this.dx=0;this.dy=0;
    return value;
  }
  dispose() {this.setActive(false);this.controller.abort();}
}
