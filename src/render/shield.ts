import * as THREE from 'three';
import type { HouseRefs } from './town';

/**
 * 金钟罩: when the wolves attack a house the guard protects, a golden bell of
 * light flares over it with every blow, rippling out from where it was struck.
 */

// bell profile (radius, height), bottom rim to crown, as fractions of R / H
const PROFILE: [number, number][] = [
  [1.08, 0],
  [1.0, 0.06],
  [0.92, 0.16],
  [0.86, 0.34],
  [0.82, 0.55],
  [0.76, 0.72],
  [0.62, 0.86],
  [0.42, 0.95],
  [0.2, 0.99],
  [0.001, 1],
];

const vert = `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vLocal;
  varying vec2 vUv;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vLocal = position;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`;

const frag = `
  uniform float power;
  uniform float time;
  uniform vec3 hit;
  uniform float hitAge;
  uniform float scale;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vLocal;
  varying vec2 vUv;
  void main(){
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
    // a lattice of ribs and bands, like a cast bell
    float ribs = smoothstep(0.9, 1.0, abs(fract(vUv.x * 24.0) * 2.0 - 1.0));
    float bands = smoothstep(0.86, 1.0, abs(fract(vUv.y * 7.0 + 0.5) * 2.0 - 1.0));
    float rim = smoothstep(0.08, 0.0, vUv.y) * 1.5;
    float shimmer = 0.75 + 0.25 * sin(vUv.y * 40.0 - time * 6.0);
    // ring rippling out from the point that was struck
    float d = distance(vLocal, hit) / scale;
    float wave = exp(-pow((d - hitAge * 1.6) * 7.0, 2.0)) * exp(-hitAge * 1.8);
    float spot = exp(-d * d * 18.0) * exp(-hitAge * 5.0);
    float a = power * (0.08 + fres * 0.8 + (ribs + bands) * 0.35 * shimmer + rim) + wave * 1.4 + spot * 2.0;
    vec3 gold = vec3(1.25, 0.72, 0.12);
    gl_FragColor = vec4(gold * a, 1.0);
  }`;

export class Shield {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private power = 0;
  private hitAge = 10;

  constructor(scene: THREE.Scene) {
    const g = new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 48, 0, Math.PI * 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        power: { value: 0 },
        time: { value: 0 },
        hit: { value: new THREE.Vector3() },
        hitAge: { value: 10 },
        scale: { value: 1 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** Flare the bell over `house`, struck at world point `at`; `power` > 1 for the final repulse. */
  strike(house: HouseRefs, at: THREE.Vector3, power = 1) {
    const { w, d, h } = house.size;
    const R = Math.hypot(w, d) / 2 + 0.7;
    const H = h + 3.2;
    this.mesh.position.copy(house.group.position);
    this.mesh.rotation.copy(house.group.rotation);
    this.mesh.scale.set(R, H, R);
    this.mesh.updateMatrixWorld(true);
    // the ripple is measured in the mesh's own (unit-bell) space
    const local = this.mesh.worldToLocal(at.clone());
    (this.mat.uniforms.hit.value as THREE.Vector3).copy(local);
    this.mat.uniforms.scale.value = 1;
    this.hitAge = 0;
    this.power = Math.max(this.power, power);
    this.mesh.visible = true;
  }

  hide() {
    this.power = 0;
    this.mesh.visible = false;
  }

  update(dt: number, t: number) {
    if (!this.mesh.visible) return;
    this.hitAge += dt;
    this.power *= Math.exp(-dt * 1.4);
    this.mat.uniforms.power.value = this.power;
    this.mat.uniforms.time.value = t;
    this.mat.uniforms.hitAge.value = this.hitAge;
    if (this.power < 0.01 && this.hitAge > 2) this.mesh.visible = false;
  }
}
