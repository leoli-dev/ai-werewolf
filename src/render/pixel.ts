import * as THREE from 'three';
import { Rng } from '../game/rng';

/** Procedurally drawn pixel-art textures (no external assets). */

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

export function pixelTexture(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const hex = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;

function jitter(base: [number, number, number], amt: number, rng: Rng): string {
  const k = (rng.next() - 0.5) * amt;
  return hex(base[0] + k, base[1] + k, base[2] + k);
}

function noiseFill(ctx: Ctx, w: number, h: number, base: [number, number, number], amt: number, rng: Rng) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    ctx.fillStyle = jitter(base, amt, rng);
    ctx.fillRect(x, y, 1, 1);
  }
}

export type Material = 'grass' | 'dirt' | 'cobble' | 'plaster' | 'wood' | 'roof' | 'stone' | 'thatch' | 'darkwood';

const cache = new Map<string, THREE.CanvasTexture>();

export function surface(kind: Material, seed = 1): THREE.CanvasTexture {
  const key = `${kind}:${seed}`;
  if (cache.has(key)) return cache.get(key)!;
  const rng = new Rng(seed * 977 + kind.length * 13);
  const S = 32;
  const [c, ctx] = canvas(S, S);
  switch (kind) {
    case 'grass': {
      noiseFill(ctx, S, S, [58, 66, 44], 18, rng);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = rng.next() < 0.5 ? '#4a5536' : '#6b6a45';
        ctx.fillRect(rng.int(S), rng.int(S), 1, 2);
      }
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = '#5b4d3a';
        ctx.fillRect(rng.int(S), rng.int(S), 2, 1);
      }
      break;
    }
    case 'dirt': {
      noiseFill(ctx, S, S, [92, 76, 58], 16, rng);
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = rng.next() < 0.5 ? '#6f6254' : '#4c3e31';
        ctx.fillRect(rng.int(S), rng.int(S), 1 + rng.int(2), 1);
      }
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = 'rgba(40,48,58,0.45)'; // puddles
        const x = rng.int(S), y = rng.int(S);
        ctx.fillRect(x, y, 3 + rng.int(3), 1);
      }
      break;
    }
    case 'cobble':
    case 'stone': {
      const big = kind === 'stone';
      ctx.fillStyle = big ? '#3b3a3c' : '#3a3834';
      ctx.fillRect(0, 0, S, S);
      const bh = big ? 8 : 6;
      for (let y = 0; y < S; y += bh) {
        const off = (y / bh) % 2 ? (big ? 8 : 4) : 0;
        const bw = big ? 16 : 8;
        for (let x = -off; x < S; x += bw) {
          const base: [number, number, number] = big ? [104, 102, 104] : [96, 92, 84];
          const k = (rng.next() - 0.5) * 30;
          for (let yy = 1; yy < bh - 1; yy++) for (let xx = 1; xx < bw - 1; xx++) {
            const px = x + xx;
            if (px < 0 || px >= S) continue;
            const kk = k + (rng.next() - 0.5) * 12 - (yy === bh - 2 ? 14 : 0) + (yy === 1 ? 10 : 0);
            ctx.fillStyle = hex(base[0] + kk, base[1] + kk, base[2] + kk);
            ctx.fillRect(px, y + yy, 1, 1);
          }
          if (rng.next() < 0.25) {
            ctx.fillStyle = '#4d5a3a'; // moss
            ctx.fillRect(Math.max(0, x + 1 + rng.int(bw - 3)), y + bh - 2, 2, 1);
          }
        }
      }
      break;
    }
    case 'plaster': {
      noiseFill(ctx, S, S, [156, 144, 122], 14, rng);
      // stains
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = 'rgba(70,60,50,0.25)';
        ctx.fillRect(rng.int(S), rng.int(S), 2 + rng.int(4), 1 + rng.int(3));
      }
      // half-timber frame
      ctx.fillStyle = '#3e2c20';
      ctx.fillRect(0, 0, S, 2);
      ctx.fillRect(0, S - 2, S, 2);
      ctx.fillRect(0, 0, 2, S);
      ctx.fillRect(S / 2 - 1, 0, 2, S);
      for (let i = 0; i < S / 2; i++) {
        ctx.fillRect(2 + i, S - 2 - i * 1.8, 2, 2);
      }
      break;
    }
    case 'wood':
    case 'darkwood': {
      const base: [number, number, number] = kind === 'wood' ? [104, 76, 52] : [62, 46, 36];
      for (let y = 0; y < S; y++) {
        const plank = Math.floor(y / 6);
        const pk = ((plank * 37) % 11) - 5;
        for (let x = 0; x < S; x++) {
          const k = pk * 2 + (rng.next() - 0.5) * 10 + (Math.sin(x * 0.7 + plank) > 0.8 ? -10 : 0);
          ctx.fillStyle = hex(base[0] + k, base[1] + k, base[2] + k);
          ctx.fillRect(x, y, 1, 1);
        }
        if (y % 6 === 5) {
          ctx.fillStyle = '#22170f';
          ctx.fillRect(0, y, S, 1);
        }
      }
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = '#1c130c';
        ctx.fillRect(rng.int(S), rng.int(S), 1, 1);
      }
      break;
    }
    case 'roof': {
      ctx.fillStyle = '#231a18';
      ctx.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 4) {
        const off = (y / 4) % 2 ? 3 : 0;
        for (let x = -off; x < S; x += 6) {
          const k = (rng.next() - 0.5) * 22;
          const missing = rng.next() < 0.05;
          for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 5; xx++) {
            if (x + xx < 0) continue;
            ctx.fillStyle = missing ? '#15100e' : hex(86 + k - yy * 8, 50 + k - yy * 6, 42 + k - yy * 6);
            ctx.fillRect(x + xx, y + yy, 1, 1);
          }
        }
      }
      break;
    }
    case 'thatch': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const k = (rng.next() - 0.5) * 30 + (y % 5 === 4 ? -24 : 0);
        ctx.fillStyle = hex(112 + k, 94 + k, 58 + k);
        ctx.fillRect(x, y, 1, 1);
      }
      break;
    }
  }
  const t = pixelTexture(c, true);
  cache.set(key, t);
  return t;
}

