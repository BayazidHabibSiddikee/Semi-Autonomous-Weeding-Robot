import * as THREE from 'three';
import { ProceduralTexturePack } from './textures';
import { FieldObstacle3D, FieldPlant3D, FieldWeed3D, TreatmentToolType } from './types';

export interface FieldEnvironmentHandle {
  workshopGroup: THREE.Group;
  fieldGroup: THREE.Group;
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

  // Shared crop & weed geometries/materials
  const stemGeo = trackGeo(new THREE.CylinderGeometry(0.006, 0.009, 0.075, 6));
  const leafClusterGeo = trackGeo(new THREE.DodecahedronGeometry(0.028, 0));
  const tomatoGeo = trackGeo(new THREE.SphereGeometry(0.009, 8, 8));
  const matStem = trackMat(new THREE.MeshStandardMaterial({ color: 0x2f6b29, roughness: 0.82 }));
  const matCropLeaf = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e6b30, roughness: 0.76 }));
  const matCropDamaged = trackMat(new THREE.MeshStandardMaterial({ color: 0x7c5d32, roughness: 0.9 }));
  const matTomatoRed = trackMat(new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.32 }));

  const weedLeafGeo = trackGeo(new THREE.ConeGeometry(0.017, 0.036, 5));
  const matWeedGreen = trackMat(new THREE.MeshStandardMaterial({ color: 0x84cc16, roughness: 0.72 }));
  const matWeedDark = trackMat(new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.78 }));
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

    // Two small ripe cherry tomatoes visible inside the young tomato plant
    const tom1 = new THREE.Mesh(tomatoGeo, matTomatoRed);
    tom1.position.set(0.016, 0.056, 0.014);
    cg.add(tom1);
    const tom2 = new THREE.Mesh(tomatoGeo, matTomatoRed);
    tom2.position.set(-0.014, 0.052, -0.012);
    cg.add(tom2);

    return cg;
  };

  const buildWeedMesh = (weed: FieldWeed3D) => {
    const alive = new THREE.Group();
    alive.position.set(weed.x, 0.004, weed.z);

    // Multi-blade broadleaf weed rosette (distinct bright lime hue so player spots it instantly)
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + weed.id * 0.4;
      const blade = new THREE.Mesh(weedLeafGeo, i % 2 === 0 ? matWeedGreen : matWeedDark);
      blade.position.set(Math.cos(ang) * 0.014, 0.016, Math.sin(ang) * 0.014);
      blade.rotation.z = -Math.cos(ang) * 0.55;
      blade.rotation.x = Math.sin(ang) * 0.55;
      blade.castShadow = true;
      alive.add(blade);
    }

    const treated = new THREE.Mesh(treatedSpotGeo, matTreatedSpot);
    treated.position.set(weed.x, 0.006, weed.z);
    treated.visible = false;

    dynamicWeedsGroup.add(alive, treated);
    return { alive, treated };
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
    syncFieldEntities,
    spawnTreatmentParticles,
    updateParticles,
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
