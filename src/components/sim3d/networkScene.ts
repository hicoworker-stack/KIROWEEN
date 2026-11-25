import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { t } from '../../ui/i18n';
import { fmt1, fmt2, LEAK_AT, LEAK_PIPE, SIM_NODES, SIM_PIPE_PATHS, SIM_PIPES, SimPhase, SimResult, SimTone } from '../../ui/sim3dModel';

/**
 * Maqueta 3D de la red de demostración (three.js). Este módulo se importa bajo demanda: la landing no carga three.js
 * hasta que la sección está en pantalla. Todo lo que muestra es SIMULADO y sale de buildSimView(), es decir, de los motores reales.
 */

export interface SceneView {
  sim: SimResult;
  selected: string | null;
}

export interface SceneController {
  update(view: SceneView): void;
  focus(phase: SimPhase): void;
  resetView(): void;
  rotate(deltaRad: number): void;
  setXray(on: boolean): void;
  setLabels(on: boolean): void;
  dispose(): void;
}

export interface SceneOptions {
  onSelect: (nodeId: string | null) => void;
  reducedMotion: boolean;
}

const COLOR = {
  accent: 0x22d3ee,
  water: 0x38bdf8,
  ok: 0x34d399,
  attention: 0xfbbf24,
  critical: 0xfb7185,
  offline: 0x94a3b8,
  line: 0x2a5873,
  dim: 0x18364a,
};
const TONE_COLOR: Record<SimTone, number> = { ok: COLOR.ok, attention: COLOR.attention, critical: COLOR.critical, offline: COLOR.offline };

const PIPE_Y = -0.75;
const BLOCK = { w: 27, d: 17, h: 2.6 };

const PIPE_MATERIAL: Record<string, { color: number; metalness: number; roughness: number }> = {
  'Acero Dúctil': { color: 0x8796a3, metalness: 0.7, roughness: 0.35 },
  'PVC PN10': { color: 0xc7d2da, metalness: 0.05, roughness: 0.5 },
  'Hierro Dúctil': { color: 0x5f6b76, metalness: 0.65, roughness: 0.45 },
  'HDPE PE100': { color: 0x2b3238, metalness: 0.1, roughness: 0.6 },
};

const CAMERA_PRESETS: Record<'overview' | 'leak' | 'detect', { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [11.5, 11, 19.5], target: [0.3, -1.2, 1.0] },
  leak: { pos: [9.6, 4.2, 3.6], target: [5.6, -0.4, -3] },
  detect: { pos: [8.5, 8.5, 9.5], target: [5.8, -0.4, -2.2] },
};
const PHASE_CAMERA: Record<SimPhase, keyof typeof CAMERA_PRESETS> = { normal: 'overview', leak: 'leak', detect: 'detect', repair: 'leak', verified: 'overview' };

/** Recorrido con codos redondeados: tramos rectos unidos por curvas cuadráticas. */
function filletPath(points: Array<[number, number]>, y: number, radius = 0.4): THREE.CurvePath<THREE.Vector3> {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cur = pts[0].clone();
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (i < pts.length - 1) {
      const next = pts[i + 1];
      const dIn = p.clone().sub(pts[i - 1]);
      const dOut = next.clone().sub(p);
      const r = Math.min(radius, dIn.length() / 2, dOut.length() / 2);
      const a = p.clone().addScaledVector(dIn.normalize(), -r);
      const b = p.clone().addScaledVector(dOut.normalize(), r);
      path.add(new THREE.LineCurve3(cur, a));
      path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), b));
      cur = b;
    } else {
      path.add(new THREE.LineCurve3(cur, p.clone()));
    }
  }
  return path;
}

const pipeRadius = (diameterMm: number) => 0.05 + (diameterMm / 1000) * 0.45;

function std(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });
}

function shadowed<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = cast;
      c.receiveShadow = receive;
    }
  });
  return o;
}

function gableRoof(w: number, h: number, d: number, mat: THREE.Material) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - 0.08, 0);
  s.lineTo(w / 2 + 0.08, 0);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d + 0.16, bevelEnabled: false });
  g.translate(0, 0, -(d + 0.16) / 2);
  return new THREE.Mesh(g, mat);
}

function windowsRow(group: THREE.Group, count: number, w: number, y: number, z: number, mat: THREE.Material) {
  const g = new THREE.PlaneGeometry(0.22, 0.2);
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(g, mat);
    m.position.set(-w / 2 + (w / (count + 1)) * (i + 1), y, z);
    group.add(m);
  }
}

