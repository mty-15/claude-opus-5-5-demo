// All sound is synthesized locally. Construction does not request audio permission;
// await start() directly from a click/key handler before emitting one-shot sounds.
const DEFAULT_VOLUME = 0.35;
const NOISE_SECONDS = 2;
const MIN_GAIN = 0.0001;
const SHOTS = {
  m416: { duration: 0.20, cutoff: 5600, body: 155, tail: 0.13, power: 0.64, type: 'triangle' },
  akm: { duration: 0.30, cutoff: 3500, body: 108, tail: 0.23, power: 0.83, type: 'sawtooth' },
  ump45: { duration: 0.135, cutoff: 2600, body: 220, tail: 0.08, power: 0.47, type: 'triangle' },
  kar98: { duration: 0.58, cutoff: 7600, body: 78, tail: 0.47, power: 0.97, type: 'triangle' },
};
function number(value, name, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  if (value < min || value > max) throw new RangeError(`${name} must be in [${min}, ${max}]`);
  return value;
}
function flag(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}
function smooth(param, value, time, constant = 0.075) {
  param.cancelScheduledValues(time);
  param.setTargetAtTime(value, time, constant);
}
function envelope(param, time, duration, peak, attack = 0.002) {
  param.setValueAtTime(0, time);
  param.linearRampToValueAtTime(Math.max(MIN_GAIN, peak), time + attack);
  param.exponentialRampToValueAtTime(MIN_GAIN, time + duration);
  param.linearRampToValueAtTime(0, time + duration + 0.008);
}

export class AudioEngine {
  constructor() {
    this._context = null;
    this._volume = DEFAULT_VOLUME;
    this._startPromise = null;
    this._disposePromise = null;
    this._disposed = false;
    this._voices = new Set();
    this._continuous = [];
    this._nodes = new Set();
    this._noiseBuffer = null;
    this._motion = { speed: 0, vehicle: false, airborne: false };
    this._lastStep = -Infinity;
    this._lastZone = -Infinity;
    this._stepSide = 1;
  }

  _assertLive() {
    if (this._disposed) throw new Error('AudioEngine has been disposed');
  }

  _ready() {
    this._assertLive();
    if (!this._context || this._context.state !== 'running') {
      throw new Error('AudioEngine is not running; await start() or resume() from a user gesture');
    }
    return this._context;
  }

