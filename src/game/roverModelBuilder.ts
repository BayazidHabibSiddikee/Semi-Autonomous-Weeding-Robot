import * as THREE from 'three';
import { ROVER_PARTS } from './roverPartsCatalog';
import { ProceduralTexturePack } from './textures';
import { PartId, TreatmentToolType } from './types';

export interface RoverRig {
  root: THREE.Group;
  partGroups: Record<PartId, THREE.Group>;
  ghostGroups: Record<PartId, THREE.Group>;
  hitboxes: THREE.Mesh[];
  leftWheels: THREE.Group[];
  rightWheels: THREE.Group[];
  // Dynamic tool references
  toolVariants: Record<TreatmentToolType, THREE.Group>;
  grinderDisc: THREE.Group;
  flameConeGroup: THREE.Group;
  sparkArcMesh: THREE.Mesh;
  servoGearMesh: THREE.Group;
  turretGearMesh: THREE.Group;
  turretPivotGroup: THREE.Group;
  laserGimbalPan: THREE.Group;
  laserGimbalTilt: THREE.Group;
  laserBeamMesh: THREE.Mesh;
  laserImpactDot: THREE.Mesh;
  // Sensor visual aids
  cameraFrustum: THREE.Group;
  tofBeam: THREE.Mesh;
  estopCap: THREE.Mesh;
  contactShadow: THREE.Mesh;
  // Runtime helpers
  setToolType: (tool: TreatmentToolType) => void;
  setFiringVisual: (
    firing: boolean,
    tool: TreatmentToolType,
    elapsed: number,
    localTarget?: { x: number; z: number } | null,
    sparkPhase?: boolean,
    manualAimRad?: number | null
  ) => void;
  getTurretYawDeg: () => number;
  setEstopPressed: (pressed: boolean) => void;
  syncPartHighlights: (selectedId: PartId | null, hoveredId: PartId | null) => void;
  getPartWorldCenter: (partId: PartId, outVec: THREE.Vector3) => void;
  dispose: () => void;
}

