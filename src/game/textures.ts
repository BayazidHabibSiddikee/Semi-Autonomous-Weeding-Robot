import * as THREE from 'three';

function createSeededRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ProceduralTexturePack {
  plywood: THREE.CanvasTexture;
  plywoodDark: THREE.CanvasTexture;
  soilAlbedo: THREE.CanvasTexture;
  soilBump: THREE.CanvasTexture;
  pcbGreen: THREE.CanvasTexture;
  pcbRed: THREE.CanvasTexture;
  pcbBlack: THREE.CanvasTexture;
  pcbBlue: THREE.CanvasTexture;
  workbenchMat: THREE.CanvasTexture;
  contactShadow: THREE.CanvasTexture;
  dispose: () => void;
}

function configureColorTex(tex: THREE.CanvasTexture, maxAniso: number, repeatX = 1, repeatY = 1) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

function makeWoodTexture(baseHex: string, grainHex: string, seed: number, maxAniso: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const rng = createSeededRng(seed);

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 160; i++) {
    const y = rng() * 512;
    const h = 1 + rng() * 4.5;
    ctx.fillStyle = grainHex;
    ctx.globalAlpha = 0.08 + rng() * 0.14;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) {
      const wave = Math.sin(x * 0.018 + i * 0.7) * 5;
      ctx.lineTo(x, y + wave);
    }
    ctx.lineTo(512, y + h);
    ctx.lineTo(0, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // Subtle wood fiber speckles
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rng() > 0.5 ? '#3a2210' : '#ebd0ab';
    ctx.fillRect(rng() * 512, rng() * 512, 6 + rng() * 14, 1);
  }
  ctx.globalAlpha = 1;

  return configureColorTex(new THREE.CanvasTexture(canvas), maxAniso, 1, 1);
}

function makePcbTexture(
  baseColor: string,
  traceColor: string,
  seed: number,
  maxAniso: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const rng = createSeededRng(seed);

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, 256, 256);

  // Subtle circuit traces
  ctx.strokeStyle = traceColor;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 38; i++) {
    const x1 = Math.floor(rng() * 16) * 16;
    const y1 = Math.floor(rng() * 16) * 16;
    const midX = x1 + (rng() > 0.5 ? 32 : -32);
    const y2 = y1 + (rng() > 0.5 ? 48 : -48);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(midX, y1);
    ctx.lineTo(midX, y2);
    ctx.stroke();
  }

  // Gold vias and SMD pads
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < 44; i++) {
    const x = Math.floor(rng() * 16) * 16;
    const y = Math.floor(rng() * 16) * 16;
    ctx.fillStyle = '#d4af37';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#18181b';
    ctx.beginPath();
    ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  return configureColorTex(new THREE.CanvasTexture(canvas), maxAniso, 1, 1);
}

function makeSoilTextures(maxAniso: number): { albedo: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = 512;
  albedoCanvas.height = 512;
  const actx = albedoCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  const rng = createSeededRng(771);

  actx.fillStyle = '#5a3e28';
  actx.fillRect(0, 0, 512, 512);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, 512, 512);

  // Subtle tilled furrow streaks along X
  for (let y = 0; y < 512; y += 6) {
    const shade = Math.sin(y * 0.14) * 16;
    actx.fillStyle = shade > 0 ? 'rgba(116, 82, 52, 0.24)' : 'rgba(54, 34, 18, 0.28)';
    actx.fillRect(0, y, 512, 4);
    const bVal = Math.round(128 + shade * 2.5);
    bctx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
    bctx.fillRect(0, y, 512, 4);
  }

  // Organic soil clods & tiny pebbles
  for (let i = 0; i < 4200; i++) {
    const x = rng() * 512;
    const y = rng() * 512;
    const r = 1 + rng() * 3.8;
    const v = rng();
    actx.fillStyle =
      v < 0.35 ? '#3f2918' : v < 0.72 ? '#6e4e35' : v < 0.92 ? '#7d5d41' : '#9b8368';
    actx.globalAlpha = 0.45 + rng() * 0.4;
    actx.beginPath();
    actx.arc(x, y, r, 0, Math.PI * 2);
    actx.fill();

    const bv = Math.round(70 + v * 150);
    bctx.fillStyle = `rgb(${bv},${bv},${bv})`;
    bctx.globalAlpha = 0.55;
    bctx.beginPath();
    bctx.arc(x, y, r, 0, Math.PI * 2);
    bctx.fill();
  }
  actx.globalAlpha = 1;
  bctx.globalAlpha = 1;

  const albedo = configureColorTex(new THREE.CanvasTexture(albedoCanvas), maxAniso, 14, 14);
  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.set(14, 14);
  bump.anisotropy = maxAniso;
  bump.needsUpdate = true;

  return { albedo, bump };
}

