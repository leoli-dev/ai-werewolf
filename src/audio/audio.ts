/**
 * Procedural audio (Web Audio, no asset files): two BGM themes — 白天悬疑 /
 * 夜晚危险 — cross-faded with the day/night mix, ambience (wind, rain,
 * thunder) and one-shot SFX (doors, wolves, rats, bats, dawn stingers).
 */

type Bus = GainNode;

/** Base mix of the three groups. */
const MIX = { music: 0.55, sfx: 0.9, ambience: 0.6 };

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: Bus;
  private dayBus!: Bus;
  private nightBus!: Bus;
  private sfx!: Bus;
  private amb!: Bus;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rainGain!: GainNode;
  private schedTimer = 0;
  private nextBeat = { day: 0, night: 0 };
  private beatIndex = { day: 0, night: 0 };
  private melodyIdx = 3;
  private night = 0;
  private muted = false;
  /** User volume per group (配置), 0..1, on top of the mix levels below. */
  private levels = { music: 1, sfx: 1, ambience: 1 };

  get started() {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.music = this.bus(MIX.music * this.levels.music);
    this.dayBus = ctx.createGain();
    this.nightBus = ctx.createGain();
    this.dayBus.gain.value = 1;
    this.nightBus.gain.value = 0;
    this.dayBus.connect(this.music);
    this.nightBus.connect(this.music);
    this.sfx = this.bus(MIX.sfx * this.levels.sfx);
    this.amb = this.bus(MIX.ambience * this.levels.ambience);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.startAmbience();
    this.startDrones();
    const now = ctx.currentTime + 0.1;
    this.nextBeat = { day: now, night: now };
    this.schedTimer = window.setInterval(() => this.schedule(), 100);
    this.setNight(this.night === 1);
  }

  /** Freeze all sound (the game is paused); scheduled music waits with the clock. */
  pause() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }

  setLevels(levels: { music: number; sfx: number; ambience: number }) {
    this.levels = { ...levels };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.music.gain.setTargetAtTime(MIX.music * levels.music, t, 0.05);
    this.sfx.gain.setTargetAtTime(MIX.sfx * levels.sfx, t, 0.05);
    this.amb.gain.setTargetAtTime(MIX.ambience * levels.ambience, t, 0.05);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.2);
  }

  /** 0 = day, 1 = night. Cross-fades music themes and ambience. */
  setNight(night: boolean) {
    this.night = night ? 1 : 0;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.dayBus.gain.setTargetAtTime(night ? 0 : 1, t, 1.5);
    this.nightBus.gain.setTargetAtTime(night ? 1 : 0, t, 1.5);
    this.rainGain.gain.setTargetAtTime(night ? 1 : 0, t, 2.5);
    this.windGain.gain.setTargetAtTime(night ? 0.2 : 0.12, t, 2);
  }

  dispose() {
    clearInterval(this.schedTimer);
    void this.ctx?.close();
    this.ctx = null;
  }

  // ───────────────────────── building blocks ─────────────────────────

  private bus(gain: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private noiseSrc(loop = false): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    if (!loop) s.loopStart = 0;
    return s;
  }

  private filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Attack/decay envelope on a fresh gain node. */
  private env(t: number, attack: number, peak: number, decay: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private out(node: AudioNode, dest: AudioNode, wet = 0) {
    node.connect(dest);
    if (wet > 0) {
      const w = this.ctx!.createGain();
      w.gain.value = wet;
      node.connect(w).connect(this.reverbSend);
    }
  }

  private tone(dest: AudioNode, t: number, freq: number, type: OscillatorType, peak: number, attack: number, decay: number, wet = 0.3) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = this.env(t, attack, peak, decay);
    o.connect(g);
    this.out(g, dest, wet);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    return o;
  }

  private burst(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, wet = 0) {
    const s = this.noiseSrc();
    const f = this.filter(type, freq, q);
    const g = this.env(t, attack, peak, decay);
    s.connect(f).connect(g);
    this.out(g, dest, wet);
    s.start(t, Math.random() * 1.5);
    s.stop(t + attack + decay + 0.05);
    return f;
  }

  // ───────────────────────── ambience ─────────────────────────

  private startAmbience() {
    const ctx = this.ctx!;
    // wind: band-passed noise with slow gusts
    const w = this.noiseSrc(true);
    this.windFilter = this.filter('bandpass', 420, 0.7);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.12;
    const gust = ctx.createGain();
    gust.gain.value = 0.6;
    w.connect(this.windFilter).connect(gust).connect(this.windGain).connect(this.amb);
    w.start();
    const gustLoop = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      gust.gain.setTargetAtTime(0.35 + Math.random() * 0.9, t, 1.2 + Math.random());
      this.windFilter.frequency.setTargetAtTime(300 + Math.random() * 500, t, 1.5);
      setTimeout(gustLoop, 1500 + Math.random() * 2500);
    };
    gustLoop();

    // rain: individual drops (scheduled in `rainDrops`) over a very soft low wash — no hiss
    const r = this.noiseSrc(true);
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const wash = this.filter('lowpass', 420, 0.6);
    const wg = ctx.createGain();
    wg.gain.value = 0.25;
    r.connect(wash).connect(wg).connect(this.rainGain);
    this.rainGain.connect(this.amb);
    r.start();
  }

  thunder(distance = 0.5) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.3 + distance * 1.4;
    const vol = 0.9 - distance * 0.4;
    // crack
    this.burst(this.amb, t, 'lowpass', 1400, 0.7, vol * 0.5, 0.01, 0.35);
    // rumble with a few swells
    const s = this.noiseSrc();
    const f = this.filter('lowpass', 160, 0.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.08);
    g.gain.linearRampToValueAtTime(vol * 0.5, t + 0.7);
    g.gain.linearRampToValueAtTime(vol * 0.8, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    s.connect(f).connect(g);
    this.out(g, this.amb, 0.4);
    s.start(t);
    s.stop(t + 4.6);
  }

  // ───────────────────────── music ─────────────────────────

  private startDrones() {
    const ctx = this.ctx!;
    const drone = (bus: Bus, freqs: [number, OscillatorType, number][], cutoff: number, lfoRate: number) => {
      const f = this.filter('lowpass', cutoff, 0.8);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = lfoRate;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = cutoff * 0.4;
      lfo.connect(lfoAmt).connect(f.frequency);
      lfo.start();
      const g = ctx.createGain();
      g.gain.value = 1;
      f.connect(g);
      this.out(g, bus, 0.25);
      for (const [hz, type, vol] of freqs) {
        for (const det of [-4, 4]) {
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.value = hz;
          o.detune.value = det;
          const og = ctx.createGain();
          og.gain.value = vol;
          o.connect(og).connect(f);
          o.start();
        }
      }
    };
    // 白天：D 小调五度持续音
    drone(this.dayBus, [[midi(38), 'sawtooth', 0.025], [midi(45), 'triangle', 0.035], [midi(50), 'sine', 0.02]], 420, 0.05);
    // 夜晚：C / F# 三全音 + 次低音
    drone(this.nightBus, [[midi(36), 'sawtooth', 0.03], [midi(42), 'sawtooth', 0.022], [midi(24), 'sine', 0.09]], 320, 0.08);
    // 夜晚高频颤音弦
    const trem = ctx.createGain();
    trem.gain.value = 0.006;
    const tl = ctx.createOscillator();
    tl.frequency.value = 7;
    const ta = ctx.createGain();
    ta.gain.value = 0.005;
    tl.connect(ta).connect(trem.gain);
    tl.start();
    for (const hz of [midi(90), midi(91)]) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.connect(trem);
      o.start();
    }
    this.out(trem, this.nightBus, 0.6);
  }

  /** Lookahead scheduler for melodic / rhythmic events of both themes. */
  private nextDrop = 0;

  /** 滴滴答答: sparse, individually pitched drops at night (~6 per second). */
  private rainDrops(horizon: number) {
    const ctx = this.ctx!;
    if (this.night < 1) {
      this.nextDrop = horizon;
      return;
    }
    this.nextDrop = Math.max(this.nextDrop, ctx.currentTime);
    while (this.nextDrop < horizon) {
      const t = this.nextDrop;
      this.nextDrop += -Math.log(1 - Math.random()) / 6; // Poisson, mean 6 drops/s
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      pan.connect(this.rainGain);
      const eave = Math.random() < 0.18; // a heavier drip off the eaves: lower, rounder "plop"
      const f = eave ? 500 + Math.random() * 350 : 1500 + Math.random() * 2200;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (eave ? 1.6 : 0.55), t + (eave ? 0.07 : 0.035));
      const g = this.env(t, 0.002, (eave ? 0.07 : 0.035) * (0.4 + Math.random() * 0.6), eave ? 0.11 : 0.05);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + 0.2);
    }
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = ctx.currentTime + 0.6;
    this.rainDrops(horizon);
    // day theme: 66 bpm, sparse music box over pizzicato pulse
    const dayBeat = 60 / 66;
    while (this.nextBeat.day < horizon) {
      const t = this.nextBeat.day;
      const i = this.beatIndex.day++;
      if (this.night < 1) this.dayEvent(t, i);
      this.nextBeat.day += dayBeat;
    }
    // night theme: 56 bpm heartbeat + stingers + bell
    const nightBeat = 60 / 56;
    while (this.nextBeat.night < horizon) {
      const t = this.nextBeat.night;
      const i = this.beatIndex.night++;
      if (this.night > 0) this.nightEvent(t, i);
      this.nextBeat.night += nightBeat;
    }
  }

  private dayEvent(t: number, i: number) {
    const bus = this.dayBus;
    // low pizzicato on 1 and 3 of 4
    if (i % 4 === 0) this.tone(bus, t, midi(38), 'sine', 0.16, 0.005, 0.7, 0.2);
    if (i % 4 === 2) this.tone(bus, t, midi(33), 'sine', 0.12, 0.005, 0.7, 0.2);
    // music box: D harmonic minor, random walk, often silent
    const scale = [62, 65, 67, 69, 70, 73, 74, 77, 79, 81];
    if (Math.random() < 0.42) {
      this.melodyIdx = Math.max(0, Math.min(scale.length - 1, this.melodyIdx + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]));
      const n = scale[this.melodyIdx] + 12;
      this.tone(bus, t, midi(n), 'triangle', 0.045, 0.004, 1.6, 0.55);
      this.tone(bus, t, midi(n + 12), 'sine', 0.012, 0.004, 0.8, 0.55);
      if (Math.random() < 0.25) this.tone(bus, t + 60 / 66 / 2, midi(scale[Math.max(0, this.melodyIdx - 2)] + 12), 'triangle', 0.03, 0.004, 1.2, 0.55);
    }
    // an unresolved swell every 16 beats
    if (i % 16 === 8) this.burst(bus, t, 'bandpass', 900, 2, 0.05, 2.2, 2.5, 0.5);
  }

  private nightEvent(t: number, i: number) {
    const bus = this.nightBus;
    // heartbeat: lub-dub
    const thump = (at: number, vol: number) => {
      const o = this.ctx!.createOscillator();
      o.frequency.setValueAtTime(62, at);
      o.frequency.exponentialRampToValueAtTime(38, at + 0.16);
      const g = this.env(at, 0.008, vol, 0.2);
      o.connect(g);
      this.out(g, bus, 0.1);
      o.start(at);
      o.stop(at + 0.3);
    };
    thump(t, 0.35);
    thump(t + 0.24, 0.22);
    // dissonant string stinger
    if (i % 16 === 12 && Math.random() < 0.7) {
      for (const n of [60, 61, 66]) this.tone(bus, t, midi(n), 'sawtooth', 0.018, 0.9, 2.8, 0.7);
    }
    // distant bell toll
    if (i % 12 === 0) {
      for (const [ratio, vol] of [[1, 0.06], [2.76, 0.025], [5.4, 0.012]] as const) this.tone(bus, t, midi(48) * ratio, 'sine', vol, 0.01, 4.5, 0.8);
    }
    // creeping low glissando
    if (i % 24 === 18) {
      const o = this.ctx!.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(midi(47), t);
      o.frequency.linearRampToValueAtTime(midi(42), t + 4);
      const f = this.filter('lowpass', 700, 1);
      const g = this.env(t, 1.5, 0.03, 3);
      o.connect(f).connect(g);
      this.out(g, bus, 0.6);
      o.start(t);
      o.stop(t + 5);
    }
  }

  // ───────────────────────── SFX ─────────────────────────

  private now(delay = 0) {
    return this.ctx ? this.ctx.currentTime + delay : -1;
  }

  doorOpen(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    // latch click
    this.burst(this.sfx, t, 'highpass', 2500, 1, 0.3 * vol, 0.002, 0.04);
    // hinge creak: wobbling sawtooth through resonant band-passes
    const o = this.ctx!.createOscillator();
    o.type = 'sawtooth';
    const curve = new Float32Array(24).map((_, k) => 70 + Math.sin(k * 1.7) * 18 + k * 2.2 + Math.random() * 12);
    o.frequency.setValueCurveAtTime(curve, t + 0.05, 0.75);
    const b1 = this.filter('bandpass', 950, 7);
    const b2 = this.filter('bandpass', 2100, 5);
    const g = this.env(t + 0.05, 0.08, 0.55 * vol, 0.7);
    o.connect(b1).connect(g);
    o.connect(b2).connect(g);
    this.out(g, this.sfx, 0.25);
    o.start(t + 0.05);
    o.stop(t + 0.95);
  }

  doorClose(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    const o = this.ctx!.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.22);
    const g = this.env(t, 0.004, 0.9 * vol, 0.3);
    o.connect(g);
    this.out(g, this.sfx, 0.3);
    o.start(t);
    o.stop(t + 0.4);
    this.burst(this.sfx, t, 'lowpass', 500, 0.8, 0.6 * vol, 0.002, 0.14);
    this.burst(this.sfx, t + 0.06, 'highpass', 3000, 1, 0.22 * vol, 0.002, 0.04);
  }

  doorBreak(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    this.burst(this.sfx, t, 'lowpass', 1600, 0.7, 0.6 * vol, 0.003, 0.5, 0.3);
    for (let k = 0; k < 6; k++) this.burst(this.sfx, t + Math.random() * 0.35, 'bandpass', 2000 + Math.random() * 2500, 3, 0.25 * vol, 0.001, 0.04);
    const o = this.ctx!.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    const g = this.env(t, 0.005, 0.5 * vol, 0.5);
    o.connect(g);
    this.out(g, this.sfx, 0.3);
    o.start(t);
    o.stop(t + 0.6);
  }

  /** A wolf's self-destruct: `big` is the house going up (boom, long rumble, falling debris). */
  explosion(vol = 1, big = true, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    const ctx = this.ctx!;
    // the crack
    this.burst(this.sfx, t, 'lowpass', big ? 2600 : 1800, 0.6, (big ? 0.95 : 0.6) * vol, 0.002, big ? 0.6 : 0.35, 0.4);
    // body: a pitch-dropping thump
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(big ? 90 : 120, t);
    o.frequency.exponentialRampToValueAtTime(big ? 28 : 45, t + (big ? 1.2 : 0.5));
    const g = this.env(t, 0.005, (big ? 1 : 0.6) * vol, big ? 1.6 : 0.6);
    o.connect(g);
    this.out(g, this.sfx, 0.4);
    o.start(t);
    o.stop(t + 2);
    if (!big) return;
    // long rolling rumble
    const s = this.noiseSrc(true);
    const f = this.filter('lowpass', 220, 0.8);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.linearRampToValueAtTime(0.9 * vol, t + 0.1);
    rg.gain.linearRampToValueAtTime(0.5 * vol, t + 1.5);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + 6);
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 5);
    s.connect(f).connect(rg);
    this.out(rg, this.sfx, 0.5);
    s.start(t);
    s.stop(t + 6.1);
    // debris raining down
    for (let k = 0; k < 14; k++) {
      this.burst(this.sfx, t + 0.9 + Math.random() * 2.2, 'bandpass', 900 + Math.random() * 2600, 2.5, (0.12 + Math.random() * 0.16) * vol, 0.002, 0.05 + Math.random() * 0.08);
    }
  }

  /** Wolves throwing themselves at a door: a heavy wooden thud and a creak of strained planks. */
  doorBang(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    const o = this.ctx!.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = this.env(t, 0.003, 1.1 * vol, 0.35);
    o.connect(g);
    this.out(g, this.sfx, 0.35);
    o.start(t);
    o.stop(t + 0.45);
    this.burst(this.sfx, t, 'lowpass', 900, 0.9, 0.8 * vol, 0.002, 0.18, 0.3);
    this.burst(this.sfx, t + 0.02, 'bandpass', 2400, 4, 0.18 * vol, 0.002, 0.12);
  }

  /** A low werewolf snarl. */
  growl(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t);
    o.frequency.linearRampToValueAtTime(95, t + 0.4);
    o.frequency.linearRampToValueAtTime(60, t + 1.1);
    // rough amplitude flutter
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 23;
    const la = ctx.createGain();
    la.gain.value = 0.5;
    lfo.connect(la).connect(am.gain);
    const f = this.filter('lowpass', 650, 2);
    const env = this.env(t, 0.08, 0.5 * vol, 1.1);
    o.connect(am).connect(f).connect(env);
    this.out(env, this.sfx, 0.4);
    o.start(t);
    o.stop(t + 1.3);
    lfo.start(t);
    lfo.stop(t + 1.3);
    this.burst(this.sfx, t, 'bandpass', 380, 1.5, 0.25 * vol, 0.1, 0.9);
  }

  /** The victim's scream, cut short. */
  scream(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    const ctx = this.ctx!;
    const mix = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const la = ctx.createGain();
    la.gain.value = 40;
    lfo.connect(la);
    for (const det of [0, 14, -11]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(520, t);
      o.frequency.linearRampToValueAtTime(1350, t + 0.18);
      o.frequency.linearRampToValueAtTime(1200, t + 0.9);
      o.frequency.exponentialRampToValueAtTime(380, t + 1.25);
      o.detune.value = det * 10;
      la.connect(o.frequency);
      o.connect(mix);
      o.start(t);
      o.stop(t + 1.3);
    }
    lfo.start(t);
    lfo.stop(t + 1.3);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.3 * vol, t + 0.05);
    env.gain.setValueAtTime(0.28 * vol, t + 1.0);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    // vowel formants ("aah")
    mix.connect(this.filter('bandpass', 1000, 4)).connect(env);
    mix.connect(this.filter('bandpass', 2700, 6)).connect(env);
    mix.connect(this.filter('bandpass', 3600, 8)).connect(env);
    this.out(env, this.sfx, 0.8);
    this.burst(this.sfx, t, 'highpass', 3000, 0.6, 0.06 * vol, 0.03, 1.1);
    // the cut-off: a thump and a wet tearing hiss
    this.burst(this.sfx, t + 1.2, 'lowpass', 500, 1, 0.5 * vol, 0.004, 0.3, 0.4);
    this.burst(this.sfx, t + 1.22, 'bandpass', 1800, 1.2, 0.18 * vol, 0.01, 0.35);
  }

  /** 金钟罩: a struck temple bell (inharmonic partials, long shimmer). */
  bell(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    for (const [ratio, amp, decay] of [[1, 0.5, 3.2], [2.76, 0.3, 2.2], [5.4, 0.18, 1.4], [8.93, 0.1, 0.8], [0.5, 0.25, 3.6]] as const) {
      this.tone(this.sfx, t, 330 * ratio, 'sine', amp * 0.5 * vol, 0.004, decay, 0.9);
    }
    this.burst(this.sfx, t, 'highpass', 4000, 0.7, 0.2 * vol, 0.001, 0.08, 0.5);
  }

  seal(vol = 1, delay = 0) {
    const t = this.now(delay);
    if (t < 0) return;
    // two paper slaps + a stamp
    this.burst(this.sfx, t, 'bandpass', 3200, 1.5, 0.25 * vol, 0.002, 0.07);
    this.burst(this.sfx, t + 0.35, 'bandpass', 2800, 1.5, 0.25 * vol, 0.002, 0.07);
    const o = this.ctx!.createOscillator();
    o.frequency.setValueAtTime(160, t + 0.8);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.9);
    const g = this.env(t + 0.8, 0.003, 0.35 * vol, 0.18);
    o.connect(g);
    this.out(g, this.sfx, 0.3);
    o.start(t + 0.8);
    o.stop(t + 1.05);
  }

  howl(vol = 1, delay = 0, pitch = 1) {
    const t = this.now(delay);
    if (t < 0) return;
    const ctx = this.ctx!;
    const base = ctx.createGain();
    const env = this.env(t, 0.5, 0.18 * vol, 2.6);
    const f1 = this.filter('bandpass', 850 * pitch, 2.5);
    const f2 = this.filter('bandpass', 2300 * pitch, 4);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const la = ctx.createGain();
    la.gain.value = 9 * pitch;
    lfo.connect(la);
    for (const [type, mul, v] of [['sawtooth', 1, 0.6], ['sine', 1, 1], ['sine', 2, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      const fr = o.frequency;
      fr.setValueAtTime(260 * pitch * mul, t);
      fr.linearRampToValueAtTime(540 * pitch * mul, t + 0.7);
      fr.linearRampToValueAtTime(500 * pitch * mul, t + 2.0);
      fr.linearRampToValueAtTime(330 * pitch * mul, t + 3.0);
      la.connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = v;
      o.connect(og).connect(base);
      o.start(t);
      o.stop(t + 3.3);
    }
    lfo.start(t);
    lfo.stop(t + 3.3);
    base.connect(f1).connect(env);
    base.connect(f2).connect(env);
    this.out(env, this.sfx, 0.9);
  }

  squeak(vol = 1) {
    const t = this.now();
    if (t < 0) return;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < n; k++) {
      const at = t + k * (0.09 + Math.random() * 0.04);
      const o = this.ctx!.createOscillator();
      o.frequency.setValueAtTime(3000 + Math.random() * 600, at);
      o.frequency.linearRampToValueAtTime(4300 + Math.random() * 500, at + 0.05);
      const g = this.env(at, 0.004, 0.05 * vol, 0.06);
      o.connect(g);
      this.out(g, this.sfx, 0.1);
      o.start(at);
      o.stop(at + 0.1);
    }
  }

  batFlap(vol = 1) {
    const t = this.now();
    if (t < 0) return;
    const flaps = 6 + Math.floor(Math.random() * 4);
    for (let k = 0; k < flaps; k++) this.burst(this.sfx, t + k * 0.075, 'bandpass', 500 + Math.random() * 300, 1.2, 0.14 * vol, 0.01, 0.05);
    // faint high chirp
    this.tone(this.sfx, t + 0.1, 7000 + Math.random() * 1500, 'sine', 0.012 * vol, 0.003, 0.04, 0);
  }

  caw(vol = 1) {
    const t = this.now();
    if (t < 0) return;
    for (let k = 0; k < 2; k++) {
      const at = t + k * 0.38;
      const o = this.ctx!.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(720, at);
      o.frequency.linearRampToValueAtTime(480, at + 0.22);
      const f = this.filter('bandpass', 1300, 2.5);
      const g = this.env(at, 0.01, 0.07 * vol, 0.24);
      o.connect(f).connect(g);
      this.out(g, this.sfx, 0.5);
      o.start(at);
      o.stop(at + 0.3);
    }
  }

  /** 平安夜: a short warm major arpeggio with soft bells. */
  peaceful() {
    const t = this.now(0.2);
    if (t < 0) return;
    [74, 78, 81, 86, 90].forEach((n, k) => {
      this.tone(this.sfx, t + k * 0.16, midi(n), 'sine', 0.09, 0.01, 1.8, 0.6);
      this.tone(this.sfx, t + k * 0.16, midi(n) * 2.01, 'sine', 0.02, 0.01, 0.8, 0.6);
    });
    for (const n of [62, 66, 69]) this.tone(this.sfx, t, midi(n), 'triangle', 0.035, 0.4, 2.4, 0.7);
  }

  /** Someone died in the night: a scream falling into a low boom. */
  death() {
    const t = this.now(0.2);
    if (t < 0) return;
    const ctx = this.ctx!;
    const env = this.env(t, 0.06, 0.16, 1.3);
    const f1 = this.filter('bandpass', 950, 5);
    const f2 = this.filter('bandpass', 2600, 6);
    const mix = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7;
    const la = ctx.createGain();
    la.gain.value = 25;
    lfo.connect(la);
    for (const det of [0, 9, -7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(680, t);
      o.frequency.linearRampToValueAtTime(1150, t + 0.25);
      o.frequency.linearRampToValueAtTime(980, t + 0.8);
      o.frequency.exponentialRampToValueAtTime(420, t + 1.35);
      o.detune.value = det * 10;
      la.connect(o.frequency);
      o.connect(mix);
      o.start(t);
      o.stop(t + 1.45);
    }
    lfo.start(t);
    lfo.stop(t + 1.45);
    mix.connect(f1).connect(env);
    mix.connect(f2).connect(env);
    this.out(env, this.sfx, 0.7);
    this.burst(this.sfx, t, 'highpass', 2500, 0.5, 0.05, 0.05, 1.1);
    // boom + dissonant chord
    const b = t + 1.1;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, b);
    o.frequency.exponentialRampToValueAtTime(30, b + 1.5);
    const g = this.env(b, 0.01, 0.6, 2.2);
    o.connect(g);
    this.out(g, this.sfx, 0.5);
    o.start(b);
    o.stop(b + 2.4);
    for (const n of [48, 49, 54]) this.tone(this.sfx, b, midi(n), 'sawtooth', 0.025, 0.05, 2.6, 0.8);
  }

  /** 天亮: a rooster crowing (ko-ke-ko-KOOO), two birds far apart. */
  rooster(delay = 0) {
    const t0 = this.now(delay);
    if (t0 < 0) return;
    const crow = (t: number, pitch: number, vol: number) => {
      const ctx = this.ctx!;
      // syllables: [start, dur, f0 start, f0 peak, f0 end]
      const syl: [number, number, number, number, number][] = [
        [0, 0.16, 520, 620, 560],
        [0.2, 0.14, 600, 700, 640],
        [0.38, 0.16, 640, 760, 700],
        [0.6, 0.95, 700, 880, 520],
      ];
      for (const [st, dur, a, b, c] of syl) {
        const at = t + st;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(a * pitch, at);
        o.frequency.linearRampToValueAtTime(b * pitch, at + dur * 0.3);
        o.frequency.linearRampToValueAtTime(c * pitch, at + dur);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 28;
        const la = ctx.createGain();
        la.gain.value = 18 * pitch;
        lfo.connect(la).connect(o.frequency);
        const f1 = this.filter('bandpass', 1100 * pitch, 3);
        const f2 = this.filter('bandpass', 2600 * pitch, 5);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(0.16 * vol, at + 0.03);
        g.gain.setValueAtTime(0.16 * vol, at + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(f1).connect(g);
        o.connect(f2).connect(g);
        this.out(g, this.sfx, 0.5);
        o.start(at);
        lfo.start(at);
        o.stop(at + dur + 0.05);
        lfo.stop(at + dur + 0.05);
      }
    };
    crow(t0, 1, 1);
    crow(t0 + 1.9, 0.92, 0.45);
  }

  /** Short UI click for the human's own turn prompts. */
  chime() {
    const t = this.now();
    if (t < 0) return;
    this.tone(this.sfx, t, midi(81), 'sine', 0.05, 0.005, 0.5, 0.4);
    this.tone(this.sfx, t + 0.09, midi(86), 'sine', 0.04, 0.005, 0.6, 0.4);
  }
}

export const audio = new AudioEngine();