function makeDeckGeometry(): THREE.ExtrudeGeometry {
  // Exact 256mm x 155mm chamfered wooden deck from CAD + real bot
  const hl = 0.128;
  const hw = 0.0775;
  const c = 0.03;

  const shape = new THREE.Shape();
  shape.moveTo(hl - c, -hw);
  shape.lineTo(hl, -hw + c);
  shape.lineTo(hl, hw - c);
  shape.lineTo(hl - c, hw);
  shape.lineTo(-hl + c, hw);
  shape.lineTo(-hl, hw - c);
  shape.lineTo(-hl, -hw + c);
  shape.lineTo(-hl + c, -hw);
  shape.closePath();

  // Rear diamond wire cutout
  const d = 0.022;
  const diamond = new THREE.Path();
  diamond.moveTo(-0.055 + d, 0);
  diamond.lineTo(-0.055, d);
  diamond.lineTo(-0.055 - d, 0);
  diamond.lineTo(-0.055, -d);
  diamond.closePath();
  shape.holes.push(diamond);

  // Front canister pass-through circular bore (canister drops through top plate into arch!)
  const bore = new THREE.Path();
  bore.absarc(0.056, 0, 0.031, 0, Math.PI * 2, true);
  shape.holes.push(bore);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0045,
    bevelEnabled: true,
    bevelThickness: 0.0008,
    bevelSize: 0.0008,
    bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function makeArchPanelGeometry(isOuter: boolean): THREE.ExtrudeGeometry {
  // Exact arched walnut wood side panels from user's real rover photos
  const pts: [number, number][] = [
    [-0.045, 0.125],
    [-0.038, 0.129],
    [-0.018, 0.129],
    [-0.018, 0.125],
    [0.018, 0.125],
    [0.018, 0.129],
    [0.038, 0.129],
    [0.045, 0.125],
    [0.138, 0.032],
    [0.135, 0.02],
    [0.118, 0.02],
    [0.115, 0.032],
    [0.042, 0.105],
    [0.022, 0.105],
    [0.018, 0.11],
    [-0.018, 0.11],
    [-0.022, 0.105],
    [-0.042, 0.105],
    [-0.115, 0.032],
    [-0.118, 0.02],
    [-0.135, 0.02],
    [-0.138, 0.032],
  ];

  const shape = new THREE.Shape();
  pts.forEach(([x, y], idx) => {
    if (idx === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  // 3 signature vertical slots in the center bridge (clearly visible in side photo!)
  for (const sx of [-0.008, 0.0, 0.008]) {
    const slot = new THREE.Path();
    slot.moveTo(sx - 0.0018, 0.112);
    slot.lineTo(sx + 0.0018, 0.112);
    slot.lineTo(sx + 0.0018, 0.122);
    slot.lineTo(sx - 0.0018, 0.122);
    slot.closePath();
    shape.holes.push(slot);
  }

  // Motor inspection windows on outer panel showing the yellow TT gearboxes!
  if (isOuter) {
    const winF = new THREE.Path();
    winF.moveTo(0.088, 0.056);
    winF.lineTo(0.104, 0.04);
    winF.lineTo(0.095, 0.031);
    winF.lineTo(0.079, 0.047);
    winF.closePath();
    shape.holes.push(winF);

    const winR = new THREE.Path();
    winR.moveTo(-0.088, 0.056);
    winR.lineTo(-0.079, 0.047);
    winR.lineTo(-0.095, 0.031);
    winR.lineTo(-0.104, 0.04);
    winR.closePath();
    shape.holes.push(winR);
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0042,
    bevelEnabled: true,
    bevelThickness: 0.0005,
    bevelSize: 0.0005,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -0.0021);
  return geo;
}

function makeSpurGearGeometry(outerRadius: number, teeth: number, thickness: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const rootR = outerRadius * 0.86;
  const step = (Math.PI * 2) / teeth;

  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
    const a1 = a0 + step * 0.22;
    const a2 = a0 + step * 0.34;
    const a3 = a0 + step * 0.66;
    const a4 = a0 + step * 0.78;
    const p0x = Math.cos(a0) * rootR;
    const p0y = Math.sin(a0) * rootR;
    if (i === 0) shape.moveTo(p0x, p0y);
    else shape.lineTo(p0x, p0y);
    shape.lineTo(Math.cos(a1) * rootR, Math.sin(a1) * rootR);
    shape.lineTo(Math.cos(a2) * outerRadius, Math.sin(a2) * outerRadius);
    shape.lineTo(Math.cos(a3) * outerRadius, Math.sin(a3) * outerRadius);
    shape.lineTo(Math.cos(a4) * rootR, Math.sin(a4) * rootR);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.0006,
    bevelSize: 0.0005,
    bevelSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function makeCanisterLabelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Signature cobalt-blue top + white band + red hazard lower stripe (matching real butane canister!)
  ctx.fillStyle = '#1e3a8a';
  ctx.fillRect(0, 0, 512, 146);

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 146, 512, 34);

  ctx.fillStyle = '#b91c1c';
  ctx.fillRect(0, 180, 512, 76);

  // Stylized industrial chevron & flame emblem
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let x = 0; x <= 512; x += 32) {
    ctx.lineTo(x, x % 64 === 0 ? 18 : 34);
  }
  ctx.stroke();

  // Hazard diamond icon
  ctx.save();
  ctx.translate(128, 86);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(-20, -20, 40, 40);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(-20, -20, 40, 40);
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('BUTANE FUEL', 210, 86);
  ctx.font = '600 18px monospace';
  ctx.fillStyle = '#bfdbfe';
  ctx.fillText('THERMAL WEEDING CELL', 210, 114);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('PRESSURIZED · AUTO-VALVE INTERLOCK', 48, 169);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeVentedCaseTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#181a1f';
  ctx.fillRect(0, 0, 256, 256);

  // Perforated honeycomb ventilation holes like the real black Pi 4 case in top-down photo
  ctx.fillStyle = '#090a0d';
  for (let row = 28; row < 228; row += 18) {
    for (let col = 28; col < 228; col += 18) {
      ctx.beginPath();
      ctx.arc(col + (row % 36 === 0 ? 0 : 9), row, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeGantryWallGeometry(): THREE.ExtrudeGeometry {
  // Exact forward-cantilevered L-shaped white gantry side wall from the real side photo!
  // Base mounts near X = +0.055..+0.115 at Y = 0.13, rises to Y = 0.27, then juts forward to X = +0.205!
  const shape = new THREE.Shape();
  shape.moveTo(0.058, 0.13);
  shape.lineTo(0.116, 0.13);
  shape.lineTo(0.116, 0.218);
  shape.lineTo(0.205, 0.218);
  shape.lineTo(0.205, 0.268);
  shape.lineTo(0.068, 0.268);
  shape.lineTo(0.058, 0.256);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.008,
    bevelEnabled: true,
    bevelThickness: 0.0012,
    bevelSize: 0.001,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -0.004);
  return geo;
}

export function buildRoverRig(textures: ProceduralTexturePack): RoverRig {
  const root = new THREE.Group();
  root.name = 'AgriRoverRoot';

  const geometriesToDispose: THREE.BufferGeometry[] = [];
  const materialsToDispose: THREE.Material[] = [];
  const localTexturesToDispose: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometriesToDispose.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materialsToDispose.push(m);
    return m;
  };

  const canisterLabelTex = makeCanisterLabelTexture();
  const ventedCaseTex = makeVentedCaseTexture();
  localTexturesToDispose.push(canisterLabelTex, ventedCaseTex);

  // Calibrated PBR Materials matching the real rover (upgraded crisp finish!)
  const matWoodTop = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.plywood,
      color: 0x9c5e34,
      roughness: 0.62,
      metalness: 0.04,
    })
  );
  const matWoodLeg = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.plywoodDark,
      color: 0x804623,
      roughness: 0.68,
      metalness: 0.04,
    })
  );
  const matYellowPlastic = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.3,
      metalness: 0.06,
    })
  );
  const matRubberTire = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x17191c,
      roughness: 0.88,
      metalness: 0.04,
    })
  );
  const matBrushedSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd8dee6,
      roughness: 0.22,
      metalness: 0.92,
    })
  );
  const matTorchMetal = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xbac2cc,
      roughness: 0.34,
      metalness: 0.86,
    })
  );
  const matDarkAnodized = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x20252d,
      roughness: 0.36,
      metalness: 0.62,
    })
  );
  const matVentedPiCase = trackMat(
    new THREE.MeshStandardMaterial({
      map: ventedCaseTex,
      color: 0x262930,
      roughness: 0.48,
      metalness: 0.16,
    })
  );
  const matPowerBank = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3b4d59,
      roughness: 0.34,
      metalness: 0.55,
    })
  );
  const matWhite3DPrint = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.38,
      metalness: 0.05,
    })
  );
  const matDarkGear = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.42,
      metalness: 0.22,
    })
  );
  const matCanisterLabel = trackMat(
    new THREE.MeshStandardMaterial({
      map: canisterLabelTex,
      roughness: 0.28,
      metalness: 0.48,
    })
  );
  const matCopperGold = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd8a83c,
      roughness: 0.28,
      metalness: 0.88,
    })
  );
  const matWhitePlastic = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.42,
      metalness: 0.02,
    })
  );
  const matPcbRed = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.pcbRed,
      roughness: 0.4,
      metalness: 0.14,
    })
  );
  const matPcbBlack = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.pcbBlack,
      roughness: 0.46,
      metalness: 0.15,
    })
  );
  const matPcbBlue = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.pcbBlue,
      roughness: 0.4,
      metalness: 0.15,
    })
  );
  const matRelayBlue = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      roughness: 0.35,
      metalness: 0.08,
    })
  );
  const matEstopRed = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.26,
      metalness: 0.08,
    })
  );
  const matSafetyYellow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xeab308,
      roughness: 0.38,
      metalness: 0.08,
    })
  );
  const matLensGlass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0b1220,
      roughness: 0.06,
      metalness: 0.88,
    })
  );
  const matBrass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc59b43,
      roughness: 0.3,
      metalness: 0.86,
    })
  );
  const matWireRed = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.55, metalness: 0.05 })
  );
  const matWireDark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6, metalness: 0.05 })
  );

  // Soft grounded contact shadow beneath rover
  const contactShadow = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(0.5, 0.36)),
    trackMat(
      new THREE.MeshBasicMaterial({
        map: textures.contactShadow,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
      })
    )
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.002;
  root.add(contactShadow);

  const partGroups = {} as Record<PartId, THREE.Group>;
  const ghostGroups = {} as Record<PartId, THREE.Group>;
  const hitboxes: THREE.Mesh[] = [];

  for (const spec of ROVER_PARTS) {
    const g = new THREE.Group();
    g.name = `Part_${spec.id}`;
    partGroups[spec.id] = g;
    root.add(g);

    const gg = new THREE.Group();
    gg.name = `Ghost_${spec.id}`;
    ghostGroups[spec.id] = gg;
    root.add(gg);
  }

  const makeShadowed = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  // =========================================================================
  // 1. WALNUT PLYWOOD TOP DECK (256 x 155 mm at Y = 0.125)
  // =========================================================================
  {
    const g = partGroups.chassis_deck;
    const deckGeo = trackGeo(makeDeckGeometry());
    const deckMesh = makeShadowed(new THREE.Mesh(deckGeo, matWoodTop));
    deckMesh.position.y = 0.125;
    g.add(deckMesh);

    const standoffGeo = trackGeo(new THREE.CylinderGeometry(0.0032, 0.0032, 0.008, 8));
    for (const sx of [-0.095, 0.095]) {
      for (const sz of [-0.058, 0.058]) {
        const st = makeShadowed(new THREE.Mesh(standoffGeo, matBrass));
        st.position.set(sx, 0.133, sz);
        g.add(st);
      }
    }

    const railGeo = trackGeo(new THREE.BoxGeometry(0.19, 0.005, 0.008));
    for (const sz of [-0.036, 0.036]) {
      const rail = makeShadowed(new THREE.Mesh(railGeo, matBrushedSteel));
      rail.position.set(0, 0.122, sz);
      g.add(rail);
    }
  }

  // =========================================================================
  // 2. 45° STRADDLE ARCH LEGS (Exact dual inner/outer walnut arch plates)
  // =========================================================================
  {
    const g = partGroups.arch_legs;
    const archOuterGeo = trackGeo(makeArchPanelGeometry(true));
    const archInnerGeo = trackGeo(makeArchPanelGeometry(false));
    const placements: Array<{ z: number; outer: boolean }> = [
      { z: -0.066, outer: true },
      { z: -0.047, outer: false },
      { z: 0.047, outer: false },
      { z: 0.066, outer: true },
    ];
    for (const p of placements) {
      const panel = makeShadowed(
        new THREE.Mesh(p.outer ? archOuterGeo : archInnerGeo, matWoodLeg)
      );
      panel.position.z = p.z;
      g.add(panel);
    }

    // M3 cross-bolts & steel hex heads along arch bridge and sloping legs
    const boltGeo = trackGeo(new THREE.CylinderGeometry(0.0022, 0.0022, 0.028, 8));
    boltGeo.rotateX(Math.PI / 2);
    const headGeo = trackGeo(new THREE.CylinderGeometry(0.004, 0.004, 0.003, 6));
    headGeo.rotateX(Math.PI / 2);

    for (const sideSign of [-1, 1]) {
      const zCenter = sideSign * 0.0565;
      for (const [bx, by] of [
        [-0.03, 0.118],
        [0.03, 0.118],
        [0.105, 0.058],
        [-0.105, 0.058],
      ]) {
        const bolt = makeShadowed(new THREE.Mesh(boltGeo, matBrushedSteel));
        bolt.position.set(bx, by, zCenter);
        g.add(bolt);

        const head = makeShadowed(new THREE.Mesh(headGeo, matBrushedSteel));
        head.position.set(bx, by, sideSign * 0.07);
        g.add(head);
      }
    }
  }

  // =========================================================================
  // 3. 4x YELLOW TT GEAR MOTORS + QUADRATURE ENCODERS
  // =========================================================================
  {
    const g = partGroups.tt_motors;
    const gearboxGeo = trackGeo(new THREE.BoxGeometry(0.042, 0.022, 0.0185));
    const noseGeo = trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.0185, 14));
    noseGeo.rotateX(Math.PI / 2);
    const canGeo = trackGeo(new THREE.CylinderGeometry(0.0098, 0.0098, 0.025, 14));
    canGeo.rotateZ(Math.PI / 2);
    const shaftGeo = trackGeo(new THREE.CylinderGeometry(0.0032, 0.0032, 0.038, 10));
    shaftGeo.rotateX(Math.PI / 2);
    const encDiscGeo = trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.002, 16));
    encDiscGeo.rotateX(Math.PI / 2);

    const configs = [
      { wx: 0.1275, dirX: 1, side: -1 },
      { wx: -0.1275, dirX: -1, side: -1 },
      { wx: 0.1275, dirX: 1, side: 1 },
      { wx: -0.1275, dirX: -1, side: 1 },
    ];

    for (const cfg of configs) {
      const mGroup = new THREE.Group();
      mGroup.position.set(cfg.wx, 0.035, cfg.side * 0.0565);
      mGroup.rotation.z = cfg.dirX > 0 ? -Math.PI / 4 : Math.PI / 4;

      const gb = makeShadowed(new THREE.Mesh(gearboxGeo, matYellowPlastic));
      gb.position.set(-cfg.dirX * 0.021, 0, 0);
      mGroup.add(gb);

      mGroup.add(makeShadowed(new THREE.Mesh(noseGeo, matYellowPlastic)));

      const can = makeShadowed(new THREE.Mesh(canGeo, matBrushedSteel));
      can.position.set(-cfg.dirX * 0.054, 0, 0);
      mGroup.add(can);

      const shaft = makeShadowed(new THREE.Mesh(shaftGeo, matWhitePlastic));
      shaft.position.set(0, 0, cfg.side * 0.004);
      mGroup.add(shaft);

      const enc = makeShadowed(new THREE.Mesh(encDiscGeo, matDarkAnodized));
      enc.position.set(0, 0, -cfg.side * 0.014);
      mGroup.add(enc);

      g.add(mGroup);
    }
  }

  // =========================================================================
  // 4. 4x YELLOW 5-SPOKE LUGGED OFF-ROAD ROVER WHEELS
  // =========================================================================
  const leftWheels: THREE.Group[] = [];
  const rightWheels: THREE.Group[] = [];
  {
    const g = partGroups.rover_wheels;
    const tireOuterGeo = trackGeo(new THREE.CylinderGeometry(0.034, 0.034, 0.026, 24));
    tireOuterGeo.rotateX(Math.PI / 2);
    const rimGeo = trackGeo(new THREE.CylinderGeometry(0.0245, 0.0245, 0.027, 20));
    rimGeo.rotateX(Math.PI / 2);
    const rimRecessGeo = trackGeo(new THREE.CylinderGeometry(0.0205, 0.0205, 0.0276, 18));
    rimRecessGeo.rotateX(Math.PI / 2);
    const hubGeo = trackGeo(new THREE.CylinderGeometry(0.0072, 0.0072, 0.0295, 12));
    hubGeo.rotateX(Math.PI / 2);
    const spokeGeo = trackGeo(new THREE.BoxGeometry(0.043, 0.0056, 0.0285));
    const lugGeo = trackGeo(new THREE.BoxGeometry(0.0042, 0.0032, 0.022));

    const wheelCoords = [
      { wx: 0.1275, wz: -0.087, isLeft: true },
      { wx: -0.1275, wz: -0.087, isLeft: true },
      { wx: 0.1275, wz: 0.087, isLeft: false },
      { wx: -0.1275, wz: 0.087, isLeft: false },
    ];

    for (const wc of wheelCoords) {
      const wPivot = new THREE.Group();
      wPivot.position.set(wc.wx, 0.035, wc.wz);

      wPivot.add(makeShadowed(new THREE.Mesh(tireOuterGeo, matRubberTire)));
      wPivot.add(makeShadowed(new THREE.Mesh(rimGeo, matYellowPlastic)));
      wPivot.add(new THREE.Mesh(rimRecessGeo, matDarkAnodized));
      wPivot.add(makeShadowed(new THREE.Mesh(hubGeo, matYellowPlastic)));

      for (let s = 0; s < 5; s++) {
        const sp = makeShadowed(new THREE.Mesh(spokeGeo, matYellowPlastic));
        sp.rotation.z = (s * Math.PI) / 5;
        wPivot.add(sp);
      }

      for (let l = 0; l < 18; l++) {
        const ang = (l * Math.PI * 2) / 18;
        const lug = new THREE.Mesh(lugGeo, matRubberTire);
        lug.position.set(Math.cos(ang) * 0.0346, Math.sin(ang) * 0.0346, 0);
        lug.rotation.z = ang + Math.PI / 2;
        wPivot.add(lug);
      }

      g.add(wPivot);
      if (wc.isLeft) leftWheels.push(wPivot);
      else rightWheels.push(wPivot);
    }
  }

  // =========================================================================
  // 5. REAR SLATE POWER BANK + L298N MOTOR DRIVER (Cleanly organized!)
  // =========================================================================
  {
    const g = partGroups.power_driver;

    // Signature rear slate-grey high-capacity power bank (seen in top & side photos)
    const pbBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.118, 0.024, 0.068)), matPowerBank)
    );
    pbBody.position.set(-0.064, 0.15, 0.002);
    g.add(pbBody);

    // Dual Velcro retention straps (cleanly mounted!)
    for (const sx of [-0.095, -0.032]) {
      const strap = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.012, 0.026, 0.072)), matDarkAnodized)
      );
      strap.position.set(sx, 0.15, 0.002);
      g.add(strap);
    }

    // Tidy white & black USB-A power connectors plugging cleanly into rear of power bank
    for (const sz of [-0.016, 0.016]) {
      const plug = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.016, 0.009, 0.012)), matWhitePlastic)
      );
      plug.position.set(-0.128, 0.15, sz);
      g.add(plug);
    }

    // L298N Red PCB Driver tucked cleanly under the rear deck bay
    const l298Board = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.042, 0.003, 0.042)), matPcbRed)
    );
    l298Board.position.set(-0.045, 0.132, -0.052);
    g.add(l298Board);

    const heatsink = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.022, 0.024)), matDarkAnodized)
    );
    heatsink.position.set(-0.052, 0.144, -0.052);
    g.add(heatsink);
  }

  // =========================================================================
  // 6. ESP32 CONTROLLER + BLUE OPTO-RELAY MODULE
  // =========================================================================
  {
    const g = partGroups.esp32_mcu;

    // ESP32 board neatly mounted on right-rear deck rail
    const espPcb = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.052, 0.003, 0.026)), matPcbBlack)
    );
    espPcb.position.set(-0.04, 0.132, 0.054);
    g.add(espPcb);

    const rfShield = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.017, 0.005, 0.016)), matBrushedSteel)
    );
    rfShield.position.set(-0.048, 0.136, 0.054);
    g.add(rfShield);

    const pins = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.044, 0.004, 0.022)), matCopperGold)
    );
    pins.position.set(-0.04, 0.134, 0.054);
    g.add(pins);

    // Signature sky-blue opto-isolated relay block visible beside the power bank!
    const relayBase = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.036, 0.003, 0.026)), matPcbBlue)
    );
    relayBase.position.set(-0.005, 0.132, -0.046);
    g.add(relayBase);

    const relayCube = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.016, 0.015, 0.014)), matRelayBlue)
    );
    relayCube.position.set(-0.008, 0.141, -0.046);
    g.add(relayCube);
  }

  // =========================================================================
  // 7. VENTED MATTE-BLACK RASPBERRY PI 4 ENCLOSURE (Stacked cleanly on power bank!)
  // =========================================================================
  {
    const g = partGroups.raspberry_pi;
    const piCase = new THREE.Group();
    piCase.position.set(-0.068, 0.175, 0.002);

    // Signature matte-black perforated Pi 4 enclosure (clearly seen in all 3 photos & video!)
    const caseBox = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.092, 0.024, 0.064)), matVentedPiCase)
    );
    piCase.add(caseBox);

    // Clean chamfered metallic bezel strip around Pi case
    const trim = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.094, 0.003, 0.066)), matDarkAnodized)
    );
    trim.position.y = -0.009;
    piCase.add(trim);

    // Subtle green & amber LED indicators recessed in side slot
    const ledGreen = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.004, 0.003, 0.003)),
      trackMat(new THREE.MeshBasicMaterial({ color: 0x22c55e }))
    );
    ledGreen.position.set(0.047, 0.004, -0.014);
    piCase.add(ledGreen);

    // Clean braided USB-C power cable curving neatly from rear power bank into Pi 4
    const cableCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.06, -0.024, -0.014),
      new THREE.Vector3(-0.072, -0.01, -0.024),
      new THREE.Vector3(-0.046, 0.0, -0.018),
    ]);
    const cableMesh = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(cableCurve, 12, 0.0026, 6, false)),
      matWhitePlastic
    );
    piCase.add(cableMesh);

    g.add(piCase);
  }

  // =========================================================================
  // 8. SIDE-MOUNTED BLACK HV ARC IGNITER + BNO055 IMU + VL53L0X ToF
  // =========================================================================
  let tofBeam: THREE.Mesh;
  {
    const g = partGroups.imu_tof;

    // Signature black cylindrical High-Voltage Arc Igniter mounted cleanly on left edge of deck!
    const hvBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.012, 0.012, 0.064, 16)), matDarkAnodized)
    );
    hvBody.rotation.z = Math.PI / 2;
    hvBody.position.set(0.015, 0.144, -0.064);
    g.add(hvBody);

    // Dual brushed clamp rings holding HV igniter neatly to deck
    const ringGeo = trackGeo(new THREE.TorusGeometry(0.013, 0.002, 8, 16));
    ringGeo.rotateY(Math.PI / 2);
    for (const rx of [-0.005, 0.032]) {
      const ring = new THREE.Mesh(ringGeo, matBrushedSteel);
      ring.position.set(rx, 0.144, -0.064);
      g.add(ring);
    }

    // Red high-voltage ignition wire routed cleanly down from HV module to front flame nozzle tip!
    const hvWireCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.047, 0.144, -0.064),
      new THREE.Vector3(0.088, 0.125, -0.062),
      new THREE.Vector3(0.118, 0.072, -0.036),
      new THREE.Vector3(0.132, 0.044, -0.008),
    ]);
    const hvWire = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(hvWireCurve, 16, 0.002, 6, false)),
      matWireRed
    );
    g.add(hvWire);

    // Blue BNO055 9-DOF IMU sensor on center deck
    const imuBoard = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.003, 0.018)), matPcbBlue)
    );
    imuBoard.position.set(0.004, 0.131, 0.0);
    g.add(imuBoard);

    // Forward VL53L0X ToF obstacle rangefinder mounted cleanly on front deck edge
    const tofHolder = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.01, 0.016, 0.034)), matDarkAnodized)
    );
    tofHolder.position.set(0.124, 0.122, 0.0);
    g.add(tofHolder);

    const lensGeo = trackGeo(new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 12));
    lensGeo.rotateZ(Math.PI / 2);
    for (const sz of [-0.007, 0.007]) {
      const lens = new THREE.Mesh(lensGeo, matLensGlass);
      lens.position.set(0.13, 0.122, sz);
      g.add(lens);
    }

    // Translucent forward ToF cone (shown in field mode)
    const beamGeo = trackGeo(new THREE.ConeGeometry(0.045, 0.36, 16, 1, true));
    beamGeo.rotateZ(Math.PI / 2);
    beamGeo.translate(0.18, 0, 0);
    tofBeam = new THREE.Mesh(
      beamGeo,
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      )
    );
    tofBeam.position.set(0.132, 0.118, 0);
    tofBeam.visible = false;
    g.add(tofBeam);
  }

  // =========================================================================
  // 9. SIGNATURE INVERTED BUTANE TURRET, MESHING SPUR GEARS, FORWARD STEEL NOZZLE & E-STOP
  // =========================================================================
  let estopCap: THREE.Mesh;
  const toolVariants = {} as Record<TreatmentToolType, THREE.Group>;
  let grinderDisc: THREE.Group;
  let flameConeGroup: THREE.Group;
  let sparkArcMesh: THREE.Mesh;
  let servoGearMesh: THREE.Group;
  let turretGearMesh: THREE.Group;
  let turretPivotGroup: THREE.Group;
  let laserGimbalPan: THREE.Group;
  let laserGimbalTilt: THREE.Group;
  let laserBeamMesh: THREE.Mesh;
  let laserImpactDot: THREE.Mesh;

  {
    const g = partGroups.estop_tool;

    // Compact red GPIO 13 Mushroom Emergency Stop switch on rear-left corner
    const estopBox = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.028, 0.016, 0.028)), matSafetyYellow)
    );
    estopBox.position.set(-0.106, 0.138, -0.052);
    g.add(estopBox);

    estopCap = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.013, 0.01, 0.011, 16)), matEstopRed)
    );
    estopCap.position.set(-0.106, 0.152, -0.052);
    g.add(estopCap);

    // --- Variant A (DEFAULT & ICONIC REAL BOT): Servo-Aimed Inverted Butane Flame Turret + Spur Gears + Forward Steel Barrel ---
    const flameGroup = new THREE.Group();

    // Fixed white 3D-printed outer bearing collar bolted to the top deck around X = +0.056, Z = 0
    const collarBase = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.042, 0.044, 0.02, 24)), matWhite3DPrint)
    );
    collarBase.position.set(0.056, 0.139, 0);
    flameGroup.add(collarBase);

    // Fixed high-torque black side servo actuator + meshing dark-grey drive spur gear (right side, exactly like photos!)
    const servoBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.04, 0.042, 0.024)), matDarkAnodized)
    );
    servoBody.position.set(0.02, 0.152, 0.062);
    flameGroup.add(servoBody);

    servoGearMesh = new THREE.Group();
    servoGearMesh.position.set(0.02, 0.174, 0.062);
    const driveGear = makeShadowed(
      new THREE.Mesh(trackGeo(makeSpurGearGeometry(0.036, 22, 0.008)), matDarkGear)
    );
    servoGearMesh.add(driveGear);
    const gearHub = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.011, 14)), matDarkAnodized)
    );
    gearHub.position.y = 0.003;
    servoGearMesh.add(gearHub);
    flameGroup.add(servoGearMesh);

    // PIVOTING TURRET ASSEMBLY: Driven directly by servo spur gear — rotates inverted butane tank AND steel flame nozzle toward weeds!
    turretPivotGroup = new THREE.Group();
    turretPivotGroup.position.set(0.056, 0, 0);

    // White driven spur gear ring bolted to the rotating canister carrier
    turretGearMesh = new THREE.Group();
    turretGearMesh.position.set(0, 0.152, 0);
    const turretGear = makeShadowed(
      new THREE.Mesh(trackGeo(makeSpurGearGeometry(0.046, 26, 0.007)), matWhite3DPrint)
    );
    turretGearMesh.add(turretGear);
    turretPivotGroup.add(turretGearMesh);

    // Upper white retention cage ring with 4 struts rotating with the canister
    const upperRing = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.TorusGeometry(0.036, 0.0045, 8, 24)),
        matWhite3DPrint
      )
    );
    upperRing.rotation.x = Math.PI / 2;
    upperRing.position.set(0, 0.184, 0);
    turretPivotGroup.add(upperRing);

    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + Math.PI / 4;
      const strut = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.006, 0.034, 0.006)), matWhite3DPrint)
      );
      strut.position.set(Math.cos(ang) * 0.036, 0.168, Math.sin(ang) * 0.036);
      turretPivotGroup.add(strut);
    }

    // Signature Inverted Cylindrical Blue/White/Red Butane Gas Canister (rotates with turret!)
    const canisterBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.033, 0.033, 0.145, 24)), matCanisterLabel)
    );
    canisterBody.position.set(0, 0.165, 0);
    turretPivotGroup.add(canisterBody);

    // Concave brushed silver metallic top cap (bottom of inverted can)
    const canCap = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0335, 0.0335, 0.006, 24)), matBrushedSteel)
    );
    canCap.position.set(0, 0.238, 0);
    turretPivotGroup.add(canCap);

    // Lower valve dome & brass regulator underneath deck inside high-clearance arch
    const canDome = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.03, 18, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)), matBrushedSteel)
    );
    canDome.position.set(0, 0.095, 0);
    turretPivotGroup.add(canDome);

    const regulatorStem = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.006, 0.008, 0.036, 12)), matBrass)
    );
    regulatorStem.position.set(0, 0.058, 0);
    turretPivotGroup.add(regulatorStem);

    // Elbow fitting & signature horizontal stainless-steel flame barrel pointing forward (rotates left/right toward weeds!)
    const elbow = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.01, 0.01, 0.022, 12)), matDarkAnodized)
    );
    elbow.rotation.z = Math.PI / 2;
    elbow.position.set(0.012, 0.038, 0);
    turretPivotGroup.add(elbow);

    const redInsulator = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.007, 0.007, 0.018, 10)), matWireRed)
    );
    redInsulator.position.set(0.054, 0.048, 0);
    turretPivotGroup.add(redInsulator);

    const torchBarrel = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.011, 0.0115, 0.11, 18)), matTorchMetal)
    );
    torchBarrel.rotation.z = Math.PI / 2;
    torchBarrel.position.set(0.069, 0.036, 0);
    turretPivotGroup.add(torchBarrel);

    const barrelMuzzle = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 16)), matDarkAnodized)
    );
    barrelMuzzle.rotation.z = Math.PI / 2;
    barrelMuzzle.position.set(0.125, 0.036, 0);
    turretPivotGroup.add(barrelMuzzle);

    // Electric arc spark flash right at muzzle tip (swings with barrel!)
    sparkArcMesh = new THREE.Mesh(
      trackGeo(new THREE.OctahedronGeometry(0.014, 0)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x7dd3fc,
          transparent: true,
          opacity: 0.95,
        })
      )
    );
    sparkArcMesh.position.set(0.132, 0.036, 0);
    sparkArcMesh.visible = false;
    turretPivotGroup.add(sparkArcMesh);

    // Roaring horizontal forward flame jet (swings directly toward weed along barrel axis!)
    flameConeGroup = new THREE.Group();
    flameConeGroup.position.set(0.128, 0.036, 0);

    const outerJetGeo = trackGeo(new THREE.ConeGeometry(0.036, 0.24, 16));
    outerJetGeo.rotateZ(-Math.PI / 2);
    outerJetGeo.translate(0.12, 0.004, 0);
    const outerJet = new THREE.Mesh(
      outerJetGeo,
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xf97316,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
        })
      )
    );
    flameConeGroup.add(outerJet);

    const midJetGeo = trackGeo(new THREE.ConeGeometry(0.024, 0.17, 14));
    midJetGeo.rotateZ(-Math.PI / 2);
    midJetGeo.translate(0.088, 0.002, 0);
    const midJet = new THREE.Mesh(
      midJetGeo,
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xfacc15,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
        })
      )
    );
    flameConeGroup.add(midJet);

    const blueCoreGeo = trackGeo(new THREE.ConeGeometry(0.012, 0.075, 12));
    blueCoreGeo.rotateZ(-Math.PI / 2);
    blueCoreGeo.translate(0.036, 0, 0);
    const blueCore = new THREE.Mesh(
      blueCoreGeo,
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        })
      )
    );
    flameConeGroup.add(blueCore);

    flameConeGroup.visible = false;
    turretPivotGroup.add(flameConeGroup);

    flameGroup.add(turretPivotGroup);
    toolVariants.flame = flameGroup;
    g.add(flameGroup);

    // --- Variant B: Mechanical Rotary Grinder Attachment ---
    const grinderGroup = new THREE.Group();
    grinderGroup.position.set(0.056, 0.12, 0);

    const gMotor = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.02, 0.02, 0.044, 16)), matDarkAnodized)
    );
    gMotor.position.y = -0.024;
    grinderGroup.add(gMotor);

    const gShaft = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0045, 0.0045, 0.042, 10)), matBrushedSteel)
    );
    gShaft.position.y = -0.062;
    grinderGroup.add(gShaft);

    const guard = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.042, 0.044, 0.014, 18, 1, true)),
        matSafetyYellow
      )
    );
    guard.position.y = -0.076;
    grinderGroup.add(guard);

    grinderDisc = new THREE.Group();
    grinderDisc.position.y = -0.084;
    grinderDisc.add(
      makeShadowed(new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.036, 0.036, 0.004, 18)), matBrushedSteel))
    );
    const toothGeo = trackGeo(new THREE.BoxGeometry(0.015, 0.006, 0.005));
    for (let t = 0; t < 6; t++) {
      const ang = (t * Math.PI * 2) / 6;
      const tooth = makeShadowed(new THREE.Mesh(toothGeo, matCopperGold));
      tooth.position.set(Math.cos(ang) * 0.033, -0.003, Math.sin(ang) * 0.033);
      tooth.rotation.y = -ang;
      grinderDisc.add(tooth);
    }
    grinderGroup.add(grinderDisc);
    toolVariants.grinder = grinderGroup;
    g.add(grinderGroup);

    // --- Variant C: Pan-Tilt Precision Diode Laser ---
    const laserGroup = new THREE.Group();
    laserGroup.position.set(0.056, 0.12, 0);

    laserGimbalPan = new THREE.Group();
    const panServo = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.026, 0.018, 0.024)), matDarkAnodized)
    );
    panServo.position.y = -0.011;
    laserGimbalPan.add(panServo);

    const uBracket = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.03, 0.018, 0.03)), matBrushedSteel)
    );
    uBracket.position.y = -0.026;
    laserGimbalPan.add(uBracket);

    laserGimbalTilt = new THREE.Group();
    laserGimbalTilt.position.y = -0.036;
    const diodeBarrel = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.034, 14)),
        trackMat(new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.25, metalness: 0.78 }))
      )
    );
    diodeBarrel.position.y = -0.015;
    laserGimbalTilt.add(diodeBarrel);

    const emitterTip = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.005, 0.007, 0.008, 12)), matBrass)
    );
    emitterTip.position.y = -0.034;
    laserGimbalTilt.add(emitterTip);

    laserGimbalPan.add(laserGimbalTilt);
    laserGroup.add(laserGimbalPan);

    const beamUnitGeo = trackGeo(new THREE.CylinderGeometry(0.0024, 0.0024, 1, 8));
    beamUnitGeo.translate(0, -0.5, 0);
    laserBeamMesh = new THREE.Mesh(
      beamUnitGeo,
      trackMat(new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.92 }))
    );
    laserBeamMesh.visible = false;
    g.add(laserBeamMesh);

    laserImpactDot = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.01, 10, 10)),
      trackMat(new THREE.MeshBasicMaterial({ color: 0x7dd3fc }))
    );
    laserImpactDot.visible = false;
    g.add(laserImpactDot);

    toolVariants.laser = laserGroup;
    g.add(laserGroup);
  }

  // =========================================================================
  // 10. SIPEED MAIXSENSE-A075V 3D ToF + RGB DEPTH MODULE (Front Corner Sensor)
  // =========================================================================
  {
    const g = partGroups.maixsense_a075v;

    // Aluminum anodized mounting bracket on front deck lip
    const mountPlate = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.016, 0.066)), matBrushedSteel)
    );
    mountPlate.position.set(0.124, 0.129, 0);
    g.add(mountPlate);

    // Compact silver/black Sipeed MaixSense-A075V housing
    const maixBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.026, 0.056)), matDarkAnodized)
    );
    maixBody.position.set(0.136, 0.143, 0);
    g.add(maixBody);

    // Metallic front faceplate bezel
    const facePlate = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.004, 0.022, 0.052)), matBrushedSteel)
    );
    facePlate.position.set(0.148, 0.143, 0);
    g.add(facePlate);

    // Dual IR VCSEL ToF emitters (crimson-tinted optics) + central RGB lens
    const matIrWindow = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.12, metalness: 0.35 })
    );
    for (const lz of [-0.017, 0.017]) {
      const irOptic = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 14)),
        matIrWindow
      );
      irOptic.rotation.z = Math.PI / 2;
      irOptic.position.set(0.151, 0.143, lz);
      g.add(irOptic);
    }
    const rgbLens = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0065, 0.0065, 0.005, 16)),
      matLensGlass
    );
    rgbLens.rotation.z = Math.PI / 2;
    rgbLens.position.set(0.151, 0.143, 0);
    g.add(rgbLens);

    // Clean USB-C cable routed back to Raspberry Pi 4
    const maixCable = new THREE.Mesh(
      trackGeo(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.134, 0.143, -0.028),
            new THREE.Vector3(0.08, 0.142, -0.068),
            new THREE.Vector3(-0.02, 0.175, -0.045),
          ]),
          14,
          0.002,
          6,
          false
        )
      ),
      matWireDark
    );
    g.add(maixCable);
  }

  // =========================================================================
  // 11. IR THERMAL & TEMPERATURE SENSOR ARRAY (MLX90614 / AMG8833 + Heatsink Probe)
  // =========================================================================
  {
    const g = partGroups.thermal_sensor;

    // Angled aluminum bracket under front-left deck aimed at flame strike zone
    const arm = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.024, 0.006, 0.024)), matBrushedSteel)
    );
    arm.position.set(0.106, 0.118, -0.046);
    g.add(arm);

    const irPcb = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.004, 0.02)), matWireRed)
    );
    irPcb.position.set(0.112, 0.112, -0.046);
    irPcb.rotation.z = -0.58;
    g.add(irPcb);

    // Gold/steel TO-39 infrared thermopile barrel (MLX90614)
    const irCan = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.006, 0.0065, 0.012, 16)), matCopperGold)
    );
    irCan.position.set(0.118, 0.106, -0.046);
    irCan.rotation.z = -0.58;
    g.add(irCan);

    // Thermal sensing cone indicator (subtle warm infrared amber)
    const irWindow = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.004, 0.004, 0.003, 12)),
      matLensGlass
    );
    irWindow.position.set(0.123, 0.101, -0.046);
    irWindow.rotation.z = -0.58;
    g.add(irWindow);

    // Rear heatsink temperature probe mounted against L298N / Pi bay
    const tempProbe = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.003, 0.003, 0.022, 10)), matBrushedSteel)
    );
    tempProbe.rotation.z = Math.PI / 2;
    tempProbe.position.set(-0.048, 0.156, 0.046);
    g.add(tempProbe);

    // Braided thermal lead wire
    const thermWire = new THREE.Mesh(
      trackGeo(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.106, 0.116, -0.046),
            new THREE.Vector3(0.03, 0.126, -0.056),
            new THREE.Vector3(-0.038, 0.145, -0.024),
          ]),
          14,
          0.0018,
          6,
          false
        )
      ),
      matWireRed
    );
    g.add(thermWire);
  }

  // =========================================================================
  // 12. SIDE CORNER ULTRASONIC PODS & FOLDING GNSS/RTK MAST
  // =========================================================================
  {
    const g = partGroups.corner_guard;

    // Dual 45°-angled Left & Right HC-SR04 / Corner Ultrasonic Guard Pods
    for (const side of [-1, 1]) {
      const pod = new THREE.Group();
      pod.position.set(0.104, 0.105, side * 0.072);
      pod.rotation.y = side * -0.52;

      const board = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.006, 0.018, 0.038)), matDarkAnodized)
      );
      pod.add(board);

      for (const tz of [-0.01, 0.01]) {
        const transducer = makeShadowed(
          new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0065, 0.0065, 0.009, 14)), matBrushedSteel)
        );
        transducer.rotation.z = Math.PI / 2;
        transducer.position.set(0.006, 0, tz);
        pod.add(transducer);
      }
      g.add(pod);
    }

    // Rear folding GNSS / RTK ceramic antenna mast for Waypoint navigation
    const mastPole = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.003, 0.0035, 0.115, 10)), matDarkAnodized)
    );
    mastPole.position.set(-0.104, 0.19, 0.052);
    g.add(mastPole);

    const gpsPuck = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.02, 0.022, 0.011, 20)), matWhite3DPrint)
    );
    gpsPuck.position.set(-0.104, 0.25, 0.052);
    g.add(gpsPuck);

    const gpsRing = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.017, 0.002, 8, 20)), matDarkAnodized)
    );
    gpsRing.rotation.x = Math.PI / 2;
    gpsRing.position.set(-0.104, 0.256, 0.052);
    g.add(gpsRing);
  }

  // =========================================================================
  // 13. WHITE CANTILEVER CAMERA GANTRY & PILL-SHAPED VISION CAMERA (Signature Front Hood!)
  // =========================================================================
  let cameraFrustum: THREE.Group;
  {
    const g = partGroups.maixsense_cam;

    // Signature twin white L-shaped forward overhang gantry walls (upgraded crisp beveled finish!)
    const wallGeo = trackGeo(makeGantryWallGeometry());
    for (const wz of [-0.058, 0.058]) {
      const wall = makeShadowed(new THREE.Mesh(wallGeo, matWhite3DPrint));
      wall.position.z = wz;
      g.add(wall);

      // Machined base mounting flange tabs
      const tab = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.056, 0.006, 0.022)), matWhite3DPrint)
      );
      tab.position.set(0.087, 0.132, wz + (wz > 0 ? 0.008 : -0.008));
      g.add(tab);
    }

    // Horizontal top cross-bridge connecting left & right white cantilever arms
    const crossbar = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.01, 0.124)), matWhite3DPrint)
    );
    crossbar.position.set(0.184, 0.258, 0);
    g.add(crossbar);

    // Lower front brace bar
    const braceBar = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.016, 0.008, 0.12)), matWhite3DPrint)
    );
    braceBar.position.set(0.116, 0.224, 0);
    g.add(braceBar);

    // Sleek black gimbal clamp bracket (clean upgrade replacing the rubber bands!)
    const camClamp = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.028, 0.026, 0.036)), matDarkAnodized)
    );
    camClamp.position.set(0.184, 0.274, 0);
    g.add(camClamp);

    // Signature wide matte-black pill-shaped HD webcam / vision sensor pitched down-forward!
    const camHead = new THREE.Group();
    camHead.position.set(0.198, 0.282, 0);
    camHead.rotation.z = -0.52; // Aimed right at the weed kill zone in front of the steel flame barrel!

    const pillGeo = trackGeo(new THREE.CapsuleGeometry(0.016, 0.044, 10, 16));
    pillGeo.rotateX(Math.PI / 2);
    const pillBody = makeShadowed(new THREE.Mesh(pillGeo, matDarkAnodized));
    camHead.add(pillBody);

    // Recessed glossy optical lens ring facing forward-downward
    const lensRing = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.006, 16)), matBrushedSteel)
    );
    lensRing.rotation.z = Math.PI / 2;
    lensRing.position.set(0.015, 0, 0);
    camHead.add(lensRing);

    const lensGlass = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.0085, 0.0085, 0.007, 16)),
      matLensGlass
    );
    lensGlass.rotation.z = Math.PI / 2;
    lensGlass.position.set(0.016, 0, 0);
    camHead.add(lensGlass);

    g.add(camHead);

    // Neat curved black USB cable running smoothly from camera back to the Pi 4 enclosure!
    const camCableCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.18, 0.282, 0),
      new THREE.Vector3(0.105, 0.278, -0.02),
      new THREE.Vector3(0.02, 0.258, -0.038),
      new THREE.Vector3(-0.025, 0.184, -0.02),
    ]);
    const camCable = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(camCableCurve, 18, 0.0024, 6, false)),
      matWireDark
    );
    g.add(camCable);

    // Ground ExG vision targeting reticle projected directly in front of the steel flame nozzle!
    cameraFrustum = new THREE.Group();
    const swathPlane = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.32, 0.28)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x10b981,
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        })
      )
    );
    swathPlane.rotation.x = -Math.PI / 2;
    swathPlane.position.set(0.28, 0.008, 0);
    cameraFrustum.add(swathPlane);

    const edges = new THREE.EdgesGeometry(trackGeo(new THREE.PlaneGeometry(0.32, 0.28)));
    geometriesToDispose.push(edges);
    const swathOutline = new THREE.LineSegments(
      edges,
      trackMat(new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.78 }))
    );
    swathOutline.rotation.x = -Math.PI / 2;
    swathOutline.position.set(0.28, 0.01, 0);
    cameraFrustum.add(swathOutline);

    cameraFrustum.visible = false;
    g.add(cameraFrustum);
  }

  // =========================================================================
  // BUILD GLOWING GHOST SNAP TARGETS + LAYER-1 RAYCAST HITBOXES
  // =========================================================================
  const ghostMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.24,
      wireframe: true,
      depthWrite: false,
    })
  );
  const ghostFillMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    })
  );
  const hitboxMat = trackMat(new THREE.MeshBasicMaterial({ visible: false }));

  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();
  const tmpCenter = new THREE.Vector3();
  const hitboxMeta = {} as Record<
    PartId,
    { mesh: THREE.Mesh; baseCenter: THREE.Vector3; size: THREE.Vector3 }
  >;

  for (const spec of ROVER_PARTS) {
    const pg = partGroups[spec.id];
    const gg = ghostGroups[spec.id];

    pg.updateMatrixWorld(true);
    tmpBox.setFromObject(pg);
    tmpBox.getSize(tmpSize);
    tmpBox.getCenter(tmpCenter);

    const sx = Math.max(0.055, tmpSize.x + 0.014);
    const sy = Math.max(0.036, tmpSize.y + 0.014);
    const sz = Math.max(0.055, tmpSize.z + 0.014);

    const boxGeo = trackGeo(new THREE.BoxGeometry(sx, sy, sz));
    const ghostWire = new THREE.Mesh(boxGeo, ghostMat);
    ghostWire.position.copy(tmpCenter);
    gg.add(ghostWire);

    const ghostFill = new THREE.Mesh(boxGeo, ghostFillMat);
    ghostFill.position.copy(tmpCenter);
    gg.add(ghostFill);

    const hitMesh = new THREE.Mesh(boxGeo, hitboxMat);
    hitMesh.position.copy(tmpCenter);
    hitMesh.userData.partId = spec.id;
    hitMesh.layers.set(1);
    root.add(hitMesh);
    hitboxes.push(hitMesh);

    hitboxMeta[spec.id] = {
      mesh: hitMesh,
      baseCenter: tmpCenter.clone(),
      size: new THREE.Vector3(sx, sy, sz),
    };
  }

  // Crisp 3D selection & hover outline frames so clicked/hovered parts stand out cleanly
  const unitBoxEdges = new THREE.EdgesGeometry(trackGeo(new THREE.BoxGeometry(1, 1, 1)));
  geometriesToDispose.push(unitBoxEdges);

  const selectionFrame = new THREE.LineSegments(
    unitBoxEdges,
    trackMat(new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.92 }))
  );
  selectionFrame.visible = false;
  root.add(selectionFrame);

  const hoverFrame = new THREE.LineSegments(
    unitBoxEdges,
    trackMat(new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 }))
  );
  hoverFrame.visible = false;
  root.add(hoverFrame);

  const syncPartHighlights = (selectedId: PartId | null, hoveredId: PartId | null) => {
    for (const spec of ROVER_PARTS) {
      const meta = hitboxMeta[spec.id];
      const pg = partGroups[spec.id];
      meta.mesh.position.set(
        meta.baseCenter.x + pg.position.x,
        meta.baseCenter.y + pg.position.y,
        meta.baseCenter.z + pg.position.z
      );
    }

    if (selectedId && hitboxMeta[selectedId]) {
      const meta = hitboxMeta[selectedId];
      selectionFrame.visible = true;
      selectionFrame.position.copy(meta.mesh.position);
      selectionFrame.scale.set(meta.size.x + 0.008, meta.size.y + 0.008, meta.size.z + 0.008);
    } else {
      selectionFrame.visible = false;
    }

    if (hoveredId && hoveredId !== selectedId && hitboxMeta[hoveredId]) {
      const meta = hitboxMeta[hoveredId];
      hoverFrame.visible = true;
      hoverFrame.position.copy(meta.mesh.position);
      hoverFrame.scale.set(meta.size.x + 0.012, meta.size.y + 0.012, meta.size.z + 0.012);
    } else {
      hoverFrame.visible = false;
    }
  };

  const getPartWorldCenter = (partId: PartId, outVec: THREE.Vector3) => {
    const meta = hitboxMeta[partId];
    if (!meta) {
      outVec.copy(root.position);
      return;
    }
    outVec.copy(meta.mesh.position);
    root.localToWorld(outVec);
  };

  // Default to the real bot's iconic Flame Turret!
  const setToolType = (tool: TreatmentToolType) => {
    toolVariants.flame.visible = tool === 'flame';
    toolVariants.grinder.visible = tool === 'grinder';
    toolVariants.laser.visible = tool === 'laser';
    if (tool !== 'laser') {
      laserBeamMesh.visible = false;
      laserImpactDot.visible = false;
    }
    if (tool !== 'flame') {
      flameConeGroup.visible = false;
      sparkArcMesh.visible = false;
    }
  };
  setToolType('flame');

  const _origin = new THREE.Vector3(0.056, 0.08, 0);
  const _target = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _quat = new THREE.Quaternion();

  const setFiringVisual = (
    firing: boolean,
    tool: TreatmentToolType,
    elapsed: number,
    localTarget?: { x: number; z: number } | null,
    sparkPhase = false,
    manualAimRad: number | null = null
  ) => {
    // Servo-driven turret yaw calculation: rotates the entire inverted butane tank + horizontal steel nozzle toward the weed!
    let desiredTurretYaw = 0;
    if (manualAimRad !== null) {
      desiredTurretYaw = THREE.MathUtils.clamp(manualAimRad, -0.82, 0.82);
    } else if (localTarget) {
      // Rover local +X is forward, +Z is right, -Z is left; Three.js +Y rotation turns +X toward -Z (left)
      const dx = Math.max(0.07, localTarget.x - 0.056);
      const rawYaw = Math.atan2(-localTarget.z, dx);
      desiredTurretYaw = THREE.MathUtils.clamp(rawYaw, -0.82, 0.82);
    }

    // Smoothly drive turret & meshing servo spur gear even while acquiring target BEFORE firing!
    turretPivotGroup.rotation.y = THREE.MathUtils.lerp(
      turretPivotGroup.rotation.y,
      desiredTurretYaw,
      0.18
    );
    servoGearMesh.rotation.y = -turretPivotGroup.rotation.y * (26 / 22);

    if (!firing) {
      flameConeGroup.visible = false;
      sparkArcMesh.visible = false;
      laserBeamMesh.visible = false;
      laserImpactDot.visible = false;
      grinderDisc.position.y = THREE.MathUtils.lerp(grinderDisc.position.y, -0.084, 0.2);
      return;
    }

    if (tool === 'flame') {
      if (sparkPhase) {
        sparkArcMesh.visible = true;
        sparkArcMesh.scale.setScalar(0.75 + Math.abs(Math.sin(elapsed * 90)) * 0.75);
        sparkArcMesh.rotation.set(elapsed * 30, elapsed * 45, 0);
        flameConeGroup.visible = false;
      } else {
        sparkArcMesh.visible = Math.sin(elapsed * 70) > 0.65;
        flameConeGroup.visible = true;
        const lengthPulse = 0.92 + Math.sin(elapsed * 46) * 0.18 + Math.cos(elapsed * 31) * 0.1;
        const widthPulse = 0.9 + Math.cos(elapsed * 52) * 0.14;
        flameConeGroup.scale.set(lengthPulse, widthPulse, widthPulse);
        flameConeGroup.rotation.z = Math.sin(elapsed * 38) * 0.06;
      }
    } else if (tool === 'grinder') {
      grinderDisc.rotation.y += 0.62;
      grinderDisc.position.y = -0.098 + Math.sin(elapsed * 44) * 0.002;
    } else if (tool === 'laser') {
      const tx = localTarget ? localTarget.x : 0.26;
      const tz = localTarget ? localTarget.z : 0;
      _target.set(tx, 0.012, tz);
      _dir.subVectors(_target, _origin);
      const dist = _dir.length();
      if (dist > 0.005) {
        _dir.normalize();
        _quat.setFromUnitVectors(_down, _dir);
        laserBeamMesh.position.copy(_origin);
        laserBeamMesh.quaternion.copy(_quat);
        laserBeamMesh.scale.set(1, dist, 1);
        laserBeamMesh.visible = true;
        laserImpactDot.position.copy(_target);
        laserImpactDot.scale.setScalar(0.85 + Math.sin(elapsed * 50) * 0.25);
        laserImpactDot.visible = true;

        laserGimbalPan.rotation.y = Math.atan2(tx - 0.056, tz || 0.001) * 0.35;
        laserGimbalTilt.rotation.z = THREE.MathUtils.clamp((tx - 0.056) * 2.1, -0.65, 0.65);
        laserGimbalTilt.rotation.x = THREE.MathUtils.clamp(-tz * 2.1, -0.65, 0.65);
      }
    }
  };

  const getTurretYawDeg = () => Math.round((turretPivotGroup.rotation.y * 180) / Math.PI);

  const setEstopPressed = (pressed: boolean) => {
    estopCap.position.y = pressed ? 0.148 : 0.152;
  };

  return {
    root,
    partGroups,
    ghostGroups,
    hitboxes,
    leftWheels,
    rightWheels,
    toolVariants,
    grinderDisc,
    flameConeGroup,
    sparkArcMesh,
    servoGearMesh,
    turretGearMesh,
    turretPivotGroup,
    laserGimbalPan,
    laserGimbalTilt,
    laserBeamMesh,
    laserImpactDot,
    cameraFrustum,
    tofBeam,
    estopCap,
    contactShadow,
    setToolType,
    setFiringVisual,
    getTurretYawDeg,
    setEstopPressed,
    syncPartHighlights,
    getPartWorldCenter,
    dispose() {
      geometriesToDispose.forEach((g) => g.dispose());
      materialsToDispose.forEach((m) => m.dispose());
      localTexturesToDispose.forEach((t) => t.dispose());
    },
  };
}
