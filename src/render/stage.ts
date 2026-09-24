import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Animals } from './animals';
import { Atmosphere } from './atmosphere';
import { characterCanvas, graveCanvas, paletteFor, pixelTexture } from './pixel';
import { billboardSprite, buildTown, seatPosition, type TownRefs } from './town';

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
  grave: THREE.Mesh;
  base: THREE.Vector3;
  alive: boolean;
  phase: number;
}

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
  private userYaw = 0;
  private userZoom = 1;

  onFrame?: (positions: ScreenPos[]) => void;
  onPick?: (id: number) => void;

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
      const tex = pixelTexture(characterCanvas(paletteFor(i)));
      const sprite = billboardSprite(tex, 1.25, 1.875);
      const sm = sprite.material as THREE.MeshStandardMaterial;
      sm.emissiveMap = tex;
      sm.emissive = new THREE.Color(0xffffff);
      sm.emissiveIntensity = 0.15;
      const base = seatPosition(i);
      sprite.position.copy(base);
      sprite.userData.seat = i;
      const grave = billboardSprite(pixelTexture(graveCanvas('cross', i)), 0.8, 1.05);
      grave.position.copy(base);
      grave.visible = false;
      this.scene.add(sprite, grave);
      this.billboards.push(sprite, grave);
      this.actors.push({ id: i, sprite, grave, base, alive: true, phase: i * 0.7 });
    }

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
    this.focusId = id;
  }

  setAlive(id: number, alive: boolean) {
    const a = this.actors[id];
    if (a.alive === alive) return;
    a.alive = alive;
    a.sprite.visible = alive;
    a.grave.visible = !alive;
  }

  resetAll() {
    for (const a of this.actors) this.setAlive(a.id, true);
    this.focus(null);
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
      this.userYaw -= dx * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.003, 0.25, 1.1);
    });
    el.addEventListener('pointerup', (e) => {
      dragging = false;
      if (moved < 6) this.pick(e);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.userZoom = THREE.MathUtils.clamp(this.userZoom * (1 + e.deltaY * 0.001), 0.45, 1.6);
      },
      { passive: false },
    );
  }

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.actors.flatMap((a) => [a.sprite, a.grave]).filter((m) => m.visible), false);
    if (hits.length) {
      const id = this.actors.find((a) => a.sprite === hits[0].object || a.grave === hits[0].object)!.id;
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
    for (const w of this.town.windows) w.emissiveIntensity = THREE.MathUtils.lerp(0.15, 2.2, n);
    this.town.lanterns.forEach((l, i) => {
      const flicker = 0.85 + Math.sin(t * 9 + i * 3) * 0.08 + Math.sin(t * 23 + i) * 0.06;
      l.intensity = THREE.MathUtils.lerp(4, 22, n) * flicker;
    });
    this.town.lanternFlames.forEach((f, i) => {
      (f.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.5 + Math.sin(t * 11 + i) * 0.6;
    });

    // characters: idle breathing; sprites stay readable at night (HD-2D style self-lit sprites)
    for (const a of this.actors) {
      if (!a.alive) continue;
      const sm = a.sprite.material as THREE.MeshStandardMaterial;
      sm.emissiveIntensity = THREE.MathUtils.lerp(0.12, 0.4, n) + (a.id === this.selfId ? 0.12 : 0);
      const speaking = this.focusId === a.id;
      const bob = Math.sin(t * (speaking ? 7 : 2) + a.phase);
      a.sprite.scale.y = 1 + bob * (speaking ? 0.035 : 0.015);
      a.sprite.position.y = speaking ? Math.max(0, bob) * 0.05 : 0;
    }

    // camera
    const focused = this.focusId !== null ? this.actors[this.focusId] : null;
    const tgt = focused ? focused.base.clone().setY(1.2).multiplyScalar(0.8) : new THREE.Vector3(0, 1, 0);
    this.camTarget.lerp(tgt, Math.min(1, dt * 1.6));
    const dist = (focused ? 26 : 40) * this.userZoom;
    this.camDist += (dist - this.camDist) * Math.min(1, dt * 1.4);
    this.yaw = this.userYaw + Math.sin(t * 0.05) * 0.12;
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

    this.animals.update(t, this.camera);

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
        const p = a.base.clone().setY(a.alive ? 2.25 : 1.3).project(this.camera);
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
