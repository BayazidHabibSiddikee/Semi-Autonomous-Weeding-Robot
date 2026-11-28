import * as THREE from 'three';
import { CROP_FIELD_BY_ID } from './fieldTypesCatalog';
import { ProceduralTexturePack } from './textures';
import {
  CropFieldId,
  FieldObstacle3D,
  FieldPlant3D,
  FieldWeed3D,
  TreatmentToolType,
} from './types';

export interface FieldEnvironmentHandle {
  workshopGroup: THREE.Group;
  fieldGroup: THREE.Group;
  setFieldType: (fieldType: CropFieldId) => void;
  syncFieldEntities: (
    crops: FieldPlant3D[],
    weeds: FieldWeed3D[],
    obstacle: FieldObstacle3D
  ) => void;
  spawnTreatmentParticles: (
    wx: number,
    wz: number,
    tool: TreatmentToolType,
    count?: number
  ) => void;
  updateParticles: (dt: number) => void;
  dispose: () => void;
}

interface ParticleSlot {
  active: boolean;
  age: number;
  life: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  scale: number;
}

export const FIELD_LENGTH_M = 3.6;
export const FIELD_WIDTH_M = 2.4;
export const FIELD_ROW_Z = [-0.9, -0.3, 0.3, 0.9];

export function buildGameEnvironments(
  textures: ProceduralTexturePack
): FieldEnvironmentHandle {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  // =========================================================================
  // 1. WORKSHOP ASSEMBLY BAY
  // =========================================================================
  const workshopGroup = new THREE.Group();
  workshopGroup.name = 'WorkshopBay';

  // Solid oak workbench table below cutting mat (top at Y = -0.002)
  const benchTop = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.5, 0.06, 1.05)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.plywoodDark,
        roughness: 0.72,
        metalness: 0.04,
      })
    )
  );
  benchTop.position.set(0, -0.032, 0);
  benchTop.receiveShadow = true;
  workshopGroup.add(benchTop);

  // Precision teal cutting mat flush at Y = 0
  const cuttingMat = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(0.92, 0.66)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.workbenchMat,
        roughness: 0.62,
        metalness: 0.06,
      })
    )
  );
  cuttingMat.rotation.x = -Math.PI / 2;
  cuttingMat.position.y = 0.0;
  cuttingMat.receiveShadow = true;
  workshopGroup.add(cuttingMat);

  // Subtle workshop floor plane far underneath
  const studioFloor = new THREE.Mesh(
    trackGeo(new THREE.CircleGeometry(14, 40)),
    trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xd9e2dd,
        roughness: 0.92,
        metalness: 0.02,
      })
    )
  );
  studioFloor.rotation.x = -Math.PI / 2;
  studioFloor.position.y = -0.78;
  workshopGroup.add(studioFloor);

  // Steel workbench legs
  const legMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.78 })
  );
  const legGeo = trackGeo(new THREE.BoxGeometry(0.05, 0.72, 0.05));
  for (const lx of [-0.66, 0.66]) {
    for (const lz of [-0.44, 0.44]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, -0.42, lz);
      workshopGroup.add(leg);
    }
  }

  // Brushed aluminum parts tray + hex driver prop off to back-left corner (unobtrusive)
  const trayMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.3, metalness: 0.85 })
  );
  const trayBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.01, 0.1)), trayMat);
  trayBase.position.set(-0.52, 0.005, -0.32);
  trayBase.castShadow = true;
  trayBase.receiveShadow = true;
  workshopGroup.add(trayBase);

  const driverHandle = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.011, 0.01, 0.08, 10)),
    trackMat(new THREE.MeshStandardMaterial({ color: 0x059669, roughness: 0.45, metalness: 0.05 }))
  );
  driverHandle.rotation.z = Math.PI / 2;
  driverHandle.rotation.y = 0.3;
  driverHandle.position.set(0.48, 0.011, -0.34);
  workshopGroup.add(driverHandle);

  const driverShaft = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.0025, 0.0025, 0.09, 8)),
    trayMat
  );
  driverShaft.rotation.z = Math.PI / 2;
  driverShaft.rotation.y = 0.3;
  driverShaft.position.set(0.56, 0.011, -0.365);
  workshopGroup.add(driverShaft);

  // =========================================================================
  // 2. OUTDOOR AGRICULTURAL TOMATO FIELD (Natural Terrain, No Floating Walls)
  // =========================================================================
  const fieldGroup = new THREE.Group();
  fieldGroup.name = 'AgriculturalField';
  fieldGroup.visible = false;

  // Extended rolling countryside meadow ground extending smoothly into horizon fog
  const outerTerrainGeo = trackGeo(new THREE.PlaneGeometry(58, 58, 36, 36));
  outerTerrainGeo.rotateX(-Math.PI / 2);
  const posAttr = outerTerrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    const distFromPlot = Math.max(0, Math.hypot(vx * 0.7, vz) - 3.6);
    const hill =
      distFromPlot > 0
        ? (Math.sin(vx * 0.22) * Math.cos(vz * 0.19) * 0.55 + Math.sin(vx * 0.09 + vz * 0.11) * 0.65) *
            Math.min(1, distFromPlot / 6.0) +
          distFromPlot * 0.045
        : 0;
    posAttr.setY(i, hill - 0.018);
  }
  outerTerrainGeo.computeVertexNormals();

  const meadowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6c8a47,
      roughness: 0.94,
      metalness: 0.0,
    })
  );
  const outerTerrain = new THREE.Mesh(outerTerrainGeo, meadowMat);
  outerTerrain.receiveShadow = true;
  fieldGroup.add(outerTerrain);

  // Cultivated agricultural soil plot (4.4m x 3.2m including headland turning aprons)
  const soilMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.soilAlbedo,
      bumpMap: textures.soilBump,
      bumpScale: 0.015,
      roughness: 0.92,
      metalness: 0.02,
    })
  );
  const plotMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(4.5, 3.3)), soilMat);
  plotMesh.rotation.x = -Math.PI / 2;
  plotMesh.position.y = 0.0;
  plotMesh.receiveShadow = true;
  fieldGroup.add(plotMesh);

  // Raised tilled crop beds along the 4 crop rows (straddled by the rover's 110mm arch)
  const ridgeGeo = trackGeo(new THREE.BoxGeometry(FIELD_LENGTH_M - 0.12, 0.024, 0.13));
  const ridgeMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.soilAlbedo,
      color: 0xb69579,
      roughness: 0.95,
      metalness: 0.01,
    })
  );
  for (const rz of FIELD_ROW_Z) {
    const ridge = new THREE.Mesh(ridgeGeo, ridgeMat);
    ridge.position.set(0, 0.011, rz);
    ridge.receiveShadow = true;
    fieldGroup.add(ridge);
  }

  // Serpentine Boustrophedon mission path guide line on the soil
  const pathPoints: THREE.Vector3[] = [];
  FIELD_ROW_Z.forEach((rz, idx) => {
    const startX = idx % 2 === 0 ? -1.68 : 1.68;
    const endX = idx % 2 === 0 ? 1.68 : -1.68;
    pathPoints.push(new THREE.Vector3(startX, 0.026, rz));
    pathPoints.push(new THREE.Vector3(endX, 0.026, rz));
  });
  const pathLineGeo = trackGeo(new THREE.BufferGeometry().setFromPoints(pathPoints));
  const pathLine = new THREE.Line(
    pathLineGeo,
    trackMat(
      new THREE.LineBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0.55,
      })
    )
  );
  fieldGroup.add(pathLine);

  // Natural wooden post-and-rail perimeter farm fence outside headland zone
  const fenceWoodMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.plywoodDark,
      color: 0x8b6745,
      roughness: 0.88,
      metalness: 0.02,
    })
  );
  const postGeo = trackGeo(new THREE.CylinderGeometry(0.036, 0.042, 0.62, 8));
  const railLongGeo = trackGeo(new THREE.BoxGeometry(5.6, 0.045, 0.03));
  const railShortGeo = trackGeo(new THREE.BoxGeometry(0.03, 0.045, 4.4));

  for (const fz of [-2.2, 2.2]) {
    for (let fx = -2.8; fx <= 2.81; fx += 1.4) {
      const post = new THREE.Mesh(postGeo, fenceWoodMat);
      post.position.set(fx, 0.29, fz);
      post.castShadow = true;
      fieldGroup.add(post);
    }
    for (const ry of [0.22, 0.44]) {
      const rail = new THREE.Mesh(railLongGeo, fenceWoodMat);
      rail.position.set(0, ry, fz);
      rail.castShadow = true;
      fieldGroup.add(rail);
    }
  }
  for (const fx of [-2.8, 2.8]) {
    for (const fz of [-1.1, 0, 1.1]) {
      const post = new THREE.Mesh(postGeo, fenceWoodMat);
      post.position.set(fx, 0.29, fz);
      post.castShadow = true;
      fieldGroup.add(post);
    }
    for (const ry of [0.22, 0.44]) {
      const rail = new THREE.Mesh(railShortGeo, fenceWoodMat);
      rail.position.set(fx, ry, 0);
      rail.castShadow = true;
      fieldGroup.add(rail);
    }
  }

  // Distant natural tree grove around perimeter (InstancedMesh with subtle scale & color tint)
  const treeCount = 26;
  const trunkInst = new THREE.InstancedMesh(
    trackGeo(new THREE.CylinderGeometry(0.1, 0.16, 1.4, 7)),
    trackMat(new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.92 })),
    treeCount
  );
  const crownInst = new THREE.InstancedMesh(
    trackGeo(new THREE.DodecahedronGeometry(0.9, 1)),
    trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 })),
    treeCount
  );
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < treeCount; i++) {
    const ang = (i / treeCount) * Math.PI * 2 + (i % 3) * 0.08;
    const rad = 8.5 + (i % 5) * 2.1;
    const tx = Math.cos(ang) * rad;
    const tz = Math.sin(ang) * rad;
    const sc = 0.85 + ((i * 37) % 100) / 250;

    dummy.position.set(tx, 0.65 * sc, tz);
    dummy.scale.set(sc, sc, sc);
    dummy.rotation.y = ang;
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(tx, 1.65 * sc, tz);
    dummy.scale.set(sc * 1.15, sc * 1.05, sc * 1.15);
    dummy.updateMatrix();
    crownInst.setMatrixAt(i, dummy.matrix);

    tint.setHSL(0.28 + ((i * 19) % 10) * 0.008, 0.42, 0.28 + ((i * 13) % 10) * 0.012);
    crownInst.setColorAt(i, tint);
  }
  trunkInst.computeBoundingSphere();
  crownInst.computeBoundingSphere();
  fieldGroup.add(trunkInst, crownInst);

  // =========================================================================
  // DYNAMIC ENTITIES: CROPS, WEEDS, OBSTACLE CRATE & PARTICLE BURSTS
  // =========================================================================
  const dynamicCropsGroup = new THREE.Group();
  const dynamicWeedsGroup = new THREE.Group();
  fieldGroup.add(dynamicCropsGroup, dynamicWeedsGroup);

  const cropMeshes = new Map<number, THREE.Group>();
  const weedMeshes = new Map<number, { alive: THREE.Group; treated: THREE.Mesh }>();
  let currentFieldType: CropFieldId = 'tomato';

  // Shared crop & weed geometries/materials across all 8 crop species
  const stemGeo = trackGeo(new THREE.CylinderGeometry(0.006, 0.009, 0.075, 6));
  const tallStemGeo = trackGeo(new THREE.CylinderGeometry(0.0055, 0.0085, 0.125, 6));
  const leafClusterGeo = trackGeo(new THREE.DodecahedronGeometry(0.028, 0));
  const broadLeafGeo = trackGeo(new THREE.BoxGeometry(0.044, 0.004, 0.016));
  const tomatoGeo = trackGeo(new THREE.SphereGeometry(0.009, 8, 8));
  const chiliPodGeo = trackGeo(new THREE.ConeGeometry(0.0055, 0.026, 6));
  const flowerBloomGeo = trackGeo(new THREE.DodecahedronGeometry(0.014, 0));
  const eggplantGeo = trackGeo(new THREE.CapsuleGeometry(0.009, 0.018, 5, 8));
  const cabbageHeadGeo = trackGeo(new THREE.SphereGeometry(0.024, 10, 8));
  const berryGeo = trackGeo(new THREE.ConeGeometry(0.0075, 0.013, 6));
  const tasselGeo = trackGeo(new THREE.ConeGeometry(0.009, 0.028, 6));

  const matStem = trackMat(new THREE.MeshStandardMaterial({ color: 0x2f6b29, roughness: 0.82 }));
  const matCropLeaf = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e6b30, roughness: 0.76 }));
  const matCropLeafLight = trackMat(new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.74 }));
  const matCropLeafBlue = trackMat(new THREE.MeshStandardMaterial({ color: 0x3b8b5b, roughness: 0.78 }));
  const matCropDamaged = trackMat(new THREE.MeshStandardMaterial({ color: 0x7c5d32, roughness: 0.9 }));
  const matTomatoRed = trackMat(new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.32 }));
  const matChiliRed = trackMat(new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.28 }));
  const matChiliGreen = trackMat(new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.34 }));
  const matMarigoldOrange = trackMat(new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.58 }));
  const matMarigoldGold = trackMat(new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.55 }));
  const matEggplantPurple = trackMat(new THREE.MeshStandardMaterial({ color: 0x581c87, roughness: 0.22, metalness: 0.05 }));
  const matCabbageCore = trackMat(new THREE.MeshStandardMaterial({ color: 0x86efac, roughness: 0.68 }));
  const matCornTassel = trackMat(new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.72 }));
  const matBerryRed = trackMat(new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.32 }));
  const matBlossomWhite = trackMat(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 }));
  const matLettuceHeart = trackMat(new THREE.MeshStandardMaterial({ color: 0xbef264, roughness: 0.7 }));

  const weedLeafGeo = trackGeo(new THREE.ConeGeometry(0.017, 0.036, 5));
  const grassBladeGeo = trackGeo(new THREE.ConeGeometry(0.006, 0.048, 4));
  const dandelionHeadGeo = trackGeo(new THREE.SphereGeometry(0.0085, 7, 7));
  const matWeedGreen = trackMat(new THREE.MeshStandardMaterial({ color: 0x84cc16, roughness: 0.72 }));
  const matWeedDark = trackMat(new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.78 }));
  const matDandelionYellow = trackMat(new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 }));
  const matPurslaneStem = trackMat(new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.75 }));
  const treatedSpotGeo = trackGeo(new THREE.CircleGeometry(0.034, 12));
  treatedSpotGeo.rotateX(-Math.PI / 2);
  const matTreatedSpot = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x291c12,
      roughness: 0.96,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
  );

  // Interactive Wooden Harvest Crate Obstacle (tests VL53L0X ToF OBSTACLE_HOLD!)
  const obstacleGroup = new THREE.Group();
  const crateMat = trackMat(
    new THREE.MeshStandardMaterial({ map: textures.plywood, color: 0xc2935b, roughness: 0.8 })
  );
  const crateCore = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.18, 0.16, 0.18)), crateMat);
  crateCore.position.y = 0.08;
  crateCore.castShadow = true;
  crateCore.receiveShadow = true;
  obstacleGroup.add(crateCore);

  const hazardMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.45, metalness: 0.1 })
  );
  const band = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.186, 0.025, 0.186)), hazardMat);
  band.position.y = 0.12;
  obstacleGroup.add(band);
  obstacleGroup.visible = false;
  fieldGroup.add(obstacleGroup);

  // Pooled Instanced Particle System for grinder sparks / flame embers / laser vapor
  const MAX_PARTICLES = 96;
  const particleSlots: ParticleSlot[] = Array.from({ length: MAX_PARTICLES }, () => ({
    active: false,
    age: 0,
    life: 0.5,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    scale: 1,
  }));
  let particleCursor = 0;

  const particleInst = new THREE.InstancedMesh(
    trackGeo(new THREE.OctahedronGeometry(0.011, 0)),
    trackMat(new THREE.MeshBasicMaterial({ color: 0xffffff })),
    MAX_PARTICLES
  );
  particleInst.frustumCulled = false;
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particleInst.setMatrixAt(i, zeroMat);
  }
  particleInst.instanceMatrix.needsUpdate = true;
  fieldGroup.add(particleInst);

  const pDummy = new THREE.Object3D();
  const pColor = new THREE.Color();

  const spawnTreatmentParticles = (
    wx: number,
    wz: number,
    tool: TreatmentToolType,
    count = 10
  ) => {
    for (let i = 0; i < count; i++) {
      const slot = particleSlots[particleCursor];
      particleCursor = (particleCursor + 1) % MAX_PARTICLES;
      slot.active = true;
      slot.age = 0;
      slot.life = 0.28 + Math.random() * 0.34;
      slot.pos.set(wx + (Math.random() - 0.5) * 0.04, 0.03, wz + (Math.random() - 0.5) * 0.04);
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.25 + Math.random() * 0.55;
      slot.vel.set(Math.cos(ang) * spd, 0.45 + Math.random() * 0.65, Math.sin(ang) * spd);
      slot.scale = 0.7 + Math.random() * 0.9;

      if (tool === 'flame') {
        pColor.setHex(Math.random() > 0.35 ? 0xf97316 : 0xfef08a);
      } else if (tool === 'laser') {
        pColor.setHex(Math.random() > 0.4 ? 0x38bdf8 : 0xe0f2fe);
      } else {
        pColor.setHex(Math.random() > 0.45 ? 0x78502d : 0x84cc16);
      }
      particleInst.setColorAt(particleCursor === 0 ? MAX_PARTICLES - 1 : particleCursor - 1, pColor);
    }
    if (particleInst.instanceColor) particleInst.instanceColor.needsUpdate = true;
  };

  const updateParticles = (dt: number) => {
    let anyChanged = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const slot = particleSlots[i];
      if (!slot.active) continue;
      anyChanged = true;
      slot.age += dt;
      if (slot.age >= slot.life) {
        slot.active = false;
        particleInst.setMatrixAt(i, zeroMat);
        continue;
      }
      slot.vel.y -= 2.4 * dt;
      slot.pos.addScaledVector(slot.vel, dt);
      if (slot.pos.y < 0.01) slot.pos.y = 0.01;
      const remain = 1 - slot.age / slot.life;
      pDummy.position.copy(slot.pos);
      pDummy.scale.setScalar(slot.scale * remain);
      pDummy.rotation.set(slot.age * 8, slot.age * 6, 0);
      pDummy.updateMatrix();
      particleInst.setMatrixAt(i, pDummy.matrix);
    }
    if (anyChanged) {
      particleInst.instanceMatrix.needsUpdate = true;
    }
  };

  const buildCropMesh = (plant: FieldPlant3D): THREE.Group => {
    const cg = new THREE.Group();
    cg.position.set(plant.x, 0.02, plant.z);

    if (currentFieldType === 'tomato') {
      const stem = new THREE.Mesh(stemGeo, matStem);
      stem.position.y = 0.036;
      stem.castShadow = true;
      cg.add(stem);

      const offsets: [number, number, number, number][] = [
        [-0.018, 0.068, 0.008, 1.0],
        [0.018, 0.072, -0.01, 0.92],
        [0.0, 0.082, 0.015, 0.84],
      ];
      offsets.forEach(([ox, oy, oz, sc]) => {
        const leaf = new THREE.Mesh(leafClusterGeo, matCropLeaf);
        leaf.position.set(ox, oy, oz);
        leaf.scale.set(sc * 1.15, sc * 0.65, sc);
        leaf.castShadow = true;
        leaf.userData.isLeaf = true;
        cg.add(leaf);
      });

      const tom1 = new THREE.Mesh(tomatoGeo, matTomatoRed);
      tom1.position.set(0.016, 0.056, 0.014);
      cg.add(tom1);
      const tom2 = new THREE.Mesh(tomatoGeo, matTomatoRed);
      tom2.position.set(-0.014, 0.052, -0.012);
      cg.add(tom2);
    } else if (currentFieldType === 'chili') {
      const stem = new THREE.Mesh(stemGeo, matStem);
      stem.position.y = 0.04;
      stem.castShadow = true;
      cg.add(stem);

      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + plant.id * 0.3;
        const leaf = new THREE.Mesh(leafClusterGeo, matCropLeaf);
        leaf.position.set(Math.cos(ang) * 0.019, 0.074 + (i % 2) * 0.01, Math.sin(ang) * 0.019);
        leaf.scale.set(0.88, 0.55, 0.88);
        leaf.userData.isLeaf = true;
        cg.add(leaf);
      }

      // Hanging slender red & green chili pods
      const pods: [number, number, number, boolean][] = [
        [0.017, 0.052, 0.012, true],
        [-0.015, 0.056, 0.01, false],
        [0.004, 0.048, -0.017, true],
      ];
      pods.forEach(([px, py, pz, isRed]) => {
        const pod = new THREE.Mesh(chiliPodGeo, isRed ? matChiliRed : matChiliGreen);
        pod.position.set(px, py, pz);
        pod.rotation.x = Math.PI + 0.2;
        pod.rotation.z = px > 0 ? 0.25 : -0.25;
        cg.add(pod);
      });
    } else if (currentFieldType === 'flower') {
      const stem = new THREE.Mesh(stemGeo, matStem);
      stem.position.y = 0.034;
      cg.add(stem);

      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + plant.id * 0.5;
        const leaf = new THREE.Mesh(leafClusterGeo, matCropLeaf);
        leaf.position.set(Math.cos(ang) * 0.02, 0.048, Math.sin(ang) * 0.02);
        leaf.scale.set(0.9, 0.55, 0.9);
        leaf.userData.isLeaf = true;
        cg.add(leaf);

        const bloom = new THREE.Mesh(
          flowerBloomGeo,
          i % 2 === 0 ? matMarigoldOrange : matMarigoldGold
        );
        bloom.position.set(Math.cos(ang) * 0.015, 0.078 + (i === 0 ? 0.012 : 0), Math.sin(ang) * 0.015);
        bloom.castShadow = true;
        cg.add(bloom);
      }
    } else if (currentFieldType === 'eggplant') {
      const stem = new THREE.Mesh(stemGeo, matStem);
      stem.position.y = 0.042;
      cg.add(stem);

      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + plant.id * 0.4;
        const leaf = new THREE.Mesh(leafClusterGeo, matCropLeaf);
        leaf.position.set(Math.cos(ang) * 0.022, 0.078, Math.sin(ang) * 0.022);
        leaf.scale.set(1.25, 0.58, 1.05);
        leaf.userData.isLeaf = true;
        cg.add(leaf);
      }

      const egg1 = new THREE.Mesh(eggplantGeo, matEggplantPurple);
      egg1.position.set(0.016, 0.048, 0.013);
      egg1.rotation.z = -0.22;
      cg.add(egg1);
      const egg2 = new THREE.Mesh(eggplantGeo, matEggplantPurple);
      egg2.position.set(-0.016, 0.044, -0.01);
      egg2.rotation.z = 0.2;
      cg.add(egg2);
    } else if (currentFieldType === 'cabbage') {
      // Compact spherical pale-green heart surrounded by cupped blue-green outer leaves
      const head = new THREE.Mesh(cabbageHeadGeo, matCabbageCore);
      head.position.y = 0.032;
      head.scale.set(1.12, 0.92, 1.12);
      head.castShadow = true;
      head.userData.isLeaf = true;
      cg.add(head);

      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + plant.id * 0.25;
        const outer = new THREE.Mesh(leafClusterGeo, matCropLeafBlue);
        outer.position.set(Math.cos(ang) * 0.026, 0.025, Math.sin(ang) * 0.026);
        outer.scale.set(0.95, 0.48, 0.95);
        outer.userData.isLeaf = true;
        cg.add(outer);
      }
    } else if (currentFieldType === 'corn') {
      const stalk = new THREE.Mesh(tallStemGeo, matStem);
      stalk.position.y = 0.062;
      stalk.castShadow = true;
      cg.add(stalk);

      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + plant.id * 0.35;
        const blade = new THREE.Mesh(broadLeafGeo, matCropLeafLight);
        blade.position.set(Math.cos(ang) * 0.02, 0.045 + i * 0.016, Math.sin(ang) * 0.02);
        blade.rotation.y = -ang;
        blade.rotation.z = -0.45;
        blade.userData.isLeaf = true;
        cg.add(blade);
      }

      const tassel = new THREE.Mesh(tasselGeo, matCornTassel);
      tassel.position.y = 0.132;
      cg.add(tassel);
    } else if (currentFieldType === 'strawberry') {
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + plant.id * 0.5;
        const mound = new THREE.Mesh(leafClusterGeo, matCropLeaf);
        mound.position.set(Math.cos(ang) * 0.02, 0.028, Math.sin(ang) * 0.02);
        mound.scale.set(0.92, 0.52, 0.92);
        mound.userData.isLeaf = true;
        cg.add(mound);
      }
      const berries: [number, number, number][] = [
        [0.022, 0.018, 0.014],
        [-0.02, 0.018, 0.012],
        [0.005, 0.017, -0.022],
      ];
      berries.forEach(([bx, by, bz]) => {
        const berry = new THREE.Mesh(berryGeo, matBerryRed);
        berry.position.set(bx, by, bz);
        berry.rotation.x = Math.PI;
        cg.add(berry);
      });
      const blossom = new THREE.Mesh(tomatoGeo, matBlossomWhite);
      blossom.scale.setScalar(0.65);
      blossom.position.set(0, 0.046, 0.006);
      cg.add(blossom);
    } else {
      // Crisphead Lettuce
      const center = new THREE.Mesh(cabbageHeadGeo, matLettuceHeart);
      center.position.y = 0.028;
      center.scale.set(1.05, 0.72, 1.05);
      center.userData.isLeaf = true;
      cg.add(center);

      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + plant.id * 0.2;
        const ruffle = new THREE.Mesh(leafClusterGeo, matCropLeafLight);
        ruffle.position.set(Math.cos(ang) * 0.024, 0.024 + (i % 2) * 0.008, Math.sin(ang) * 0.024);
        ruffle.scale.set(0.88, 0.52, 0.88);
        ruffle.userData.isLeaf = true;
        cg.add(ruffle);
      }
    }

    return cg;
  };

  const buildWeedMesh = (weed: FieldWeed3D) => {
    const alive = new THREE.Group();
    alive.position.set(weed.x, 0.004, weed.z);

    if (weed.weedClass === 'weed_grass') {
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + weed.id * 0.3;
        const blade = new THREE.Mesh(grassBladeGeo, i % 2 === 0 ? matWeedGreen : matWeedDark);
        blade.position.set(Math.cos(ang) * 0.009, 0.022, Math.sin(ang) * 0.009);
        blade.rotation.z = -Math.cos(ang) * 0.35;
        blade.rotation.x = Math.sin(ang) * 0.35;
        blade.castShadow = true;
        alive.add(blade);
      }
    } else if (weed.weedClass === 'weed_dandelion') {
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + weed.id * 0.4;
        const blade = new THREE.Mesh(weedLeafGeo, matWeedDark);
        blade.position.set(Math.cos(ang) * 0.015, 0.012, Math.sin(ang) * 0.015);
        blade.rotation.z = -Math.cos(ang) * 0.72;
        blade.rotation.x = Math.sin(ang) * 0.72;
        alive.add(blade);
      }
      const head = new THREE.Mesh(dandelionHeadGeo, matDandelionYellow);
      head.position.set(0, 0.036, 0);
      alive.add(head);
    } else if (weed.weedClass === 'weed_purslane') {
      const centerStem = new THREE.Mesh(tomatoGeo, matPurslaneStem);
      centerStem.scale.set(0.8, 0.4, 0.8);
      centerStem.position.y = 0.008;
      alive.add(centerStem);
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + weed.id * 0.5;
        const lobe = new THREE.Mesh(weedLeafGeo, matWeedGreen);
        lobe.position.set(Math.cos(ang) * 0.016, 0.01, Math.sin(ang) * 0.016);
        lobe.scale.set(1.1, 0.6, 1.1);
        lobe.rotation.z = -Math.cos(ang) * 0.85;
        lobe.rotation.x = Math.sin(ang) * 0.85;
        alive.add(lobe);
      }
    } else {
      // weed_amaranth / broadleaf rosette
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + weed.id * 0.4;
        const blade = new THREE.Mesh(weedLeafGeo, i % 2 === 0 ? matWeedGreen : matWeedDark);
        blade.position.set(Math.cos(ang) * 0.014, 0.018, Math.sin(ang) * 0.014);
        blade.rotation.z = -Math.cos(ang) * 0.52;
        blade.rotation.x = Math.sin(ang) * 0.52;
        blade.castShadow = true;
        alive.add(blade);
      }
    }

    const treated = new THREE.Mesh(treatedSpotGeo, matTreatedSpot);
    treated.position.set(weed.x, 0.006, weed.z);
    treated.visible = false;

    dynamicWeedsGroup.add(alive, treated);
    return { alive, treated };
  };

  const setFieldType = (fieldType: CropFieldId) => {
    currentFieldType = fieldType;
    const spec = CROP_FIELD_BY_ID[fieldType];
    soilMat.color.setHex(spec.soilTintHex);
    ridgeMat.color.setHex(spec.ridgeTintHex);
    meadowMat.color.setHex(spec.meadowTintHex);

    // Clear existing cached crop & weed meshes so the next sync builds the new crop species cleanly
    for (const group of cropMeshes.values()) {
      dynamicCropsGroup.remove(group);
    }
    cropMeshes.clear();
    for (const entry of weedMeshes.values()) {
      dynamicWeedsGroup.remove(entry.alive, entry.treated);
    }
    weedMeshes.clear();
  };

  const syncFieldEntities = (
    crops: FieldPlant3D[],
    weeds: FieldWeed3D[],
    obstacle: FieldObstacle3D
  ) => {
    // Sync crops
    const activeCropIds = new Set<number>();
    for (const c of crops) {
      activeCropIds.add(c.id);
      let meshGroup = cropMeshes.get(c.id);
      if (!meshGroup) {
        meshGroup = buildCropMesh(c);
        cropMeshes.set(c.id, meshGroup);
        dynamicCropsGroup.add(meshGroup);
      }
      if (c.damaged) {
        meshGroup.rotation.z = 0.85;
        meshGroup.scale.set(0.85, 0.48, 0.85);
        meshGroup.children.forEach((ch) => {
          if (ch instanceof THREE.Mesh && ch.userData.isLeaf) {
            ch.material = matCropDamaged;
          }
        });
      } else {
        meshGroup.rotation.z = 0;
        meshGroup.scale.set(1, 1, 1);
      }
    }
    for (const [id, group] of cropMeshes.entries()) {
      if (!activeCropIds.has(id)) {
        dynamicCropsGroup.remove(group);
        cropMeshes.delete(id);
      }
    }

    // Sync weeds
    const activeWeedIds = new Set<number>();
    for (const w of weeds) {
      activeWeedIds.add(w.id);
      let entry = weedMeshes.get(w.id);
      if (!entry) {
        entry = buildWeedMesh(w);
        weedMeshes.set(w.id, entry);
      }
      if (w.eliminated) {
        entry.alive.visible = false;
        entry.treated.visible = true;
      } else {
        entry.alive.visible = true;
        entry.treated.visible = false;
        const shrink = Math.max(0.25, 1 - w.treatProgress * 0.72);
        entry.alive.scale.set(shrink, shrink, shrink);
      }
    }
    for (const [id, entry] of weedMeshes.entries()) {
      if (!activeWeedIds.has(id)) {
        dynamicWeedsGroup.remove(entry.alive, entry.treated);
        weedMeshes.delete(id);
      }
    }

    // Sync obstacle crate
    obstacleGroup.visible = obstacle.active;
    if (obstacle.active) {
      obstacleGroup.position.set(obstacle.x, 0, obstacle.z);
    }
  };

  return {
    workshopGroup,
    fieldGroup,
    setFieldType,
    syncFieldEntities,
    spawnTreatmentParticles,
    updateParticles,
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