  async start() {
    this._assertLive();
    if (this._startPromise) return this._startPromise;
    if (!this._context) {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (typeof Context !== 'function') throw new Error('Web Audio API is unavailable: AudioContext is required');
      this._context = new Context({ latencyHint: 'interactive' });
      try {
        this._createGraph();
      } catch (error) {
        // A partially initialized context must not become a successful later start.
        try { await this.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Audio initialization and cleanup failed'); }
        throw error;
      }
    }
    if (this._context.state === 'closed') throw new Error('AudioContext is closed; create a new AudioEngine');
    // Invoke resume synchronously while transient user activation is still present.
    const resume = this._context.state === 'running' ? Promise.resolve() : this._context.resume();
    this._startPromise = Promise.resolve(resume).then(() => {
      this._ready();
      this._applyMotion();
      return this;
    });
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async resume() {
    return this.start();
  }

  _node(node) {
    this._nodes.add(node);
    return node;
  }

  _createGraph() {
    const ctx = this._context;
    this._master = this._node(ctx.createGain());
    this._master.gain.value = this._volume;
    const limiter = this._node(ctx.createDynamicsCompressor());
    limiter.threshold.value = -9;
    limiter.knee.value = 9;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    this._master.connect(limiter);
    limiter.connect(ctx.destination);
    const length = Math.ceil(ctx.sampleRate * NOISE_SECONDS);
    this._noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this._noiseBuffer.getChannelData(0);
    const edge = Math.max(1, Math.round(ctx.sampleRate * 0.012));
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.min(1, i / edge, (length - 1 - i) / edge);
    }
    // Only two continuously running sources: one engine harmonic oscillator and
    // one shared noise loop feeding wind and tyre/engine-texture filters.
    this._engine = this._node(ctx.createOscillator());
    const real = new Float32Array(12);
    const imaginary = new Float32Array(12);
    imaginary[1] = 0.6; imaginary[2] = 1; imaginary[3] = 0.28;
    imaginary[4] = 0.4; imaginary[6] = 0.17; imaginary[8] = 0.09;
    this._engine.setPeriodicWave(ctx.createPeriodicWave(real, imaginary));
    this._engine.frequency.value = 33;
    const engineFilter = this._node(ctx.createBiquadFilter());
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 700;
    this._engineGain = this._node(ctx.createGain());
    this._engineGain.gain.value = 0;
    this._engine.connect(engineFilter);
    engineFilter.connect(this._engineGain);
    this._engineGain.connect(this._master);
    this._air = this._node(ctx.createBufferSource());
    this._air.buffer = this._noiseBuffer;
    this._air.loop = true;
    this._windFilter = this._node(ctx.createBiquadFilter());
    this._windFilter.type = 'bandpass';
    this._windFilter.frequency.value = 650;
    this._windFilter.Q.value = 0.55;
    this._windGain = this._node(ctx.createGain());
    this._windGain.gain.value = 0;
    this._air.connect(this._windFilter);
    this._windFilter.connect(this._windGain);
    this._windGain.connect(this._master);
    const roadFilter = this._node(ctx.createBiquadFilter());
    roadFilter.type = 'lowpass';
    roadFilter.frequency.value = 270;
    this._roadGain = this._node(ctx.createGain());
    this._roadGain.gain.value = 0;
    this._air.connect(roadFilter);
    roadFilter.connect(this._roadGain);
    this._roadGain.connect(this._master);
    this._engine.start();
    this._continuous.push(this._engine);
    this._air.start();
    this._continuous.push(this._air);
  }

  _voice(source, chain, time, duration, offset) {
    const record = { source, nodes: [source, ...chain], ended: false };
    this._voices.add(record);
    const cleanup = () => {
      if (record.ended) return;
      record.ended = true;
      source.onended = null;
      record.nodes.forEach(node => node.disconnect());
      this._voices.delete(record);
    };
    record.cleanup = cleanup;
    source.onended = cleanup;
    let previous = source;
    for (const node of chain) { previous.connect(node); previous = node; }
    previous.connect(this._master);
    if (offset === undefined) source.start(time);
    else source.start(time, offset);
    source.stop(time + duration + 0.012);
  }

  _tone({ frequency, end = frequency, duration, gain, type = 'sine', delay = 0, attack = 0.002 }) {
    const ctx = this._context;
    const time = ctx.currentTime + delay;
    const source = ctx.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(frequency, time);
    source.frequency.exponentialRampToValueAtTime(Math.max(20, end), time + duration);
    const level = ctx.createGain();
    envelope(level.gain, time, duration, gain, attack);
    this._voice(source, [level], time, duration);
  }

  _noise({ duration, gain, frequency, type = 'lowpass', q = 0.7, delay = 0, attack = 0.001 }) {
    const ctx = this._context;
    const time = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    // A different starting point avoids identical waveform phasing during automatic fire.
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = Math.min(frequency, ctx.sampleRate * 0.45);
    filter.Q.value = q;
    const level = ctx.createGain();
    envelope(level.gain, time, duration, gain, attack);
    this._voice(source, [filter, level], time, duration, 0.02 + Math.random() * (NOISE_SECONDS - duration - 0.04));
  }

  shot(id, volume = 1) {
    if (!Object.hasOwn(SHOTS, id)) throw new RangeError(`Unknown weapon: ${id}`);
    number(volume, 'shot volume', 0, 1);
    this._ready();
    if (volume === 0) return;
    const spec = SHOTS[id];
    const gain = spec.power * volume;
    const variation = 0.96 + Math.random() * 0.08;
    this._noise({ duration: spec.duration, gain, frequency: spec.cutoff * variation });
    this._noise({ duration: 0.026, gain: gain * 0.48, frequency: spec.cutoff * 0.8, type: 'highpass' });
    this._tone({ frequency: spec.body * variation, end: spec.body * 0.32, duration: spec.tail,
      gain: gain * 0.65, type: spec.type });
    this._noise({ duration: spec.tail, gain: gain * 0.13, frequency: 1150, delay: 0.048 });
    if (id === 'kar98') this._tone({ frequency: 1450, end: 390, duration: 0.045, gain: 0.10 * volume, delay: 0.10 });
  }

  hit(headshot = false) {
    flag(headshot, 'headshot');
    this._ready();
    this._noise({ duration: 0.045, gain: 0.18, frequency: headshot ? 3800 : 1500, type: 'bandpass' });
    this._tone({ frequency: headshot ? 1760 : 670, end: headshot ? 2280 : 430,
      duration: headshot ? 0.115 : 0.055, gain: 0.17, type: 'triangle' });
    if (headshot) this._tone({ frequency: 2640, end: 2300, duration: 0.10, gain: 0.095, delay: 0.04 });
  }

  pickup() {
    this._ready();
    this._tone({ frequency: 740, end: 940, duration: 0.075, gain: 0.15, type: 'triangle' });
    this._tone({ frequency: 1110, end: 1480, duration: 0.12, gain: 0.12, delay: 0.065, type: 'triangle' });
    this._noise({ duration: 0.024, gain: 0.075, frequency: 2800, type: 'bandpass' });
  }

  reload() {
    this._ready();
    // Mechanical magazine release, insertion and bolt return; no wall-clock timers.
    for (const [delay, frequency, gain] of [[0, 1800, 0.15], [0.23, 760, 0.12], [0.61, 2100, 0.20], [0.84, 3200, 0.17]]) {
      this._noise({ duration: 0.045, gain, frequency, type: 'bandpass', q: 1.5, delay });
      this._tone({ frequency: frequency * 0.22, end: 90, duration: 0.035, gain: gain * 0.65, delay });
    }
  }

  step(speed) {
    number(speed, 'speed', 0);
    const ctx = this._ready();
    if (speed === 0 || this._motion.vehicle || this._motion.airborne) return;
    const cadence = Math.max(0.23, 0.53 - Math.min(speed, 8) * 0.036);
    if (ctx.currentTime - this._lastStep < cadence) return;
    this._lastStep = ctx.currentTime;
    this._stepSide *= -1;
    const gain = 0.045 + Math.min(speed / 8, 1) * 0.10;
    this._noise({ duration: 0.095, gain, frequency: 950 + this._stepSide * 110, type: 'lowpass', attack: 0.004 });
    this._tone({ frequency: 105 + this._stepSide * 9, end: 48, duration: 0.065, gain: gain * 0.74 });
    this._noise({ duration: 0.045, gain: gain * 0.42, frequency: 2800, type: 'bandpass', delay: 0.035 });
  }

  zone() {
    const ctx = this._ready();
    // Safe to call during every outside-zone frame; pulse cadence uses audio time.
    if (ctx.currentTime - this._lastZone < 0.8) return;
    this._lastZone = ctx.currentTime;
    this._tone({ frequency: 185, end: 125, duration: 0.30, gain: 0.16, type: 'sine', attack: 0.025 });
    this._tone({ frequency: 370, end: 250, duration: 0.22, gain: 0.055, type: 'triangle', delay: 0.12 });
    this._noise({ duration: 0.28, gain: 0.075, frequency: 1050, type: 'bandpass', attack: 0.03 });
  }

  end(win) {
    flag(win, 'win');
    this._ready();
    this.update({ speed: 0, vehicle: false, airborne: false });
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63, 196];
    notes.forEach((frequency, index) => {
      this._tone({ frequency, duration: index === 3 ? 0.9 : 0.32,
        gain: 0.13, type: 'triangle', delay: index * 0.16, attack: 0.015 });
      this._tone({ frequency: frequency / 2, duration: 0.4,
        gain: 0.06, delay: index * 0.16, attack: 0.02 });
    });
  }