/** Generador determinista para la disposición (árboles, gotas iniciales): misma maqueta en cada carga. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createNetworkScene(host: HTMLElement, opts: SceneOptions): SceneController {
  const width = () => Math.max(1, host.clientWidth);
  const height = () => Math.max(1, host.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width(), height());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  host.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(width(), height());
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  host.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x06131c, 34, 70);

  const camera = new THREE.PerspectiveCamera(38, width() / height(), 0.1, 200);
  camera.position.set(...CAMERA_PRESETS.overview.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...CAMERA_PRESETS.overview.target);
  controls.maxDistance = 46;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxPolarAngle = Math.PI * 0.6;
  controls.screenSpacePanning = true;
  controls.update();

  // ───────────── Luz ─────────────
  scene.add(new THREE.HemisphereLight(0xcfeeff, 0x0b1a24, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(10, 18, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 13, bottom: -13, near: 1, far: 60 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x22d3ee, 0.35);
  rim.position.set(-12, 6, -10);
  scene.add(rim);

  const root = new THREE.Group();
  scene.add(root);

  // ───────────── Terreno en corte: césped, dos estratos de suelo y contorno ─────────────
  const topMat = std(0x1f4a3a, { transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.95 });
  const soilMats = [std(0x5a4632, { transparent: true, opacity: 0.3, depthWrite: false }), std(0x3c2f23, { transparent: true, opacity: 0.3, depthWrite: false })];
  const top = new THREE.Mesh(new THREE.BoxGeometry(BLOCK.w, 0.18, BLOCK.d), topMat);
  top.position.y = -0.09;
  top.receiveShadow = true;
  top.renderOrder = 2;
  root.add(top);
  const strata = [
    { y0: -0.18, y1: -1.25, mat: soilMats[0] },
    { y0: -1.25, y1: -BLOCK.h, mat: soilMats[1] },
  ];
  for (const s of strata) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(BLOCK.w, s.y0 - s.y1, BLOCK.d), s.mat);
    m.position.y = (s.y0 + s.y1) / 2;
    m.renderOrder = 1;
    root.add(m);
  }
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BLOCK.w, BLOCK.h, BLOCK.d)), new THREE.LineBasicMaterial({ color: COLOR.line }));
  outline.position.y = -BLOCK.h / 2;
  root.add(outline);
  const base = new THREE.Mesh(new THREE.BoxGeometry(BLOCK.w, 0.08, BLOCK.d), std(0x0a1d29));
  base.position.y = -BLOCK.h - 0.04;
  root.add(base);

  // Cuadrícula técnica sobre el terreno (1 unidad).
  {
    const pts: number[] = [];
    for (let x = -BLOCK.w / 2 + 1; x < BLOCK.w / 2; x += 1) pts.push(x, 0.005, -BLOCK.d / 2, x, 0.005, BLOCK.d / 2);
    for (let z = -BLOCK.d / 2 + 1; z < BLOCK.d / 2; z += 1) pts.push(-BLOCK.w / 2, 0.005, z, BLOCK.w / 2, 0.005, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    root.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLOR.dim, transparent: true, opacity: 0.45 })));
  }

  // ───────────── Quebrada con corriente ─────────────
  const riverX = -12.2;
  const river = new THREE.Mesh(new THREE.PlaneGeometry(1.8, BLOCK.d), std(0x14618a, { roughness: 0.15, metalness: 0.2, emissive: 0x0a3550, emissiveIntensity: 0.4 }));
  river.rotation.x = -Math.PI / 2;
  river.position.set(riverX, 0.012, 0);
  root.add(river);
  const streakGeo = new THREE.PlaneGeometry(0.05, 0.7);
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.45 });
  const streaks: THREE.Mesh[] = [];
  {
    const rnd = seeded(7);
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(streakGeo, streakMat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(riverX - 0.7 + rnd() * 1.4, 0.02, -BLOCK.d / 2 + rnd() * BLOCK.d);
      streaks.push(s);
      root.add(s);
    }
  }

  // ───────────── Calle sobre el tramo P-05 (la fuga ocurre bajo ella) ─────────────
  const road = new THREE.Mesh(new THREE.PlaneGeometry(BLOCK.w - 6, 1.3), std(0x1b2a33, { roughness: 0.9 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(3, 0.008, -3.9);
  road.receiveShadow = true;
  root.add(road);
  {
    const dash = new THREE.PlaneGeometry(0.5, 0.06);
    const dm = new THREE.MeshBasicMaterial({ color: 0x8fa9b8, transparent: true, opacity: 0.6 });
    for (let x = -6.5; x < 12.5; x += 1.1) {
      const d = new THREE.Mesh(dash, dm);
      d.rotation.x = -Math.PI / 2;
      d.position.set(x, 0.012, -3.9);
      root.add(d);
    }
  }

  // ───────────── Árboles ─────────────
  {
    const trunkG = new THREE.CylinderGeometry(0.05, 0.07, 0.4, 6);
    const crownG = new THREE.IcosahedronGeometry(0.42, 0);
    const trunkM = std(0x5b4636);
    const crownM = [std(0x2f6f55, { flatShading: true }), std(0x3d8a66, { flatShading: true }), std(0x285e49, { flatShading: true })];
    const spots: Array<[number, number, number]> = [
      [-11, 6.5, 1], [-9.8, 7.2, 0.8], [-8.5, 1.2, 1], [-7.2, 2.4, 0.9], [-4.8, 6.6, 1.1], [-0.4, 6.8, 0.9], [0.8, -6.6, 1], [-2.6, -6.4, 0.8],
      [6.2, 6.8, 1], [11.6, 6.6, 0.9], [12.2, 1.2, 1.1], [12, -6.2, 0.9], [6.4, -6.6, 1], [-6, -7, 0.9], [-10.6, -7.2, 1], [4.4, 0.6, 0.8],
    ];
    spots.forEach(([x, z, s], i) => {
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(trunkG, trunkM);
      trunk.position.y = 0.2;
      const crown = new THREE.Mesh(crownG, crownM[i % 3]);
      crown.position.y = 0.68;
      crown.scale.set(1, 1.15, 1);
      t.add(trunk, crown);
      t.scale.setScalar(s);
      t.position.set(x, 0, z);
      root.add(shadowed(t));
    });
  }

  // ───────────── Edificios e instalaciones ─────────────
  const pickables: THREE.Object3D[] = [];
  const tag = (o: THREE.Object3D, nodeId: string) => {
    o.traverse((c) => (c.userData.nodeId = nodeId));
    pickables.push(o);
    return o;
  };
  const concrete = std(0x8aa0ad, { roughness: 0.9 });
  const wall = std(0xd4dde2);
  const roofM = std(0x2a5873, { roughness: 0.7 });
  const windowM = new THREE.MeshStandardMaterial({ color: 0x0f2736, emissive: 0x22d3ee, emissiveIntensity: 0.35 });
  const metal = std(0x9fb0bc, { metalness: 0.7, roughness: 0.35 });
  const nodePos = (id: string) => SIM_NODES.find((n) => n.id === id)!.pos;

  // Bocatoma: caja de captación en la orilla, rejilla y compuerta.
  {
    const [x, z] = nodePos('N-TOMA-01');
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 1.3), concrete);
    box.position.set(-0.7, 0.35, 0);
    g.add(box);
    for (let i = 0; i < 6; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.03), metal);
      bar.position.set(-1.47, 0.35, -0.45 + i * 0.18);
      g.add(bar);
    }
    const gate = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.5), std(0x4d5b66, { metalness: 0.6 }));
    gate.position.set(0.1, 0.45, 0);
    g.add(gate);
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), 'N-TOMA-01'));
  }

  // Planta de filtración: edificio, dos filtros cilíndricos y un tanque de cloro.
  {
    const [x, z] = nodePos('N-PLANTA-02');
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.4), wall);
    b.position.set(0, 0.55, -0.9);
    g.add(b);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.08, 1.55), roofM);
    roof.position.set(0, 1.14, -0.9);
    g.add(roof);
    windowsRow(g, 4, 2.2, 0.72, -0.19, windowM);
    for (const dx of [-0.65, 0.4]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.0, 24), std(0x6f8594, { metalness: 0.5, roughness: 0.4 }));
      f.position.set(dx, 0.5, 0.75);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.025, 6, 24), metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(dx, 0.75, 0.75);
      g.add(f, ring);
    }
    const chlorine = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.55, 16), std(0xfbbf24, { roughness: 0.5 }));
    chlorine.position.set(1.25, 0.28, 0.5);
    g.add(chlorine);
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), 'N-PLANTA-02'));
  }

  // Tanque elevado: cuatro patas con riostras, depósito, cubierta, escalera e indicador de nivel.
  {
    const [x, z] = nodePos('N-TANQ-03');
    const g = new THREE.Group();
    const H = 3;
    for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, H, 8), concrete);
      leg.position.set(dx, H / 2, dz);
      g.add(leg);
    }
    for (const y of [1.0, 2.0]) {
      for (const [ax, az, len, rotY] of [[0, -0.6, 1.2, 0], [0, 0.6, 1.2, 0], [-0.6, 0, 1.2, Math.PI / 2], [0.6, 0, 1.2, Math.PI / 2]] as Array<[number, number, number, number]>) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), concrete);
        brace.position.set(ax, y, az);
        brace.rotation.y = rotY;
        g.add(brace);
      }
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.3, 32), std(0xc9d6de, { roughness: 0.55, metalness: 0.15 }));
    tank.position.y = H + 0.65;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.01, 1.01, 0.12, 32), roofM);
    band.position.y = H + 0.95;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.08, 0.45, 32), roofM);
    cap.position.y = H + 1.53;
    const gauge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.02), std(0x0f2736));
    gauge.position.set(0, H + 0.65, 1.005);
    const level = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 0.025), new THREE.MeshStandardMaterial({ color: COLOR.accent, emissive: COLOR.accent, emissiveIntensity: 0.6 }));
    level.position.set(0, H + 0.51, 1.01);
    g.add(tank, band, cap, gauge, level);
    // Escalera
    for (const dx of [0.78, 0.98]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, H + 0.8, 6), metal);
      rail.position.set(dx, (H + 0.8) / 2, 0.55);
      g.add(rail);
    }
    for (let y = 0.3; y < H + 0.7; y += 0.28) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.02), metal);
      rung.position.set(0.88, y, 0.55);
      g.add(rung);
    }
    // Bajante hacia la red enterrada
    const down = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, H, 12), metal);
    down.position.set(0, H / 2, 0);
    g.add(down);
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), 'N-TANQ-03'));
  }

  // Cámaras de válvulas con tapa y volante.
  const valveWheels: Record<string, THREE.Group> = {};
  for (const id of ['N-TRON-04', 'N-VALV-05']) {
    const [x, z] = nodePos(id);
    const g = new THREE.Group();
    const chamber = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.9), concrete);
    chamber.position.y = 0.08;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 24), std(0x3b4650, { metalness: 0.6 }));
    lid.position.set(-0.15, 0.175, 0.15);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), metal);
    stem.position.set(0.2, 0.36, -0.2);
    const wheel = new THREE.Group();
    const rimM = std(COLOR.ok, { metalness: 0.4, roughness: 0.4 });
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.028, 8, 28), rimM));
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.025, 0.025), rimM);
      spoke.rotation.z = (i * Math.PI) / 3;
      wheel.add(spoke);
    }
    wheel.rotation.x = -Math.PI / 2;
    wheel.position.set(0.2, 0.57, -0.2);
    wheel.userData.material = rimM;
    valveWheels[id] = wheel;
    // Caja de válvula enterrada sobre la tubería
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), std(0x4d5b66, { metalness: 0.6, roughness: 0.4 }));
    body.position.set(0.2, PIPE_Y, -0.2);
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, Math.abs(PIPE_Y), 8), metal);
    riser.position.set(0.2, PIPE_Y / 2, -0.2);
    g.add(chamber, lid, stem, wheel, body, riser);
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), id));
  }

  // Escuela (techo a dos aguas, ventanas, asta) y centro de salud (cruz).
  {
    const [x, z] = nodePos('N-DIST-06');
    const g = new THREE.Group();
    const school = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 1.4), std(0xe3d9c6));
    school.position.set(0, 0.5, -0.2);
    // Cumbrera a lo largo del edificio: el perfil cubre el fondo (1,4) y se extruye a lo largo (2,6).
    const roofLong = gableRoof(1.4, 0.55, 2.6, std(0xb4553f, { roughness: 0.7 }));
    roofLong.rotation.y = Math.PI / 2;
    roofLong.position.set(0, 1.0, -0.2);
    g.add(school, roofLong);
    windowsRow(g, 5, 2.6, 0.62, 0.505, windowM);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.5), std(0x2a5873));
    door.position.set(0, 0.25, 0.506);
    g.add(door);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 6), metal);
    pole.position.set(-1.6, 0.9, 0.6);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.25), new THREE.MeshStandardMaterial({ color: COLOR.accent, side: THREE.DoubleSide }));
    flag.position.set(-1.39, 1.65, 0.6);
    g.add(pole, flag);
    // Centro de salud
    const clinic = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.85, 1.1), std(0xf1f5f7));
    clinic.position.set(2.15, 0.425, 1.3);
    const clinicRoof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.07, 1.2), roofM);
    clinicRoof.position.set(2.15, 0.885, 1.3);
    const crossM = new THREE.MeshStandardMaterial({ color: COLOR.critical, emissive: COLOR.critical, emissiveIntensity: 0.35 });
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.02), crossM);
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.02), crossM);
    for (const c of [c1, c2]) c.position.set(2.15, 0.55, 1.861);
    g.add(clinic, clinicRoof, c1, c2);
    for (const dx of [-0.42, 0.42]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.2), windowM);
      w.position.set(2.15 + dx, 0.55, 1.861);
      g.add(w);
    }
    // Medidor de entrega
    const meter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.2), std(0x4d5b66, { metalness: 0.5 }));
    meter.position.set(-1.0, 0.11, 0.9);
    g.add(meter);
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), 'N-DIST-06'));
  }

  // Barrio La Esperanza: viviendas con techos de colores, cercas y tanques domiciliarios.
  {
    const [x, z] = nodePos('N-DIST-07');
    const g = new THREE.Group();
    const houses: Array<[number, number, number, number]> = [
      [-1.6, -0.6, 0xd8c9b0, 0x9b4a3a], [-0.3, -0.9, 0xc9d6de, 0x2a5873], [1.0, -0.5, 0xe6dccb, 0x7b5a3a],
      [-1.2, 1.0, 0xd3dfd5, 0x9b4a3a], [0.2, 1.2, 0xe3d9c6, 0x2a5873], [1.6, 0.9, 0xd8c9b0, 0x6b7f3a],
    ];
    houses.forEach(([hx, hz, wallC, roofC], i) => {
      const h = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.6, 0.7), std(wallC));
      body.position.y = 0.3;
      const r = gableRoof(0.7, 0.35, 0.85, std(roofC, { roughness: 0.7 }));
      r.rotation.y = Math.PI / 2;
      r.position.y = 0.6;
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.16), windowM);
      win.position.set(0.18, 0.34, 0.351);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.32), std(0x3b2f25));
      door.position.set(-0.18, 0.16, 0.351);
      h.add(body, r, win, door);
      if (i % 2 === 0) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 12), std(0x1f2a33));
        tank.position.set(0.25, 0.95, 0);
        h.add(tank);
      }
      h.position.set(hx, 0, hz);
      h.rotation.y = (i % 3) * 0.08 - 0.08;
      g.add(h);
    });
    g.position.set(x, 0, z);
    root.add(tag(shadowed(g), 'N-DIST-07'));
  }

  // ───────────── Tuberías enterradas con agua visible ─────────────
  interface PipeVis {
    id: string;
    path: THREE.CurvePath<THREE.Vector3>;
    length: number;
    radius: number;
    particles: THREE.InstancedMesh;
    u: Float32Array;
    highlight?: THREE.Mesh;
  }
  const pipes: PipeVis[] = [];
  const waterMat = new THREE.MeshStandardMaterial({ color: COLOR.water, emissive: 0x0e7490, emissiveIntensity: 0.9, roughness: 0.2 });
  const dummy = new THREE.Object3D();
  for (const p of SIM_PIPES) {
    const path = filletPath(SIM_PIPE_PATHS[p.id], PIPE_Y);
    const length = path.getLength();
    const radius = pipeRadius(p.diameterMm);
    const spec = PIPE_MATERIAL[p.material] ?? PIPE_MATERIAL['PVC PN10'];
    const shell = new THREE.Mesh(
      new THREE.TubeGeometry(path, Math.max(48, Math.round(length * 14)), radius, 18, false),
      new THREE.MeshStandardMaterial({ ...spec, transparent: true, opacity: 0.55, depthWrite: false })
    );
    shell.renderOrder = 3;
    shell.castShadow = false;
    root.add(shell);
    const count = Math.max(8, Math.round(length / 0.3));
    const particles = new THREE.InstancedMesh(new THREE.SphereGeometry(radius * 0.5, 10, 8), waterMat, count);
    particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    particles.frustumCulled = false;
    const u = new Float32Array(count);
    for (let i = 0; i < count; i++) u[i] = i / count;
    root.add(particles);
    const vis: PipeVis = { id: p.id, path, length, radius, particles, u };
    if (p.id === LEAK_PIPE) {
      vis.highlight = new THREE.Mesh(
        new THREE.TubeGeometry(path, 64, radius * 2.1, 18, false),
        new THREE.MeshBasicMaterial({ color: COLOR.critical, transparent: true, opacity: 0, depthWrite: false })
      );
      vis.highlight.renderOrder = 4;
      root.add(vis.highlight);
    }
    // Bridas en los extremos
    for (const t of [0, 1]) {
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.45, radius * 1.45, 0.07, 18), metal);
      const pos = path.getPointAt(t);
      const tan = path.getTangentAt(t);
      flange.position.copy(pos).addScaledVector(tan, t === 0 ? 0.12 : -0.12);
      flange.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
      root.add(flange);
    }
    pipes.push(vis);
  }
  // Uniones en los nudos y bajantes hasta la superficie
  for (const n of SIM_NODES) {
    const [x, z] = n.pos;
    const joint = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), metal);
    joint.position.set(x, PIPE_Y, z);
    root.add(joint);
  }

  // ───────────── Fuga: grieta, chorro, charco, suelo saturado ─────────────
  const leakPipe = pipes.find((p) => p.id === LEAK_PIPE)!;
  const leakPoint = leakPipe.path.getPointAt(LEAK_AT);
  const leakTangent = leakPipe.path.getTangentAt(LEAK_AT);
  const alongPipe = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), leakTangent);

  const crack = new THREE.Mesh(new THREE.TorusGeometry(leakPipe.radius * 1.15, 0.018, 6, 24), new THREE.MeshBasicMaterial({ color: COLOR.critical }));
  crack.position.copy(leakPoint);
  crack.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), leakTangent));
  root.add(crack);

  const saturated = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: COLOR.water, transparent: true, opacity: 0, depthWrite: false }));
  saturated.position.copy(leakPoint);
  saturated.scale.set(0.01, 0.01, 0.01);
  root.add(saturated);

  const wet = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: 0x2a2018, transparent: true, opacity: 0, roughness: 0.4, depthWrite: false }));
  wet.rotation.x = -Math.PI / 2;
  wet.position.set(leakPoint.x, 0.016, leakPoint.z);
  root.add(wet);
  const puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: 0x1e88b8, transparent: true, opacity: 0, roughness: 0.08, metalness: 0.3, depthWrite: false }));
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(leakPoint.x, 0.02, leakPoint.z);
  root.add(puddle);

  const DROPS = 180;
  const drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 6, 5), new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x0e7490, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }), DROPS);
  drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  drops.frustumCulled = false;
  const dropPos = new Float32Array(DROPS * 3);
  const dropVel = new Float32Array(DROPS * 3);
  const dropAlive = new Uint8Array(DROPS);
  root.add(drops);

  // Abrazadera de reparación con pernos
  const clamp = new THREE.Group();
  {
    const r = leakPipe.radius * 1.55;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.42, 24), std(0xb7c6d1, { metalness: 0.8, roughness: 0.25 }));
    clamp.add(band);
    for (const y of [-0.13, 0.13]) {
      const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, r * 2.6), std(0x6f7f8a, { metalness: 0.8 }));
      bolt.position.y = y;
      clamp.add(bolt);
    }
  }
  clamp.position.copy(leakPoint);
  clamp.quaternion.copy(alongPipe);
  clamp.scale.setScalar(0.001);
  root.add(clamp);

  // Excavación, cuadrilla y camión de servicio
  const works = new THREE.Group();
  {
    const pit = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.02, 1.0), std(0x120e0a));
    pit.position.set(0, 0.022, 0);
    const pitWalls = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.4, Math.abs(PIPE_Y) + 0.2, 1.0)), new THREE.LineBasicMaterial({ color: 0x8b6b4a }));
    pitWalls.position.y = PIPE_Y / 2 - 0.1;
    const spoil = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x6b5238, { flatShading: true }));
    spoil.scale.set(1, 0.5, 0.8);
    spoil.position.set(1.25, 0, 0.75);
    works.add(pit, pitWalls, spoil);
    const coneM = std(COLOR.attention, { roughness: 0.6 });
    const stripeM = std(0xf1f5f7);
    for (const [cx, cz] of [[-0.9, -0.7], [0.9, -0.7], [-0.9, 0.7], [0.9, 0.7]]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 12), coneM);
      cone.position.set(cx, 0.15, cz);
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.062, 0.05, 12), stripeM);
      stripe.position.set(cx, 0.17, cz);
      works.add(cone, stripe);
    }
    // Cinta de seguridad
    const tapePts = [[-0.9, -0.7], [0.9, -0.7], [0.9, 0.7], [-0.9, 0.7], [-0.9, -0.7]].map(([a, b]) => new THREE.Vector3(a, 0.24, b));
    works.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tapePts), new THREE.LineBasicMaterial({ color: COLOR.attention })));
    // Operarios
    for (const [wx, wz, ry] of [[-0.35, 0.95, 0.4], [0.45, -0.95, -2.6]]) {
      const w = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.22, 4, 8), std(COLOR.attention));
      body.position.y = 0.2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), std(0xd9b38c));
      head.position.y = 0.43;
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.072, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), std(0xf1f5f7));
      helmet.position.y = 0.45;
      w.add(body, head, helmet);
      w.position.set(wx, 0, wz);
      w.rotation.y = ry;
      works.add(w);
    }
    // Camión
    const truck = new THREE.Group();
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 0.6), std(0xe6f1f5));
    bed.position.set(-0.25, 0.4, 0);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.6), std(COLOR.accent, { roughness: 0.5 }));
    cab.position.set(0.55, 0.38, 0);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.2), std(0x0f2736, { metalness: 0.6, roughness: 0.1 }));
    glass.position.set(0.781, 0.48, 0);
    glass.rotation.y = Math.PI / 2;
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.12), new THREE.MeshStandardMaterial({ color: COLOR.attention, emissive: COLOR.attention, emissiveIntensity: 1 }));
    beacon.position.set(0.55, 0.64, 0);
    beacon.name = 'beacon';
    truck.add(bed, cab, glass, beacon);
    for (const [wx, wz] of [[-0.5, -0.3], [-0.5, 0.3], [0.5, -0.3], [0.5, 0.3]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 14), std(0x1b2228));
      wh.rotation.x = Math.PI / 2;
      wh.position.set(wx, 0.13, wz);
      truck.add(wh);
    }
    truck.position.set(-2.1, 0, -0.9);
    works.add(truck);
  }
  works.position.set(leakPoint.x, 0, leakPoint.z);
  works.visible = false;
  root.add(shadowed(works));
  const beacon = works.getObjectByName('beacon') as THREE.Mesh;

  // Parche de asfalto tras la reparación
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.0), std(0x2c3a44, { roughness: 0.95 }));
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(leakPoint.x, 0.014, leakPoint.z);
  patch.visible = false;
  root.add(patch);

  // ───────────── Sensores ─────────────
  interface SensorVis {
    id: string;
    led: THREE.Mesh;
    ledMat: THREE.MeshStandardMaterial;
    halo: THREE.Mesh;
    haloMat: THREE.MeshBasicMaterial;
    select: THREE.Mesh;
    label: CSS2DObject;
    labelValue: HTMLSpanElement;
    labelEl: HTMLDivElement;
    dot: HTMLSpanElement;
    tone: SimTone;
  }
  const sensors: SensorVis[] = [];
  const postM = std(0x6f7f8a, { metalness: 0.6, roughness: 0.4 });
  const headM = std(0x1f2a33, { metalness: 0.3, roughness: 0.5 });
  const selectMat = new THREE.MeshBasicMaterial({ color: COLOR.accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  const labelHeights: Record<string, number> = { 'N-TOMA-01': 0.9, 'N-PLANTA-02': 2.3, 'N-TANQ-03': 5.2, 'N-TRON-04': 1.4, 'N-VALV-05': 1.4, 'N-DIST-06': 2.0, 'N-DIST-07': 1.7 };
  for (const n of SIM_NODES) {
    const [sx, sz] = n.sensor;
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.75, 8), postM);
    post.position.y = 0.375;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.14), headM);
    head.position.y = 0.82;
    const ledMat = new THREE.MeshStandardMaterial({ color: COLOR.ok, emissive: COLOR.ok, emissiveIntensity: 1.4 });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), ledMat);
    led.position.y = 0.96;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.32, 4), postM);
    antenna.position.set(0.07, 1.06, 0);
    // Zona de clic generosa (invisible) para que sea fácil tocar el sensor.
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.6;
    const haloMat = new THREE.MeshBasicMaterial({ color: COLOR.ok, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.32, 40), haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.025;
    const select = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.5, 48), selectMat);
    select.rotation.x = -Math.PI / 2;
    select.position.y = 0.03;
    select.visible = false;
    g.add(post, head, led, antenna, hit, halo, select);
    g.position.set(sx, n.id === 'N-TRON-04' || n.id === 'N-VALV-05' ? 0.16 : 0, sz);
    if (n.id === 'N-TRON-04' || n.id === 'N-VALV-05') g.position.add(new THREE.Vector3(-0.3, 0, -0.3));
    root.add(tag(shadowed(g), n.id));

    const el = document.createElement('div');
    el.className = 'pointer-events-auto cursor-pointer select-none whitespace-nowrap rounded-full border border-line-strong bg-canvas/85 px-2.5 py-1 text-[11px] font-medium leading-none text-ink shadow-lg shadow-black/30 backdrop-blur-sm transition-colors';
    const dot = document.createElement('span');
    dot.className = 'mr-1.5 inline-block h-2 w-2 rounded-full align-middle';
    const name = document.createElement('span');
    name.textContent = n.name;
    const value = document.createElement('span');
    value.className = 'ml-1.5 tabular-nums text-soft';
    el.append(dot, name, value);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onSelect(n.id);
    });
    const label = new CSS2DObject(el);
    label.position.set(n.pos[0], labelHeights[n.id] ?? 1.5, n.pos[1]);
    root.add(label);
    sensors.push({ id: n.id, led, ledMat, halo, haloMat, select, label, labelValue: value, labelEl: el, dot, tone: 'ok' });
  }

  // Etiqueta del balance de masa sobre el tramo candidato
  const balanceEl = document.createElement('div');
  balanceEl.className = 'pointer-events-none whitespace-nowrap rounded-lg border px-3 py-2 text-center text-[11px] font-semibold leading-snug shadow-lg shadow-black/40 backdrop-blur-sm';
  const balanceLabel = new CSS2DObject(balanceEl);
  const mid = leakPipe.path.getPointAt(0.5);
  balanceLabel.position.set(mid.x, 3.2, mid.z - 0.6);
  balanceLabel.visible = false;
  root.add(balanceLabel);
  const flowTagEls = ['in', 'out'].map(() => {
    const el = document.createElement('div');
    el.className = 'pointer-events-none whitespace-nowrap rounded-md bg-accent px-2 py-0.5 text-[11px] font-bold tabular-nums text-[#041018] shadow';
    return el;
  });
  const flowTags = flowTagEls.map((el) => new CSS2DObject(el));
  flowTags[0].position.copy(leakPipe.path.getPointAt(0.12)).setY(0.15);
  flowTags[1].position.copy(leakPipe.path.getPointAt(0.8)).setY(0.15);
  flowTags.forEach((t) => {
    t.visible = false;
    root.add(t);
  });

  // ───────────── Estado y animación ─────────────
  let view: SceneView | null = null;
  const anim = { leak: 0, puddle: 0, highlight: 0, clamp: 0, valveAngle: 0, valveTarget: 0 };
  let tween: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3; t: number } | null = null;
  let labelsOn = true;
  let visible = true;
  let disposed = false;

  const toneHex = (t: SimTone) => `#${TONE_COLOR[t].toString(16).padStart(6, '0')}`;

  function applyView() {
    if (!view) return;
    const { sim, selected } = view;
    for (const s of sensors) {
      const r = sim.readings[s.id];
      s.tone = r.tone;
      const c = TONE_COLOR[r.tone];
      s.ledMat.color.setHex(c);
      s.ledMat.emissive.setHex(c);
      s.haloMat.color.setHex(c);
      s.select.visible = selected === s.id;
      s.labelValue.textContent = `${fmt2(r.pressureBar)} bar`;
      s.dot.style.backgroundColor = toneHex(r.tone);
      s.labelEl.style.borderColor = selected === s.id ? '#22d3ee' : '';
      s.labelEl.setAttribute('aria-pressed', String(selected === s.id));
    }
    const e = sim.engine;
    const detect = sim.phase === 'detect';
    const concludes = e.level === 'localized_leak' || e.level === 'possible_leak';
    balanceLabel.visible = detect && labelsOn;
    flowTags.forEach((t) => (t.visible = detect && labelsOn));
    flowTagEls[0].textContent = t(`Troncal mide ${fmt1(sim.readings['N-TRON-04'].flowLs)} L/s`, `Trunk main reads ${fmt1(sim.readings['N-TRON-04'].flowLs)} L/s`);
    flowTagEls[1].textContent = t(`Escuela recibe ${fmt1(sim.readings['N-DIST-06'].flowLs)} L/s`, `School receives ${fmt1(sim.readings['N-DIST-06'].flowLs)} L/s`);
    const bal = e.balance;
    balanceEl.textContent = !bal
      ? t('El motor no puede evaluar el balance', 'The engine cannot assess the balance')
      : concludes
        ? t(`Exceso ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · motor: ${e.level === 'localized_leak' ? 'fuga localizada' : 'posible fuga'} en ${e.candidatePipeIds.join(', ')}`, `Excess ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · engine: ${e.level === 'localized_leak' ? 'localized leak' : 'possible leak'} in ${e.candidatePipeIds.join(', ')}`)
        : e.level === 'flow_anomaly'
          ? t(`Exceso ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · el motor NO concluye fuga (la presión no discrimina)`, `Excess ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · the engine does NOT conclude a leak (pressure cannot tell)`)
          : t(`Exceso ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · bajo el límite de ${fmt1(bal.detectionLimitLs)} L/s: sin anomalía`, `Excess ${fmt1(bal.excessLs)} ± ${fmt1(bal.sigmaLs)} L/s · below the ${fmt1(bal.detectionLimitLs)} L/s limit: no anomaly`);
    balanceEl.style.borderColor = concludes ? '#fb7185' : e.level === 'flow_anomaly' ? '#fbbf24' : '#34d399';
    balanceEl.style.background = concludes ? 'rgba(42,6,16,0.88)' : e.level === 'flow_anomaly' ? 'rgba(40,28,4,0.88)' : 'rgba(4,36,24,0.88)';
    balanceEl.style.color = concludes ? '#fecdd3' : e.level === 'flow_anomaly' ? '#fde68a' : '#a7f3d0';
    (leakPipe.highlight!.material as THREE.MeshBasicMaterial).color.setHex(concludes ? COLOR.critical : e.level === 'flow_anomaly' ? COLOR.attention : COLOR.ok);    anim.valveTarget = sim.isolated ? Math.PI * 6 : 0;
    const wheelMat = valveWheels['N-TRON-04'].userData.material as THREE.MeshStandardMaterial;
    wheelMat.color.setHex(sim.isolated ? COLOR.critical : COLOR.ok);
    works.visible = sim.phase === 'repair';
    patch.visible = sim.phase === 'verified' && sim.verdict === 'VERIFIED';
  }

  /** Aleja la cámara cuando el visor es estrecho, para que la maqueta entera quepa en la vista general. */
  const fitted = (preset: keyof typeof CAMERA_PRESETS) => {
    const p = CAMERA_PRESETS[preset];
    const target = new THREE.Vector3(...p.target);
    const offset = new THREE.Vector3(...p.pos).sub(target);
    if (preset === 'overview') {
      // La maqueta vista en diagonal ocupa ~29 × 16 unidades en pantalla: se aleja lo justo para que quepa en ancho y en alto.
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanH = tanV * camera.aspect;
      const dist = Math.max(14.5 / tanH, 8 / tanV) * 1.04;
      return { pos: target.clone().addScaledVector(offset.normalize(), dist), target };
    }
    const k = Math.max(1, 1.2 / Math.max(0.5, camera.aspect));
    return { pos: target.clone().addScaledVector(offset, k), target };
  };

  function goTo(preset: keyof typeof CAMERA_PRESETS) {
    const { pos: toPos, target: toTarget } = fitted(preset);
    if (opts.reducedMotion) {
      camera.position.copy(toPos);
      controls.target.copy(toTarget);
      controls.update();
      tween = null;
      return;
    }
    tween = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos, toTarget, t: 0 };
  }
  controls.addEventListener('start', () => (tween = null));
  // El encuadre no se aleja de la maqueta al desplazar.
  controls.addEventListener('change', () => {
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -12, 12);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -8, 8);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, -2.5, 3);
  });

  // ───────────── Selección con el puntero ─────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;
  const pick = (ev: PointerEvent): string | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables, true).find((h) => h.object.userData.nodeId);
    return hit ? (hit.object.userData.nodeId as string) : null;
  };
  const onDown = (ev: PointerEvent) => (downAt = { x: ev.clientX, y: ev.clientY });
  const onUp = (ev: PointerEvent) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved < 6) opts.onSelect(pick(ev));
  };
  let lastHover = 0;
  const onMove = (ev: PointerEvent) => {
    if (ev.buttons !== 0) return;
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    renderer.domElement.style.cursor = pick(ev) ? 'pointer' : 'grab';
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointermove', onMove);

  // ───────────── Tamaño y visibilidad ─────────────
  const resize = () => {
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    renderer.setSize(width(), height());
    labelRenderer.setSize(width(), height());
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const io = new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), { threshold: 0.01 });
  io.observe(host);

  // ───────────── Bucle ─────────────
  const clock = new THREE.Clock();
  let raf = 0;
  const rnd = Math.random;
  const spawnDrop = (i: number, strength: number) => {
    const a = rnd() * Math.PI * 2;
    const spread = 0.35 + rnd() * 0.45;
    dropPos[i * 3] = leakPoint.x + (rnd() - 0.5) * 0.08;
    dropPos[i * 3 + 1] = leakPoint.y + leakPipe.radius;
    dropPos[i * 3 + 2] = leakPoint.z + (rnd() - 0.5) * 0.08;
    dropVel[i * 3] = Math.cos(a) * spread;
    dropVel[i * 3 + 1] = (2.6 + rnd() * 1.4) * strength;
    dropVel[i * 3 + 2] = Math.sin(a) * spread;
    dropAlive[i] = 1;
  };

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible || disposed) {
      clock.getDelta();
      return;
    }
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    const sim = view?.sim;

    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.4);
      const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.t >= 1) tween = null;
    }
    controls.update();

    // Agua en las tuberías: velocidad proporcional al caudal de cada tramo (antes y después de la fuga en P-05).
    for (const p of pipes) {
      const f = sim?.pipes[p.id] ?? { up: 0, down: 0 };
      const flowing = f.up > 0.01 || f.down > 0.01;
      p.particles.visible = flowing;
      if (!flowing) continue;
      // Misma velocidad en todo el tramo; después de la fuga se ven menos gotas, en proporción al caudal que sigue.
      const ratio = f.up > 0 ? f.down / f.up : 1;
      for (let i = 0; i < p.u.length; i++) {
        p.u[i] = (p.u[i] + (dt * (0.18 + f.up * 0.12)) / p.length) % 1;
        const lost = p.id === LEAK_PIPE && p.u[i] > LEAK_AT && (i * 0.618034) % 1 >= ratio;
        if (lost) dummy.position.set(0, -50, 0);
        else dummy.position.copy(p.path.getPointAt(p.u[i]));
        dummy.updateMatrix();
        p.particles.setMatrixAt(i, dummy.matrix);
      }
      p.particles.instanceMatrix.needsUpdate = true;
    }

    // Fuga
    const leakOn = sim?.leakActive ?? false;
    const strength = sim ? Math.sqrt(Math.max(0, sim.leakLps) / 6) : 0;
    anim.leak += ((leakOn ? 1 : 0) - anim.leak) * Math.min(1, dt * 3);
    anim.puddle += ((leakOn ? 0.5 + 0.12 * sim!.leakLps : 0) - anim.puddle) * Math.min(1, dt * (leakOn ? 0.8 : 2.5));
    const pr = Math.max(0.001, anim.puddle);
    puddle.scale.set(pr, pr, 1);
    (puddle.material as THREE.MeshStandardMaterial).opacity = Math.min(0.75, anim.puddle * 0.9);
    wet.scale.set(pr * 1.6, pr * 1.6, 1);
    (wet.material as THREE.MeshStandardMaterial).opacity = Math.min(0.55, anim.puddle * 0.7);
    const satR = 0.2 + anim.puddle * 0.6;
    saturated.scale.set(satR * 1.2, satR * 0.7, satR);
    (saturated.material as THREE.MeshBasicMaterial).opacity = anim.leak * 0.16;
    crack.visible = anim.leak > 0.05;
    (crack.material as THREE.MeshBasicMaterial).color.setHex(COLOR.critical);
    crack.scale.setScalar(1 + Math.sin(t * 6) * 0.08);
    for (let i = 0; i < DROPS; i++) {
      if (!dropAlive[i]) {
        if (leakOn && rnd() < 0.12 * strength) spawnDrop(i, Math.max(0.5, strength));
        else {
          dummy.position.set(0, -50, 0);
          dummy.updateMatrix();
          drops.setMatrixAt(i, dummy.matrix);
          continue;
        }
      }
      dropVel[i * 3 + 1] -= 6.5 * dt;
      dropPos[i * 3] += dropVel[i * 3] * dt;
      dropPos[i * 3 + 1] += dropVel[i * 3 + 1] * dt;
      dropPos[i * 3 + 2] += dropVel[i * 3 + 2] * dt;
      if (dropPos[i * 3 + 1] < 0.02 && dropVel[i * 3 + 1] < 0) dropAlive[i] = 0;
      dummy.position.set(dropPos[i * 3], dropPos[i * 3 + 1], dropPos[i * 3 + 2]);
      dummy.updateMatrix();
      drops.setMatrixAt(i, dummy.matrix);
    }
    drops.instanceMatrix.needsUpdate = true;

    // Detección: el tramo candidato late.
    anim.highlight += ((sim?.phase === 'detect' && sim.engine.level !== 'no_anomaly' ? 1 : 0) - anim.highlight) * Math.min(1, dt * 4);
    (leakPipe.highlight!.material as THREE.MeshBasicMaterial).opacity = anim.highlight * (0.35 + 0.2 * Math.sin(t * 4));
    leakPipe.highlight!.visible = anim.highlight > 0.01;

    // Reparación: válvula que gira, abrazadera que aparece, baliza que parpadea.
    anim.valveAngle += (anim.valveTarget - anim.valveAngle) * Math.min(1, dt * 1.6);
    valveWheels['N-TRON-04'].rotation.z = anim.valveAngle;
    anim.clamp += ((sim?.repaired ? 1 : 0) - anim.clamp) * Math.min(1, dt * 2.2);
    clamp.scale.setScalar(Math.max(0.001, anim.clamp));
    if (works.visible) (beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(t * 10) > 0 ? 1.6 : 0.2;

    // Sensores: el halo late según su estado.
    for (const s of sensors) {
      const speed = s.tone === 'critical' ? 5 : s.tone === 'attention' ? 3 : 1.5;
      const k = (Math.sin(t * speed) + 1) / 2;
      s.halo.scale.setScalar(1 + k * (s.tone === 'ok' ? 0.15 : 0.6));
      s.haloMat.opacity = 0.25 + (1 - k) * 0.45;
      s.ledMat.emissiveIntensity = s.tone === 'ok' ? 1.2 : 0.8 + k * 1.4;
    }

    for (const s of streaks) {
      s.position.z += dt * 1.2;
      if (s.position.z > BLOCK.d / 2 - 0.4) s.position.z = -BLOCK.d / 2 + 0.4;
    }

    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  {
    const start = fitted('overview');
    camera.position.copy(start.pos);
    controls.target.copy(start.target);
    controls.update();
  }
  frame();

  return {
    update(v) {
      view = v;
      applyView();
    },
    focus(phase) {
      goTo(PHASE_CAMERA[phase]);
    },
    resetView() {
      goTo('overview');
    },
    rotate(delta) {
      tween = null;
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), delta);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    },
    setXray(on) {
      topMat.opacity = on ? 0.6 : 1;
      topMat.transparent = on;
      topMat.depthWrite = !on;
      for (const m of soilMats) {
        m.opacity = on ? 0.3 : 0.97;
        m.depthWrite = !on;
      }
      topMat.needsUpdate = true;
      soilMats.forEach((m) => (m.needsUpdate = true));
    },
    setLabels(on) {
      labelsOn = on;
      for (const s of sensors) s.label.visible = on;
      applyView();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
        if (o instanceof CSS2DObject) o.element.remove();
      });
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    },
  };
}
