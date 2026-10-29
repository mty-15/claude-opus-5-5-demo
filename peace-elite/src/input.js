import { touchEnabled, loadTouchSettings, TOUCH_DEFAULTS, touchLookRadians } from './touch-settings.js';

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
// 普通圆盘内推杆只移动。向上推过正常行程并保持，才进入持续冲刺。
const SPRINT_RING = 1.15;
const LOCK_HOLD = .6;
const LOCK_FORWARD = .85;
const LOCK_DIRECTION_SLOP = .28;

export class Input {
  constructor(canvas, { onPause, onError }) {
    this.canvas = canvas;
    this.onPause = onPause;
    this.onError = onError;
    this.touch = touchEnabled();
    this.touchSettings = loadTouchSettings();
    this.touchDx = 0; this.touchDy = 0; this.scopeScale = 1;
    this.heldPointers = new Map();
    this.lookPointers = new Map();
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
    // 锁定奔跑状态：lockTimer 累计「在冲刺区停留」的时间，locked 表示已锁定，
    // lockedMove 保存锁定时的方向，松手后 this.move 保持它。
    this.lockTimer = 0;
    this.lockBlocked = false;
    this.lockAngle = 0;
    this.stickAngle = 0;
    this.locked = false;
    this.lockedMove = { x: 0, y: 0 };
    this.stickTapToUnlock = false;
    this.sprintLock = false;      // 锁定后是否按冲刺速度跑
    this.sprintLockGate = true;   // 游戏每帧更新：仅地面步行（非载具/空中）时允许锁定与保持锁定
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
      this.beginLook(e.pointerId,e.clientX,e.clientY);
      canvas.setPointerCapture(e.pointerId);
    });
    on(canvas,'pointermove',e=>this.moveLook(e.pointerId,e.clientX,e.clientY));
    const endLook=e=>this.endLook(e.pointerId);
    on(canvas,'pointerup',endLook); on(canvas,'pointercancel',endLook); on(canvas,'lostpointercapture',endLook);
    // 移动摇杆自己处理指针：拖动时旋钮跟手，松手回中（锁定奔跑时保持方向）。
    if(this.stickRoot) {
      on(this.stickRoot,'pointerdown',e=>{
        if(!this.active || this.layoutEditing || this.stickPointer!==undefined) return;
        e.preventDefault(); e.stopPropagation();
        this.stickRoot.setPointerCapture(e.pointerId);
        this.beginStick(e.pointerId);
        if(!this.stickTapToUnlock) this.updateStick(e.clientX,e.clientY);
      });
      on(this.stickRoot,'pointermove',e=>{
        if(e.pointerId!==this.stickPointer || !this.active || this.layoutEditing) return;
        e.preventDefault();
        // 解除锁定那一下的按下不算操作摇杆；要先把手指推离圆心才恢复跟手。
        if(this.stickTapToUnlock) {
          const c=this.stickCentre;
          if(!c || Math.hypot(e.clientX-c.x,e.clientY-c.y) < c.travel*STICK_DEADZONE) return;
          this.stickTapToUnlock=false;
        }
        this.updateStick(e.clientX,e.clientY);
      });
      const endStick=e=>{if(e.pointerId===this.stickPointer) this.endStick();};
      const cancelStick=e=>{if(e.pointerId===this.stickPointer){this.unlockSprint();this.endStick();}};
      on(this.stickRoot,'pointerup',endStick);
      on(this.stickRoot,'pointercancel',cancelStick);
      on(this.stickRoot,'lostpointercapture',cancelStick);
    }
    this.touchButtons=[...document.querySelectorAll('button[data-touch]')];
    for(const button of this.touchButtons) {
      const action=button.dataset.touch;
      on(button,'pointerdown',e=>{
        if(!this.active || this.layoutEditing) return;
        e.preventDefault(); e.stopPropagation(); button.setPointerCapture(e.pointerId);
        this.heldPointers.set(e.pointerId,{action,button});
        if(TOUCH_HELD.has(action)) this.touchKeys.add(action);
        else if(action==='aim') this.aim=!this.aim;
        // 右手开火键兼作视角区：两拇指也能一边移动、一边跟枪。
        if(action==='fire'&&this.touch) this.beginLook(e.pointerId,e.clientX,e.clientY);
        this.edges.add(action); button.classList.add('pressed');
      });
      if(action==='fire') on(button,'pointermove',e=>this.moveLook(e.pointerId,e.clientX,e.clientY));
      const release=e=>{
        this.heldPointers.delete(e.pointerId);this.endLook(e.pointerId);
        if(![...this.heldPointers.values()].some(p=>p.action===action)) this.touchKeys.delete(action);
        if(![...this.heldPointers.values()].some(p=>p.button===button)) button.classList.remove('pressed');
      };
      on(button,'pointerup',release); on(button,'pointercancel',release); on(button,'lostpointercapture',release);
    }
    on(canvas,'wheel',e=>{
      if(!this.active || this.cursorMode) return;
      e.preventDefault(); this.edges.add('nextSlot');
    },{passive:false});
  }
  beginLook(pointerId,x,y) {
    (this.lookPointers||=new Map()).set(pointerId,{x,y});
    if(this.lookPointer!==undefined) return false;
    this.lookPointer=pointerId;this.lookX=x;this.lookY=y;
    return true;
  }
  moveLook(pointerId,x,y) {
    if(!this.active||this.layoutEditing) return;
    const point=this.lookPointers?.get(pointerId);
    if(!point) return;
    point.x=x;point.y=y;
    if(pointerId!==this.lookPointer) return;
    const settings=this.touchSettings||TOUCH_DEFAULTS;
    const sensitivity=this.aim?settings.ads:settings.look;
    const scope=this.aim?(this.scopeScale||1):1;
    this.touchDx=(this.touchDx||0)+touchLookRadians(x-this.lookX,globalThis.innerWidth||844,sensitivity,scope);
    this.touchDy=(this.touchDy||0)+touchLookRadians(y-this.lookY,globalThis.innerWidth||844,sensitivity,scope);
    this.lookX=x;this.lookY=y;
  }
  endLook(pointerId) {
    this.lookPointers?.delete(pointerId);
    if(pointerId!==this.lookPointer) return;
    this.lookPointer=undefined;
    const next=this.lookPointers?.entries().next().value;
    if(next){this.lookPointer=next[0];this.lookX=next[1].x;this.lookY=next[1].y;}
  }
  // 布局编辑期间屏蔽游戏输入：按键与画面拖动只服务于拖动定位。
  setTouchEditing(value) { this.layoutEditing = !!value; }
  /** 摇杆圆心固定在控件自身中心，触点无需落在圆内，靠指针捕获跟手。 */
  beginStick(pointerId) {
    const rect = this.stickRoot.getBoundingClientRect();
    this.stickPointer = pointerId;
    this.stickCentre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, travel: rect.width * STICK_TRAVEL };
    this.stickRoot.classList.add('is-active');
    this.lockTimer = 0;
    this.lockBlocked = false;
    // 锁定状态下点一下摇杆就是解除：这次按下不再驱动方向，避免角色被拖动。
    if (this.locked) {
      this.unlockSprint();
      this.stickTapToUnlock = true;
    } else this.stickTapToUnlock = false;
    this.move = { x: 0, y: 0 };
    const knob = this.stickRoot.querySelector('.touch-stick-knob');
    if (knob) knob.style.transform = '';
  }
  updateStick(clientX, clientY) {
    const centre = this.stickCentre;
    if (!centre) return;
    const dx=clientX-centre.x,dy=clientY-centre.y,length=Math.hypot(dx,dy);
    const raw=length/centre.travel;
    const scaled=raw<=STICK_DEADZONE?0:Math.min(1,raw);
    const unit=length?1/length:0;
    const knob=this.stickRoot.querySelector('.touch-stick-knob');
    if(knob) knob.style.transform=`translate(${dx*unit*Math.min(length,centre.travel)}px,${dy*unit*Math.min(length,centre.travel)}px)`;
    this.stickAngle=Math.atan2(dy,dx);
    // 回拉/横移退出锁定，让玩家能在物品附近重新小幅定位。
    if(this.locked&&!this.inSprintZone(raw,this.stickAngle)) this.unlockSprint();
    this.move={x:dx*unit*scaled,y:-dy*unit*scaled};
    if(raw>STICK_DEADZONE) this.stickTapToUnlock=false;
    if(this.locked) this.lockedMove={...this.move};
    this.trackSprintHold(raw,this.stickAngle);
  }
  inSprintZone(raw,angle) {
    return raw>=SPRINT_RING&&-Math.sin(angle)>=LOCK_FORWARD;
  }
  /** 同方向在向上外推区域停留，普通满推、横移和倒退不会触发。 */
  trackSprintHold(raw, angle) {
    if(this.lockBlocked||!this.inSprintZone(raw,angle)){this.lockTimer=0;return;}
    const drift=Math.abs(Math.atan2(Math.sin(angle-this.lockAngle),Math.cos(angle-this.lockAngle)));
    if(this.lockTimer<=0||drift>LOCK_DIRECTION_SLOP){this.lockTimer=0.0001;this.lockAngle=angle;}
  }
  /** 每帧推进锁定计时。手指停住不动时不会产生 pointermove，所以计时必须靠帧推进。 */
  tick(dt) {
    // 载具／空中阶段不允许冲刺锁定：已锁定的立即解除，计时中的直接清零。
    if (!this.active || this.layoutEditing || !this.sprintLockGate) {
      if (this.locked) this.unlockSprint();
      this.lockTimer = 0;
      return;
    }
    if (!this.stickCentre || this.locked || this.lockTimer <= 0) return;
    this.lockTimer += dt;
    if (this.lockTimer >= LOCK_HOLD) this.lockSprint();
  }
  lockSprint() {
    if (this.locked || !this.stickCentre || !this.sprintLockGate) return;
    this.locked = true;
    this.sprintLock = true;
    // 锁定后按满速奔跑，方向取当前摇杆方向。
    const angle = this.stickAngle || 0;
    this.lockedMove = { x: Math.cos(angle), y: -Math.sin(angle) };
    this.move = { ...this.lockedMove };
    this.stickRoot?.classList.add('is-locked');
    if (navigator.vibrate) navigator.vibrate(12);
  }
  unlockSprint() {
    this.lockTimer=0;
    this.lockBlocked=this.stickPointer!==undefined;
    if (!this.locked) return;
    this.locked = false;
    this.sprintLock = false;
    this.lockedMove = { x: 0, y: 0 };
    this.stickRoot?.classList.remove('is-locked');
    this.move = { x: 0, y: 0 };
  }
  endStick() {
    this.stickPointer = undefined;
    this.stickCentre = null;
    this.stickTapToUnlock = false;
    this.lockTimer = 0;
    // 锁定时松手保持方向继续跑；否则回中。
    this.move = this.locked ? { ...this.lockedMove } : { x: 0, y: 0 };
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
  // 整体重置（重开一局 / 暂停 / 返回菜单 / 窗口失焦）必须连锁定一起解除：
  // 否则 endStick 会保留 lockedMove，新一局会在出生点沿旧方向自动冲刺。
  reset() {
    this.keys.clear();this.touchKeys.clear();this.edges.clear();this.dx=0;this.dy=0;this.touchDx=0;this.touchDy=0;
    this.aim=false;this.lookPointer=undefined;this.lookPointers?.clear();this.heldPointers?.clear();
    for(const button of this.touchButtons||[]) button.classList.remove('pressed');
    this.unlockSprint();this.endStick();
  }
  sample() {
    const held=new Set([...this.keys.values(),...this.touchKeys]);
    if(this.locked) held.add('sprint');
    const value={held,pressed:new Set(this.edges),dx:this.dx,dy:this.dy,touchDx:this.touchDx||0,touchDy:this.touchDy||0,aim:this.aim,move:this.move,locked:this.locked};
    this.edges.clear();this.dx=0;this.dy=0;this.touchDx=0;this.touchDy=0;
    return value;
  }
  dispose() {this.setActive(false);this.controller.abort();}
}
