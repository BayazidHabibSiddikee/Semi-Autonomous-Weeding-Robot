import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Box,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Flame,
  Gamepad2,
  Layers,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Sprout,
  Volume2,
  VolumeX,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  buildGameEnvironments,
  FieldEnvironmentHandle,
} from '../game/environmentBuilder';
import { CROP_FIELDS, CROP_FIELD_BY_ID } from '../game/fieldTypesCatalog';
import { FieldMissionEngine, ManualInputState } from '../game/fieldMissionEngine';
import { buildRoverRig, RoverRig } from '../game/roverModelBuilder';
import {
  canInstallPart,
  CORE_DRIVE_PARTS,
  getNextInstallablePart,
  PART_BY_ID,
  ROVER_PARTS,
} from '../game/roverPartsCatalog';
import { soundEngine } from '../game/soundEngine';
import { createProceduralTexturePack } from '../game/textures';
import {
  CameraPreset,
  ControlMode,
  CropFieldId,
  GameHudSnapshot,
  GamePhase,
  PartId,
  TreatmentToolType,
} from '../game/types';
import { RightPanelTab, RoverRightPanel } from './RoverRightPanel';

interface Props {
  estopActive: boolean;
  onLogEvent?: (msg: string) => void;
}

const DEFAULT_INSTALLED: PartId[] = ['chassis_deck'];

function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

// Reusable math scratch objects outside render loop (zero GC)
const _camTargetPos = new THREE.Vector3();
const _camLookAt = new THREE.Vector3();
const _rayMouse = new THREE.Vector2();