  // Motion and volume are configuration: safe before start(), never create nodes.
  update({ speed = 0, vehicle = false, airborne = false } = {}) {
    this._assertLive();
    number(speed, 'speed', 0);
    flag(vehicle, 'vehicle'); flag(airborne, 'airborne');
    this._motion = { speed, vehicle, airborne };
    if (this._context && this._context.state === 'running') this._applyMotion();
  }

  _applyMotion() {
    const { speed, vehicle, airborne } = this._motion;
    const time = this._context.currentTime;
    const throttle = Math.min(speed / 27, 1);
    const wind = airborne ? 0.19 + Math.min(speed / 60, 1) * 0.14 : vehicle ? throttle * 0.065 : 0;
    smooth(this._engine.frequency, 33 + throttle * 92 + Math.sin(time * 13) * (vehicle ? 0.8 : 0), time, 0.12);
    smooth(this._engineGain.gain, vehicle ? 0.10 + throttle * 0.085 : 0, time, 0.16);
    smooth(this._roadGain.gain, vehicle ? 0.055 + throttle * 0.09 : 0, time, 0.15);
    smooth(this._windFilter.frequency, airborne ? 750 + Math.min(speed, 60) * 15 : 580, time, 0.2);
    smooth(this._windGain.gain, wind * (0.94 + Math.sin(time * 0.83) * 0.06), time, 0.2);
  }

  setVolume(value) {
    this._assertLive();
    number(value, 'volume', 0, 1);
    this._volume = value;
    if (this._master) smooth(this._master.gain, value, this._context.currentTime, 0.025);
  }

  dispose() {
    if (this._disposed) return this._disposePromise;
    this._disposed = true;
    const ctx = this._context;
    if (!ctx) {
      this._disposePromise = Promise.resolve();
      return this._disposePromise;
    }
    for (const voice of this._voices) {
      if (!voice.ended && ctx.state !== 'closed') voice.source.stop(ctx.currentTime);
      voice.cleanup();
    }
    for (const source of this._continuous) if (ctx.state !== 'closed') source.stop(ctx.currentTime);
    this._nodes.forEach(node => node.disconnect());
    this._nodes.clear();
    this._continuous.length = 0;
    this._noiseBuffer = null;
    if (this._air) this._air.buffer = null;
    this._disposePromise = ctx.state === 'closed' ? Promise.resolve() : ctx.close();
    return this._disposePromise;
  }
}