function makeWorkbenchMatTexture(maxAniso: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  // Engineering cutting mat (deep slate-teal)
  ctx.fillStyle = '#1b2c2a';
  ctx.fillRect(0, 0, 1024, 1024);

  // Fine 10mm grid
  ctx.strokeStyle = 'rgba(134, 212, 186, 0.12)';
  ctx.lineWidth = 1;
  for (let p = 0; p <= 1024; p += 32) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 1024);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(1024, p);
    ctx.stroke();
  }

  // Major 50mm grid
  ctx.strokeStyle = 'rgba(167, 243, 208, 0.26)';
  ctx.lineWidth = 2;
  for (let p = 0; p <= 1024; p += 128) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 1024);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(1024, p);
    ctx.stroke();
  }

  // Center rover footprint silhouette guide (325 x 200 mm)
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(512 - 210, 512 - 140, 420, 280);
  ctx.setLineDash([]);

  // Crosshair & markings
  ctx.strokeStyle = 'rgba(167, 243, 208, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(512, 512, 48, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(167, 243, 208, 0.6)';
  ctx.font = '600 22px monospace';
  ctx.fillText('AGRI-ROVER ASSEMBLY BAY  ·  325 × 200 MM', 64, 960);
  ctx.fillText('FRONT +X  →', 760, 520);

  return configureColorTex(new THREE.CanvasTexture(canvas), maxAniso, 1, 1);
}

function makeContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 16, 128, 128, 122);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.25)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function createProceduralTexturePack(renderer: THREE.WebGLRenderer): ProceduralTexturePack {
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const plywood = makeWoodTexture('#c78d56', '#8a572c', 101, maxAniso);
  const plywoodDark = makeWoodTexture('#a36c3d', '#69401d', 202, maxAniso);
  const { albedo: soilAlbedo, bump: soilBump } = makeSoilTextures(maxAniso);
  const pcbGreen = makePcbTexture('#155e34', '#2ea860', 303, maxAniso);
  const pcbRed = makePcbTexture('#991b1b', '#e04f4f', 404, maxAniso);
  const pcbBlack = makePcbTexture('#1e242b', '#475569', 505, maxAniso);
  const pcbBlue = makePcbTexture('#1d4ed8', '#60a5fa', 606, maxAniso);
  const workbenchMat = makeWorkbenchMatTexture(maxAniso);
  const contactShadow = makeContactShadowTexture();

  return {
    plywood,
    plywoodDark,
    soilAlbedo,
    soilBump,
    pcbGreen,
    pcbRed,
    pcbBlack,
    pcbBlue,
    workbenchMat,
    contactShadow,
    dispose() {
      plywood.dispose();
      plywoodDark.dispose();
      soilAlbedo.dispose();
      soilBump.dispose();
      pcbGreen.dispose();
      pcbRed.dispose();
      pcbBlack.dispose();
      pcbBlue.dispose();
      workbenchMat.dispose();
      contactShadow.dispose();
    },
  };
}
