import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Animals } from './animals';
import { Atmosphere } from './atmosphere';
import { PERSONAS } from '../personas';
import { characterCanvas, graveCanvas, pixelTexture, werewolfCanvas, type Look } from './pixel';
import { EXIT_PATH, billboardSprite, buildTown, seatAngle, seatPosition, type HouseRefs, type TownRefs } from './town';

/** Separable tilt-shift blur: sharp band around `focus` (0..1 screen y), blur grows away from it. */
const TiltShift = (dir: [number, number]) => ({
  uniforms: {
    tDiffuse: { value: null },
    texel: { value: new THREE.Vector2(dir[0] / 1024, dir[1] / 1024) },
    focus: { value: 0.45 },
    band: { value: 0.16 },
    strength: { value: 2.2 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 texel; uniform float focus; uniform float band; uniform float strength;
    varying vec2 vUv;
    void main(){
      float d = max(abs(vUv.y - focus) - band, 0.0);
      float s = clamp(d * strength * 4.0, 0.0, 3.0);
      vec4 sum = vec4(0.0);
      sum += texture2D(tDiffuse, vUv - 4.0 * texel * s) * 0.051;
      sum += texture2D(tDiffuse, vUv - 3.0 * texel * s) * 0.0918;
      sum += texture2D(tDiffuse, vUv - 2.0 * texel * s) * 0.12245;
      sum += texture2D(tDiffuse, vUv - 1.0 * texel * s) * 0.1531;
      sum += texture2D(tDiffuse, vUv) * 0.1633;
      sum += texture2D(tDiffuse, vUv + 1.0 * texel * s) * 0.1531;
      sum += texture2D(tDiffuse, vUv + 2.0 * texel * s) * 0.12245;
      sum += texture2D(tDiffuse, vUv + 3.0 * texel * s) * 0.0918;
      sum += texture2D(tDiffuse, vUv + 4.0 * texel * s) * 0.051;
      gl_FragColor = sum;
    }`,
});

/** Final grade: vignette, split toning, film grain, lightning lift. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    night: { value: 0 },
    flash: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float night; uniform float flash;
    varying vec2 vUv;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float lum = dot(c.rgb, vec3(0.299,0.587,0.114));
      vec3 shadowTint = mix(vec3(0.92,0.96,1.06), vec3(0.8,0.9,1.2), night);
      vec3 highTint = vec3(1.08,1.0,0.9);
      c.rgb *= mix(shadowTint, highTint, smoothstep(0.1, 0.7, lum));
      c.rgb = mix(vec3(lum), c.rgb, mix(0.85, 0.75, night));
      vec2 p = vUv - 0.5;
      float v = smoothstep(0.85, 0.25, length(p * vec2(1.0, 1.15)));
      c.rgb *= mix(0.55, 1.0, v);
      c.rgb += flash * 0.12;
      c.rgb += (rand(vUv * 800.0 + time) - 0.5) * 0.035;
      gl_FragColor = c;
    }`,
};

interface Actor {
  id: number;
  sprite: THREE.Mesh;
  /** Werewolf form, only ever shown to wolves (or god view) during the wolf turn. */
  wolf: THREE.Mesh;
  grave: THREE.Mesh;
  /** Standing spot on the plaza ring. */
  base: THREE.Vector3;
  /** Where the wolves gather in the plaza. */
  den: THREE.Vector3;
  status: 'alive' | 'dead' | 'exiled';
  /** Bumped by every new command; running sequences stop when it changes. */
  gen: number;
  phase: number;
}

/** Scene sounds, positioned by the stage (volume falls off with distance). */
export interface StageSounds {
  doorOpen(vol: number): void;
  doorClose(vol: number): void;
  doorBreak(vol: number): void;
  seal(vol: number): void;
  squeak(vol: number): void;
  flap(vol: number): void;
  caw(vol: number): void;
  thunder(distance: number): void;
}

interface Tween {
  t: number;
  dur: number;
  fn: (k: number) => void;
  resolve: () => void;
}

const WALK_SPEED = 2.6;
/** Camera limits: look around a little, never orbit freely. */
const MAX_DRAG_YAW = 0.52; // ±30°
const PITCH_MIN = 0.4;
const PITCH_MAX = 0.8;
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.25;

export interface ScreenPos {
  x: number;
  y: number;
  visible: boolean;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private tiltH: ShaderPass;
  private tiltV: ShaderPass;
  private grade: ShaderPass;
  private atmo: Atmosphere;
  private town: TownRefs;
  private animals: Animals;
  private actors: Actor[] = [];
  private billboards: THREE.Object3D[] = [];
  private focusRing: THREE.Mesh;
  private focusLight: THREE.SpotLight;
  private timer = new THREE.Timer();

  private nightTarget = 0;
  private focusId: number | null = null;
  private camTarget = new THREE.Vector3(0, 1, 0);
  private camDist = 40;
  private yaw = 0;
  private pitch = 0.55;
  /** Auto-framed heading (eased towards `yawGoal`). */
  private baseYaw = 0;
  /** Player drag offset, limited to a small arc around the framed view. */
  private dragYaw = 0;
  private userZoom = 1;

  onFrame?: (positions: ScreenPos[]) => void;
  onPick?: (id: number) => void;
  sounds?: StageSounds;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    this.atmo = new Atmosphere(this.scene);
    this.town = buildTown();
    this.scene.add(this.town.root);
    this.billboards.push(...this.town.billboards);

    this.animals = new Animals(this.town.perches, this.town.fliesSpots);
    this.scene.add(this.animals.group);
    this.billboards.push(...this.animals.billboards);

    for (let i = 0; i < 12; i++) {
      const tex = pixelTexture(characterCanvas(PERSONAS[i].look));
      const sprite = this.selfLit(billboardSprite(tex, 1.25, 1.875), tex);
      const base = seatPosition(i);
      sprite.position.copy(base);
      const wtex = pixelTexture(werewolfCanvas(i));
      const wolf = this.selfLit(billboardSprite(wtex, 1.9, 2.375), wtex);
      wolf.visible = false;
      const grave = billboardSprite(pixelTexture(graveCanvas('cross', i)), 0.8, 1.05);
      grave.position.copy(base);
      grave.visible = false;
      const da = seatAngle(i);
      const den = new THREE.Vector3(Math.cos(da) * 4.6, 0, Math.sin(da) * 4.6);
      this.scene.add(sprite, wolf, grave);
      this.billboards.push(sprite, wolf, grave);
      this.actors.push({ id: i, sprite, wolf, grave, base, den, status: 'alive', gen: 0, phase: i * 0.7 });
    }

    this.animals.onSqueak = (p) => this.sounds?.squeak(this.falloff(p));
    this.animals.onFlap = (p) => this.sounds?.flap(this.falloff(p));
    this.animals.onCaw = (p) => this.sounds?.caw(this.falloff(p) * 0.7);
    this.atmo.onStrike = (d) => this.sounds?.thunder(d);

    this.focusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 24),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.0, depthWrite: false, fog: false }),
    );
    this.focusRing.rotation.x = -Math.PI / 2;
    this.focusRing.position.y = 0.05;
    this.scene.add(this.focusRing);
    this.focusLight = new THREE.SpotLight(0xffc890, 0, 14, 0.45, 0.6, 1.2);
    this.focusLight.position.set(0, 8, 0);
    this.scene.add(this.focusLight, this.focusLight.target);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.tiltH = new ShaderPass(TiltShift([1, 0]));
    this.tiltV = new ShaderPass(TiltShift([0, 1]));
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────────────────── public API ─────────────────────────

  setNight(night: boolean) {
    this.nightTarget = night ? 1 : 0;
  }

  focus(id: number | null) {
    if (id !== null && id !== this.focusId) this.reframe(id);
    this.focusId = id;
  }

  /**
   * Swing the camera round to look at `id` from the plaza side, so only their own
   * house is behind them and no building blocks the view. Resets manual pitch/zoom.
   */
  private reframe(id: number) {
    const a = this.actors[id];
    const p = this.anchor(a) ?? a.base;
    // camera offset direction is (sin yaw, cos yaw): point it from the actor towards the centre
    this.yawGoal = Math.atan2(-p.x, -p.z);
    this.pitchGoal = 0.55;
    this.userZoom = 1;
    this.dragReset = true;
  }

  private yawGoal = 0;
  private pitchGoal: number | null = null;
  private dragReset = false;

  // ── choreography ──

  /** 天黑请闭眼: everyone still standing walks home and shuts the door. */
  nightFall(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const a of this.actors) {
      if (a.status !== 'alive') continue;
      const gen = ++a.gen;
      jobs.push(this.goInside(a, gen, a.sprite, Math.random() * 1.4));
    }
    return Promise.all(jobs).then(() => {});
  }

  /** Dawn: survivors open their doors and walk back to the plaza. */
  dayBreak(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const a of this.actors) {
      if (a.status !== 'alive') continue;
      const gen = ++a.gen;
      jobs.push(this.comeOutside(a, gen, a.sprite, a.base, 0.4 + Math.random() * 1.4));
    }
    return Promise.all(jobs).then(() => {});
  }

  /** Wolf turn, seen only by wolves: they step out in werewolf form. */
  wolvesOut(ids: number[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const id of ids) {
      const a = this.actors[id];
      if (a.status !== 'alive') continue;
      const gen = ++a.gen;
      a.sprite.visible = false;
      jobs.push(this.comeOutside(a, gen, a.wolf, a.den, Math.random() * 0.8));
    }
    return Promise.all(jobs).then(() => {});
  }

  wolvesIn(ids: number[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const id of ids) {
      const a = this.actors[id];
      if (!a.wolf.visible) continue;
      const gen = ++a.gen;
      jobs.push(this.goInside(a, gen, a.wolf, Math.random() * 0.6));
    }
    return Promise.all(jobs).then(() => {});
  }

  /** Killed (night kill, poison, hunter shot): a grave takes their place, their door is smashed. */
  killed(id: number) {
    const a = this.actors[id];
    if (a.status !== 'alive') return;
    a.status = 'dead';
    a.gen++;
    a.sprite.visible = false;
    a.wolf.visible = false;
    a.grave.visible = true;
    const h = this.town.houses[id];
    h.lit = false;
    h.state = 'broken';
    h.debris.visible = true;
    h.doorPivot.visible = false; // torn off: it now lies on the ground (part of debris)
    this.sounds?.doorBreak(this.falloff(h.doorstep));
  }

  /** Exiled by vote: they walk out of town along the path; their house goes dark and is sealed. No grave. */
  exiled(id: number) {
    const a = this.actors[id];
    if (a.status !== 'alive') return;
    a.status = 'exiled';
    const gen = ++a.gen;
    const h = this.town.houses[id];
    void (async () => {
      h.lit = false;
      h.state = 'sealed';
      await this.wait(0.6);
      h.seal.visible = true;
      this.sounds?.seal(this.falloff(h.doorstep));
      if (!a.sprite.visible) return;
      // join the path at its nearest point, then follow it out
      const start = EXIT_PATH.reduce((best, p, k) => (p.distanceTo(a.sprite.position) < EXIT_PATH[best].distanceTo(a.sprite.position) ? k : best), 0);
      for (const p of EXIT_PATH.slice(start)) {
        await this.walk(a.sprite, p, () => a.gen === gen, 1.8);
        if (a.gen !== gen) return;
      }
      a.sprite.visible = false;
    })();
  }

  resetAll() {
    for (const a of this.actors) {
      a.status = 'alive';
      a.gen++;
      a.sprite.visible = true;
      a.sprite.position.copy(a.base);
      a.wolf.visible = false;
      a.grave.visible = false;
    }
    for (const h of this.town.houses) {
      h.lit = true;
      h.state = 'normal';
      h.seal.visible = false;
      h.debris.visible = false;
      h.doorPivot.visible = true;
      h.doorPivot.rotation.set(0, 0, 0);
    }
    this.focus(null);
  }

  /** World position that labels / focus should follow, or null if hidden indoors. */
  private anchor(a: Actor): THREE.Vector3 | null {
    if (a.wolf.visible) return a.wolf.position;
    if (a.sprite.visible) return a.sprite.position;
    if (a.status === 'dead') return a.grave.position;
    return null;
  }

  private async goInside(a: Actor, gen: number, body: THREE.Mesh, delay: number) {
    const h = this.town.houses[a.id];
    await this.wait(delay);
    if (a.gen !== gen || !body.visible) return;
    await this.walk(body, h.doorstep, () => a.gen === gen);
    if (a.gen !== gen) return;
    await this.swingDoor(h, true);
    await this.walk(body, h.inside, () => a.gen === gen);
    body.visible = false;
    await this.swingDoor(h, false);
  }

  private async comeOutside(a: Actor, gen: number, body: THREE.Mesh, dest: THREE.Vector3, delay: number) {
    const h = this.town.houses[a.id];
    await this.wait(delay);
    if (a.gen !== gen || a.status !== 'alive') return;
    if (body.visible) {
      await this.walk(body, dest, () => a.gen === gen);
      return;
    }
    await this.swingDoor(h, true);
    if (a.gen !== gen) return;
    body.position.copy(h.inside);
    body.visible = true;
    await this.walk(body, h.doorstep, () => a.gen === gen);
    void this.swingDoor(h, false);
    await this.walk(body, dest, () => a.gen === gen);
  }

  private async swingDoor(h: HouseRefs, open: boolean) {
    if (h.state !== 'normal') return;
    const from = h.doorPivot.rotation.y;
    const to = open ? 1.45 : 0;
    if (open) this.sounds?.doorOpen(this.falloff(h.doorstep));
    await this.tween(open ? 0.55 : 0.4, (k) => this.setDoor(h, from + (to - from) * (open ? k : k * k)));
    if (!open) this.sounds?.doorClose(this.falloff(h.doorstep));
  }

  private setDoor(h: HouseRefs, angle: number) {
    h.doorPivot.rotation.y = angle;
  }

  /** Walk `body` to `to` with a stepping bob; stops early if `alive()` turns false. */
  private walk(body: THREE.Mesh, to: THREE.Vector3, alive: () => boolean, speed = WALK_SPEED): Promise<void> {
    const from = body.position.clone().setY(0);
    const dist = from.distanceTo(to);
    if (dist < 0.05) return Promise.resolve();
    const dir = to.clone().sub(from);
    return this.tween(dist / speed, (k) => {
      if (!alive()) return;
      body.position.lerpVectors(from, to, k);
      body.position.y = Math.abs(Math.sin(k * dist * 3.2)) * 0.09;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      body.scale.x = dir.dot(right) >= 0 ? 1 : -1;
    }).then(() => {
      if (alive()) body.position.y = 0;
    });
  }

  private tweens: Tween[] = [];

  private tween(dur: number, fn: (k: number) => void): Promise<void> {
    return new Promise((resolve) => this.tweens.push({ t: 0, dur: Math.max(dur, 0.001), fn, resolve }));
  }

  private wait(sec: number) {
    return this.tween(sec, () => {});
  }

  private stepTweens(dt: number) {
    const done: Tween[] = [];
    for (const tw of this.tweens) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(k);
      if (k >= 1) done.push(tw);
    }
    if (done.length) {
      this.tweens = this.tweens.filter((x) => !done.includes(x));
      for (const d of done) d.resolve();
    }
  }

  /** 1 near the camera focus, fading with distance. */
  private falloff(p: THREE.Vector3): number {
    return THREE.MathUtils.clamp(1.2 - p.distanceTo(this.camTarget) / 45, 0.45, 1);
  }

  private selfLit(m: THREE.Mesh, tex: THREE.Texture): THREE.Mesh {
    const sm = m.material as THREE.MeshStandardMaterial;
    sm.emissiveMap = tex;
    sm.emissive = new THREE.Color(0xffffff);
    sm.emissiveIntensity = 0.15;
    return m;
  }

  /** Dress each seat as its persona (called when a game starts). */
  setLooks(looks: Look[]) {
    looks.forEach((look, i) => {
      const tex = pixelTexture(characterCanvas(look));
      const sprite = this.actors[i].sprite;
      const m = sprite.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.map = tex;
      m.emissiveMap = tex;
      m.needsUpdate = true;
      (sprite.customDepthMaterial as THREE.MeshDepthMaterial).map = tex;
    });
  }

  /** Tint the human's own character slightly so they can find themselves. */
  highlightSelf(id: number) {
    this.selfId = id;
  }
  private selfId = -1;

  // ───────────────────────── internals ─────────────────────────

  private bindInput() {
    const el = this.renderer.domElement;
    let dragging = false;
    let moved = 0;
    let lx = 0;
    let ly = 0;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = 0;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX;
      ly = e.clientY;
      // small town, fixed cast: only a gentle look-around, no free 360° orbit
      this.dragYaw = THREE.MathUtils.clamp(this.dragYaw - dx * 0.004, -MAX_DRAG_YAW, MAX_DRAG_YAW);
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.002, PITCH_MIN, PITCH_MAX);
      this.pitchGoal = null;
      this.dragReset = false;
    });
    el.addEventListener('pointerup', (e) => {
      dragging = false;
      if (moved < 6) this.pick(e);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.userZoom = THREE.MathUtils.clamp(this.userZoom * (1 + e.deltaY * 0.001), ZOOM_MIN, ZOOM_MAX);
      },
      { passive: false },
    );
  }

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.actors.flatMap((a) => [a.sprite, a.wolf, a.grave]).filter((m) => m.visible), false);
    if (hits.length) {
      const id = this.actors.find((a) => [a.sprite, a.wolf, a.grave].includes(hits[0].object as THREE.Mesh))!.id;
      this.onPick?.(id);
    }
  }

  private resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    (this.tiltH.uniforms.texel.value as THREE.Vector2).set(1 / (w * pr), 0);
    (this.tiltV.uniforms.texel.value as THREE.Vector2).set(0, 1 / (h * pr));
  }

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();

    // day/night easing
    this.atmo.mix += (this.nightTarget - this.atmo.mix) * Math.min(1, dt * 0.8);
    const n = this.atmo.mix;
    this.atmo.update(dt, t);
    this.stepTweens(dt);
    for (const w of this.town.windows) w.emissiveIntensity = THREE.MathUtils.lerp(0.15, 2.2, n);
    for (const h of this.town.houses) {
      const glow = h.lit ? THREE.MathUtils.lerp(0.15, 2.2, n) : 0;
      for (const w of h.windows) w.emissiveIntensity += (glow - w.emissiveIntensity) * Math.min(1, dt * 2);
    }
    this.town.lanterns.forEach((l, i) => {
      const flicker = 0.85 + Math.sin(t * 9 + i * 3) * 0.08 + Math.sin(t * 23 + i) * 0.06;
      l.intensity = THREE.MathUtils.lerp(4, 22, n) * flicker;
    });
    this.town.lanternFlames.forEach((f, i) => {
      (f.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.5 + Math.sin(t * 11 + i) * 0.6;
    });

    // characters: idle breathing; sprites stay readable at night (HD-2D style self-lit sprites)
    for (const a of this.actors) {
      for (const body of [a.sprite, a.wolf]) {
        if (!body.visible) continue;
        const sm = body.material as THREE.MeshStandardMaterial;
        sm.emissiveIntensity = THREE.MathUtils.lerp(0.12, 0.4, n) + (a.id === this.selfId ? 0.12 : 0) + (body === a.wolf ? 0.1 : 0);
        const speaking = this.focusId === a.id;
        const bob = Math.sin(t * (speaking ? 7 : 2) + a.phase);
        body.scale.y = 1 + bob * (speaking ? 0.035 : body === a.wolf ? 0.03 : 0.015);
      }
    }

    // camera
    const focusedActor = this.focusId !== null ? this.actors[this.focusId] : null;
    const focusPos = focusedActor ? this.anchor(focusedActor) : null;
    const focused = focusPos ? { base: focusPos.clone().setY(0) } : null;
    const tgt = focused ? focused.base.clone().setY(1.2).multiplyScalar(0.5) : new THREE.Vector3(0, 1, 0);
    this.camTarget.lerp(tgt, Math.min(1, dt * 1.6));
    const dist = (focused ? 34 : 40) * this.userZoom; // stay wide enough to keep most of the ring (and their bubbles) in view
    this.camDist += (dist - this.camDist) * Math.min(1, dt * 1.4);
    const sway = Math.sin(t * 0.05) * 0.12;
    {
      // ease the framed heading the shortest way round (the idle sway is part of the final angle)
      const want = this.yawGoal - sway;
      const diff = Math.atan2(Math.sin(want - this.baseYaw), Math.cos(want - this.baseYaw));
      this.baseYaw += diff * Math.min(1, dt * 2.2);
    }
    if (this.dragReset) {
      this.dragYaw += (0 - this.dragYaw) * Math.min(1, dt * 2.2);
      if (Math.abs(this.dragYaw) < 0.002) this.dragReset = false;
    }
    if (this.pitchGoal !== null) {
      this.pitch += (this.pitchGoal - this.pitch) * Math.min(1, dt * 2.2);
      if (Math.abs(this.pitchGoal - this.pitch) < 0.002) this.pitchGoal = null;
    }
    this.yaw = this.baseYaw + this.dragYaw + sway;
    const cp = this.pitch;
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.yaw) * Math.cos(cp) * this.camDist,
      this.camTarget.y + Math.sin(cp) * this.camDist,
      this.camTarget.z + Math.cos(this.yaw) * Math.cos(cp) * this.camDist,
    );
    this.camera.lookAt(this.camTarget);
    this.camera.updateMatrixWorld();

    // focus ring/spot
    const ringMat = this.focusRing.material as THREE.MeshBasicMaterial;
    if (focused) {
      this.focusRing.position.set(focused.base.x, 0.05, focused.base.z);
      ringMat.opacity += (0.85 - ringMat.opacity) * Math.min(1, dt * 4);
      this.focusRing.scale.setScalar(1 + Math.sin(t * 4) * 0.06);
      this.focusLight.position.set(focused.base.x * 0.7, 9, focused.base.z * 0.7);
      this.focusLight.target.position.copy(focused.base);
      this.focusLight.intensity += (60 - this.focusLight.intensity) * Math.min(1, dt * 3);
    } else {
      ringMat.opacity += (0 - ringMat.opacity) * Math.min(1, dt * 4);
      this.focusLight.intensity += (0 - this.focusLight.intensity) * Math.min(1, dt * 3);
    }

    // billboards face camera around Y
    for (const b of this.billboards) {
      const wp = b.getWorldPosition(new THREE.Vector3());
      const parentRot = b.parent && b.parent !== this.scene ? b.parent.rotation.y : 0;
      b.rotation.y = Math.atan2(this.camera.position.x - wp.x, this.camera.position.z - wp.z) - parentRot;
    }

    this.animals.update(t, this.camera, n);

    // post
    const ft = this.camTarget.clone().project(this.camera);
    const focusY = THREE.MathUtils.clamp((ft.y + 1) / 2, 0.2, 0.8);
    for (const p of [this.tiltH, this.tiltV]) {
      p.uniforms.focus.value += (focusY - p.uniforms.focus.value) * Math.min(1, dt * 3);
      p.uniforms.band.value = focused ? 0.1 : 0.16;
    }
    this.bloom.strength = THREE.MathUtils.lerp(0.35, 0.9, n) + this.atmo.lightning * 0.4;
    this.grade.uniforms.time.value = t;
    this.grade.uniforms.night.value = n;
    this.grade.uniforms.flash.value = this.atmo.lightning * n;
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.05, 1.25, n);

    this.composer.render(dt);

    if (this.onFrame) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const out: ScreenPos[] = this.actors.map((a) => {
        const anchor = this.anchor(a);
        if (!anchor) return { x: 0, y: 0, visible: false };
        const height = a.wolf.visible ? 2.7 : a.status === 'dead' ? 1.3 : 2.25;
        const p = anchor.clone().setY(height).project(this.camera);
        return {
          x: rect.left + ((p.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - p.y) / 2) * rect.height,
          visible: p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1,
        };
      });
      this.onFrame(out);
    }
  }
}
