import * as THREE from 'three';
import { PART_BY_ID, ROVER_PARTS } from './roverPartsCatalog';
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
    localTarget?: { x: number; z: number } | null
  ) => void;
  setEstopPressed: (pressed: boolean) => void;
  dispose: () => void;
}

function makeDeckGeometry(): THREE.ExtrudeGeometry {
  // Matches generate_chassis_model.py: 256mm x 155mm octagonal chamfered deck (chamfer 32mm)
  const hl = 0.128;
  const hw = 0.0775;
  const c = 0.032;

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

  // Signature 5-point star cutout at X=+40mm
  const starHole = new THREE.Path();
  const rOut = 0.019;
  const rIn = 0.0082;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const ang = (i * Math.PI) / 5;
    const x = 0.04 + Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    if (i === 0) starHole.moveTo(x, y);
    else starHole.lineTo(x, y);
  }
  starHole.closePath();
  shape.holes.push(starHole);

  // Signature diamond cutout at X=-55mm
  const d = 0.025;
  const diamond = new THREE.Path();
  diamond.moveTo(-0.055 + d, 0);
  diamond.lineTo(-0.055, d);
  diamond.lineTo(-0.055 - d, 0);
  diamond.lineTo(-0.055, -d);
  diamond.closePath();
  shape.holes.push(diamond);

  // Ventilation slots (3 per side for clean triangulation)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const sx = 0.024 + i * 0.016;
      const sy = side * 0.05;
      const slot = new THREE.Path();
      slot.moveTo(sx, sy - 0.007);
      slot.lineTo(sx + 0.006, sy - 0.007);
      slot.lineTo(sx + 0.006, sy + 0.007);
      slot.lineTo(sx, sy + 0.007);
      slot.closePath();
      shape.holes.push(slot);
    }
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0045,
    bevelEnabled: true,
    bevelThickness: 0.0008,
    bevelSize: 0.0008,
    bevelSegments: 2,
  });
  // Extrude is in XY (+Z depth); rotate so plate lies flat in XZ with thickness along +Y
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function makeArchPanelGeometry(): THREE.ExtrudeGeometry {
  // Matches generate_chassis_model.py side arch panel in X-Y plane
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

  // Front & rear triangular lightening cutouts
  const triF = new THREE.Path();
  triF.moveTo(0.072, 0.076);
  triF.lineTo(0.084, 0.064);
  triF.lineTo(0.07, 0.064);
  triF.closePath();
  shape.holes.push(triF);

  const triR = new THREE.Path();
  triR.moveTo(-0.072, 0.076);
  triR.lineTo(-0.07, 0.064);
  triR.lineTo(-0.084, 0.064);
  triR.closePath();
  shape.holes.push(triR);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.004,
    bevelEnabled: true,
    bevelThickness: 0.0005,
    bevelSize: 0.0005,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -0.002);
  return geo;
}