// ───────────────────────── characters ─────────────────────────

export interface Palette {
  skin: string;
  hair: string;
  cloak: string;
  cloakDark: string;
  shirt: string;
  pants: string;
  hood: boolean;
  beard: boolean;
  hat: boolean;
}

const SKINS = ['#e0b48f', '#c99873', '#a8775a', '#e8c3a2', '#8d5f45'];
const HAIRS = ['#2b1d14', '#5a3a22', '#8a6a3a', '#bdb6a8', '#1a1a1e', '#7a3a1e'];
const CLOAKS: [string, string][] = [
  ['#5c3a2e', '#3b241c'], ['#34464f', '#222e35'], ['#4b5233', '#303521'], ['#5b4a6b', '#3b2f47'],
  ['#6b5a3a', '#463a24'], ['#743434', '#4a2020'], ['#3b3b44', '#25252c'], ['#2f4a3a', '#1e3026'],
  ['#6a5a4a', '#46392e'], ['#4a3f5c', '#2f283c'], ['#7a6040', '#503e28'], ['#3a4a5c', '#26313d'],
];

export function paletteFor(i: number): Palette {
  const rng = new Rng(i * 131 + 7);
  const [cloak, cloakDark] = CLOAKS[i % CLOAKS.length];
  return {
    skin: rng.pick(SKINS),
    hair: rng.pick(HAIRS),
    cloak,
    cloakDark,
    shirt: rng.pick(['#9a8a6a', '#7a7466', '#b0a080', '#6a5c4c']),
    pants: rng.pick(['#3a3028', '#2c2a2e', '#4a3c2c']),
    hood: rng.next() < 0.4,
    beard: rng.next() < 0.35,
    hat: rng.next() < 0.25,
  };
}

/** 16×24 villager sprite with 1px dark outline. */
export function characterCanvas(p: Palette): HTMLCanvasElement {
  const W = 16, H = 24;
  const [c, ctx] = canvas(W, H);
  const r = (x: number, y: number, w: number, h: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  };
  // legs & boots
  r(5, 18, 2, 4, p.pants);
  r(9, 18, 2, 4, p.pants);
  r(4, 22, 3, 2, '#1e1712');
  r(9, 22, 3, 2, '#1e1712');
  // body / cloak
  r(4, 10, 8, 9, p.cloak);
  r(10, 10, 2, 9, p.cloakDark);
  r(6, 10, 4, 7, p.shirt);
  r(7, 10, 2, 7, p.cloak);
  r(4, 15, 8, 1, '#2a1d14'); // belt
  r(7, 15, 1, 1, '#c8a24a'); // buckle
  // arms
  r(3, 11, 1, 6, p.cloakDark);
  r(12, 11, 1, 6, p.cloakDark);
  r(3, 17, 1, 1, p.skin);
  r(12, 17, 1, 1, p.skin);
  // head
  r(5, 3, 6, 7, p.skin);
  r(10, 4, 1, 6, 'rgba(0,0,0,0.12)');
  r(6, 6, 1, 1, '#1a1210');
  r(9, 6, 1, 1, '#1a1210');
  if (p.beard) r(5, 8, 6, 2, p.hair);
  else r(7, 8, 2, 1, 'rgba(90,40,30,0.5)');
  if (p.hood) {
    r(4, 2, 8, 2, p.cloak);
    r(4, 2, 1, 8, p.cloak);
    r(11, 2, 1, 8, p.cloakDark);
    r(5, 1, 6, 1, p.cloak);
  } else if (p.hat) {
    r(3, 3, 10, 1, '#2a2420');
    r(5, 0, 6, 3, '#3a3028');
    r(5, 2, 6, 1, '#6a2a20');
  } else {
    r(5, 2, 6, 2, p.hair);
    r(4, 3, 1, 4, p.hair);
    r(11, 3, 1, 4, p.hair);
  }
  outline(ctx, W, H, '#120d0b');
  return c;
}