export const Rover3DGame: React.FC<Props> = ({ estopActive, onLogEvent }) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);

  // React UI state
  const [phase, setPhase] = useState<GamePhase>('workshop');
  const [fieldType, setFieldType] = useState<CropFieldId>('tomato');
  const [installedSet, setInstalledSet] = useState<Set<PartId>>(
    () => new Set<PartId>(DEFAULT_INSTALLED)
  );
  const [selectedPartId, setSelectedPartId] = useState<PartId>('arch_legs');
  const [hoveredPartId, setHoveredPartId] = useState<PartId | null>(null);
  const [selectedTool, setSelectedTool] = useState<TreatmentToolType>('flame');
  const [explodeFactor, setExplodeFactor] = useState<number>(0);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('orbit');
  const [controlMode, setControlMode] = useState<ControlMode>('auto');
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(true);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('specs');
  const [muted, setMuted] = useState<boolean>(false);
  const [servoTestActive, setServoTestActive] = useState<boolean>(false);
  const [webglError, setWebglError] = useState<string | null>(null);

  const engineRef = useRef<FieldMissionEngine>(new FieldMissionEngine(42));
  const [hud, setHud] = useState<GameHudSnapshot>(() =>
    engineRef.current.getHudSnapshot(
      'workshop',
      new Set<PartId>(DEFAULT_INSTALLED),
      'flame',
      false,
      0
    )
  );

  // Mutable refs read inside the stable WebGL loop so React updates never recreate the canvas
  const phaseRef = useRef<GamePhase>(phase);
  const fieldTypeRef = useRef<CropFieldId>(fieldType);
  const installedRef = useRef<Set<PartId>>(installedSet);
  const selectedPartIdRef = useRef<PartId>(selectedPartId);
  const hoveredPartIdRef = useRef<PartId | null>(hoveredPartId);
  const rightPanelOpenRef = useRef<boolean>(rightPanelOpen);
  const rightPanelTabRef = useRef<RightPanelTab>(rightPanelTab);
  const selectedToolRef = useRef<TreatmentToolType>(selectedTool);
  const explodeRef = useRef<number>(explodeFactor);
  const cameraPresetRef = useRef<CameraPreset>(cameraPreset);
  const servoTestRef = useRef<boolean>(servoTestActive);
  const estopRef = useRef<boolean>(estopActive);
  const partFocusRef = useRef<{
    active: boolean;
    camPos: THREE.Vector3;
    lookAt: THREE.Vector3;
  }>({
    active: false,
    camPos: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
  });
  const manualInputRef = useRef<ManualInputState>({
    forward: false,
    backward: false,
    left: false,
    right: false,
    fire: false,
  });
  const partAnimProgressRef = useRef<Record<PartId, number>>(
    Object.fromEntries(
      ROVER_PARTS.map((p) => [p.id, DEFAULT_INSTALLED.includes(p.id) ? 1 : 0])
    ) as Record<PartId, number>
  );
  const camTransitionActiveRef = useRef<boolean>(true);
  const cameraObjRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsObjRef = useRef<OrbitControls | null>(null);
  const roverRigRef = useRef<RoverRig | null>(null);
  const envHandleRef = useRef<FieldEnvironmentHandle | null>(null);
  const sceneObjRef = useRef<THREE.Scene | null>(null);
  const onLogRef = useRef(onLogEvent);
  onLogRef.current = onLogEvent;

  const canDeploy = CORE_DRIVE_PARTS.every((id) => installedSet.has(id));
  const canDeployRef = useRef<boolean>(canDeploy);
  canDeployRef.current = canDeploy;

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    fieldTypeRef.current = fieldType;
  }, [fieldType]);

  useEffect(() => {
    installedRef.current = installedSet;
  }, [installedSet]);

  useEffect(() => {
    selectedPartIdRef.current = selectedPartId;
  }, [selectedPartId]);

  useEffect(() => {
    hoveredPartIdRef.current = hoveredPartId;
  }, [hoveredPartId]);

  useEffect(() => {
    rightPanelOpenRef.current = rightPanelOpen;
  }, [rightPanelOpen]);

  useEffect(() => {
    rightPanelTabRef.current = rightPanelTab;
  }, [rightPanelTab]);

  useEffect(() => {
    selectedToolRef.current = selectedTool;
    roverRigRef.current?.setToolType(selectedTool);
  }, [selectedTool]);

  useEffect(() => {
    explodeRef.current = explodeFactor;
  }, [explodeFactor]);

  useEffect(() => {
    cameraPresetRef.current = cameraPreset;
    camTransitionActiveRef.current = true;
    partFocusRef.current.active = false;
  }, [cameraPreset]);

  useEffect(() => {
    servoTestRef.current = servoTestActive;
  }, [servoTestActive]);

  useEffect(() => {
    estopRef.current = estopActive;
    roverRigRef.current?.setEstopPressed(estopActive);
    if (estopActive) {
      engineRef.current.triggerEstop();
    } else if (engineRef.current.state === 'ESTOP') {
      engineRef.current.recoverFromEstop();
    }
  }, [estopActive]);

  // Install a specific rover part with spring drop-in animation and sound
  const installPart = useCallback((partId: PartId) => {
    setInstalledSet((prev) => {
      if (prev.has(partId)) {
        setSelectedPartId(partId);
        return prev;
      }
      if (!canInstallPart(partId, prev)) {
        setSelectedPartId(partId);
        soundEngine.playAlert();
        return prev;
      }
      const next = new Set(prev);
      next.add(partId);
      partAnimProgressRef.current[partId] = 0.01;
      const spec = PART_BY_ID[partId];
      soundEngine.playPartSnap(spec.step);
      onLogRef.current?.(`[Workshop] Mounted Step ${spec.step}: ${spec.name}`);

      const upcoming = getNextInstallablePart(next);
      setSelectedPartId(upcoming ? upcoming.id : partId);
      if (next.size === ROVER_PARTS.length) {
        soundEngine.playBuildComplete();
        onLogRef.current?.(
          `[Workshop] All ${ROVER_PARTS.length} subsystems assembled! Rover certified for field deployment.`
        );
      }
      return next;
    });
  }, []);

  const installPartRef = useRef(installPart);
  installPartRef.current = installPart;

  const handleAssembleNext = useCallback(() => {
    const next = getNextInstallablePart(installedRef.current);
    if (next) {
      installPart(next.id);
    }
  }, [installPart]);

  const handleQuickAssemble = useCallback(() => {
    const all = new Set<PartId>(ROVER_PARTS.map((p) => p.id));
    ROVER_PARTS.forEach((p, idx) => {
      if (!installedRef.current.has(p.id)) {
        partAnimProgressRef.current[p.id] = Math.max(0.01, 0.15 - idx * 0.015);
      }
    });
    setInstalledSet(all);
    setSelectedPartId('maixsense_cam');
    setExplodeFactor(0);
    soundEngine.playBuildComplete();
    onLogRef.current?.(
      `[Workshop] Quick-assembled full ${ROVER_PARTS.length}-part agricultural flame weeding rover.`
    );
  }, []);

  const handleResetBuild = useCallback(() => {
    const base = new Set<PartId>(DEFAULT_INSTALLED);
    ROVER_PARTS.forEach((p) => {
      partAnimProgressRef.current[p.id] = DEFAULT_INSTALLED.includes(p.id) ? 1 : 0;
    });
    setInstalledSet(base);
    setSelectedPartId('arch_legs');
    setExplodeFactor(0);
  }, []);

  const handleSelectFieldType = useCallback((nextFieldType: CropFieldId) => {
    setFieldType(nextFieldType);
    engineRef.current.setFieldType(nextFieldType);
    envHandleRef.current?.setFieldType(nextFieldType);
    const spec = CROP_FIELD_BY_ID[nextFieldType];
    if (phaseRef.current === 'field' && sceneObjRef.current) {
      (sceneObjRef.current.background as THREE.Color).setHex(spec.skyTintHex);
      if (sceneObjRef.current.fog instanceof THREE.FogExp2) {
        sceneObjRef.current.fog.color.setHex(spec.skyTintHex);
      }
    }
    onLogRef.current?.(`[Field] Switched crop environment to ${spec.name} (${spec.modelClass}).`);
  }, []);

  const handleFocusPartIn3D = useCallback((partId: PartId) => {
    const rig = roverRigRef.current;
    const cam = cameraObjRef.current;
    if (!rig || !cam) return;
    const center = new THREE.Vector3();
    rig.getPartWorldCenter(partId, center);
    const offsetDir = cam.position.clone().sub(center);
    if (offsetDir.lengthSq() < 0.001) {
      offsetDir.set(0.28, 0.2, 0.28);
    }
    offsetDir.normalize();
    offsetDir.y = Math.max(0.28, offsetDir.y);
    offsetDir.normalize();
    const focusDist = phaseRef.current === 'workshop' ? 0.34 : 0.48;
    partFocusRef.current.lookAt.copy(center);
    partFocusRef.current.camPos.copy(center).addScaledVector(offsetDir, focusDist);
    partFocusRef.current.active = true;
    camTransitionActiveRef.current = false;
    if (phaseRef.current === 'field' && cameraPresetRef.current === 'mast') {
      setCameraPreset('orbit');
    }
  }, []);

  const handleClick3DPart = useCallback(
    (partId: PartId) => {
      setSelectedPartId(partId);
      setRightPanelOpen(true);
      setRightPanelTab('specs');
      if (
        phaseRef.current === 'workshop' &&
        !installedRef.current.has(partId) &&
        canInstallPart(partId, installedRef.current)
      ) {
        installPart(partId);
        // Keep the newly mounted part active in the specs inspector so the user reads its guide!
        setSelectedPartId(partId);
      }
    },
    [installPart]
  );

  const handleClick3DPartRef = useRef(handleClick3DPart);
  handleClick3DPartRef.current = handleClick3DPart;

  const enterFieldMode = useCallback(() => {
    if (!canDeployRef.current) {
      soundEngine.playAlert();
      return;
    }
    setExplodeFactor(0);
    partFocusRef.current.active = false;
    engineRef.current.setFieldType(fieldTypeRef.current);
    envHandleRef.current?.setFieldType(fieldTypeRef.current);
    engineRef.current.controlMode = controlMode;
    setPhase('field');
    setCameraPreset('chase');
    setRightPanelOpen(true);
    setRightPanelTab('camera');
    camTransitionActiveRef.current = true;
    const spec = CROP_FIELD_BY_ID[fieldTypeRef.current];
    onLogRef.current?.(`[Field] Deployed custom-built rover into ${spec.name} (${spec.modelClass}).`);
  }, [controlMode]);

  const enterWorkshopMode = useCallback(() => {
    engineRef.current.running = false;
    partFocusRef.current.active = false;
    setPhase('workshop');
    setCameraPreset('orbit');
    setRightPanelTab('specs');
    camTransitionActiveRef.current = true;
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      soundEngine.setMuted(next);
      return next;
    });
  }, []);

  const handleModeSwitch = useCallback((mode: ControlMode) => {
    setControlMode(mode);
    engineRef.current.controlMode = mode;
    if (mode === 'manual') {
      engineRef.current.running = false;
      engineRef.current.statusNote = 'Manual drive active — use WASD/Arrows to steer & F to fire tool.';
    } else {
      engineRef.current.statusNote = 'Autonomous Boustrophedon mode ready — click Start Mission.';
    }
  }, []);

  // Keyboard shortcuts (H to collapse HUD, WASD/Arrows/F for Manual Drive, Space for E-Stop)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'KeyH') {
        setDockCollapsed((prev) => !prev);
        return;
      }
      if (e.code === 'KeyI') {
        setRightPanelOpen((prev) => !prev);
        return;
      }
      if (e.code === 'Escape') {
        setRightPanelOpen(false);
        return;
      }

      if (phaseRef.current !== 'field') return;

      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          manualInputRef.current.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          manualInputRef.current.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          manualInputRef.current.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          manualInputRef.current.right = true;
          break;
        case 'KeyF':
          manualInputRef.current.fire = true;
          break;
        case 'Space':
          e.preventDefault();
          if (engineRef.current.state === 'ESTOP') {
            engineRef.current.recoverFromEstop();
          } else {
            engineRef.current.triggerEstop();
            soundEngine.playAlert();
          }
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          manualInputRef.current.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          manualInputRef.current.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          manualInputRef.current.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          manualInputRef.current.right = false;
          break;
        case 'KeyF':
          manualInputRef.current.fire = false;
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // =========================================================================
  // STABLE ONE-TIME THREE.JS WEBGL INITIALIZATION & GAME LOOP
  // =========================================================================
  useEffect(() => {
    const mount = canvasMountRef.current;
    if (!mount) return;

    const isSoftwareGl = detectSoftwareWebGL();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError('WebGL2 is unavailable in this browser context.');
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(mount.clientWidth || 1280, mount.clientHeight || 720);
    renderer.domElement.style.touchAction = 'none';

    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe3ebe8);
    scene.fog = new THREE.FogExp2(0xe3ebe8, 0.045);
    sceneObjRef.current = scene;

    // Mandatory studio environment map for crisp metallic & lens PBR reflections
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmremGenerator.dispose();

    // Balanced 3-point warm/cool lighting rig
    const hemiLight = new THREE.HemisphereLight(0xdff0fa, 0x6b563e, 0.85);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sunLight.position.set(3.2, 5.2, 2.6);
    sunLight.castShadow = !isSoftwareGl;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 16;
    const d = 3.2;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0xbbe0f8, 0.72);
    rimLight.position.set(-3.4, 2.6, -2.8);
    scene.add(rimLight);

    const camera = new THREE.PerspectiveCamera(
      42,
      (mount.clientWidth || 1280) / (mount.clientHeight || 720),
      0.02,
      90
    );
    camera.position.set(0.46, 0.34, 0.44);
    cameraObjRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 1.05;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.24;
    controls.maxDistance = 8.5;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0.03, 0.14, 0);
    controls.update();
    controlsObjRef.current = controls;

    // Cancel any scripted camera transition immediately when the user drags/rotates the viewport
    const onControlStart = () => {
      camTransitionActiveRef.current = false;
      partFocusRef.current.active = false;
      if (phaseRef.current === 'field' && cameraPresetRef.current === 'mast') {
        cameraPresetRef.current = 'orbit';
        setCameraPreset('orbit');
      }
    };
    controls.addEventListener('start', onControlStart);

    // Build procedural textures, rover rig, and environments
    const textures = createProceduralTexturePack(renderer);
    const roverRig = buildRoverRig(textures);
    roverRig.setToolType(selectedToolRef.current);
    roverRigRef.current = roverRig;
    scene.add(roverRig.root);

    const envHandle = buildGameEnvironments(textures);
    envHandleRef.current = envHandle;
    scene.add(envHandle.workshopGroup);
    scene.add(envHandle.fieldGroup);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Layer-1 Raycasting for interactive 3D part inspection & assembly in BOTH Workshop and Field modes
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    let lastHoverCheck = 0;
    let pointerDownXY: { x: number; y: number } | null = null;

    const pickPartAtEvent = (ev: PointerEvent): PartId | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);
      const hits = raycaster.intersectObjects(roverRig.hitboxes, false);
      const curInstalled = installedRef.current;
      for (const hit of hits) {
        const pid = hit.object.userData.partId as PartId | undefined;
        if (!pid) continue;
        if (phaseRef.current === 'workshop') {
          if (curInstalled.has(pid) || canInstallPart(pid, curInstalled)) {
            return pid;
          }
        } else if (curInstalled.has(pid)) {
          return pid;
        }
      }
      return null;
    };

    const onPointerMove = (ev: PointerEvent) => {
      const now = performance.now();
      if (now - lastHoverCheck < 50) return;
      lastHoverCheck = now;
      const pid = pickPartAtEvent(ev);
      setHoveredPartId(pid);
      renderer.domElement.style.cursor = pid ? 'pointer' : 'grab';
    };

    const onPointerDown = (ev: PointerEvent) => {
      pointerDownXY = { x: ev.clientX, y: ev.clientY };
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (!pointerDownXY) return;
      const dist = Math.hypot(ev.clientX - pointerDownXY.x, ev.clientY - pointerDownXY.y);
      pointerDownXY = null;
      if (dist > 6) return; // Dragged camera, not a click
      const pid = pickPartAtEvent(ev);
      if (pid) {
        handleClick3DPartRef.current(pid);
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // WebGL context loss safety
    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglError('WebGL context lost — waiting to restore...');
    };
    const onContextRestored = () => {
      setWebglError(null);
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    // Responsive ResizeObserver
    const handleResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObs = new ResizeObserver(handleResize);
    resizeObs.observe(mount);

    // Main continuous loop with Software-WebGL fenceSync pacing
    let frameId = 0;
    let disposed = false;
    let prevTime = performance.now();
    let elapsed = 0;
    let lastHudPush = 0;
    let lastPhaseRendered: GamePhase | null = null;
    let prevRoverX = engineRef.current.x;
    let prevRoverZ = engineRef.current.z;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;

      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - prevTime) / 1000));
      prevTime = now;
      elapsed += dt;

      const curPhase = phaseRef.current;
      const installed = installedRef.current;
      const curTool = selectedToolRef.current;
      const engine = engineRef.current;

      // Switch atmosphere & environment visibility on phase change
      if (lastPhaseRendered !== curPhase) {
        lastPhaseRendered = curPhase;
        envHandle.workshopGroup.visible = curPhase === 'workshop';
        envHandle.fieldGroup.visible = curPhase === 'field';
        if (curPhase === 'workshop') {
          (scene.background as THREE.Color).setHex(0xe3ebe8);
          (scene.fog as THREE.FogExp2).color.setHex(0xe3ebe8);
          (scene.fog as THREE.FogExp2).density = 0.045;
          roverRig.root.position.set(0, 0, 0);
          roverRig.root.rotation.set(0, 0, 0);
          roverRig.cameraFrustum.visible = false;
          roverRig.tofBeam.visible = false;
        } else {
          const fieldSpec = CROP_FIELD_BY_ID[fieldTypeRef.current];
          (scene.background as THREE.Color).setHex(fieldSpec.skyTintHex);
          (scene.fog as THREE.FogExp2).color.setHex(fieldSpec.skyTintHex);
          (scene.fog as THREE.FogExp2).density = 0.036;
          envHandle.setFieldType(fieldTypeRef.current);
          prevRoverX = engine.x;
          prevRoverZ = engine.z;
        }
      }

      // Update part visibility, drop-in spring damping, exploded view, and ghost snap targets
      const explodeVal = curPhase === 'workshop' ? explodeRef.current : 0;
      const nextInstallable = getNextInstallablePart(installed);

      for (const spec of ROVER_PARTS) {
        const pg = roverRig.partGroups[spec.id];
        const gg = roverRig.ghostGroups[spec.id];
        const isInstalled = installed.has(spec.id);

        if (isInstalled) {
          pg.visible = true;
          gg.visible = false;
          const prevAnim = partAnimProgressRef.current[spec.id] ?? 1;
          const nextAnim = THREE.MathUtils.damp(prevAnim, 1, 9, dt);
          partAnimProgressRef.current[spec.id] = Math.abs(1 - nextAnim) < 0.002 ? 1 : nextAnim;
          const dropT = 1 - partAnimProgressRef.current[spec.id];

          const targetX = spec.explodeOffset[0] * explodeVal + spec.dropOffset[0] * dropT;
          const targetY = spec.explodeOffset[1] * explodeVal + spec.dropOffset[1] * dropT;
          const targetZ = spec.explodeOffset[2] * explodeVal + spec.dropOffset[2] * dropT;

          pg.position.x = THREE.MathUtils.damp(pg.position.x, targetX, 11, dt);
          pg.position.y = THREE.MathUtils.damp(pg.position.y, targetY, 11, dt);
          pg.position.z = THREE.MathUtils.damp(pg.position.z, targetZ, 11, dt);
        } else {
          pg.visible = false;
          // Show crisp wireframe ghost socket for the next installable part(s) in workshop
          const installableNow = curPhase === 'workshop' && canInstallPart(spec.id, installed);
          gg.visible = installableNow;
          if (installableNow) {
            const isPrimaryNext = nextInstallable?.id === spec.id;
            const hoverBob = Math.sin(elapsed * 3.4) * 0.004;
            gg.position.set(0, hoverBob, 0);
            gg.scale.setScalar(isPrimaryNext ? 1.02 : 0.98);
          }
        }
      }

      // Sync 3D hitboxes to exploded positions + crisp selection/hover highlight frames
      roverRig.syncPartHighlights(
        rightPanelOpenRef.current && rightPanelTabRef.current === 'specs'
          ? selectedPartIdRef.current
          : null,
        hoveredPartIdRef.current
      );

      if (curPhase === 'workshop') {
        // Allow interactive Workshop servo sweep test to demonstrate tank + nozzle rotation!
        const manualSweepRad =
          servoTestRef.current && installed.has('estop_tool')
            ? Math.sin(elapsed * 2.2) * 0.72
            : null;
        roverRig.setFiringVisual(false, curTool, elapsed, null, false, manualSweepRad);
        if (partFocusRef.current.active) {
          camera.position.x = THREE.MathUtils.damp(
            camera.position.x,
            partFocusRef.current.camPos.x,
            6.5,
            dt
          );
          camera.position.y = THREE.MathUtils.damp(
            camera.position.y,
            partFocusRef.current.camPos.y,
            6.5,
            dt
          );
          camera.position.z = THREE.MathUtils.damp(
            camera.position.z,
            partFocusRef.current.camPos.z,
            6.5,
            dt
          );
          controls.target.x = THREE.MathUtils.damp(
            controls.target.x,
            partFocusRef.current.lookAt.x,
            7.5,
            dt
          );
          controls.target.y = THREE.MathUtils.damp(
            controls.target.y,
            partFocusRef.current.lookAt.y,
            7.5,
            dt
          );
          controls.target.z = THREE.MathUtils.damp(
            controls.target.z,
            partFocusRef.current.lookAt.z,
            7.5,
            dt
          );
          if (camera.position.distanceTo(partFocusRef.current.camPos) < 0.012) {
            partFocusRef.current.active = false;
          }
        } else if (camTransitionActiveRef.current) {
          _camTargetPos.set(0.45, 0.34, 0.44);
          _camLookAt.set(0.03, 0.14, 0);
          camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 5.5, dt);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 5.5, dt);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 5.5, dt);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, _camLookAt.x, 6.5, dt);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, _camLookAt.y, 6.5, dt);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, _camLookAt.z, 6.5, dt);
          if (camera.position.distanceTo(_camTargetPos) < 0.01) {
            camTransitionActiveRef.current = false;
          }
        }
      } else {
        // Step real-time Field Mission Engine
        const events = engine.step(dt, installed, curTool, manualInputRef.current);

        if (events.arcIgnite) {
          soundEngine.playArcIgniter();
        }
        if (events.treatmentTick) {
          envHandle.spawnTreatmentParticles(
            events.treatmentTick.x,
            events.treatmentTick.z,
            events.treatmentTick.tool,
            curTool === 'flame' ? 12 : 8
          );
          if (Math.random() < 0.45) {
            soundEngine.playTreatment(events.treatmentTick.tool);
          }
        }
        if (events.weedEliminated) {
          envHandle.spawnTreatmentParticles(
            events.weedEliminated.x,
            events.weedEliminated.z,
            events.weedEliminated.tool,
            18
          );
          soundEngine.playTreatment(events.weedEliminated.tool);
        }
        if (events.obstacleTriggered || events.cropHit) {
          soundEngine.playAlert();
        }
        if (events.missionComplete) {
          soundEngine.playMissionComplete();
        }

        // Sync 3D rover pose, wheel spin, sensor overlays, and firing visuals
        roverRig.root.position.set(engine.x, 0, engine.z);
        roverRig.root.rotation.set(0, engine.headingRad, 0);

        roverRig.leftWheels.forEach((w) => {
          w.rotation.z = engine.leftWheelAngle;
        });
        roverRig.rightWheels.forEach((w) => {
          w.rotation.z = engine.rightWheelAngle;
        });

        roverRig.cameraFrustum.visible = installed.has('maixsense_cam');
        roverRig.tofBeam.visible = installed.has('imu_tof');
        roverRig.setFiringVisual(
          engine.isToolFiring() && installed.has('estop_tool'),
          curTool,
          elapsed,
          engine.activeWeedLocal,
          engine.isSparkPhase()
        );

        // Sync 3D crops, weeds, obstacle crate, and particle bursts
        envHandle.syncFieldEntities(engine.crops, engine.weeds, engine.obstacle);
        envHandle.updateParticles(dt);

        // Smooth camera presets in Field mode — always allow unrestricted 360° OrbitControls rotation!
        const preset = cameraPresetRef.current;
        const dirX = Math.cos(engine.headingRad);
        const dirZ = -Math.sin(engine.headingRad);
        const dxRover = engine.x - prevRoverX;
        const dzRover = engine.z - prevRoverZ;
        prevRoverX = engine.x;
        prevRoverZ = engine.z;

        if (partFocusRef.current.active) {
          partFocusRef.current.camPos.x += dxRover;
          partFocusRef.current.camPos.z += dzRover;
          partFocusRef.current.lookAt.x += dxRover;
          partFocusRef.current.lookAt.z += dzRover;
          camera.position.x = THREE.MathUtils.damp(
            camera.position.x,
            partFocusRef.current.camPos.x,
            6.5,
            dt
          );
          camera.position.y = THREE.MathUtils.damp(
            camera.position.y,
            partFocusRef.current.camPos.y,
            6.5,
            dt
          );
          camera.position.z = THREE.MathUtils.damp(
            camera.position.z,
            partFocusRef.current.camPos.z,
            6.5,
            dt
          );
          controls.target.x = THREE.MathUtils.damp(
            controls.target.x,
            partFocusRef.current.lookAt.x,
            7.5,
            dt
          );
          controls.target.y = THREE.MathUtils.damp(
            controls.target.y,
            partFocusRef.current.lookAt.y,
            7.5,
            dt
          );
          controls.target.z = THREE.MathUtils.damp(
            controls.target.z,
            partFocusRef.current.lookAt.z,
            7.5,
            dt
          );
          if (camera.position.distanceTo(partFocusRef.current.camPos) < 0.02) {
            partFocusRef.current.active = false;
          }
        } else if (preset === 'chase') {
          if (camTransitionActiveRef.current) {
            _camTargetPos.set(engine.x - dirX * 0.88, 0.56, engine.z - dirZ * 0.88 + 0.14);
            _camLookAt.set(engine.x + dirX * 0.18, 0.12, engine.z + dirZ * 0.18);
            camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 5.5, dt);
            camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 5.5, dt);
            camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 5.5, dt);
            controls.target.x = THREE.MathUtils.damp(controls.target.x, _camLookAt.x, 6.5, dt);
            controls.target.y = THREE.MathUtils.damp(controls.target.y, _camLookAt.y, 6.5, dt);
            controls.target.z = THREE.MathUtils.damp(controls.target.z, _camLookAt.z, 6.5, dt);
            if (camera.position.distanceTo(_camTargetPos) < 0.04) {
              camTransitionActiveRef.current = false;
            }
          } else {
            // Follow the rover's translation delta while 100% preserving whatever 360° angle the user rotated to
            camera.position.x += dxRover;
            camera.position.z += dzRover;
            controls.target.x += dxRover;
            controls.target.z += dzRover;
          }
        } else if (preset === 'mast') {
          // Camera POV right behind the white cantilever camera gantry looking at the flame target zone!
          _camTargetPos.set(engine.x - dirX * 0.04, 0.42, engine.z - dirZ * 0.04);
          _camLookAt.set(engine.x + dirX * 0.52, 0.04, engine.z + dirZ * 0.52);
          camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 9, dt);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 9, dt);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 9, dt);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, _camLookAt.x, 9, dt);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, _camLookAt.y, 9, dt);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, _camLookAt.z, 9, dt);
        } else if (preset === 'bev') {
          if (camTransitionActiveRef.current) {
            _camTargetPos.set(0, 4.2, 0.55);
            _camLookAt.set(0, 0, 0);
            camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 5, dt);
            camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 5, dt);
            camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 5, dt);
            controls.target.x = THREE.MathUtils.damp(controls.target.x, _camLookAt.x, 6, dt);
            controls.target.y = THREE.MathUtils.damp(controls.target.y, _camLookAt.y, 6, dt);
            controls.target.z = THREE.MathUtils.damp(controls.target.z, _camLookAt.z, 6, dt);
            if (camera.position.distanceTo(_camTargetPos) < 0.04) {
              camTransitionActiveRef.current = false;
            }
          }
        } else if (preset === 'orbit' && camTransitionActiveRef.current) {
          _camTargetPos.set(engine.x + 1.15, 0.95, engine.z + 1.35);
          _camLookAt.set(engine.x, 0.14, engine.z);
          camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 5, dt);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 5, dt);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 5, dt);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, _camLookAt.x, 6, dt);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, _camLookAt.y, 6, dt);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, _camLookAt.z, 6, dt);
          if (camera.position.distanceTo(_camTargetPos) < 0.04) {
            camTransitionActiveRef.current = false;
          }
        }
      }

      controls.update();
      renderer.render(scene, camera);

      // Push throttled HUD snapshot to React (~10 Hz)
      if (now - lastHudPush > 100) {
        lastHudPush = now;
        setHud(
          engine.getHudSnapshot(
            curPhase,
            installed,
            curTool,
            canDeployRef.current,
            roverRig.getTurretYawDeg()
          )
        );
      }

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObs.disconnect();
      controls.removeEventListener('start', onControlStart);
      controls.dispose();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      roverRig.dispose();
      envHandle.dispose();
      textures.dispose();
      envTarget.dispose();
      renderer.dispose();
    };
  }, []);

  const activeInspectSpec = PART_BY_ID[hoveredPartId ?? selectedPartId] ?? ROVER_PARTS[0];
  const nextPart = getNextInstallablePart(installedSet);

  const setManualKey = (key: keyof ManualInputState, active: boolean) => {
    manualInputRef.current[key] = active;
  };

  return (
    <div className="relative w-full h-[calc(100vh-56px)] min-h-[580px] overflow-hidden bg-[#18221e] select-none">
      {/* Dedicated isolated WebGL canvas container (zero React children) */}
      <div ref={canvasMountRef} className="absolute inset-0 w-full h-full touch-none" />

      {/* Graceful WebGL fallback if unavailable */}
      {webglError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/90 text-white p-6">
          <div className="max-w-md text-center space-y-2">
            <h2 className="text-lg font-semibold">3D Viewport Unavailable</h2>
            <p className="text-sm text-slate-300">{webglError}</p>
          </div>
        </div>
      )}

      {/* Minimal Top-Left HUD Badge (Solid rgba surface, NO backdrop-filter over WebGL, zero pulsating dots) */}
      <div
        className={`pointer-events-none absolute top-4 left-4 z-10 ${
          rightPanelOpen ? 'max-w-[min(560px,calc(100vw-396px))]' : 'max-w-[min(620px,92vw)]'
        }`}
      >
        <div className="pointer-events-auto rounded-lg bg-[#111917]/90 border border-white/12 px-4 py-2.5 text-white shadow-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-semibold tracking-tight text-emerald-300">
              {phase === 'workshop' ? '3D Rover Workshop' : CROP_FIELD_BY_ID[fieldType].name}
            </span>
            <span className="text-white/30" aria-hidden="true">
              ·
            </span>
            {phase === 'workshop' ? (
              <span className="font-mono tabular-nums text-slate-200">
                Assembly {installedSet.size}/{ROVER_PARTS.length}
              </span>
            ) : (
              <span className="font-mono tabular-nums text-slate-200">
                State: {hud.roverState}
              </span>
            )}
            <span className="text-white/30" aria-hidden="true">
              ·
            </span>
            <span className="font-mono tabular-nums text-amber-300">
              Servo Aim {hud.turretYawDeg > 0 ? `+${hud.turretYawDeg}` : hud.turretYawDeg}°
            </span>
            <span className="text-white/30" aria-hidden="true">
              ·
            </span>
            <span className="text-[11px] text-slate-400">
              Click any part to inspect · Drag 360°
            </span>
          </div>

          {phase === 'workshop' ? (
            <p className="mt-1 text-xs text-slate-300 leading-snug">
              <span className="font-semibold text-white">
                {activeInspectSpec.step}. {activeInspectSpec.name}
              </span>
              <span className="text-white/35 mx-1.5" aria-hidden="true">
                —
              </span>
              <span>{activeInspectSpec.specLine}</span>
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-slate-200">
              <span>
                Weeds {hud.weedsEliminated}/{hud.totalWeeds}
              </span>
              <span className="text-white/25" aria-hidden="true">
                ·
              </span>
              <span>
                Crops {hud.cropsSafe}/{hud.totalCrops}
              </span>
              <span className="text-white/25" aria-hidden="true">
                ·
              </span>
              <span>
                Nozzle {hud.nozzleTempC}°C
              </span>
              <span className="text-white/25" aria-hidden="true">
                ·
              </span>
              <span>
                Pi {hud.piTempC}°C
              </span>
              <span className="text-white/25" aria-hidden="true">
                ·
              </span>
              <span>{hud.cornerStatus.replace(/_/g, ' ')}</span>
              <span className="text-white/25" aria-hidden="true">
                ·
              </span>
              <span className="text-emerald-300">Score {hud.score}</span>
            </div>
          )}

          {phase === 'field' && (
            <p className="mt-1 text-[11px] text-slate-300 truncate">{hud.statusNote}</p>
          )}
        </div>
      </div>

      {/* Unified Right-Side Panel: Live Rover Camera Output + Interactive Part Specs & Assembly Guide */}
      <RoverRightPanel
        open={rightPanelOpen}
        activeTab={rightPanelTab}
        onChangeTab={setRightPanelTab}
        onClose={() => setRightPanelOpen(false)}
        phase={phase}
        hud={hud}
        engineRef={engineRef}
        fieldType={fieldType}
        onSelectFieldType={handleSelectFieldType}
        selectedPartId={selectedPartId}
        onSelectPart={(pid) => setSelectedPartId(pid)}
        installedSet={installedSet}
        onInstallPart={installPart}
        onFocusPartIn3D={handleFocusPartIn3D}
        servoTestActive={servoTestActive}
        onToggleServoTest={() => setServoTestActive((v) => !v)}
      />

      {/* Mission Complete Summary Overlay (only when DONE) */}
      {phase === 'field' && hud.roverState === 'DONE' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-xl bg-[#111917]/95 border border-emerald-400/30 p-6 text-white shadow-2xl space-y-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-emerald-300">
                Field Mission Complete
              </h2>
              <p className="text-xs text-slate-300 mt-1">
                Your custom-assembled agricultural rover finished all 4 serpentine rows in the{' '}
                {CROP_FIELD_BY_ID[fieldType].name}.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums bg-white/5 rounded-lg p-3.5 border border-white/10">
              <div>
                <div className="text-slate-400">Weeds Eliminated</div>
                <div className="text-base font-semibold text-white mt-0.5">
                  {hud.weedsEliminated} / {hud.totalWeeds}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Crops Protected</div>
                <div className="text-base font-semibold text-emerald-300 mt-0.5">
                  {hud.cropsSafe} / {hud.totalCrops}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Distance Driven</div>
                <div className="text-base font-semibold text-white mt-0.5">
                  {hud.distanceTravelledM.toFixed(1)} m
                </div>
              </div>
              <div>
                <div className="text-slate-400">Mission Score</div>
                <div className="text-base font-semibold text-amber-300 mt-0.5">{hud.score} pts</div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={enterWorkshopMode}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-white cursor-pointer transition-colors whitespace-nowrap"
              >
                Back to Workshop
              </button>
              <button
                type="button"
                onClick={() => engineRef.current.startOrPause()}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer transition-colors whitespace-nowrap"
              >
                Run New Field
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unified Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 z-20 w-[min(980px,95vw)] transition-transform duration-200 ease-out ${
          dockCollapsed ? 'bottom-0 translate-y-[calc(100%-34px)]' : 'bottom-4 translate-y-0'
        }`}
      >
        {/* Collapse / Expand Tab */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            className="flex items-center gap-1.5 rounded-t-lg bg-[#111917]/92 border border-b-0 border-white/15 px-3.5 py-1 text-[11px] font-medium text-slate-200 hover:text-white cursor-pointer"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Show Controls (H)</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Hide Controls (H)</span>
              </>
            )}
          </button>
        </div>

        {/* Main Dock Body (solid dark rgba, zero backdrop-filter over WebGL) */}
        <div className="rounded-xl bg-[#111917]/94 border border-white/14 p-3 text-white shadow-2xl space-y-2.5">
          {phase === 'workshop' ? (
            <>
              {/* Row 1: 10-Part Interactive Assembly Strip */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {ROVER_PARTS.map((part) => {
                  const isDone = installedSet.has(part.id);
                  const isReady = canInstallPart(part.id, installedSet);
                  const isSelected = selectedPartId === part.id;
                  return (
                    <button
                      key={part.id}
                      type="button"
                      onClick={() => {
                        setSelectedPartId(part.id);
                        setRightPanelOpen(true);
                        setRightPanelTab('specs');
                        installPart(part.id);
                      }}
                      onMouseEnter={() => setSelectedPartId(part.id)}
                      title={`${part.step}. ${part.name} — ${part.description}`}
                      className={`shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 border cursor-pointer whitespace-nowrap ${
                        isDone
                          ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-200 hover:bg-emerald-900/80'
                          : isReady
                          ? 'bg-amber-500/20 border-amber-400/70 text-amber-200 hover:bg-amber-500/30'
                          : isSelected
                          ? 'bg-white/10 border-white/25 text-slate-300'
                          : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {isDone ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <span className="font-mono tabular-nums text-[11px] opacity-80">
                          {part.step}.
                        </span>
                      )}
                      <span>{part.shortName}</span>
                    </button>
                  );
                })}
              </div>

              {/* Row 2: Workshop Actions, Exploded View Slider, Attachment Selector & Deploy CTA */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  {nextPart && (
                    <button
                      type="button"
                      onClick={handleAssembleNext}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      <span>Mount {nextPart.shortName}</span>
                    </button>
                  )}

                  {installedSet.size < ROVER_PARTS.length && (
                    <button
                      type="button"
                      onClick={handleQuickAssemble}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-100 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Quick Assemble All</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleResetBuild}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/8 hover:bg-white/15 text-slate-200 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                    title="Disassemble rover back to bare top deck"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setServoTestActive((prev) => !prev)}
                    disabled={!installedSet.has('estop_tool')}
                    title={
                      installedSet.has('estop_tool')
                        ? 'Test servo spur gear rotating butane tank & flame nozzle left/right'
                        : 'Mount Step 9 (Butane Flame Turret) first to test servo aim'
                    }
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap ${
                      servoTestActive
                        ? 'bg-orange-500 text-slate-950 font-semibold'
                        : 'bg-white/10 hover:bg-white/15 text-slate-200'
                    }`}
                  >
                    <Compass className="w-3.5 h-3.5" />
                    <span>{servoTestActive ? 'Stop Servo Sweep' : 'Test Servo Aim'}</span>
                  </button>

                  {/* Exploded View Slider */}
                  <label className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-white/6 text-xs text-slate-300">
                    <Layers className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
                    <span className="whitespace-nowrap">Explode</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={explodeFactor}
                      onChange={(e) => setExplodeFactor(Number(e.target.value))}
                      className="w-20 accent-emerald-400 cursor-pointer"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Attachment Tool Selector */}
                  <div className="flex items-center bg-white/8 rounded-lg p-0.5 text-xs">
                    {(
                      [
                        { id: 'flame', label: 'Flame', Icon: Flame },
                        { id: 'grinder', label: 'Grinder', Icon: Wrench },
                        { id: 'laser', label: 'Laser', Icon: Zap },
                      ] as const
                    ).map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedTool(id)}
                        className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap ${
                          selectedTool === id
                            ? 'bg-emerald-600 text-white'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setRightPanelOpen((o) => !o)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      rightPanelOpen
                        ? 'bg-emerald-600/30 border border-emerald-400/50 text-emerald-200'
                        : 'bg-white/10 hover:bg-white/15 text-slate-200'
                    }`}
                    title="Toggle Part Specs & Live Camera right panel (I)"
                  >
                    <PanelRight className="w-3.5 h-3.5" />
                    <span>Specs & Cam</span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? 'Unmute audio' : 'Mute audio'}
                    className="p-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-slate-200 cursor-pointer"
                  >
                    {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={enterFieldMode}
                    disabled={!canDeploy}
                    title={
                      canDeploy
                        ? 'Deploy your assembled rover into the 3D agricultural field'
                        : 'Assemble Deck, Arch, Motors, Wheels, Power, ESP32 & Pi 4 first'
                    }
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 text-white flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Deploy to Field</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Field Mode Dock */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Auto / Manual Segmented Toggle */}
                  <div className="flex items-center bg-white/8 rounded-lg p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => handleModeSwitch('auto')}
                      className={`px-2.5 py-1 rounded-md font-medium cursor-pointer whitespace-nowrap ${
                        controlMode === 'auto'
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Auto Mission
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModeSwitch('manual')}
                      className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                        controlMode === 'manual'
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      <Gamepad2 className="w-3.5 h-3.5" />
                      <span>Manual Drive</span>
                    </button>
                  </div>

                  {controlMode === 'auto' ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (hud.roverState === 'ESTOP') {
                          engineRef.current.recoverFromEstop();
                        } else {
                          engineRef.current.startOrPause();
                        }
                      }}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      {hud.roverState === 'ESTOP' ? (
                        <>
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Recover Latch</span>
                        </>
                      ) : engineRef.current.running ? (
                        <>
                          <Pause className="w-3.5 h-3.5" />
                          <span>Pause</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" />
                          <span>{hud.roverState === 'DONE' ? 'Replay Field' : 'Start Mission'}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onPointerDown={() => setManualKey('fire', true)}
                      onPointerUp={() => setManualKey('fire', false)}
                      onPointerLeave={() => setManualKey('fire', false)}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 hover:bg-orange-500 text-white flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Flame className="w-3.5 h-3.5" />
                      <span>Fire {selectedTool === 'flame' ? 'Torch' : selectedTool === 'grinder' ? 'Grinder' : 'Laser'} (F)</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => engineRef.current.toggleObstacleAhead()}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      hud.obstacleActive
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'bg-white/10 hover:bg-white/15 text-slate-100'
                    }`}
                  >
                    <Box className="w-3.5 h-3.5" />
                    <span>{hud.obstacleActive ? 'Clear Crate' : 'Drop Obstacle'}</span>
                  </button>

                  {/* 8-Crop Field Selector Dropdown */}
                  <label className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 text-xs text-slate-200">
                    <Sprout className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <select
                      aria-label="Select crop field type"
                      value={fieldType}
                      onChange={(e) => handleSelectFieldType(e.target.value as CropFieldId)}
                      className="bg-transparent text-xs font-medium text-white outline-none cursor-pointer"
                    >
                      {CROP_FIELDS.map((cf) => (
                        <option key={cf.id} value={cf.id} className="bg-slate-900 text-white">
                          {cf.index}. {cf.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    onClick={() => engineRef.current.resetField(Math.floor(Math.random() * 9000) + 1)}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/8 hover:bg-white/15 text-slate-200 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>New Field</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Camera Presets */}
                  <div className="flex items-center bg-white/8 rounded-lg p-0.5 text-xs">
                    <Camera className="w-3.5 h-3.5 text-slate-400 mx-1.5 shrink-0" />
                    {(
                      [
                        { id: 'chase', label: 'Chase' },
                        { id: 'mast', label: 'Cam POV' },
                        { id: 'bev', label: 'Top BEV' },
                        { id: 'orbit', label: 'Orbit' },
                      ] as const
                    ).map((cam) => (
                      <button
                        key={cam.id}
                        type="button"
                        onClick={() => setCameraPreset(cam.id)}
                        className={`px-2 py-1 rounded-md font-medium cursor-pointer whitespace-nowrap ${
                          cameraPreset === cam.id
                            ? 'bg-white text-slate-950'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {cam.label}
                      </button>
                    ))}
                  </div>

                  {/* Tool Switcher in Field */}
                  <div className="flex items-center bg-white/8 rounded-lg p-0.5 text-xs">
                    {(['flame', 'grinder', 'laser'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setSelectedTool(t)}
                        className={`px-2 py-1 rounded-md font-medium capitalize cursor-pointer whitespace-nowrap ${
                          selectedTool === t
                            ? 'bg-orange-600 text-white'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setRightPanelOpen((o) => !o)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      rightPanelOpen
                        ? 'bg-emerald-600/30 border border-emerald-400/50 text-emerald-200'
                        : 'bg-white/10 hover:bg-white/15 text-slate-200'
                    }`}
                    title="Toggle Live Camera Output & Part Specs panel (I)"
                  >
                    <PanelRight className="w-3.5 h-3.5" />
                    <span>Live Cam</span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? 'Unmute audio' : 'Mute audio'}
                    className="p-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-slate-200 cursor-pointer"
                  >
                    {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={enterWorkshopMode}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/18 text-white flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    <span>Workshop</span>
                  </button>
                </div>
              </div>

              {/* Compact On-Screen Touch/Mouse Drive Pad (only when Manual Drive active) */}
              {controlMode === 'manual' && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/10 text-xs">
                  <div className="flex items-center gap-1.5">
                    {(
                      [
                        { k: 'forward', label: 'Forward (W)' },
                        { k: 'backward', label: 'Reverse (S)' },
                        { k: 'left', label: 'Left (A)' },
                        { k: 'right', label: 'Right (D)' },
                      ] as const
                    ).map(({ k, label }) => (
                      <button
                        key={k}
                        type="button"
                        onPointerDown={() => setManualKey(k, true)}
                        onPointerUp={() => setManualKey(k, false)}
                        onPointerLeave={() => setManualKey(k, false)}
                        className="px-2.5 py-1.5 rounded-md bg-white/10 active:bg-emerald-600 text-slate-100 font-medium cursor-pointer whitespace-nowrap"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    Straddle tomato stems under the arch · Aim nozzle at weeds · Space for E-Stop
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