export function buildRoverRig(textures: ProceduralTexturePack): RoverRig {
  const root = new THREE.Group();
  root.name = 'AgriRoverRoot';

  const geometriesToDispose: THREE.BufferGeometry[] = [];
  const materialsToDispose: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometriesToDispose.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materialsToDispose.push(m);
    return m;
  };

  // Shared calibrated PBR Materials (varied roughness & metalness)
  const matWoodTop = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.plywood,
      roughness: 0.68,
      metalness: 0.04,
    })
  );
  const matWoodLeg = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.plywoodDark,
      roughness: 0.74,
      metalness: 0.04,
    })
  );
  const matYellowPlastic = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf4c41c,
      roughness: 0.34,
      metalness: 0.05,
    })
  );
  const matRubberTire = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1b1d20,
      roughness: 0.88,
      metalness: 0.04,
    })
  );
  const matBrushedSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd4dae2,
      roughness: 0.24,
      metalness: 0.9,
    })
  );
  const matDarkAnodized = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x262c34,
      roughness: 0.38,
      metalness: 0.72,
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
      color: 0xf1f5f9,
      roughness: 0.45,
      metalness: 0.02,
    })
  );
  const matPcbGreen = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.pcbGreen,
      roughness: 0.42,
      metalness: 0.12,
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
  const matLipoBlue = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e56a0,
      roughness: 0.35,
      metalness: 0.18,
    })
  );
  const matEstopRed = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.28,
      metalness: 0.08,
    })
  );
  const matSafetyYellow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xeab308,
      roughness: 0.4,
      metalness: 0.08,
    })
  );
  const matLensGlass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.08,
      metalness: 0.85,
    })
  );
  const matBrass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc59b43,
      roughness: 0.3,
      metalness: 0.86,
    })
  );

  // Soft contact shadow directly under the rover (Y = 0.002 to avoid z-fighting)
  const contactShadow = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(0.46, 0.34)),
    trackMat(
      new THREE.MeshBasicMaterial({
        map: textures.contactShadow,
        transparent: true,
        opacity: 0.5,
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
  // 1. CHASSIS TOP DECK (256 x 155 x 4.5 mm at Y = 0.125)
  // =========================================================================
  {
    const g = partGroups.chassis_deck;
    const deckGeo = trackGeo(makeDeckGeometry());
    const deckMesh = makeShadowed(new THREE.Mesh(deckGeo, matWoodTop));
    deckMesh.position.y = 0.125;
    g.add(deckMesh);

    // 4 Brass corner standoffs + M3 screws on top deck
    const standoffGeo = trackGeo(new THREE.CylinderGeometry(0.0035, 0.0035, 0.008, 8));
    for (const sx of [-0.088, 0.088]) {
      for (const sz of [-0.058, 0.058]) {
        const st = makeShadowed(new THREE.Mesh(standoffGeo, matBrass));
        st.position.set(sx, 0.133, sz);
        g.add(st);
      }
    }

    // Center aluminum stiffener rails underneath deck
    const railGeo = trackGeo(new THREE.BoxGeometry(0.18, 0.005, 0.008));
    for (const sz of [-0.036, 0.036]) {
      const rail = makeShadowed(new THREE.Mesh(railGeo, matBrushedSteel));
      rail.position.set(0, 0.122, sz);
      g.add(rail);
    }
  }

  // =========================================================================
  // 2. HIGH-CLEARANCE STRADDLE ARCH LEGS (4 parallel bridge panels + M3 bolts)
  // =========================================================================
  {
    const g = partGroups.arch_legs;
    const archGeo = trackGeo(makeArchPanelGeometry());
    const zPositions = [-0.066, -0.047, 0.047, 0.066];
    for (const zp of zPositions) {
      const panel = makeShadowed(new THREE.Mesh(archGeo, matWoodLeg));
      panel.position.z = zp;
      g.add(panel);
    }

    // Cross-bridge M3 clamping bolts & hex caps spanning inner-outer plates
    const boltGeo = trackGeo(new THREE.CylinderGeometry(0.0022, 0.0022, 0.028, 8));
    boltGeo.rotateX(Math.PI / 2);
    const headGeo = trackGeo(new THREE.CylinderGeometry(0.0042, 0.0042, 0.003, 6));
    headGeo.rotateX(Math.PI / 2);

    for (const sideSign of [-1, 1]) {
      const zCenter = sideSign * 0.0565;
      for (const bx of [-0.03, 0.03]) {
        const bolt = makeShadowed(new THREE.Mesh(boltGeo, matBrushedSteel));
        bolt.position.set(bx, 0.118, zCenter);
        g.add(bolt);

        const head = makeShadowed(new THREE.Mesh(headGeo, matBrushedSteel));
        head.position.set(bx, 0.118, sideSign * 0.07);
        g.add(head);
      }
    }
  }

  // =========================================================================
  // 3. 4x YELLOW TT GEARED MOTORS + QUADRATURE ENCODERS
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
      // Tilt 45 deg up-inward along the sloping arch leg
      mGroup.rotation.z = cfg.dirX > 0 ? -Math.PI / 4 : Math.PI / 4;

      const gb = makeShadowed(new THREE.Mesh(gearboxGeo, matYellowPlastic));
      gb.position.set(-cfg.dirX * 0.021, 0, 0);
      mGroup.add(gb);

      const nose = makeShadowed(new THREE.Mesh(noseGeo, matYellowPlastic));
      mGroup.add(nose);

      const can = makeShadowed(new THREE.Mesh(canGeo, matBrushedSteel));
      can.position.set(-cfg.dirX * 0.054, 0, 0);
      mGroup.add(can);

      // White drive shaft extending outward into wheel hub
      const shaft = makeShadowed(new THREE.Mesh(shaftGeo, matWhitePlastic));
      shaft.position.set(0, 0, cfg.side * 0.004);
      mGroup.add(shaft);

      // Optical quadrature encoder disc on inner stub shaft
      const enc = makeShadowed(new THREE.Mesh(encDiscGeo, matDarkAnodized));
      enc.position.set(0, 0, -cfg.side * 0.014);
      mGroup.add(enc);

      g.add(mGroup);
    }
  }

  // =========================================================================
  // 4. 4x LUGGED OFF-ROAD ROVER WHEELS (Ø70mm, W=26mm, 5-spoke yellow rims)
  // =========================================================================
  const leftWheels: THREE.Group[] = [];
  const rightWheels: THREE.Group[] = [];
  {
    const g = partGroups.rover_wheels;
    const tireOuterGeo = trackGeo(new THREE.CylinderGeometry(0.034, 0.034, 0.026, 24));
    tireOuterGeo.rotateX(Math.PI / 2);
    const rimGeo = trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.027, 18));
    rimGeo.rotateX(Math.PI / 2);
    const hubGeo = trackGeo(new THREE.CylinderGeometry(0.0075, 0.0075, 0.029, 12));
    hubGeo.rotateX(Math.PI / 2);
    const spokeGeo = trackGeo(new THREE.BoxGeometry(0.044, 0.005, 0.0285));
    const lugGeo = trackGeo(new THREE.BoxGeometry(0.004, 0.0032, 0.022));

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
      wPivot.add(makeShadowed(new THREE.Mesh(hubGeo, matWhitePlastic)));

      // 5 spokes (3 crossed bars)
      for (let s = 0; s < 5; s++) {
        const sp = makeShadowed(new THREE.Mesh(spokeGeo, matYellowPlastic));
        sp.rotation.z = (s * Math.PI) / 5;
        wPivot.add(sp);
      }

      // 16 agricultural tread lugs
      for (let l = 0; l < 16; l++) {
        const ang = (l * Math.PI * 2) / 16;
        const lug = new THREE.Mesh(lugGeo, matRubberTire);
        lug.position.set(Math.cos(ang) * 0.0345, Math.sin(ang) * 0.0345, 0);
        lug.rotation.z = ang + Math.PI / 2;
        wPivot.add(lug);
      }

      g.add(wPivot);
      if (wc.isLeft) leftWheels.push(wPivot);
      else rightWheels.push(wPivot);
    }
  }

  // =========================================================================
  // 5. L298N DUAL H-BRIDGE DRIVER + 3S LiPo BATTERY PACK
  // =========================================================================
  {
    const g = partGroups.power_driver;

    // 3S LiPo battery mounted cleanly on rear-center deck
    const lipo = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.072, 0.022, 0.038)), matLipoBlue)
    );
    lipo.position.set(-0.068, 0.141, 0.028);
    g.add(lipo);

    // Velcro strap around battery
    const strap = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.024, 0.041)), matDarkAnodized)
    );
    strap.position.set(-0.068, 0.141, 0.028);
    g.add(strap);

    // Yellow XT60 plug
    const xt60 = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.008, 0.012)), matSafetyYellow)
    );
    xt60.position.set(-0.026, 0.136, 0.028);
    g.add(xt60);

    // L298N Red PCB board
    const l298Board = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.043, 0.003, 0.043)), matPcbRed)
    );
    l298Board.position.set(-0.015, 0.132, -0.042);
    g.add(l298Board);

    // Tall anodized aluminum finned heatsink on L298N
    const sinkBase = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.024, 0.024)), matDarkAnodized)
    );
    sinkBase.position.set(-0.022, 0.145, -0.042);
    g.add(sinkBase);

    for (let f = -1; f <= 1; f++) {
      const fin = makeShadowed(
        new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.022, 0.003)), matDarkAnodized)
      );
      fin.position.set(-0.022, 0.145, -0.042 + f * 0.008);
      g.add(fin);
    }

    // Blue/green screw terminal blocks
    const termMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.45, metalness: 0.1 })
    );
    const term = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.01, 0.01, 0.028)), termMat)
    );
    term.position.set(0.0, 0.138, -0.042);
    g.add(term);
  }

  // =========================================================================
  // 6. ESP32 REAL-TIME MOTOR & WATCHDOG CONTROLLER
  // =========================================================================
  {
    const g = partGroups.esp32_mcu;
    const espGroup = new THREE.Group();
    espGroup.position.set(0.042, 0.133, 0.042);

    const pcb = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.052, 0.003, 0.028)), matPcbBlack)
    );
    espGroup.add(pcb);

    // Metallic WROOM-32 RF Shield
    const shield = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.005, 0.018)), matBrushedSteel)
    );
    shield.position.set(-0.01, 0.004, 0);
    espGroup.add(shield);

    // USB-C silver port
    const usb = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.008, 0.004, 0.009)), matBrushedSteel)
    );
    usb.position.set(0.024, 0.0035, 0);
    espGroup.add(usb);

    // Gold pin headers along both sides
    const pinGeo = trackGeo(new THREE.BoxGeometry(0.046, 0.005, 0.0025));
    for (const sz of [-0.0115, 0.0115]) {
      const pins = makeShadowed(new THREE.Mesh(pinGeo, matCopperGold));
      pins.position.set(0, 0.004, sz);
      espGroup.add(pins);
    }

    g.add(espGroup);
  }

  // =========================================================================
  // 7. RASPBERRY PI 4 COMPUTE BRAIN
  // =========================================================================
  {
    const g = partGroups.raspberry_pi;
    const piGroup = new THREE.Group();
    piGroup.position.set(0.036, 0.138, -0.024);

    // Green PCB (85 x 56 mm scaled cleanly onto deck)
    const pcb = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.082, 0.003, 0.054)), matPcbGreen)
    );
    piGroup.add(pcb);

    // Broadcom SoC + Black finned heatsink
    const soc = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.009, 0.018)), matDarkAnodized)
    );
    soc.position.set(-0.008, 0.006, 0);
    piGroup.add(soc);

    // Dual USB stacks + Gigabit Ethernet metal housings
    const eth = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.02, 0.014, 0.016)), matBrushedSteel)
    );
    eth.position.set(0.032, 0.0085, -0.016);
    piGroup.add(eth);

    const usb1 = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.014, 0.013)), matBrushedSteel)
    );
    usb1.position.set(0.032, 0.0085, 0.002);
    piGroup.add(usb1);

    const usb2 = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.018, 0.014, 0.013)), matBrushedSteel)
    );
    usb2.position.set(0.032, 0.0085, 0.018);
    piGroup.add(usb2);

    // 40-pin GPIO header strip
    const gpio = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.052, 0.008, 0.005)), matDarkAnodized)
    );
    gpio.position.set(-0.006, 0.0055, -0.022);
    piGroup.add(gpio);

    // Standoffs lifting Pi 4 cleanly above plywood deck
    const stGeo = trackGeo(new THREE.CylinderGeometry(0.0024, 0.0024, 0.008, 8));
    for (const sx of [-0.035, 0.035]) {
      for (const sz of [-0.022, 0.022]) {
        const st = makeShadowed(new THREE.Mesh(stGeo, matBrass));
        st.position.set(sx, -0.005, sz);
        piGroup.add(st);
      }
    }

    g.add(piGroup);
  }

  // =========================================================================
  // 8. BNO055 9-DOF IMU + VL53L0X FRONT OBSTACLE ToF SENSOR
  // =========================================================================
  let tofBeam: THREE.Mesh;
  {
    const g = partGroups.imu_tof;

    // Blue BNO055 IMU breakout mounted near center-front of deck
    const imuBoard = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.024, 0.003, 0.02)), matPcbBlue)
    );
    imuBoard.position.set(0.095, 0.133, 0.0);
    g.add(imuBoard);

    const imuChip = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.007, 0.003, 0.007)), matDarkAnodized)
    );
    imuChip.position.set(0.095, 0.136, 0.0);
    g.add(imuChip);

    // Front aluminum sensor bumper bracket
    const bracket = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.024, 0.05)), matDarkAnodized)
    );
    bracket.position.set(0.132, 0.118, 0.0);
    g.add(bracket);

    // VL53L0X Time-of-Flight purple/blue sensor module facing forward (+X)
    const tofBoard = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.005, 0.016, 0.026)), matPcbBlue)
    );
    tofBoard.position.set(0.14, 0.118, 0.0);
    g.add(tofBoard);

    // Twin optical emitter/receiver lenses
    const lensGeo = trackGeo(new THREE.CylinderGeometry(0.0035, 0.0035, 0.004, 12));
    lensGeo.rotateZ(Math.PI / 2);
    for (const sz of [-0.006, 0.006]) {
      const lens = makeShadowed(new THREE.Mesh(lensGeo, matLensGlass));
      lens.position.set(0.143, 0.118, sz);
      g.add(lens);
    }

    // Subtle forward ToF laser-rangefinder beam (visible in Field mode)
    const beamGeo = trackGeo(new THREE.ConeGeometry(0.045, 0.35, 16, 1, true));
    beamGeo.rotateZ(Math.PI / 2);
    beamGeo.translate(0.175, 0, 0);
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
    tofBeam.position.set(0.145, 0.118, 0);
    tofBeam.visible = false;
    g.add(tofBeam);
  }

  // =========================================================================
  // 9. MAIXSENSE-A075V RGB-D CAMERA MAST + GROUND SWATH FRUSTUM
  // =========================================================================
  let cameraFrustum: THREE.Group;
  {
    const g = partGroups.maixsense_cam;

    // Mast base flange
    const flange = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.032, 0.008, 0.032)), matDarkAnodized)
    );
    flange.position.set(-0.02, 0.133, 0.0);
    g.add(flange);

    // Vertical 2020-style aluminum mast extrusion (height 210mm)
    const mastPole = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.015, 0.21, 0.015)), matBrushedSteel)
    );
    mastPole.position.set(-0.02, 0.24, 0.0);
    g.add(mastPole);

    // Forward cantilever arm
    const arm = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.013, 0.013)), matBrushedSteel)
    );
    arm.position.set(0.032, 0.34, 0.0);
    g.add(arm);

    // Diagonal gusset brace
    const brace = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.07, 0.007, 0.007)), matDarkAnodized)
    );
    brace.position.set(0.01, 0.312, 0.0);
    brace.rotation.z = Math.PI / 4;
    g.add(brace);

    // Sipeed MaixSense-A075V aluminum camera body angled downward toward crop row
    const camHead = new THREE.Group();
    camHead.position.set(0.088, 0.33, 0.0);
    camHead.rotation.z = -0.35; // Pitched down forward

    const camBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.034, 0.026, 0.056)), matDarkAnodized)
    );
    camHead.add(camBody);

    // Red Sipeed accent trim ring on camera faceplate
    const accentTrim = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.036, 0.004, 0.058)),
        trackMat(new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.35, metalness: 0.3 }))
      )
    );
    accentTrim.position.y = -0.012;
    camHead.add(accentTrim);

    // RGB lens + ToF emitter lens on bottom face
    const camLensGeo = trackGeo(new THREE.CylinderGeometry(0.0085, 0.0085, 0.006, 16));
    const rgbLens = makeShadowed(new THREE.Mesh(camLensGeo, matLensGlass));
    rgbLens.position.set(0, -0.015, -0.014);
    camHead.add(rgbLens);

    const tofLens = makeShadowed(new THREE.Mesh(camLensGeo, matLensGlass));
    tofLens.position.set(0, -0.015, 0.014);
    camHead.add(tofLens);

    g.add(camHead);

    // Translucent ground scan footprint (40 x 30 cm ExG swath) shown during field run
    cameraFrustum = new THREE.Group();
    const swathPlane = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.36, 0.28)),
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
    swathPlane.position.set(0.05, 0.008, 0);
    cameraFrustum.add(swathPlane);

    const edges = new THREE.EdgesGeometry(trackGeo(new THREE.PlaneGeometry(0.36, 0.28)));
    geometriesToDispose.push(edges);
    const swathOutline = new THREE.LineSegments(
      edges,
      trackMat(new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.72 }))
    );
    swathOutline.rotation.x = -Math.PI / 2;
    swathOutline.position.set(0.05, 0.01, 0);
    cameraFrustum.add(swathOutline);

    cameraFrustum.visible = false;
    g.add(cameraFrustum);
  }

  // =========================================================================
  // 10. GPIO 13 PHYSICAL E-STOP + MODULAR WEEDING ATTACHMENT (Grinder / Flame / Laser)
  // =========================================================================
  let estopCap: THREE.Mesh;
  const toolVariants = {} as Record<TreatmentToolType, THREE.Group>;
  let grinderDisc: THREE.Group;
  let flameConeGroup: THREE.Group;
  let laserGimbalPan: THREE.Group;
  let laserGimbalTilt: THREE.Group;
  let laserBeamMesh: THREE.Mesh;
  let laserImpactDot: THREE.Mesh;

  {
    const g = partGroups.estop_tool;

    // Yellow industrial E-Stop enclosure box on rear-left top deck
    const estopBox = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.036, 0.022, 0.036)), matSafetyYellow)
    );
    estopBox.position.set(-0.088, 0.14, -0.026);
    g.add(estopBox);

    const collar = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.012, 0.013, 0.006, 16)), matDarkAnodized)
    );
    collar.position.set(-0.088, 0.153, -0.026);
    g.add(collar);

    estopCap = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.016, 0.012, 0.012, 18)), matEstopRed)
    );
    estopCap.position.set(-0.088, 0.161, -0.026);
    g.add(estopCap);

    // Under-chassis modular tool mount plate (inside high-clearance arch at Y=0.102)
    const mountPlate = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.054, 0.006, 0.054)), matDarkAnodized)
    );
    mountPlate.position.set(0.01, 0.118, 0);
    g.add(mountPlate);

    // --- Variant A: Mechanical Rotary Grinder (Simpla Bot) ---
    const grinderGroup = new THREE.Group();
    grinderGroup.position.set(0.01, 0.115, 0);

    const gMotor = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.038, 16)), matDarkAnodized)
    );
    gMotor.position.y = -0.022;
    grinderGroup.add(gMotor);

    const gShaft = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.004, 0.004, 0.035, 10)), matBrushedSteel)
    );
    gShaft.position.y = -0.054;
    grinderGroup.add(gShaft);

    const guard = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.038, 0.04, 0.014, 18, 1, true)),
        matSafetyYellow
      )
    );
    guard.position.y = -0.064;
    grinderGroup.add(guard);

    grinderDisc = new THREE.Group();
    grinderDisc.position.y = -0.072;
    const discBody = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.032, 0.032, 0.004, 18)), matBrushedSteel)
    );
    grinderDisc.add(discBody);

    const toothGeo = trackGeo(new THREE.BoxGeometry(0.014, 0.006, 0.005));
    for (let t = 0; t < 6; t++) {
      const ang = (t * Math.PI * 2) / 6;
      const tooth = makeShadowed(new THREE.Mesh(toothGeo, matCopperGold));
      tooth.position.set(Math.cos(ang) * 0.03, -0.003, Math.sin(ang) * 0.03);
      tooth.rotation.y = -ang;
      grinderDisc.add(tooth);
    }
    grinderGroup.add(grinderDisc);
    toolVariants.grinder = grinderGroup;
    g.add(grinderGroup);

    // --- Variant B: Precision Thermal Flame Weeder (Simpla Bot) ---
    const flameGroup = new THREE.Group();
    flameGroup.position.set(0.01, 0.115, 0);

    const valve = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.024, 0.022, 0.024)), matBrass)
    );
    valve.position.y = -0.015;
    flameGroup.add(valve);

    const wand = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.006, 0.006, 0.042, 12)), matBrushedSteel)
    );
    wand.position.y = -0.042;
    flameGroup.add(wand);

    const nozzle = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.009, 0.013, 0.016, 14)), matDarkAnodized)
    );
    nozzle.position.y = -0.065;
    flameGroup.add(nozzle);

    flameConeGroup = new THREE.Group();
    flameConeGroup.position.y = -0.073;
    const outerFlame = new THREE.Mesh(
      trackGeo(new THREE.ConeGeometry(0.022, 0.072, 14)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xf97316,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
        })
      )
    );
    outerFlame.rotation.x = Math.PI;
    outerFlame.position.y = -0.034;
    flameConeGroup.add(outerFlame);

    const innerFlame = new THREE.Mesh(
      trackGeo(new THREE.ConeGeometry(0.011, 0.044, 12)),
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        })
      )
    );
    innerFlame.rotation.x = Math.PI;
    innerFlame.position.y = -0.02;
    flameConeGroup.add(innerFlame);

    flameConeGroup.visible = false;
    flameGroup.add(flameConeGroup);
    toolVariants.flame = flameGroup;
    g.add(flameGroup);

    // --- Variant C: Pan-Tilt Precision Diode Laser (Weed_Detection / FieldSim) ---
    const laserGroup = new THREE.Group();
    laserGroup.position.set(0.01, 0.115, 0);

    laserGimbalPan = new THREE.Group();
    const panServo = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.024, 0.018, 0.022)), matDarkAnodized)
    );
    panServo.position.y = -0.011;
    laserGimbalPan.add(panServo);

    const uBracket = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.028, 0.018, 0.028)), matBrushedSteel)
    );
    uBracket.position.y = -0.026;
    laserGimbalPan.add(uBracket);

    laserGimbalTilt = new THREE.Group();
    laserGimbalTilt.position.y = -0.036;

    const diodeBarrel = makeShadowed(
      new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.01, 0.01, 0.032, 14)),
        trackMat(new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.25, metalness: 0.75 }))
      )
    );
    diodeBarrel.position.y = -0.014;
    laserGimbalTilt.add(diodeBarrel);

    const emitterTip = makeShadowed(
      new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.005, 0.007, 0.008, 12)), matBrass)
    );
    emitterTip.position.y = -0.032;
    laserGimbalTilt.add(emitterTip);

    laserGimbalPan.add(laserGimbalTilt);
    laserGroup.add(laserGimbalPan);

    // Dynamic laser beam (positioned in rover-local space)
    const beamUnitGeo = trackGeo(new THREE.CylinderGeometry(0.0022, 0.0022, 1, 8));
    beamUnitGeo.translate(0, -0.5, 0);
    laserBeamMesh = new THREE.Mesh(
      beamUnitGeo,
      trackMat(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.92,
        })
      )
    );
    laserBeamMesh.visible = false;
    g.add(laserBeamMesh);

    laserImpactDot = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.009, 10, 10)),
      trackMat(new THREE.MeshBasicMaterial({ color: 0x7dd3fc }))
    );
    laserImpactDot.visible = false;
    g.add(laserImpactDot);

    toolVariants.laser = laserGroup;
    g.add(laserGroup);
  }

  // =========================================================================
  // BUILD GLOWING GHOST SNAP TARGETS + LAYER-1 RAYCAST HITBOXES FOR EVERY PART
  // =========================================================================
  const ghostMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.22,
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

  for (const spec of ROVER_PARTS) {
    const pg = partGroups[spec.id];
    const gg = ghostGroups[spec.id];

    pg.updateMatrixWorld(true);
    tmpBox.setFromObject(pg);
    tmpBox.getSize(tmpSize);
    tmpBox.getCenter(tmpCenter);

    // Ensure non-zero hitbox padding for crisp click picking
    const sx = Math.max(0.055, tmpSize.x + 0.016);
    const sy = Math.max(0.036, tmpSize.y + 0.016);
    const sz = Math.max(0.055, tmpSize.z + 0.016);

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
  }

  // Default tool selection
  const setToolType = (tool: TreatmentToolType) => {
    toolVariants.grinder.visible = tool === 'grinder';
    toolVariants.flame.visible = tool === 'flame';
    toolVariants.laser.visible = tool === 'laser';
    if (tool !== 'laser') {
      laserBeamMesh.visible = false;
      laserImpactDot.visible = false;
    }
    if (tool !== 'flame') {
      flameConeGroup.visible = false;
    }
  };
  setToolType('grinder');

  const _origin = new THREE.Vector3(0.01, 0.075, 0);
  const _target = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _quat = new THREE.Quaternion();

  const setFiringVisual = (
    firing: boolean,
    tool: TreatmentToolType,
    elapsed: number,
    localTarget?: { x: number; z: number } | null
  ) => {
    if (!firing) {
      flameConeGroup.visible = false;
      laserBeamMesh.visible = false;
      laserImpactDot.visible = false;
      grinderDisc.position.y = THREE.MathUtils.lerp(grinderDisc.position.y, -0.072, 0.2);
      return;
    }

    if (tool === 'grinder') {
      grinderDisc.rotation.y += 0.55;
      grinderDisc.position.y = -0.088 + Math.sin(elapsed * 42) * 0.002;
    } else if (tool === 'flame') {
      flameConeGroup.visible = true;
      const flicker = 0.85 + Math.sin(elapsed * 55) * 0.16 + Math.cos(elapsed * 37) * 0.08;
      flameConeGroup.scale.set(0.95 + Math.sin(elapsed * 40) * 0.12, flicker, 0.95 + Math.cos(elapsed * 44) * 0.12);
    } else if (tool === 'laser') {
      const tx = localTarget ? localTarget.x : 0.01;
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

        // Slew gimbal visibly toward target
        laserGimbalPan.rotation.y = Math.atan2(tx - 0.01, tz || 0.001) * 0.35;
        laserGimbalTilt.rotation.z = THREE.MathUtils.clamp((tx - 0.01) * 2.4, -0.6, 0.6);
        laserGimbalTilt.rotation.x = THREE.MathUtils.clamp(-(tz) * 2.4, -0.6, 0.6);
      }
    }
  };

  const setEstopPressed = (pressed: boolean) => {
    estopCap.position.y = pressed ? 0.156 : 0.161;
  };

  // Validate PART_BY_ID referenced so tree shaking keeps metadata aligned
  void PART_BY_ID;

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
    setEstopPressed,
    dispose() {
      geometriesToDispose.forEach((g) => g.dispose());
      materialsToDispose.forEach((m) => m.dispose());
    },
  };
}