function outline(ctx: Ctx, W: number, H: number, col: string) {
  const img = ctx.getImageData(0, 0, W, H);
  const a = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : img.data[(y * W + x) * 4 + 3]);
  const pts: [number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a(x, y)) continue;
    if (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1)) pts.push([x, y]);
  }
  ctx.fillStyle = col;
  for (const [x, y] of pts) ctx.fillRect(x, y, 1, 1);
}

// ───────────────────────── small sprites ─────────────────────────

export function crowFrames(): HTMLCanvasElement[] {
  const frames: HTMLCanvasElement[] = [];
  for (let f = 0; f < 2; f++) {
    const [c, ctx] = canvas(12, 8);
    ctx.fillStyle = '#121216';
    ctx.fillRect(4, 3, 5, 2); // body
    ctx.fillRect(9, 2, 2, 2); // head
    ctx.fillStyle = '#6b5a2a';
    ctx.fillRect(11, 3, 1, 1); // beak
    ctx.fillStyle = '#121216';
    ctx.fillRect(2, 4, 2, 1); // tail
    if (f === 0) {
      ctx.fillRect(5, 0, 2, 3);
      ctx.fillRect(4, 0, 1, 1);
    } else {
      ctx.fillRect(5, 5, 2, 3);
      ctx.fillRect(4, 7, 1, 1);
    }
    frames.push(c);
  }
  return frames;
}

export function perchedCrow(): HTMLCanvasElement {
  const [c, ctx] = canvas(8, 8);
  ctx.fillStyle = '#121216';
  ctx.fillRect(2, 2, 4, 4);
  ctx.fillRect(5, 1, 2, 2);
  ctx.fillRect(1, 5, 2, 1);
  ctx.fillStyle = '#6b5a2a';
  ctx.fillRect(7, 2, 1, 1);
  ctx.fillRect(3, 6, 1, 2);
  ctx.fillRect(5, 6, 1, 2);
  ctx.fillStyle = '#c0a040';
  ctx.fillRect(6, 1, 1, 1);
  return c;
}

export function ratFrames(): HTMLCanvasElement[] {
  const frames: HTMLCanvasElement[] = [];
  for (let f = 0; f < 2; f++) {
    const [c, ctx] = canvas(10, 5);
    ctx.fillStyle = '#3a3230';
    ctx.fillRect(2, 1, 5, 3);
    ctx.fillRect(7, 2, 2, 2);
    ctx.fillStyle = '#a07070';
    ctx.fillRect(9, 3, 1, 1); // nose
    ctx.fillRect(0, f ? 2 : 3, 2, 1); // tail
    ctx.fillStyle = '#2a2220';
    ctx.fillRect(f ? 3 : 2, 4, 1, 1);
    ctx.fillRect(f ? 5 : 6, 4, 1, 1);
    ctx.fillStyle = '#e0d0a0';
    ctx.fillRect(8, 2, 1, 1); // eye
    frames.push(c);
  }
  return frames;
}

export function graveCanvas(kind: 'cross' | 'stone', seed = 0): HTMLCanvasElement {
  const [c, ctx] = canvas(12, 16);
  const rng = new Rng(seed + 5);
  if (kind === 'cross') {
    ctx.fillStyle = '#4a3a2c';
    ctx.fillRect(5, 1, 2, 15);
    ctx.fillRect(2, 4, 8, 2);
    ctx.fillStyle = '#2e241b';
    ctx.fillRect(6, 1, 1, 15);
  } else {
    for (let y = 2; y < 16; y++) for (let x = 2; x < 10; x++) {
      if (y < 4 && (x < 3 || x > 8)) continue;
      const k = (rng.next() - 0.5) * 16;
      ctx.fillStyle = hex(92 + k, 92 + k, 96 + k);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = '#3a3a40';
    ctx.fillRect(4, 6, 4, 1);
    ctx.fillRect(5, 5, 2, 4);
    ctx.fillStyle = '#4d5a3a';
    ctx.fillRect(2, 14, 3, 2);
  }
  outline(ctx, 12, 16, '#141112');
  return c;
}

/** Soft cloud noise (not pixel) for the overcast sky layer. */
export function cloudTexture(seed = 3): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.imageSmoothingEnabled = true;
  const rng = new Rng(seed);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 20 + rng.next() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const shade = 60 + rng.int(50);
    g.addColorStop(0, `rgba(${shade},${shade},${shade + 8},0.35)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
