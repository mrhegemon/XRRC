'use strict';

import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.183.2/examples/jsm/loaders/GLTFLoader.js';

const THREE = window.THREE;
const Core = window.XRRCGameCore;
const Config = window.XRRCConfig;
const XRCore = window.XRRCXRCore;
const ControlsCore = window.XRRCControlsCore;
const I18n = window.XRRCI18n;
const ShareCore = window.XRRCShareCore;
const TrackCore = window.XRRCTrackCore;
const RaceCore = window.XRRCRaceCore;
const COURSE_SCALE = 2.15;
// A placed AR course has to stay room-sized no matter how large the circuits
// get on screen. courseRoot is scaled by COURSE_SCALE, so the XR root scales
// inversely to hold the physical footprint at roughly five metres across.
// Deriving it means growing the circuits can never quietly inflate the AR
// course past the space someone is standing in.
const XR_COURSE_SPAN = 0.568;
const XR_WORLD_SCALE = XR_COURSE_SPAN / COURSE_SCALE;
const MAX_FRAME_CATCHUP = 0.25;
const MAX_SIMULATION_STEP = 0.05;
const TRACK_BOUNDS = Object.freeze({
  x: 4.15 * COURSE_SCALE,
  z: 3.15 * COURSE_SCALE,
});
const BASE_START_GRID = Object.freeze({ x: 0.8, z: 2.25, heading: Math.PI / 2 });
const START_GRID = Object.freeze({
  x: BASE_START_GRID.x * COURSE_SCALE,
  z: BASE_START_GRID.z * COURSE_SCALE,
  heading: BASE_START_GRID.heading,
});
// Ramps and the vertical loop are derived per-circuit in _computeCourseFeatures
// so they land on the racing line instead of a separate infield strip.
const COURSE_SAMPLE_COUNT = 240;
const RACE_CHECKPOINTS = Object.freeze([0.22, 0.47, 0.72]);
const RACE_SAVE_KEY = 'xrrc-race-records-v1';
const AI_NAMES = Object.freeze(['BOLT', 'MICA', 'PIXEL', 'NOVA', 'KICK']);
const AI_COLORS = Object.freeze([0x457b9d, 0x2a9d8f, 0xe9c46a, 0xf4a261, 0xa8dadc]);
const QR_CODE_SOURCE = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';
const remoteCars = new Map();

// GLB car skins: visual reskins of the 'rally' physics profile, loaded on
// demand from public/assets/cars/. Each glb was authored nose-forward on
// +Z, but the game's forward direction at yaw 0 is -Z, so loaded models
// get a 180deg yaw correction (confirmed against wheel-node placement and
// isometric renders for every model in the set).
const GLB_SKINS = Object.freeze({
  'toy-car-1': { file: 'assets/cars/toy-car-1.glb' },
  'toy-car-2': { file: 'assets/cars/toy-car-2.glb' },
  'toy-car-3': { file: 'assets/cars/toy-car-3.glb' },
  'toy-car-taxi': { file: 'assets/cars/toy-car-taxi.glb' },
  'toy-car-cop': { file: 'assets/cars/toy-car-cop.glb' },
  car1: { file: 'assets/cars/car1.glb' },
  car2: { file: 'assets/cars/car2.glb' },
});
const GLB_SKIN_YAW_OFFSET = Math.PI;
const GLB_SKIN_LENGTH = 0.42; // matches the rally car's chassis depth (Z)
const gltfLoader = new GLTFLoader();
const glbModelCache = new Map(); // file -> Promise<THREE.Object3D>

function loadGLBModel(file) {
  if (!glbModelCache.has(file)) {
    const request = new Promise((resolve, reject) => {
        gltfLoader.load(file, (gltf) => resolve(gltf.scene), undefined, reject);
      })
      .catch((error) => {
        glbModelCache.delete(file);
        throw error;
      });
    glbModelCache.set(file, request);
  }
  return glbModelCache.get(file);
}

// Vehicle-bay selection can name a physics type (rally, buggy, ...) or a
// GLB skin id; GLB skins pass through untouched so Vehicle can load them,
// everything else is sanitized by the physics layer's normalizer.
function normalizeVehicleSelection(value) {
  return skinSpec(value) ? value : Core.normalizeVehicleType(value);
}

// -- Dream lab (Tripo AI generation) --------------------------------------
// A Tripo-enabled XRRC server can generate one custom vehicle skin and a set
// of map-themed props per player. The vehicle rides the same GLB-skin pipeline
// as the bundled toy cars; props are placed on fixed grass anchors when the
// game builds (or as soon as generation lands). The feature stays completely
// inert without a Tripo-enabled server, so the static Pages build is untouched.
const TripoCore = window.XRRCTripoCore;
const CUSTOM_VEHICLE_ID = 'dream-car';
const DREAM_VEHICLE_STORE = 'xrrc-dream-vehicle';
const DREAM_MAP_STORE = 'xrrc-dream-map';
// Prop anchors live in course-local space and are attached to courseRoot, so
// they scale and place with the circuit. Every spot sits in the outer grass
// ring - beyond the |x| <= 3.70 / |z| <= 2.70 envelope every track spline
// stays inside, but within the 8.8 x 6.8 ground plane - so props never clip
// the road whichever of the six courses is loaded.
const DREAM_PROP_ANCHORS = Object.freeze({
  landmark: { size: 1.0, spots: [[4.05, 0.2, -Math.PI / 3]] },
  decor: { size: 0.62, spots: [[-4.05, -1.3, Math.PI / 5], [-4.05, 1.3, -Math.PI / 8]] },
  marker: { size: 0.4, spots: [[2.1, -3.0, Math.PI / 7], [-2.1, -3.0, -Math.PI / 4]] },
});
let dreamApiBase = null; // origin of the Tripo-enabled server, null = unavailable
let customSkin = null; // { file, taskId, label, imageUrl } once a dream car exists
const dreamProps = new Map(); // role -> { role, taskId, status, file, imageUrl }

function skinSpec(type) {
  if (Object.hasOwn(GLB_SKINS, type)) return GLB_SKINS[type];
  if (type === CUSTOM_VEHICLE_ID && customSkin) return customSkin;
  return null;
}

function vehicleDisplayName(type) {
  if (type === CUSTOM_VEHICLE_ID && customSkin) return customSkin.label;
  return I18n.t(`vehicle.${type}`);
}

// The dream car joins the selectable list only once it has been generated.
function selectableVehicleTypes() {
  return customSkin ? [...VEHICLE_TYPES, CUSTOM_VEHICLE_ID] : VEHICLE_TYPES;
}

// Canonical selection order: the 7 procedural physics types, then the GLB
// skins - matches the lobby's vehicle bay markup and drives the in-race
// vehicle bay's slot order and each vehicle's fixed pit position.
const VEHICLE_TYPES = Object.freeze([...Object.keys(Core.VEHICLE_SPECS), ...Object.keys(GLB_SKINS)]);

// Every selectable vehicle gets a fixed home spot near the start grid so
// summoning/recalling never has to reason about what else is parked.
function pitStallPosition(type) {
  const types = selectableVehicleTypes();
  const index = types.indexOf(type);
  const cols = types.length;
  return {
    x: START_GRID.x + (index - (cols - 1) / 2) * 0.36,
    z: START_GRID.z + 0.9,
    heading: START_GRID.heading,
  };
}

// -- Box colliders -------------------------------------------------------
// Every vehicle gets its footprint measured directly from its built
// geometry (procedural body or loaded glb) rather than hand-tuned
// per-type constants, so collider size always matches what's rendered.
// Measured with the group's transform temporarily zeroed so a vehicle's
// current heading/position never skews the result.
function measureHalfExtents(group) {
  group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().makeEmpty();
  const inverseRoot = group.matrixWorld.clone().invert();
  const corner = new THREE.Vector3();
  group.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    if (!bounds) return;
    const localMatrix = inverseRoot.clone().multiply(object.matrixWorld);
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          corner.set(x, y, z).applyMatrix4(localMatrix);
          box.expandByPoint(corner);
        }
      }
    }
  });
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(0.1, 0.1, 0.1));
  const size = box.getSize(new THREE.Vector3());
  return {
    x: Math.max(size.x / 2, 0.05),
    z: Math.max(size.z / 2, 0.05),
    minY: box.min.y,
    maxY: box.max.y,
  };
}

function clampToBounds(position, bounds = TRACK_BOUNDS) {
  position.x = Core.clamp(position.x, -bounds.x, bounds.x);
  position.z = Core.clamp(position.z, -bounds.z, bounds.z);
}

function loadRaceSave() {
  try {
    return RaceCore.parseSave(window.localStorage.getItem(RACE_SAVE_KEY));
  } catch (error) {
    console.warn('[race] Personal records are unavailable:', error);
    return RaceCore.emptySave();
  }
}

function persistRaceSave(save) {
  try {
    window.localStorage.setItem(RACE_SAVE_KEY, JSON.stringify(save));
    return true;
  } catch (error) {
    console.warn('[race] Personal records could not be saved:', error);
    return false;
  }
}

function wrappedAngleDelta(target, current) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function vehicleOBB(car) {
  const p = car.group.position;
  return {
    x: p.x,
    z: p.z,
    theta: -car.group.rotation.y,
    hx: car.halfExtents.x,
    hz: car.halfExtents.z,
  };
}

// Separating-axis test for two rotated rectangles in the XZ plane. Returns
// null when they don't overlap, otherwise the minimum-penetration normal
// (pointing from a toward b) and the overlap distance along it.
function testOBBCollision(a, b) {
  const ua = [Math.cos(a.theta), Math.sin(a.theta)];
  const va = [-Math.sin(a.theta), Math.cos(a.theta)];
  const ub = [Math.cos(b.theta), Math.sin(b.theta)];
  const vb = [-Math.sin(b.theta), Math.cos(b.theta)];
  const dx = b.x - a.x;
  const dz = b.z - a.z;

  let minOverlap = Infinity;
  let normal = null;
  for (const axis of [ua, va, ub, vb]) {
    const dist = dx * axis[0] + dz * axis[1];
    const rA = a.hx * Math.abs(ua[0] * axis[0] + ua[1] * axis[1]) +
      a.hz * Math.abs(va[0] * axis[0] + va[1] * axis[1]);
    const rB = b.hx * Math.abs(ub[0] * axis[0] + ub[1] * axis[1]) +
      b.hz * Math.abs(vb[0] * axis[0] + vb[1] * axis[1]);
    const overlap = rA + rB - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      normal = dist < 0 ? [-axis[0], -axis[1]] : [axis[0], axis[1]];
    }
  }
  return { normal: { x: normal[0], z: normal[1] }, overlap: minOverlap };
}

// Adds a knockback impulse decoupled from the driving physics, capped so
// holding throttle into an obstacle can't make it grow without bound.
function addKnockback(car, nx, nz, speed) {
  car.knockback.x += nx * speed;
  car.knockback.z += nz * speed;
  const mag = Math.hypot(car.knockback.x, car.knockback.z);
  const maxKnockback = 2.2;
  if (mag > maxKnockback) {
    car.knockback.x = (car.knockback.x / mag) * maxKnockback;
    car.knockback.z = (car.knockback.z / mag) * maxKnockback;
  }
}

function prefersQuestQuality() {
  const requestedQuality = new URLSearchParams(window.location.search).get('quality');
  return (
    requestedQuality === 'quest' ||
    /OculusBrowser|Meta Quest/i.test(window.navigator.userAgent)
  );
}

let game = null;
let networkManager = null;
let toastTimer = null;
let shareCopyTimer = null;
let shareQrRequest = 0;
// 8th Wall's hosted platform retired on 2026-02-28; the engine is now
// distributed as a proprietary binary on npm. Versions are pinned exactly
// rather than floated on a major range, because a silent bump to a closed
// binary would break camera AR in production with nothing in the repo changing.
const EIGHTH_WALL_VERSION = '1.0.0';
const EIGHTH_WALL_SCRIPTS = Object.freeze([
  {
    url: `https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@${EIGHTH_WALL_VERSION}/dist/xr.js`,
    attributes: { async: '', crossorigin: 'anonymous', 'data-preload-chunks': 'slam' },
  },
  {
    url: `https://cdn.jsdelivr.net/npm/@8thwall/xrextras@${EIGHTH_WALL_VERSION}/dist/xrextras.js`,
    attributes: { crossorigin: 'anonymous' },
  },
  {
    url: `https://cdn.jsdelivr.net/npm/@8thwall/landing-page@${EIGHTH_WALL_VERSION}/dist/landing-page.js`,
    attributes: { crossorigin: 'anonymous' },
  },
]);
const EIGHTH_WALL_START_TIMEOUT_MS = 45000;
let eighthWallConfigured = false;
let notifyEighthWallStarted = null;
let qrCodeModulePromise = null;
let webXRSupportChecked = false;
let webXRSupported = false;
const audioManager = new window.XRRCAudioManager();

class ParticleField {
  constructor(parent, count = 180) {
    this.count = count;
    this.cursor = 0;
    this.enabled = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.sizes = new Float32Array(count);
    this.velocities = Array.from({ length: count }, () => new THREE.Vector3());

    for (let index = 0; index < count; index += 1) {
      this.positions[index * 3 + 1] = -100;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aLife;
        attribute float aSize;
        varying vec3 vColor;
        varying float vLife;

        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = aSize * clamp(1.7 / max(0.35, -viewPosition.z), 0.55, 2.25);
          vColor = aColor;
          vLife = aLife;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vLife;

        void main() {
          float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
          float softCircle = 1.0 - smoothstep(0.18, 0.5, distanceToCenter);
          gl_FragColor = vec4(vColor, softCircle * smoothstep(0.0, 0.35, vLife) * 0.82);
        }
      `,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    parent.add(this.points);
  }

  spawn(position, velocity, color, size = 12, duration = 0.7) {
    if (!this.enabled) return;
    const index = this.cursor;
    const offset = index * 3;
    const particleColor = color instanceof THREE.Color ? color : new THREE.Color(color);
    this.positions[offset] = position.x;
    this.positions[offset + 1] = position.y;
    this.positions[offset + 2] = position.z;
    this.colors[offset] = particleColor.r;
    this.colors[offset + 1] = particleColor.g;
    this.colors[offset + 2] = particleColor.b;
    this.life[index] = 1;
    this.maxLife[index] = duration;
    this.sizes[index] = size;
    this.velocities[index].copy(velocity);
    this.cursor = (index + 1) % this.count;
  }

  burst(position, colors, amount = 12, force = 0.45) {
    for (let index = 0; index < amount; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = new THREE.Vector3(
        Math.cos(angle) * force * (0.4 + Math.random()),
        0.12 + Math.random() * force,
        Math.sin(angle) * force * (0.4 + Math.random())
      );
      this.spawn(
        position,
        velocity,
        colors[index % colors.length],
        8 + Math.random() * 8,
        0.35 + Math.random() * 0.5
      );
    }
  }

  update(delta) {
    if (!this.enabled) return;
    let changed = false;
    for (let index = 0; index < this.count; index += 1) {
      if (this.life[index] <= 0) continue;
      const offset = index * 3;
      const duration = this.maxLife[index] || 1;
      this.life[index] = Math.max(0, this.life[index] - delta / duration);
      if (this.life[index] === 0) {
        this.positions[offset + 1] = -100;
      } else {
        const velocity = this.velocities[index];
        velocity.y += 0.12 * delta;
        velocity.multiplyScalar(Math.exp(-1.1 * delta));
        this.positions[offset] += velocity.x * delta;
        this.positions[offset + 1] += velocity.y * delta;
        this.positions[offset + 2] += velocity.z * delta;
      }
      changed = true;
    }
    if (!changed) return;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aLife.needsUpdate = true;
  }
}

function createNameplate(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 48;
  const context = canvas.getContext('2d');
  context.fillStyle = '#24251f';
  context.fillRect(0, 4, canvas.width, 40);
  context.fillStyle = color;
  context.fillRect(0, 4, 10, 40);
  context.fillStyle = '#f4ead2';
  context.font = '900 25px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 102, 25);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    depthTest: false,
    map: texture,
    transparent: true,
  }));
  sprite.position.y = 0.36;
  sprite.scale.set(0.58, 0.145, 1);
  sprite.renderOrder = 8;
  return sprite;
}

const raceAvatarGeometry = (() => {
  const parts = [
    [0.25, 0.075, 0.42, 0, 0.065, 0, [1, 1, 1]],
    [0.19, 0.075, 0.2, 0, 0.135, -0.035, [0.32, 0.34, 0.31]],
    [0.28, 0.035, 0.055, 0, 0.055, -0.2, [0.15, 0.16, 0.14]],
    [0.052, 0.07, 0.105, -0.135, 0.045, -0.13, [0.07, 0.075, 0.065]],
    [0.052, 0.07, 0.105, 0.135, 0.045, -0.13, [0.07, 0.075, 0.065]],
    [0.052, 0.07, 0.105, -0.135, 0.045, 0.13, [0.07, 0.075, 0.065]],
    [0.052, 0.07, 0.105, 0.135, 0.045, 0.13, [0.07, 0.075, 0.065]],
  ];
  const positions = [];
  const normals = [];
  const colors = [];
  for (const [width, height, depth, x, y, z, color] of parts) {
    const part = new THREE.BoxGeometry(width, height, depth)
      .translate(x, y, z)
      .toNonIndexed();
    positions.push(...part.getAttribute('position').array);
    normals.push(...part.getAttribute('normal').array);
    const vertexCount = part.getAttribute('position').count;
    for (let index = 0; index < vertexCount; index += 1) colors.push(...color);
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
})();

class RaceAvatar {
  constructor(name, color, ghost = false) {
    this.group = new THREE.Group();
    this.velocity = 0;
    this.knockback = { x: 0, z: 0 };
    this.offset = { x: 0, z: 0 };
    this.halfExtents = { x: 0.12, z: 0.21, minY: -0.06, maxY: 0.08 };
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: ghost ? color : 0x000000,
      emissiveIntensity: ghost ? 0.28 : 0,
      metalness: ghost ? 0.05 : 0.22,
      opacity: ghost ? 0.32 : 1,
      roughness: 0.42,
      transparent: ghost,
      depthWrite: !ghost,
      vertexColors: true,
    });
    this.body = new THREE.Mesh(raceAvatarGeometry, material);
    this.body.castShadow = !ghost;
    this.body.receiveShadow = !ghost;
    this.group.add(this.body);
    if (name) {
      this.nameplate = createNameplate(name, `#${new THREE.Color(color).getHexString()}`);
      this.group.add(this.nameplate);
    }
  }

  setPose(position, heading) {
    this.offset.x *= 0.985;
    this.offset.z *= 0.985;
    this.group.position.set(
      position.x + this.offset.x,
      position.y,
      position.z + this.offset.z
    );
    this.group.rotation.y = heading;
  }

  applyKnockback(delta) {
    this.offset.x += this.knockback.x * delta;
    this.offset.z += this.knockback.z * delta;
    const damping = Math.max(0, 1 - 6 * delta);
    this.knockback.x *= damping;
    this.knockback.z *= damping;
  }

  dispose() {
    this.body.material.dispose();
    if (this.nameplate) {
      this.nameplate.material.map.dispose();
      this.nameplate.material.dispose();
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

class SkidMarkField {
  constructor(parent, count = 48) {
    this.parent = parent;
    this.attached = false;
    this.cursor = 0;
    this.marks = Array.from({ length: count }, () => ({
      age: Infinity,
      position: new THREE.Vector3(0, -100, 0),
      rotation: new THREE.Quaternion(),
    }));
    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.038, 0.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x24251f,
        depthWrite: false,
        opacity: 0.34,
        transparent: true,
      }),
      count
    );
    this.mesh.frustumCulled = false;
    this._matrix = new THREE.Matrix4();
    this._scale = new THREE.Vector3();
    this.update(0);
  }

  add(car) {
    if (!this.attached) {
      this.parent.add(this.mesh);
      this.attached = true;
    }
    for (const side of [-1, 1]) {
      const mark = this.marks[this.cursor];
      mark.age = 0;
      mark.position.copy(car.pointFromLocal(side * 0.075, 0.006, 0.17));
      mark.rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), car.group.rotation.y);
      this.cursor = (this.cursor + 1) % this.marks.length;
    }
  }

  update(delta) {
    this.marks.forEach((mark, index) => {
      mark.age += delta;
      const life = Math.max(0, 1 - mark.age / 4.2);
      this._scale.set(life > 0 ? 0.75 + life * 0.25 : 0, 1, life > 0 ? 1 : 0);
      this._matrix.compose(mark.position, mark.rotation, this._scale);
      this.mesh.setMatrixAt(index, this._matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.marks.forEach((mark) => {
      mark.age = Infinity;
      mark.position.y = -100;
    });
    this.update(0);
    if (this.attached) this.parent.remove(this.mesh);
    this.attached = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}

class Vehicle {
  constructor(color, isLocal, type = 'rally') {
    this.group = new THREE.Group();
    this.visual = new THREE.Group();
    this.group.add(this.visual);
    this.color = color;
    this.isLocal = isLocal;
    this.velocity = 0;
    this.verticalVelocity = 0;
    this.throttle = 0;
    this.steering = 0;
    this.lift = 0;
    this.broadcastTimer = 0;
    this.sequence = 0;
    this.active = !isLocal;
    this.wheels = [];
    this.frontWheelPivots = [];
    this.rotors = [];
    this.airborne = false;
    this.rampContact = false;
    this.loopState = null;
    this.loopPitch = 0;
    this.loopCooldown = 0;
    this.surface = 'road';
    this.hoverTime = Math.random() * Math.PI * 2;
    this.lastRemoteSequence = -1;
    this.remoteTarget = null;
    this.remoteReceivedAt = 0;
    this.skinOverride = null; // remote peers' dream-car skins resolve per-instance
    this.networkRaceState = null;
    this.raceState = null;
    this.lastRaceVersion = null;
    this._bodyTilt = 0;
    this.knockback = { x: 0, z: 0 };
    this.disposed = false;
    this.modelSource = 'procedural';
    this.modelStatus = 'building';
    this.modelReady = Promise.resolve();
    this.setType(type);
    this.reset(
      isLocal ? START_GRID.x : START_GRID.x + 0.42,
      START_GRID.z,
      START_GRID.heading
    );

    if (isLocal) {
      this._inputHandler = (event) => {
        this.lift = event.detail.lift || 0;
        this.throttle = event.detail.throttle;
        this.steering = event.detail.steering;
      };
      document.addEventListener('car-input', this._inputHandler);
    }
  }

  _material(color, options = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.45,
      metalness: options.metalness ?? 0.22,
      emissive: options.emissive ?? 0x000000,
      emissiveIntensity: options.emissiveIntensity ?? 0,
    });
  }

  _box(width, height, depth, material, x = 0, y = 0, z = 0, parent = this.visual) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      material
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  _cylinder(radiusTop, radiusBottom, height, material, x, y, z, rotation = null) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 18),
      material
    );
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.set(rotation.x, rotation.y, rotation.z);
    mesh.castShadow = true;
    this.visual.add(mesh);
    return mesh;
  }

  _sphere(radius, material, x, y, z, scale = null) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 18, 12),
      material
    );
    mesh.position.set(x, y, z);
    if (scale) mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.castShadow = true;
    this.visual.add(mesh);
    return mesh;
  }

  _wheel(x, z, radius, width, material, isFront = false, y = radius) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    this.visual.add(pivot);
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, width, 18),
      material
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    pivot.add(wheel);
    this.wheels.push(wheel);
    if (isFront) this.frontWheelPivots.push(pivot);
    return wheel;
  }

  _antenna(dark, accent, x, z, height = 0.24) {
    const antenna = this._cylinder(
      0.004,
      0.004,
      height,
      dark,
      x,
      0.18 + height / 2,
      z,
      new THREE.Euler(0, 0, -0.08)
    );
    const tip = this._sphere(0.012, accent, x + 0.01, 0.18 + height, z);
    antenna.castShadow = false;
    tip.castShadow = false;
  }

  _clearVisual() {
    const geometries = new Set();
    const materials = new Set();
    this.visual.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) {
        const objectMaterials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of objectMaterials) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.visual.clear();
    this.wheels = [];
    this.frontWheelPivots = [];
    this.rotors = [];
  }

  setType(type) {
    // A remote peer's dream car carries its own resolved skin; everything else
    // resolves through the shared skin registry / physics normalizer.
    const hasOverride = Boolean(this.skinOverride) && type === CUSTOM_VEHICLE_ID;
    const nextType = hasOverride ? CUSTOM_VEHICLE_ID : normalizeVehicleSelection(type);
    if (this.type === nextType && this.visual.children.length > 0) return;

    this._clearVisual();
    this.type = nextType;
    this.spec = Core.getVehicleSpec(nextType);
    this.group.position.y = this.spec.rideHeight;

    const skin = hasOverride ? this.skinOverride : skinSpec(nextType);
    this.visual.scale.setScalar(skin ? 1 : this.spec.visualScale || 1);
    if (skin) {
      // Procedural placeholder so the car is visible immediately; swapped
      // for the real model once the glb finishes loading.
      this._buildRally();
      this.halfExtents = measureHalfExtents(this.group);
      this.modelSource = 'procedural-fallback';
      this.modelStatus = 'loading';
      this.modelReady = this._loadGLBSkin(nextType, skin);
      return;
    }

    const builders = {
      rally: () => this._buildRally(),
      buggy: () => this._buildBuggy(),
      truck: () => this._buildTruck(),
      motorcycle: () => this._buildMotorcycle(),
      tank: () => this._buildTank(),
      plane: () => this._buildPlane(),
      helicopter: () => this._buildHelicopter(),
    };
    builders[nextType]();
    this.halfExtents = measureHalfExtents(this.group);
    this.modelSource = 'procedural';
    this.modelStatus = 'ready';
    this.modelReady = Promise.resolve();
  }

  async _loadGLBSkin(type, skin) {
    try {
      const source = await loadGLBModel(skin.file);
      if (this.disposed || this.type !== type) return;

      const model = source.clone(true);
      model.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry = node.geometry.clone();
        node.material = Array.isArray(node.material)
          ? node.material.map((material) => material.clone())
          : node.material.clone();
        node.castShadow = true;
        node.receiveShadow = true;
        if (/wheel/i.test(node.name)) this.wheels.push(node);
      });

      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -box.min.y, -center.z);

      const scale = size.z > 0 ? GLB_SKIN_LENGTH / size.z : 1;
      const pivot = new THREE.Group();
      pivot.rotation.y = GLB_SKIN_YAW_OFFSET;
      pivot.scale.setScalar(scale);
      pivot.add(model);

      this._clearVisual();
      this.visual.add(pivot);
      this.halfExtents = measureHalfExtents(this.group);
      this.modelSource = 'glb';
      this.modelStatus = 'ready';
    } catch (err) {
      if (this.disposed || this.type !== type) return;
      this.modelStatus = 'fallback';
      console.error(`[vehicle] failed to load ${skin.file}, keeping fallback body`, err);
    }
  }

  _palette() {
    const body = this._material(this.color, { roughness: 0.34, metalness: 0.38 });
    const dark = this._material(0x24251f, { roughness: 0.72, metalness: 0.1 });
    const windowMaterial = this._material(0x91b8bd, {
      roughness: 0.18,
      metalness: 0.48,
    });
    const yellow = this._material(0xf1c644, { roughness: 0.5 });
    const headlight = this._material(0xfff1aa, {
      emissive: 0xffd75c,
      emissiveIntensity: 1.4,
    });
    const taillight = this._material(0xc83224, {
      emissive: 0x6f0804,
      emissiveIntensity: 1.1,
    });
    return { body, dark, windowMaterial, yellow, headlight, taillight };
  }

  _buildRally() {
    const { body, dark, windowMaterial, yellow, headlight, taillight } = this._palette();
    this._box(0.25, 0.065, 0.42, body, 0, 0.075, 0);
    this._box(0.21, 0.055, 0.15, body, 0, 0.125, -0.075);
    this._box(0.18, 0.053, 0.125, windowMaterial, 0, 0.172, 0.015);
    this._box(0.205, 0.018, 0.04, yellow, 0, 0.112, -0.16);
    this._box(0.17, 0.028, 0.018, dark, 0, 0.155, 0.197);
    this._box(0.25, 0.026, 0.026, dark, 0, 0.105, 0.214);
    this._box(0.25, 0.026, 0.026, dark, 0, 0.08, -0.222);
    this._box(0.07, 0.025, 0.012, headlight, -0.07, 0.105, -0.218);
    this._box(0.07, 0.025, 0.012, headlight, 0.07, 0.105, -0.218);
    this._box(0.065, 0.023, 0.012, taillight, -0.07, 0.105, 0.218);
    this._box(0.065, 0.023, 0.012, taillight, 0.07, 0.105, 0.218);
    this._antenna(dark, yellow, 0.075, 0.105);

    for (const [x, z, isFront] of [
      [-0.14, -0.135, true],
      [0.14, -0.135, true],
      [-0.14, 0.14, false],
      [0.14, 0.14, false],
    ]) {
      this._wheel(x, z, 0.055, 0.052, dark, isFront, 0.065);
    }
  }

  _buildBuggy() {
    const { body, dark, yellow, headlight } = this._palette();
    this._box(0.23, 0.045, 0.36, body, 0, 0.08, 0.01);
    this._box(0.18, 0.025, 0.17, yellow, 0, 0.115, -0.035);
    this._box(0.19, 0.018, 0.025, dark, 0, 0.2, 0.105);
    this._box(0.018, 0.18, 0.018, dark, -0.08, 0.15, 0.06);
    this._box(0.018, 0.18, 0.018, dark, 0.08, 0.15, 0.06);
    this._box(0.16, 0.018, 0.018, dark, 0, 0.235, 0.02);
    this._box(0.055, 0.023, 0.012, headlight, -0.06, 0.095, -0.19);
    this._box(0.055, 0.023, 0.012, headlight, 0.06, 0.095, -0.19);
    this._antenna(dark, yellow, 0.07, 0.11, 0.2);
    for (const [x, z, isFront] of [
      [-0.15, -0.13, true],
      [0.15, -0.13, true],
      [-0.15, 0.13, false],
      [0.15, 0.13, false],
    ]) {
      this._wheel(x, z, 0.065, 0.06, dark, isFront, 0.07);
    }
  }

  _buildTruck() {
    const { body, dark, windowMaterial, yellow, headlight, taillight } = this._palette();
    this._box(0.29, 0.075, 0.48, body, 0, 0.09, 0);
    this._box(0.245, 0.11, 0.19, body, 0, 0.165, -0.105);
    this._box(0.205, 0.067, 0.135, windowMaterial, 0, 0.205, -0.12);
    this._box(0.235, 0.065, 0.2, dark, 0, 0.14, 0.12);
    this._box(0.25, 0.025, 0.025, yellow, 0, 0.235, -0.12);
    this._box(0.32, 0.035, 0.035, dark, 0, 0.085, -0.255);
    this._box(0.32, 0.035, 0.035, dark, 0, 0.085, 0.255);
    this._box(0.07, 0.027, 0.012, headlight, -0.08, 0.13, -0.245);
    this._box(0.07, 0.027, 0.012, headlight, 0.08, 0.13, -0.245);
    this._box(0.06, 0.024, 0.012, taillight, -0.085, 0.13, 0.245);
    this._box(0.06, 0.024, 0.012, taillight, 0.085, 0.13, 0.245);
    this._antenna(dark, yellow, 0.1, 0.17, 0.28);
    for (const [x, z, isFront] of [
      [-0.165, -0.155, true],
      [0.165, -0.155, true],
      [-0.165, 0.165, false],
      [0.165, 0.165, false],
    ]) {
      this._wheel(x, z, 0.07, 0.06, dark, isFront, 0.075);
    }
  }

  _buildMotorcycle() {
    const { body, dark, yellow, headlight, taillight } = this._palette();
    this._box(0.045, 0.045, 0.31, dark, 0, 0.105, 0);
    this._sphere(
      0.08,
      body,
      0,
      0.17,
      -0.035,
      new THREE.Vector3(0.72, 0.75, 1.15)
    );
    this._box(0.07, 0.035, 0.11, dark, 0, 0.16, 0.095);
    this._box(0.21, 0.014, 0.018, yellow, 0, 0.235, -0.115);
    this._box(0.025, 0.18, 0.025, dark, 0, 0.17, -0.115);
    this._sphere(0.025, headlight, 0, 0.205, -0.175);
    this._sphere(0.02, taillight, 0, 0.17, 0.17);
    this._wheel(0, -0.155, 0.078, 0.027, dark, true, 0.08);
    this._wheel(0, 0.155, 0.078, 0.027, dark, false, 0.08);
    this._antenna(dark, yellow, 0.025, 0.1, 0.2);
  }

  _buildTank() {
    const { body, dark, yellow } = this._palette();
    this._box(0.31, 0.085, 0.42, body, 0, 0.095, 0);
    this._box(0.085, 0.095, 0.44, dark, -0.15, 0.075, 0);
    this._box(0.085, 0.095, 0.44, dark, 0.15, 0.075, 0);
    this._cylinder(0.105, 0.12, 0.08, body, 0, 0.19, -0.03);
    this._sphere(
      0.105,
      body,
      0,
      0.225,
      -0.03,
      new THREE.Vector3(1, 0.55, 1)
    );
    this._cylinder(
      0.022,
      0.028,
      0.31,
      dark,
      0,
      0.225,
      -0.22,
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    this._box(0.07, 0.018, 0.025, yellow, 0, 0.27, -0.03);
    this._antenna(dark, yellow, 0.07, 0.06, 0.26);
    for (const x of [-0.15, 0.15]) {
      for (const z of [-0.13, 0, 0.13]) {
        this._wheel(x, z, 0.045, 0.09, dark, false, 0.07);
      }
    }
  }

  _buildPlane() {
    const { body, dark, windowMaterial, yellow } = this._palette();
    this._cylinder(
      0.04,
      0.07,
      0.54,
      body,
      0,
      0.03,
      0,
      new THREE.Euler(Math.PI / 2, 0, 0)
    );
    this._sphere(
      0.085,
      windowMaterial,
      0,
      0.08,
      -0.09,
      new THREE.Vector3(0.8, 0.58, 1.05)
    );
    this._box(0.62, 0.028, 0.13, body, 0, 0.04, -0.01);
    this._box(0.3, 0.022, 0.085, yellow, 0, 0.055, 0.2);
    this._box(0.035, 0.18, 0.1, body, 0, 0.12, 0.21);
    const propeller = new THREE.Group();
    propeller.position.set(0, 0.03, -0.3);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.018, 0.018),
      dark
    );
    blade.castShadow = true;
    propeller.add(blade);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), yellow);
    propeller.add(hub);
    this.visual.add(propeller);
    this.rotors.push({ object: propeller, axis: 'z', speed: 25 });
    this._wheel(-0.095, -0.06, 0.035, 0.025, dark, false, -0.01);
    this._wheel(0.095, -0.06, 0.035, 0.025, dark, false, -0.01);
    this._wheel(0, 0.21, 0.025, 0.018, dark, false, 0);
  }

  _buildHelicopter() {
    const { body, dark, windowMaterial, yellow } = this._palette();
    this._sphere(
      0.13,
      body,
      0,
      0.05,
      -0.08,
      new THREE.Vector3(0.95, 0.85, 1.2)
    );
    this._sphere(
      0.105,
      windowMaterial,
      0,
      0.07,
      -0.15,
      new THREE.Vector3(0.82, 0.7, 0.72)
    );
    this._box(0.065, 0.06, 0.42, body, 0, 0.07, 0.16);
    this._box(0.21, 0.025, 0.08, yellow, 0, 0.09, 0.36);
    this._box(0.025, 0.2, 0.07, body, 0, 0.15, 0.34);
    this._box(0.018, 0.11, 0.38, dark, -0.11, -0.07, -0.01);
    this._box(0.018, 0.11, 0.38, dark, 0.11, -0.07, -0.01);
    this._box(0.25, 0.018, 0.018, dark, 0, -0.02, -0.15);
    this._box(0.25, 0.018, 0.018, dark, 0, -0.02, 0.15);
    this._cylinder(0.012, 0.012, 0.18, dark, 0, 0.22, -0.03);

    const mainRotor = new THREE.Group();
    mainRotor.position.set(0, 0.32, -0.03);
    mainRotor.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.012, 0.035),
      dark
    ));
    mainRotor.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 0.012, 0.68),
      dark
    ));
    this.visual.add(mainRotor);
    this.rotors.push({ object: mainRotor, axis: 'y', speed: 19 });

    const tailRotor = new THREE.Group();
    tailRotor.position.set(0.04, 0.14, 0.4);
    tailRotor.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.26, 0.025),
      dark
    ));
    tailRotor.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.025, 0.26),
      dark
    ));
    this.visual.add(tailRotor);
    this.rotors.push({ object: tailRotor, axis: 'x', speed: 28 });
    this._antenna(dark, yellow, 0.08, 0.04, 0.2);
  }

  reset(
    x = START_GRID.x,
    z = START_GRID.z,
    heading = START_GRID.heading,
    y = this.spec.rideHeight
  ) {
    this.group.position.set(x, y, z);
    this.peakY = y;
    this.group.rotation.set(0, heading, 0);
    this.visual.position.y = 0;
    this.visual.rotation.set(0, 0, 0);
    this.velocity = 0;
    this.verticalVelocity = 0;
    this.throttle = 0;
    this.steering = 0;
    this.lift = 0;
    this.airborne = y > (this.spec.groundHeight ?? this.spec.rideHeight) + 0.01;
    this.rampContact = false;
    this.loopState = null;
    this.loopPitch = 0;
    this.loopCooldown = 0;
    this.surface = 'road';
    this.knockback.x = 0;
    this.knockback.z = 0;
    this.remoteTarget = null;
  }

  // Collision knockback: a residual world-space velocity decoupled from
  // the driving model, so both the controlled vehicle and whatever it
  // hits can be shoved off their line of travel and settle back down.
  applyKnockback(delta) {
    const k = this.knockback;
    if (Math.abs(k.x) < 0.001 && Math.abs(k.z) < 0.001) {
      k.x = 0;
      k.z = 0;
      return;
    }
    this.group.position.x += k.x * delta;
    this.group.position.z += k.z * delta;
    const damping = Math.max(0, 1 - 6 * delta);
    k.x *= damping;
    k.z *= damping;
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.lift = 0;
      this.throttle = 0;
      this.steering = 0;
    }
  }

  update(delta, context = {}) {
    if (!this.isLocal) {
      return this._updateRemote(delta);
    }

    const input = this.active
      ? { lift: this.lift, throttle: this.throttle, steering: this.steering }
      : { lift: 0, throttle: 0, steering: 0 };
    this.loopCooldown = Math.max(0, this.loopCooldown - delta);
    const drivingSurface = this.spec.category === 'air' && this.airborne
      ? 'road'
      : context.surface?.type;
    this.drivingSurface = drivingSurface || 'road';
    const physics = Core.getDrivingPhysics(this.spec.physics, {
      airborne: this.spec.category === 'ground' && this.airborne,
      surface: drivingSurface,
    });
    if (context.boost) {
      physics.acceleration *= 1.4;
      physics.maxForwardSpeed *= 1.26;
      physics.poweredDrag *= 0.55;
    }
    const next = Core.stepCar({
      x: this.group.position.x,
      z: this.group.position.z,
      heading: this.group.rotation.y,
      velocity: this.velocity,
    }, input, delta, {
      ...physics,
      bounds: {
        x: TRACK_BOUNDS.x - this.halfExtents.x,
        z: TRACK_BOUNDS.z - this.halfExtents.z,
      },
    });
    const isOnRamp = Boolean(context.rampLaunchSpeed);
    const launchSpeed = isOnRamp && !this.rampContact
      ? context.rampLaunchSpeed
      : 0;
    this.rampContact = isOnRamp;
    const flight = this.spec.flight;
    const vertical = Core.stepVertical({
      y: this.group.position.y,
      velocityY: this.verticalVelocity,
    }, input, delta, flight
      ? {
          ...flight,
          forwardSpeed: next.velocity,
          groundY: this.spec.groundHeight,
        }
      : {
          gravity: 7.2,
          groundY: this.spec.rideHeight,
          launchSpeed,
          mode: 'ground',
        });
    if (!this.loopState && context.loopTrigger) {
      const direction = Math.sign(
        -Math.sin(this.group.rotation.y) * (Math.sign(this.velocity) || 1)
      ) || 1;
      this.loopState = {
        direction,
        progress: 0,
        speed: Math.max(1.15, Math.abs(this.velocity)),
      };
    }
    let loop = null;
    if (this.loopState && context.loop) {
      loop = Core.stepLoop(this.loopState, delta, {
        ...context.loop,
        direction: this.loopState.direction,
        groundY: this.spec.rideHeight,
        speed: this.loopState.speed,
      });
      this.loopState.progress = loop.progress;
      next.x = loop.x;
      next.z = loop.z;
      vertical.y = loop.y;
      vertical.velocityY = loop.velocityY;
      vertical.airborne = loop.airborne;
      vertical.grounded = loop.complete;
      this.loopPitch = loop.pitch;
      if (loop.complete) {
        next.x += this.loopState.direction * Math.abs(next.velocity) * delta;
        this.loopState = null;
        this.loopCooldown = 0.8;
      }
    }

    this.velocity = next.velocity;
    this.verticalVelocity = vertical.velocityY;
    this.airborne = vertical.airborne;
    this.surface = context.surface?.type || 'offroad';
    this.group.position.x = next.x;
    this.group.position.y = vertical.y;
    this.group.position.z = next.z;
    this.peakY = Math.max(this.peakY, vertical.y);
    this.group.rotation.y = next.heading;
    this.applyKnockback(delta);
    clampToBounds(this.group.position);
    this._applyVisualMotion(delta, next.speedRatio, vertical);
    for (const pivot of this.frontWheelPivots) {
      pivot.rotation.y += ((this.steering * 0.42) - pivot.rotation.y) * 0.2;
    }

    this.broadcastTimer += delta;
    if (this.active && this.broadcastTimer >= 0.05 && networkManager) {
      this.broadcastTimer = 0;
      networkManager.broadcastState({
        type: this.type,
        seq: this.sequence,
        x: this.group.position.x,
        y: this.group.position.y,
        z: this.group.position.z,
        ry: this.group.rotation.y,
        v: this.velocity,
        vy: this.verticalVelocity,
        lift: this.lift,
        throttle: this.throttle,
        steering: this.steering,
        // Peers resolve this task id against their own Tripo-enabled server.
        ...(this.type === CUSTOM_VEHICLE_ID && customSkin
          ? { skinTask: customSkin.taskId }
          : null),
        race: this.networkRaceState,
      });
      this.sequence += 1;
    }

    return {
      ...next,
      ...vertical,
      lift: this.lift,
      looping: Boolean(this.loopState),
      surface: this.surface,
      throttle: this.throttle,
      steering: this.steering,
    };
  }

  _applyVisualMotion(delta, speedRatio, vertical = null) {
    this.hoverTime += delta;
    const tiltScale = this.type === 'motorcycle'
      ? 0.27
      : this.spec.category === 'air'
        ? 0.18
        : 0.1;
    this._bodyTilt += ((-this.steering * speedRatio * tiltScale) - this._bodyTilt) * 0.13;
    this.visual.rotation.z = this._bodyTilt;
    const targetPitch = this.loopState
      ? this.loopPitch
      : this.spec.category === 'air'
      ? Core.clamp((-this.lift * 0.16) + (this.verticalVelocity * 0.055), -0.24, 0.24)
      : vertical?.landed
        ? -0.08
        : 0;
    if (this.loopState) this.visual.rotation.x = targetPitch;
    else this.visual.rotation.x += (targetPitch - this.visual.rotation.x) * 0.14;
    const hover = this.spec.category === 'air'
      ? Math.sin(this.hoverTime * (this.type === 'helicopter' ? 4.2 : 2.4)) * 0.012
      : 0;
    this.visual.position.y += (hover - this.visual.position.y) * 0.2;

    for (const wheel of this.wheels) {
      wheel.rotation.x += this.velocity * delta * 22;
    }
    for (const rotor of this.rotors) {
      const rotorSpeed = rotor.speed * (0.55 + Math.abs(this.throttle) * 0.45);
      rotor.object.rotation[rotor.axis] += rotorSpeed * delta;
    }
  }

  pointFromLocal(x, y, z) {
    return new THREE.Vector3(x, y, z)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.group.rotation.y)
      .add(this.group.position);
  }

  applyRemoteState(state) {
    if (!Core.shouldAcceptNetworkState(this.lastRemoteSequence, state)) return false;
    this.lastRemoteSequence = state.seq;
    // A peer's dream car announces its skin task id; resolve it against this
    // client's own Tripo-enabled server (if any) and force a rebuild with the
    // announced skin. Peers without a Tripo backend keep the rally fallback.
    if (
      state.type === CUSTOM_VEHICLE_ID &&
      dreamApiBase &&
      TripoCore &&
      TripoCore.isTaskId(state.skinTask)
    ) {
      const file = `${dreamApiBase}/api/tripo/model/${state.skinTask}`;
      if (!this.skinOverride || this.skinOverride.file !== file) {
        this.skinOverride = { file };
        this.type = null; // force a rebuild with the newly announced skin
      }
    }
    this.setType(state.type);
    this.remoteTarget = {
      ...state,
      type: this.type,
      lift: Number.isFinite(state.lift) ? state.lift : 0,
      throttle: Number.isFinite(state.throttle) ? state.throttle : 0,
      steering: Number.isFinite(state.steering) ? state.steering : 0,
    };
    if (state.race && typeof state.race === 'object') this.applyRaceState(state.race);
    this.remoteReceivedAt = performance.now();
    return true;
  }

  applyRaceState(race) {
    if (
      !race ||
      !Number.isFinite(race.completedLaps) ||
      !Number.isFinite(race.progress)
    ) {
      return false;
    }
    if (!RaceCore.shouldAcceptRaceState(this.lastRaceVersion, race)) return false;
    const attempt = Number.isFinite(race.attempt) ? Math.max(0, Math.floor(race.attempt)) : 0;
    const revision = Number.isFinite(race.revision) ? Math.max(0, Math.floor(race.revision)) : 0;
    this.lastRaceVersion = { attempt, revision };
    this.raceState = {
      attempt,
      completedLaps: Core.clamp(Math.floor(race.completedLaps), 0, 9),
      elapsedMs: Number.isFinite(race.elapsedMs) ? Math.max(0, race.elapsedMs) : 0,
      finishTime: Number.isFinite(race.finishTime) ? race.finishTime : null,
      finished: Boolean(race.finished),
      lap: Core.clamp(Math.floor(race.lap || 1), 1, 9),
      lapTimes: Array.isArray(race.lapTimes)
        ? race.lapTimes.filter((time) => Number.isFinite(time) && time > 0).slice(0, 9)
        : [],
      nextCheckpoint: Core.clamp(Math.floor(race.nextCheckpoint || 0), 0, 3),
      progress: Core.clamp(race.progress, 0, 0.999999),
      revision,
      totalLaps: Core.clamp(Math.floor(race.totalLaps || 3), 1, 9),
    };
    return true;
  }

  _updateRemote(delta) {
    if (!this.remoteTarget) {
      this._applyVisualMotion(delta, Math.min(1, Math.abs(this.velocity) / 1.7));
      return null;
    }

    const age = (performance.now() - this.remoteReceivedAt) / 1000;
    const target = Core.predictNetworkState(this.remoteTarget, age);
    const blend = 1 - Math.exp(-12 * delta);
    this.group.position.lerp(
      new THREE.Vector3(target.x, target.y, target.z),
      blend
    );
    let rotationDelta = target.ry - this.group.rotation.y;
    while (rotationDelta > Math.PI) rotationDelta -= Math.PI * 2;
    while (rotationDelta < -Math.PI) rotationDelta += Math.PI * 2;
    this.group.rotation.y += rotationDelta * blend;
    this.applyKnockback(delta);
    clampToBounds(this.group.position);
    this.velocity += (target.v - this.velocity) * blend;
    this.verticalVelocity += ((target.vy || 0) - this.verticalVelocity) * blend;
    this.airborne = this.group.position.y > (this.spec.groundHeight ?? this.spec.rideHeight) + 0.01;
    this.lift = target.lift || 0;
    this.throttle = target.throttle;
    this.steering = target.steering;
    this._applyVisualMotion(
      delta,
      Math.min(1, Math.abs(this.velocity) / (this.spec.physics.maxForwardSpeed || 1.7)),
      { airborne: this.airborne, landed: false }
    );
    return null;
  }

  getRenderDiagnostics() {
    let meshes = 0;
    let triangles = 0;
    this.visual.traverse((object) => {
      if (!object.isMesh || !object.geometry) return;
      meshes += 1;
      const geometry = object.geometry;
      const count = geometry.index
        ? geometry.index.count
        : geometry.getAttribute('position')?.count || 0;
      triangles += count / 3;
    });
    return {
      bounds: { ...this.halfExtents },
      airborne: this.airborne,
      category: this.spec.category,
      drivingSurface: this.drivingSurface || 'road',
      meshes,
      modelSource: this.modelSource,
      modelStatus: this.modelStatus,
      rotors: this.rotors.length,
      triangles,
      wheels: this.wheels.length,
      verticalVelocity: this.verticalVelocity,
      looping: Boolean(this.loopState),
    };
  }

  dispose() {
    this.disposed = true;
    if (this._inputHandler) {
      document.removeEventListener('car-input', this._inputHandler);
      this._inputHandler = null;
    }
    this._clearVisual();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

// Offscreen rig reused to snapshot every vehicle for the in-race bay: a
// small dedicated renderer/scene/camera, framed to each vehicle's own
// bounding box so procedural bodies and very different-sized GLB skins
// all fill the thumbnail consistently.
let thumbnailRenderer = null;
let thumbnailCanvas = null;
let thumbnailScene = null;
let thumbnailCamera = null;
const thumbnailCache = new Map(); // type -> Promise<string data URL>

function scheduleBackgroundTask(callback) {
  if (typeof window.requestIdleCallback === 'function') {
    return {
      id: window.requestIdleCallback(callback, { timeout: 750 }),
      type: 'idle',
    };
  }
  return {
    id: window.setTimeout(callback, 32),
    type: 'timeout',
  };
}

function cancelBackgroundTask(task) {
  if (!task) return;
  if (task.type === 'idle') window.cancelIdleCallback(task.id);
  else window.clearTimeout(task.id);
}

function ensureThumbnailRig() {
  if (thumbnailRenderer) return;
  const size = 128;
  thumbnailCanvas = document.createElement('canvas');
  thumbnailCanvas.width = size;
  thumbnailCanvas.height = size;
  thumbnailRenderer = new THREE.WebGLRenderer({ canvas: thumbnailCanvas, antialias: true, alpha: true });
  thumbnailRenderer.setSize(size, size);
  thumbnailRenderer.setClearColor(0x000000, 0);
  thumbnailScene = new THREE.Scene();
  thumbnailScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(2, 4, 3);
  thumbnailScene.add(sun);
  thumbnailCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
}

function renderVehicleThumbnail(type) {
  if (thumbnailCache.has(type)) return thumbnailCache.get(type);
  const promise = (async () => {
    ensureThumbnailRig();
    const car = new Vehicle(0xe84a27, false, type);
    await car.modelReady;
    car.group.position.set(0, 0, 0);
    car.group.rotation.set(0, -0.6, 0);
    car.group.updateWorldMatrix(true, true);
    thumbnailScene.add(car.group);

    const box = new THREE.Box3().setFromObject(car.group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    thumbnailCamera.position.set(
      center.x + maxDim * 1.35,
      center.y + maxDim * 1.05,
      center.z + maxDim * 1.35
    );
    thumbnailCamera.lookAt(center);
    thumbnailCamera.updateProjectionMatrix();

    thumbnailRenderer.render(thumbnailScene, thumbnailCamera);
    const dataUrl = thumbnailCanvas.toDataURL('image/png');
    thumbnailScene.remove(car.group);
    car.dispose();
    return dataUrl;
  })();
  thumbnailCache.set(type, promise);
  return promise;
}

function populateLobbyVehicleThumbnails() {
  const rail = document.querySelector('.vehicle-rail');
  if (!rail) return;
  const queue = Array.from(rail.querySelectorAll('input[name="vehicle"]'))
    .filter((input) => input.value !== CUSTOM_VEHICLE_ID)
    .map((input) => ({ type: input.value, glyph: input.closest('.vehicle-toggle').querySelector('.vehicle-glyph') }));
  const renderNext = () => {
    if (queue.length === 0) return;
    scheduleBackgroundTask(async () => {
      const { type, glyph } = queue.shift();
      try {
        const url = await renderVehicleThumbnail(type);
        if (glyph.isConnected) {
          glyph.style.backgroundImage = `url("${url}")`;
          glyph.classList.add('thumb-glyph');
        }
      } catch (error) {
        console.warn(`[vehicle] failed to render ${type} thumbnail`, error);
      }
      renderNext();
    });
  };
  renderNext();
}

// -- Dream lab UI ----------------------------------------------------------
// Lobby-side Tripo generation: prompt a custom vehicle (shown spinning on a
// display plate once ready) and a map theme whose props land on the track.
let dreamRig = null;
let dreamPreviewToken = 0;

async function resolveDreamApiBase() {
  const candidates = [];
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    candidates.push(location.origin);
  }
  const signalValue = getSignalValue();
  if (signalValue) {
    try {
      const healthUrl = Config.getHealthUrl(signalValue, location.protocol);
      if (healthUrl) candidates.push(new URL(healthUrl).origin);
    } catch {
      // Malformed relay value; same-origin probe may still succeed.
    }
  }
  for (const base of candidates) {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4000);
      const response = await fetch(`${base}/api/tripo/status`, { signal: controller.signal });
      window.clearTimeout(timer);
      if (!response.ok) continue;
      const body = await response.json();
      if (body.enabled) return base;
    } catch {
      // Static host or unreachable relay; try the next candidate.
    }
  }
  return null;
}

async function fetchDreamJson(path, init) {
  const response = await fetch(`${dreamApiBase}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function trackDreamTask(taskId, onProgress) {
  const deadline = Date.now() + TripoCore.POLL_TIMEOUT_MS;
  for (;;) {
    const task = await fetchDreamJson(`/api/tripo/task/${taskId}`);
    if (task.status === 'success') return task;
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(I18n.t('dream.taskFailed'));
    }
    if (onProgress) onProgress(task);
    if (Date.now() > deadline) throw new Error(I18n.t('dream.taskTimeout'));
    await new Promise((resolve) => window.setTimeout(resolve, TripoCore.POLL_INTERVAL_MS));
  }
}

function setDreamStatus(id, text, state = '') {
  const element = document.getElementById(id);
  element.textContent = text;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function upsertDreamVehicleToggle() {
  const rail = document.querySelector('.vehicle-rail');
  if (!rail || !customSkin) return;
  let toggle = document.getElementById('dream-vehicle-toggle');
  if (!toggle) {
    toggle = document.createElement('label');
    toggle.className = 'vehicle-toggle';
    toggle.id = 'dream-vehicle-toggle';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'vehicle';
    input.value = CUSTOM_VEHICLE_ID;
    const glyph = document.createElement('span');
    glyph.className = 'vehicle-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    toggle.append(input, glyph, document.createElement('strong'));
    rail.appendChild(toggle);
  }
  toggle.querySelector('strong').textContent = customSkin.label;
  const glyph = toggle.querySelector('.vehicle-glyph');
  glyph.classList.toggle('thumb-glyph', Boolean(customSkin.imageUrl));
  glyph.style.backgroundImage = customSkin.imageUrl ? `url("${customSkin.imageUrl}")` : '';
  toggle.querySelector('input').checked = true;
  toggle.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function ensureDreamRig() {
  if (dreamRig) return dreamRig;
  const canvas = document.getElementById('dream-plate-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.width, canvas.height, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(32, canvas.width / canvas.height, 0.01, 50);
  // The display plate: dark turntable with a yellow rim, car sits on top.
  const turntable = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.37, 0.035, 48),
    new THREE.MeshStandardMaterial({ color: 0x34362f, roughness: 0.85, metalness: 0.05 })
  );
  plate.position.y = -0.0175;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.345, 0.012, 10, 48),
    new THREE.MeshStandardMaterial({ color: 0xf1c644, roughness: 0.55 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.002;
  turntable.add(plate, rim);
  scene.add(turntable);
  dreamRig = { renderer, scene, camera, turntable, carGroup: null, raf: 0, last: 0 };
  return dreamRig;
}

function startDreamPreviewLoop() {
  const rig = dreamRig;
  if (!rig || rig.raf || !rig.carGroup) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    rig.renderer.render(rig.scene, rig.camera);
    return;
  }
  rig.last = performance.now();
  const step = (now) => {
    rig.raf = 0;
    if (document.getElementById('lobby').hidden || !rig.carGroup) return;
    const delta = Math.min((now - rig.last) / 1000, 0.1);
    rig.last = now;
    rig.turntable.rotation.y += delta * 0.55;
    rig.renderer.render(rig.scene, rig.camera);
    rig.raf = requestAnimationFrame(step);
  };
  rig.raf = requestAnimationFrame(step);
}

async function showDreamCarPreview() {
  if (!customSkin) return;
  const token = ++dreamPreviewToken;
  const rig = ensureDreamRig();
  document.getElementById('dream-vehicle-preview').hidden = false;
  document.getElementById('dream-vehicle-name').textContent = customSkin.label;
  const car = new Vehicle(0xe84a27, false, CUSTOM_VEHICLE_ID);
  await car.modelReady;
  if (token !== dreamPreviewToken) {
    car.dispose();
    return;
  }
  if (rig.carGroup) rig.turntable.remove(rig.carGroup);
  car.group.position.set(0, 0, 0);
  car.group.rotation.set(0, 0, 0);
  rig.carGroup = car.group;
  rig.turntable.add(car.group);
  const box = new THREE.Box3().setFromObject(rig.turntable);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  rig.camera.position.set(
    center.x + maxDim * 1.15,
    center.y + maxDim * 0.78,
    center.z + maxDim * 1.15
  );
  rig.camera.lookAt(center.x, center.y * 0.8, center.z);
  rig.camera.updateProjectionMatrix();
  rig.renderer.render(rig.scene, rig.camera);
  startDreamPreviewLoop();
}

function persistDreamVehicle(entry) {
  try {
    localStorage.setItem(DREAM_VEHICLE_STORE, JSON.stringify(entry));
  } catch {
    // Storage full or blocked; the car still works for this session.
  }
}

function persistDreamMap(theme) {
  try {
    localStorage.setItem(DREAM_MAP_STORE, JSON.stringify({
      theme,
      props: Array.from(dreamProps.values(), ({ role, taskId }) => ({ role, taskId })),
    }));
  } catch {
    // Storage full or blocked; props still work for this session.
  }
}

function registerDreamVehicle({ taskId, label, imageUrl, prompt }) {
  customSkin = {
    file: `${dreamApiBase}/api/tripo/model/${taskId}`,
    taskId,
    label,
    imageUrl: imageUrl || '',
  };
  thumbnailCache.delete(CUSTOM_VEHICLE_ID);
  persistDreamVehicle({ taskId, label, imageUrl: customSkin.imageUrl, prompt });
  upsertDreamVehicleToggle();
  showDreamCarPreview();
  if (game) game._initVehicleBay();
}

async function generateDreamVehicle() {
  const input = document.getElementById('dream-vehicle-input');
  const button = document.getElementById('dream-vehicle-btn');
  const text = TripoCore.cleanPromptText(input.value);
  if (!text || !dreamApiBase || button.disabled) return;
  button.disabled = true;
  setDreamStatus('dream-vehicle-status', I18n.t('dream.sending'));
  try {
    const { tasks } = await fetchDreamJson('/api/tripo/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vehicle', text }),
    });
    const taskId = tasks[0].taskId;
    const task = await trackDreamTask(taskId, ({ status, progress }) => {
      setDreamStatus(
        'dream-vehicle-status',
        I18n.t(status === 'queued' ? 'dream.queued' : 'dream.progress', { progress })
      );
    });
    registerDreamVehicle({
      taskId,
      label: TripoCore.shortLabel(text, I18n.t('vehicle.dream-car')),
      imageUrl: task.imageUrl,
      prompt: text,
    });
    setDreamStatus('dream-vehicle-status', I18n.t('dream.vehicleReady'), 'done');
  } catch (error) {
    setDreamStatus('dream-vehicle-status', I18n.t('dream.error', { message: error.message }), 'error');
  } finally {
    button.disabled = false;
  }
}

function createDreamPropCard(strip, role) {
  const element = document.createElement('figure');
  element.className = 'dream-prop';
  const image = document.createElement('img');
  image.alt = '';
  image.hidden = true;
  const title = document.createElement('strong');
  title.textContent = I18n.t(`dream.role.${role}`);
  const status = document.createElement('small');
  status.textContent = I18n.t('dream.queued', { progress: 0 });
  element.append(image, title, status);
  strip.appendChild(element);
  return { element, image, status };
}

function markDreamPropCard(card, prop) {
  if (prop.imageUrl) {
    card.image.src = prop.imageUrl;
    card.image.hidden = false;
  }
  card.element.classList.add('is-ready');
  card.status.textContent = I18n.t('dream.propReady');
}

async function generateDreamMap() {
  const input = document.getElementById('dream-map-input');
  const button = document.getElementById('dream-map-btn');
  const theme = TripoCore.cleanPromptText(input.value);
  if (!theme || !dreamApiBase || button.disabled) return;
  button.disabled = true;
  setDreamStatus('dream-map-status', I18n.t('dream.sending'));
  const strip = document.getElementById('dream-prop-strip');
  strip.hidden = false;
  strip.innerHTML = '';
  dreamProps.clear();
  try {
    const { tasks } = await fetchDreamJson('/api/tripo/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'map', text: theme }),
    });
    const cards = new Map();
    for (const { role, taskId } of tasks) {
      dreamProps.set(role, {
        role,
        taskId,
        status: 'pending',
        file: `${dreamApiBase}/api/tripo/model/${taskId}`,
        imageUrl: '',
      });
      cards.set(role, createDreamPropCard(strip, role));
    }
    persistDreamMap(theme);
    const results = await Promise.all(tasks.map(async ({ role, taskId }) => {
      const card = cards.get(role);
      const prop = dreamProps.get(role);
      try {
        const task = await trackDreamTask(taskId, ({ progress }) => {
          card.status.textContent = I18n.t('dream.progressShort', { progress });
        });
        prop.status = 'success';
        prop.imageUrl = task.imageUrl || '';
        markDreamPropCard(card, prop);
        if (game) game._placeDreamProp(prop);
        return true;
      } catch (error) {
        prop.status = 'failed';
        card.element.classList.add('is-failed');
        card.status.textContent = error.message;
        return false;
      }
    }));
    const succeeded = results.filter(Boolean).length;
    if (succeeded > 0) {
      setDreamStatus('dream-map-status', I18n.t('dream.mapReady'), 'done');
    } else {
      setDreamStatus('dream-map-status', I18n.t('dream.taskFailed'), 'error');
    }
  } catch (error) {
    setDreamStatus('dream-map-status', I18n.t('dream.error', { message: error.message }), 'error');
  } finally {
    button.disabled = false;
  }
}

async function restoreDreamLab() {
  let storedVehicle = null;
  let storedMap = null;
  try {
    storedVehicle = JSON.parse(localStorage.getItem(DREAM_VEHICLE_STORE) || 'null');
    storedMap = JSON.parse(localStorage.getItem(DREAM_MAP_STORE) || 'null');
  } catch {
    // Corrupt storage; treat as empty.
  }
  if (storedVehicle && TripoCore.isTaskId(storedVehicle.taskId)) {
    try {
      const task = await fetchDreamJson(`/api/tripo/task/${storedVehicle.taskId}`);
      if (task.status === 'success') {
        if (storedVehicle.prompt) {
          document.getElementById('dream-vehicle-input').value = storedVehicle.prompt;
        }
        registerDreamVehicle({
          taskId: storedVehicle.taskId,
          label: storedVehicle.label || I18n.t('vehicle.dream-car'),
          imageUrl: task.imageUrl || storedVehicle.imageUrl,
          prompt: storedVehicle.prompt,
        });
        setDreamStatus('dream-vehicle-status', I18n.t('dream.restored'), 'done');
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        localStorage.removeItem(DREAM_VEHICLE_STORE);
      }
    } catch {
      // Task expired upstream or server hiccup; keep the entry for later.
    }
  }
  if (storedMap && Array.isArray(storedMap.props) && storedMap.props.length > 0) {
    const strip = document.getElementById('dream-prop-strip');
    if (storedMap.theme) document.getElementById('dream-map-input').value = storedMap.theme;
    let restored = 0;
    for (const { role, taskId } of storedMap.props) {
      if (!TripoCore.PROP_ROLES.includes(role) || !TripoCore.isTaskId(taskId)) continue;
      try {
        const task = await fetchDreamJson(`/api/tripo/task/${taskId}`);
        if (task.status !== 'success') continue;
        const prop = {
          role,
          taskId,
          status: 'success',
          file: `${dreamApiBase}/api/tripo/model/${taskId}`,
          imageUrl: task.imageUrl || '',
        };
        dreamProps.set(role, prop);
        strip.hidden = false;
        markDreamPropCard(createDreamPropCard(strip, role), prop);
        if (game) game._placeDreamProp(prop);
        restored += 1;
      } catch {
        // Skip entries the server can no longer resolve.
      }
    }
    if (restored > 0) setDreamStatus('dream-map-status', I18n.t('dream.restored'), 'done');
    else localStorage.removeItem(DREAM_MAP_STORE);
  }
}

async function initDreamLab() {
  const lab = document.getElementById('dream-lab');
  if (!lab || typeof fetch !== 'function' || !TripoCore) return;
  dreamApiBase = await resolveDreamApiBase();
  if (!dreamApiBase) return; // no Tripo-enabled server reachable; stay hidden
  lab.hidden = false;
  document.getElementById('dream-vehicle-btn').addEventListener('click', generateDreamVehicle);
  document.getElementById('dream-map-btn').addEventListener('click', generateDreamMap);
  document.getElementById('dream-vehicle-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      generateDreamVehicle();
    }
  });
  document.getElementById('dream-map-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      generateDreamMap();
    }
  });
  restoreDreamLab();
}

class Game {
  constructor(canvas, props, runtime = null) {
    this.canvas = canvas;
    this.props = props;
    this.track = TrackCore.getTrack(props.track);
    this.runtime = runtime;
    this.clock = new THREE.Clock();
    this.isQuest = prefersQuestQuality();
    this.scene = runtime ? runtime.scene : new THREE.Scene();
    this.camera = runtime
      ? runtime.camera
      : new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.01, 100);
    this.renderer = runtime
      ? runtime.renderer
      : new THREE.WebGLRenderer({
          canvas,
          antialias: !this.isQuest,
          alpha: true,
          powerPreference: 'high-performance',
        });
    this.ownsRenderer = !runtime;
    this.destroyed = false;
    this.hitTestSource = null;
    this.xrSession = null;
    this.desktopMode = false;
    this.isPlaced = false;
    this.countdownStarted = false;
    this.paused = false;
    this.totalLaps = RaceCore.normalizeLapCount(props.laps);
    this.assistEnabled = props.assist !== false;
    this.raceSave = loadRaceSave();
    this.aiRacers = [];
    this.ghostAvatar = null;
    this.ghostData = null;
    this.ghostSamples = [];
    this.ghostSampleTimer = 0;
    this.boostCharge = 0;
    this.boostTimer = 0;
    this.wasDrifting = false;
    this.skidTimer = 0;
    this.boostFxTimer = 0;
    this.standingsTimer = 0;
    this.baseCameraFov = 44;
    this.collisionCooldown = 0;
    this.dustTimer = 0;
    this.smokeTimer = 0;
    this.telemetryTimer = 0;
    this.thumbnailGeneration = 0;
    this.thumbnailTask = null;
    this.cameraTarget = new THREE.Vector3();
    this.cameraOffset = new THREE.Vector3();
    this.overviewCamera = Boolean(window.XRRC_OVERVIEW_CAMERA);
    this.staticColliders = [];
    this.trackSamples = [];
    this.lastSafePose = { ...START_GRID, y: Core.getVehicleSpec(props.vehicle).rideHeight };
    this.stuckTimer = 0;
    this.lastStaticCollision = null;
    this.raceState = {};
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (this.ownsRenderer) {
      this.renderer.setPixelRatio(this.isQuest ? 1 : Math.min(devicePixelRatio, 2));
      this.renderer.setSize(innerWidth, innerHeight);
      this.renderer.shadowMap.enabled = !this.isQuest;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.xr.enabled = true;
    }

    this.gameRoot = new THREE.Group();
    this.gameRoot.visible = false;
    if (runtime) this.gameRoot.scale.setScalar(XR_WORLD_SCALE);
    this.scene.add(this.gameRoot);
    this.courseRoot = new THREE.Group();
    this.courseRoot.scale.setScalar(COURSE_SCALE);
    this.gameRoot.add(this.courseRoot);
    this._buildTrack();
    this.worldCars = new Map(); // vehicle type/skin -> Vehicle placed on the track
    this.particles = new ParticleField(this.gameRoot, this.isQuest ? 96 : 180);
    this.skidMarks = new SkidMarkField(this.gameRoot, this.isQuest ? 28 : 48);
    this.localCar = this._summonVehicle(props.vehicle, { silent: true });
    this._initAIRacers(props.multiplayer ? 0 : props.aiCount);
    this._loadGhost();
    this._resetRaceState();
    this.reticle = this._createReticle();
    this.scene.add(this.reticle);
    this._addLights();
    this._initVehicleBay();
    // Place any dream-lab props already generated this session; new ones are
    // placed as their generation lands (see _placeDreamProp).
    this.dreamPropRoots = new Map();
    for (const prop of dreamProps.values()) {
      if (prop.status === 'success') this._placeDreamProp(prop);
    }

    this._resizeHandler = () => this.resize();
    this._pauseHandler = () => this.togglePause();
    this._visibilityHandler = () => {
      if (
        document.hidden &&
        !this.paused &&
        !this.props.multiplayer &&
        this.raceState.status === 'racing'
      ) {
        this.togglePause();
      }
    };
    window.addEventListener('resize', this._resizeHandler);
    document.addEventListener('game-pause', this._pauseHandler);
    document.addEventListener('visibilitychange', this._visibilityHandler);
    this._setupRaceUi();
  }

  _setupRaceUi() {
    const pauseDialog = document.getElementById('pause-dialog');
    const resultsDialog = document.getElementById('results-dialog');
    const pauseButton = document.getElementById('pause-btn');
    pauseButton.disabled = this.props.multiplayer;
    pauseButton.onclick = () => this.togglePause();
    document.getElementById('resume-btn').onclick = () => this.resume();
    document.getElementById('retry-btn').onclick = () => this.restartRace();
    document.getElementById('quit-btn').onclick = () => {
      this.resume(false);
      restoreLobby(I18n.t('status.fallback'));
    };
    document.getElementById('results-retry-btn').onclick = () => this.restartRace();
    document.getElementById('results-lobby-btn').onclick = () => {
      resultsDialog.close();
      restoreLobby(I18n.t('status.fallback'));
    };
    document.getElementById('pause-assist').onclick = () => {
      this.setAssistEnabled(!this.assistEnabled);
    };
    pauseDialog.oncancel = (event) => {
      event.preventDefault();
      this.resume();
    };
    resultsDialog.oncancel = (event) => event.preventDefault();
    this.setAssistEnabled(this.assistEnabled);
    this._syncBestLapHud();
  }

  setAssistEnabled(enabled) {
    this.assistEnabled = Boolean(enabled);
    try {
      window.localStorage.setItem('xrrc-steering-assist', String(this.assistEnabled));
    } catch (error) {
      console.warn('[race] Steering assist preference could not be saved:', error);
    }
    const button = document.getElementById('pause-assist');
    const input = document.getElementById('steering-assist');
    if (button) {
      button.setAttribute('aria-pressed', String(this.assistEnabled));
      button.querySelector('strong').textContent = I18n.t(
        this.assistEnabled ? 'common.on' : 'common.off'
      );
    }
    if (input) input.checked = this.assistEnabled;
  }

  togglePause() {
    if (
      this.props.multiplayer ||
      !this.isPlaced ||
      this.raceState.status !== 'racing'
    ) {
      return;
    }
    if (this.paused) {
      this.resume();
      return;
    }
    this.paused = true;
    this.setActive(false);
    const dialog = document.getElementById('pause-dialog');
    if (!dialog.open) dialog.showModal();
  }

  resume(reactivate = true) {
    const dialog = document.getElementById('pause-dialog');
    if (dialog.open) dialog.close();
    this.paused = false;
    this.clock.getDelta();
    if (reactivate && this.raceState.status === 'racing') this.setActive(true);
  }

  restartRace() {
    for (const dialog of [
      document.getElementById('pause-dialog'),
      document.getElementById('results-dialog'),
    ]) {
      if (dialog.open) dialog.close();
    }
    this.paused = false;
    this.countdownStarted = false;
    this.localCar.reset();
    this.lastSafePose = {
      ...START_GRID,
      y: this.localCar.group.position.y,
    };
    this.stuckTimer = 0;
    this.boostCharge = 0;
    this.boostTimer = 0;
    this.wasDrifting = false;
    this.skidMarks.clear();
    this._resetAIRacers();
    this._resetRaceState();
    runCountdown(this);
  }

  beginRace() {
    const race = this.raceState;
    race.status = 'racing';
    race.elapsedMs = 0;
    race.lapElapsedMs = 0;
    race.sectorStartedAt = 0;
    this.ghostSamples = [];
    this.ghostSampleTimer = 0;
    this._recordGhostSample(true);
    this.setActive(true);
    this._broadcastRace();
  }

  _initAIRacers(countValue) {
    const count = Core.clamp(Number.parseInt(countValue, 10) || 0, 0, 5);
    for (let index = 0; index < count; index += 1) {
      const avatar = new RaceAvatar(index < 2 ? AI_NAMES[index] : null, AI_COLORS[index]);
      this.gameRoot.add(avatar.group);
      this.aiRacers.push({
        avatar,
        baseSpeed: 1.18 + index * 0.045,
        completedLaps: 0,
        distance: -(index + 1) * 0.5,
        finishTime: null,
        finished: false,
        id: `ai-${index}`,
        lane: (index % 2 === 0 ? -1 : 1) * (0.13 + Math.floor(index / 2) * 0.035),
        name: AI_NAMES[index],
        progress: 0,
        speed: 0,
        startDistance: -(index + 1) * 0.5,
      });
    }
    this._resetAIRacers();
  }

  _resetAIRacers() {
    for (const racer of this.aiRacers) {
      racer.completedLaps = 0;
      racer.distance = racer.startDistance;
      racer.finishTime = null;
      racer.finished = false;
      racer.progress = 0;
      racer.speed = 0;
      racer.avatar.knockback.x = 0;
      racer.avatar.knockback.z = 0;
      racer.avatar.offset.x = 0;
      racer.avatar.offset.z = 0;
      this._positionAIRacer(racer);
    }
  }

  _coursePoseAtDistance(distance, lane = 0) {
    const trackLength = this.trackCurve.getLength() * COURSE_SCALE;
    const progress = distance / trackLength;
    const raw = (
      this.startProgress +
      this.raceDirection * progress +
      Math.ceil(Math.abs(progress)) +
      1
    ) % 1;
    const point = this.trackCurve.getPointAt(raw).multiplyScalar(COURSE_SCALE);
    const tangent = this.trackCurve.getTangentAt(raw).normalize();
    const forwardX = tangent.x * this.raceDirection;
    const forwardZ = tangent.z * this.raceDirection;
    point.x += -forwardZ * lane;
    point.z += forwardX * lane;
    point.y = 0.055;
    return {
      heading: Math.atan2(-forwardX, -forwardZ),
      point,
      raw,
      trackLength,
    };
  }

  _positionAIRacer(racer) {
    const pose = this._coursePoseAtDistance(racer.distance, racer.lane);
    racer.avatar.velocity = racer.speed;
    racer.avatar.setPose(pose.point, pose.heading);
    return pose;
  }

  _updateAIRacers(delta) {
    const race = this.raceState;
    const playerDistance = (
      race.completedLaps + race.progress
    ) * this.trackCurve.getLength() * COURSE_SCALE;
    for (const racer of this.aiRacers) {
      const pose = this._coursePoseAtDistance(racer.distance, racer.lane);
      if (race.status === 'racing' && !racer.finished) {
        const nextRaw = (pose.raw + this.raceDirection * 0.018 + 1) % 1;
        const tangent = this.trackCurve.getTangentAt(pose.raw).normalize();
        const nextTangent = this.trackCurve.getTangentAt(nextRaw).normalize();
        const curveFactor = 0.74 + Math.max(0, tangent.dot(nextTangent)) * 0.26;
        const gap = playerDistance - racer.distance;
        const rubberBand = gap > pose.trackLength * 0.18
          ? 1.1
          : gap < -pose.trackLength * 0.18
            ? 0.93
            : 1;
        const targetSpeed = racer.baseSpeed * curveFactor * rubberBand;
        racer.speed += (targetSpeed - racer.speed) * Math.min(1, delta * 2.8);
        racer.distance += racer.speed * delta;
        const totalProgress = Math.max(0, racer.distance / pose.trackLength);
        racer.completedLaps = Math.min(this.totalLaps, Math.floor(totalProgress));
        racer.progress = totalProgress % 1;
        if (totalProgress >= this.totalLaps) {
          racer.completedLaps = this.totalLaps;
          racer.finishTime = race.elapsedMs;
          racer.finished = true;
          racer.progress = 0;
          racer.distance = pose.trackLength * this.totalLaps;
        }
      }
      this._positionAIRacer(racer);
      racer.avatar.applyKnockback(delta);
    }
  }

  _loadGhost() {
    const ghost = this.raceSave.ghosts[this.track.id];
    if (!ghost || !Array.isArray(ghost.samples) || ghost.samples.length < 2) return;
    this.ghostData = ghost;
    this.ghostAvatar = new RaceAvatar(null, 0xf1c644, true);
    this.ghostAvatar.group.visible = false;
    this.gameRoot.add(this.ghostAvatar.group);
  }

  _replaceGhost(ghost) {
    if (this.ghostAvatar) this.ghostAvatar.dispose();
    this.ghostData = ghost;
    this.ghostAvatar = new RaceAvatar(null, 0xf1c644, true);
    this.ghostAvatar.group.visible = false;
    this.gameRoot.add(this.ghostAvatar.group);
  }

  _recordGhostSample(force = false) {
    const race = this.raceState;
    if (race.status !== 'racing' || race.finished) return;
    if (!force && this.ghostSampleTimer < 0.08) return;
    this.ghostSampleTimer = 0;
    const position = this.localCar.group.position;
    this.ghostSamples.push({
      t: Math.round(race.lapElapsedMs),
      x: Number(position.x.toFixed(4)),
      y: Number(position.y.toFixed(4)),
      z: Number(position.z.toFixed(4)),
      ry: Number(this.localCar.group.rotation.y.toFixed(4)),
    });
    if (this.ghostSamples.length > 1800) this.ghostSamples.shift();
  }

  _updateGhost() {
    if (!this.ghostAvatar || !this.ghostData || this.raceState.status !== 'racing') return;
    const pose = RaceCore.interpolateGhost(
      this.ghostData.samples,
      this.raceState.lapElapsedMs
    );
    this.ghostAvatar.group.visible = Boolean(pose);
    if (pose) this.ghostAvatar.setPose(pose, pose.ry);
  }

  _serializeRaceState() {
    const race = this.raceState;
    return {
      attempt: race.attempt,
      completedLaps: race.completedLaps,
      elapsedMs: race.elapsedMs,
      finishTime: race.finishTime,
      finished: race.finished,
      lap: race.lap,
      lapTimes: [...race.lapTimes],
      nextCheckpoint: race.nextCheckpoint,
      progress: race.progress,
      revision: race.revision,
      totalLaps: this.totalLaps,
    };
  }

  adoptRaceRules(race) {
    if (
      !race ||
      this.raceState.completedLaps > 0 ||
      !Number.isFinite(race.totalLaps)
    ) {
      return false;
    }
    const nextTotal = RaceCore.normalizeLapCount(race.totalLaps, this.totalLaps);
    if (nextTotal === this.totalLaps) return false;
    this.totalLaps = nextTotal;
    document.getElementById('lap-count').value = String(nextTotal);
    this._syncRaceHud(this.localCar.surface || 'road');
    this._syncStandings();
    setupShareLink(getRoom(), getSignalValue(), this.track.id);
    return true;
  }

  _broadcastRace() {
    this.raceState.revision += 1;
    const state = this._serializeRaceState();
    this.localCar.networkRaceState = state;
    if (networkManager) networkManager.broadcastRace(state);
  }

  // Places the selected vehicle at the current race position and returns
  // the previous vehicle to its fixed paddock stall.
  _summonVehicle(type, { silent = false } = {}) {
    const nextType = normalizeVehicleSelection(type);
    if (this.worldCars.has(nextType)) return this.worldCars.get(nextType);

    const previous = this.localCar;
    const spawn = previous
      ? {
          x: previous.group.position.x,
          z: previous.group.position.z,
          heading: previous.group.rotation.y,
        }
      : START_GRID;
    if (previous) {
      previous.setActive(false);
      const stall = pitStallPosition(previous.type);
      previous.reset(stall.x, stall.z, stall.heading);
      previous.setActive(false);
    }

    const car = new Vehicle(0xe84a27, true, nextType);
    car.reset(spawn.x, spawn.z, spawn.heading);
    car.setActive(true);
    this.gameRoot.add(car.group);
    this.worldCars.set(nextType, car);
    this.localCar = car;
    document.documentElement.dataset.vehicleCategory = car.spec.category;

    const label = document.getElementById('vehicle-label');
    if (label) label.textContent = vehicleDisplayName(nextType);

    if (!silent) {
      this.particles.burst(
        car.group.position.clone().add(new THREE.Vector3(0, 0.1, 0)),
        [0xf1c644, 0xe84a27, 0xf4ead2],
        14,
        0.4
      );
      audioManager.playCue('toggle');
    }
    this._syncVehicleBay();
    return car;
  }

  // Removes a parked (non-controlled) vehicle from the track, freeing its
  // vehicle-bay slot. The currently controlled vehicle can't recall itself.
  _recallVehicle(type) {
    const car = this.worldCars.get(type);
    if (!car || car === this.localCar) return;
    car.dispose();
    this.worldCars.delete(type);
    this._syncVehicleBay();
  }

  _onVehicleSlotClick(type) {
    if (this.worldCars.has(type)) this._recallVehicle(type);
    else this._summonVehicle(type);
  }

  _initVehicleBay() {
    const bay = document.getElementById('vehicle-bay');
    if (!bay) return;
    bay.innerHTML = '';
    // selectableVehicleTypes() adds the generated dream-car once it exists, so
    // the bay rebuilds to include it the moment generation lands.
    const types = selectableVehicleTypes();
    bay.style.setProperty('--bay-columns', String(Math.ceil(types.length / 3)));
    this.vehicleSlots = new Map();
    const thumbnailQueue = [];
    for (const type of types) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'vehicle-slot';
      slot.setAttribute('role', 'option');
      slot.setAttribute('aria-label', vehicleDisplayName(type));
      const thumb = document.createElement('img');
      thumb.className = 'vehicle-thumb';
      thumb.alt = '';
      slot.append(thumb);
      slot.addEventListener('click', () => this._onVehicleSlotClick(type));
      bay.appendChild(slot);
      this.vehicleSlots.set(type, slot);
      thumbnailQueue.push({ thumb, type });
    }
    this._queueVehicleThumbnails(thumbnailQueue);
    this._syncVehicleBay();
  }

  _queueVehicleThumbnails(queue) {
    const generation = ++this.thumbnailGeneration;
    const renderNext = () => {
      if (generation !== this.thumbnailGeneration || queue.length === 0) return;
      this.thumbnailTask = scheduleBackgroundTask(async () => {
        this.thumbnailTask = null;
        const { thumb, type } = queue.shift();
        try {
          const url = await renderVehicleThumbnail(type);
          if (generation === this.thumbnailGeneration && thumb.isConnected) thumb.src = url;
        } catch (error) {
          console.warn(`[vehicle] failed to render ${type} thumbnail`, error);
        }
        renderNext();
      });
    };
    renderNext();
  }

  _syncVehicleBay() {
    if (!this.vehicleSlots) return;
    for (const [type, slot] of this.vehicleSlots) {
      const car = this.worldCars.get(type);
      const isActive = car === this.localCar;
      slot.classList.toggle('is-active', isActive);
      slot.classList.toggle('is-parked', Boolean(car) && !isActive);
      slot.setAttribute('aria-selected', String(isActive));
    }
  }

  // Places one generated map prop at its fixed anchor spots. Runs during
  // construction for already-generated props and again from the dream lab
  // when a generation finishes while a race is running. Props attach to
  // courseRoot (not gameRoot) so they scale and place with the circuit, and
  // the anchors sit in the off-track grass ring so they never clip the road.
  async _placeDreamProp(prop) {
    const anchors = DREAM_PROP_ANCHORS[prop.role];
    if (!anchors || !prop.file || this.dreamPropRoots.has(prop.role)) return;
    const root = new THREE.Group();
    this.dreamPropRoots.set(prop.role, root);
    this.courseRoot.add(root);
    try {
      const source = await loadGLBModel(prop.file);
      if (!root.parent) return; // game was destroyed while loading
      for (const [x, z, yaw] of anchors.spots) {
        const model = source.clone(true);
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = true;
          node.receiveShadow = true;
        });
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const holder = new THREE.Group();
        holder.scale.setScalar(anchors.size / maxDim);
        model.position.set(-center.x, -box.min.y, -center.z);
        holder.add(model);
        holder.position.set(x, 0, z);
        holder.rotation.y = yaw;
        root.add(holder);
      }
    } catch (error) {
      console.warn(`[dream] failed to place ${prop.role} prop`, error);
      this.courseRoot.remove(root);
      this.dreamPropRoots.delete(prop.role);
    }
  }

  _standardMaterial(color, roughness = 0.72, metalness = 0.08) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }

  _addMesh(geometry, material, position, rotation = null, parent = null) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    if (rotation) mesh.rotation.set(rotation.x, rotation.y, rotation.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (parent || this.courseRoot).add(mesh);
    return mesh;
  }

  _addInstances(geometry, material, transforms, options = {}) {
    if (transforms.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    const dummy = new THREE.Object3D();
    transforms.forEach((transform, index) => {
      dummy.position.copy(transform.position);
      dummy.rotation.copy(transform.rotation || new THREE.Euler());
      dummy.scale.copy(transform.scale || new THREE.Vector3(1, 1, 1));
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.computeBoundingSphere();
    (options.parent || this.courseRoot).add(mesh);
    return mesh;
  }

  _registerStaticOBB(x, z, halfX, halfZ, rotation, height, label) {
    this.staticColliders.push(Object.freeze({
      height: Math.max(0.04, height * COURSE_SCALE),
      hx: Math.max(0.02, halfX * COURSE_SCALE),
      hz: Math.max(0.02, halfZ * COURSE_SCALE),
      label,
      theta: -rotation,
      x: x * COURSE_SCALE,
      z: z * COURSE_SCALE,
    }));
  }

  _registerStaticCircle(x, z, radius, height, label) {
    this._registerStaticOBB(x, z, radius, radius, 0, height, label);
  }

  _buildCourseSamples() {
    this.trackSamples = Array.from({ length: COURSE_SAMPLE_COUNT }, (_, index) => {
      const point = this.trackCurve.getPointAt(index / COURSE_SAMPLE_COUNT);
      return Object.freeze({
        x: point.x * COURSE_SCALE,
        z: point.z * COURSE_SCALE,
      });
    });
    const startSurface = this._sampleSurface(START_GRID);
    this.startProgress = startSurface.progress;
    const forwardX = -Math.sin(START_GRID.heading);
    const forwardZ = -Math.cos(START_GRID.heading);
    this.raceDirection = (
      forwardX * startSurface.tangent.x +
      forwardZ * startSurface.tangent.z
    ) >= 0 ? 1 : -1;
  }

  _sampleSurface(position) {
    return Core.sampleCourseSurface(
      position,
      this.trackSamples,
      this.roadWidth,
      null
    );
  }

  // Screenshot/demo autopilot: steer toward a point further along the course so
  // the car actually laps a circuit with real corners. stepCar subtracts
  // steering from heading, hence the negated correction.
  _updateDemoAutopilot(surface) {
    if (!window.XRRC_DEMO_AUTOPILOT || !this.trackSamples) return;
    const count = this.trackSamples.length;
    const lookahead = Math.round(count * 0.05) * (this.raceDirection || 1);
    const index = Math.round(surface.progress * count) % count;
    const target = this.trackSamples[((index + lookahead) % count + count) % count];
    const car = this.localCar.group.position;
    const desired = Math.atan2(-(target.x - car.x), -(target.z - car.z));
    let error = desired - this.localCar.group.rotation.y;
    while (error > Math.PI) error -= Math.PI * 2;
    while (error < -Math.PI) error += Math.PI * 2;
    window.XRRC_DEMO_INPUT = {
      throttle: 0.9,
      steering: Math.max(-1, Math.min(1, -error * 1.8)),
    };
  }

  // Stunt features used to sit on a straight strip through the infield, which
  // meant leaving the racing line to reach them. They are now derived from the
  // circuit itself so every lap runs through them.
  //
  // stepLoop() drives the car along world x with a constant z, so the vertical
  // loop can only be placed where the course runs parallel to the x axis. That
  // is exactly the start/finish straight, so we score each sample for
  // x-alignment plus straightness and take the best window clear of the grid.
  _computeCourseFeatures() {
    const samples = this.trackSamples;
    const count = samples.length;
    const tangentAt = (index) => {
      const before = samples[(index - 3 + count) % count];
      const after = samples[(index + 3) % count];
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const length = Math.hypot(dx, dz) || 1;
      return { x: dx / length, z: dz / length };
    };

    const startIndex = Math.round(this.startProgress * count) % count;
    const gridClearance = Math.round(count * 0.06);
    const window = Math.max(3, Math.round(count * 0.03));

    let bestScore = -Infinity;
    let bestIndex = -1;
    for (let index = 0; index < count; index += 1) {
      const fromGrid = Math.min(
        (index - startIndex + count) % count,
        (startIndex - index + count) % count
      );
      if (fromGrid < gridClearance) continue;
      const centre = tangentAt(index);
      // The car is carried along x at a fixed z, so a loop on a curve spits it
      // off the road. Straightness across the whole window dominates the score;
      // x-alignment only breaks ties between equally straight candidates.
      let deviation = 0;
      for (let offset = -window; offset <= window; offset += 1) {
        const tangent = tangentAt((index + offset + count) % count);
        deviation = Math.max(
          deviation,
          Math.abs(tangent.z - centre.z) + Math.abs(tangent.x - centre.x)
        );
      }
      const score = Math.abs(centre.x) - deviation * 10;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const loopSample = samples[bestIndex >= 0 ? bestIndex : startIndex];
    this.loopFeature = Object.freeze({
      centerX: loopSample.x,
      centerZ: loopSample.z,
      radius: 0.5 * COURSE_SCALE,
      progress: (bestIndex >= 0 ? bestIndex : startIndex) / count,
    });

    // Four ramps spread around the lap, kept clear of the grid and the loop.
    const loopProgress = this.loopFeature.progress;
    const offsets = [0.18, 0.38, 0.6, 0.82];
    this.jumpZones = Object.freeze(offsets.map((offset, ordinal) => {
      let progress = (this.startProgress + offset * this.raceDirection + 1) % 1;
      const apart = Math.abs(((progress - loopProgress + 1.5) % 1) - 0.5);
      if (apart < 0.07) progress = (progress + 0.09) % 1;
      const index = Math.round(progress * count) % count;
      const sample = samples[index];
      const tangent = tangentAt(index);
      return Object.freeze({
        x: sample.x,
        z: sample.z,
        radius: (ordinal % 2 === 0 ? 0.44 : 0.36) * COURSE_SCALE,
        lift: ordinal % 2 === 0 ? 0.5 : 0.34,
        progress,
        tangentX: tangent.x,
        tangentZ: tangent.z,
        // Rotating a mesh by theta about Y sends its local +X to
        // (cos theta, -sin theta) in the xz plane, so aligning the ramp's long
        // axis with the course tangent needs atan2(-tz, tx).
        meshRotationY: Math.atan2(-tangent.z, tangent.x),
        // Car headings use forward = (-sin h, -cos h).
        carHeading: Math.atan2(-tangent.x, -tangent.z),
      });
    }));
  }

  _buildTrack() {
    const { palette, points, roadWidth } = this.track;
    const localRoadWidth = roadWidth / COURSE_SCALE;
    const grass = this._standardMaterial(palette.ground, 0.98, 0);
    const dirt = this._standardMaterial(palette.shoulder, 1, 0);
    const asphalt = this._standardMaterial(palette.road, 0.94, 0.02);
    const white = this._standardMaterial(palette.line, 0.82, 0);
    const red = this._standardMaterial(palette.curbA, 0.72, 0.08);
    const curbB = this._standardMaterial(palette.curbB, 0.78, 0.04);
    const yellow = this._standardMaterial(palette.accent, 0.76, 0.04);
    const dark = this._standardMaterial(palette.dark, 0.84, 0.08);
    this.roadWidth = roadWidth;

    const ground = this._addMesh(
      new THREE.PlaneGeometry(8.8, 6.8),
      grass,
      new THREE.Vector3(0, -0.018, 0),
      new THREE.Euler(-Math.PI / 2, 0, 0)
    );
    ground.castShadow = false;

    this.trackCurve = new THREE.CatmullRomCurve3(
      points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
      0.45
    );
    this._buildCourseSamples();
    this._computeCourseFeatures();

    const shoulder = this._addMesh(
      this._createRoadGeometry(this.trackCurve, localRoadWidth + 0.24 / COURSE_SCALE),
      dirt,
      new THREE.Vector3(0, -0.002, 0)
    );
    shoulder.castShadow = false;
    const road = this._addMesh(
      this._createRoadGeometry(this.trackCurve, localRoadWidth),
      asphalt,
      new THREE.Vector3(0, 0.006, 0)
    );
    this.road = road;
    road.castShadow = false;
    this._addCourseDetails(this.trackCurve, white, red, curbB, localRoadWidth);
    this._addStartGrid(white, dark);
    this._addBarrier(-2.55, -2.92, 1.4, 0.08, red, white);
    this._addBarrier(2.55, 2.92, 1.2, -0.08, yellow, dark);
    this._addTireWall(-3.95, 0.35, 0.9, Math.PI / 2, dark);
    this._addTireWall(3.78, -0.85, 0.9, Math.PI / 2, dark);
    this._addTracksideMarkers(yellow, dark);
    this._addBillboard(yellow, dark);
    this._addThemeScenery();

    if (this.props.jump) this._addJump(red, yellow);
    if (this.props.loop) this._addLoop(yellow, red);
    if (this.props.traffic) this._addStreetKit(red, yellow, dark, white);
  }

  _createRoadGeometry(curve, width, segments = 180) {
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let index = 0; index <= segments; index += 1) {
      const progress = index / segments;
      const point = curve.getPointAt(progress);
      const tangent = curve.getTangentAt(progress).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
      for (const side of [-1, 1]) {
        positions.push(
          point.x + normal.x * width * 0.5 * side,
          0,
          point.z + normal.z * width * 0.5 * side
        );
        uvs.push(progress * 12, side === -1 ? 0 : 1);
      }
      if (index < segments) {
        const offset = index * 2;
        indices.push(
          offset,
          offset + 1,
          offset + 2,
          offset + 2,
          offset + 1,
          offset + 3
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  _addCourseDetails(curve, line, curbA, curbB, roadWidth) {
    const samples = 120;
    const markerTransforms = [];
    const whiteCurbTransforms = [];
    const redCurbTransforms = [];
    for (let index = 0; index < samples; index += 1) {
      const progress = index / samples;
      const point = curve.getPointAt(progress);
      const tangent = curve.getTangentAt(progress).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
      const rotation = Math.atan2(-tangent.z, tangent.x);

      if (index % 6 < 3) {
        markerTransforms.push({
          position: new THREE.Vector3(point.x, 0.02, point.z),
          rotation: new THREE.Euler(0, rotation, 0),
        });
      }

      if (index % 2 === 0) {
        for (const side of [-1, 1]) {
          const transforms = (
            (Math.floor(index / 2) + (side === 1 ? 1 : 0)) % 2
              ? whiteCurbTransforms
              : redCurbTransforms
          );
          transforms.push({
            position: new THREE.Vector3(
              point.x + normal.x * (roadWidth / 2 + 0.025) * side,
              0.018,
              point.z + normal.z * (roadWidth / 2 + 0.025) * side
            ),
            rotation: new THREE.Euler(0, rotation, 0),
          });
        }
      }
    }
    this._addInstances(
      new THREE.BoxGeometry(0.24, 0.012, 0.035),
      line,
      markerTransforms,
      { castShadow: false }
    );
    const curbGeometry = new THREE.BoxGeometry(0.2, 0.035, 0.075);
    this._addInstances(curbGeometry, curbB, whiteCurbTransforms);
    this._addInstances(curbGeometry.clone(), curbA, redCurbTransforms);
  }

  _addStartGrid(white, dark) {
    const whiteTiles = [];
    const darkTiles = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        const transforms = (row + column) % 2 ? darkTiles : whiteTiles;
        transforms.push({
          position: new THREE.Vector3(
            BASE_START_GRID.x + (row - 2) * 0.11,
            0.022,
            BASE_START_GRID.z + (column - 4.5) * 0.11
          ),
        });
      }
    }
    const geometry = new THREE.BoxGeometry(0.11, 0.014, 0.11);
    this._addInstances(geometry, white, whiteTiles, { castShadow: false });
    this._addInstances(geometry.clone(), dark, darkTiles, { castShadow: false });
  }

  _addBarrier(x, z, length, rotation, firstMaterial, secondMaterial) {
    const count = 7;
    const firstTransforms = [];
    const secondTransforms = [];
    for (let index = 0; index < count; index += 1) {
      const offset = (index - (count - 1) / 2) * (length / count);
      const worldX = x + Math.cos(rotation) * offset;
      const worldZ = z - Math.sin(rotation) * offset;
      (index % 2 ? firstTransforms : secondTransforms).push({
        position: new THREE.Vector3(worldX, 0.065, worldZ),
        rotation: new THREE.Euler(0, rotation, 0),
      });
    }
    const geometry = new THREE.BoxGeometry(length / count + 0.015, 0.13, 0.09);
    this._addInstances(geometry, firstMaterial, firstTransforms);
    this._addInstances(geometry.clone(), secondMaterial, secondTransforms);
    this._registerStaticOBB(x, z, length / 2, 0.055, rotation, 0.14, 'barrier');
  }

  _addTireWall(x, z, length, rotation, material) {
    const count = Math.max(4, Math.round(length / 0.13));
    const transforms = [];
    for (let level = 0; level < 2; level += 1) {
      for (let index = 0; index < count; index += 1) {
        const offset = (index - (count - 1) / 2) * 0.13;
        transforms.push({
          position: new THREE.Vector3(
            x + Math.cos(rotation) * offset,
            0.035 + level * 0.055,
            z - Math.sin(rotation) * offset
          ),
          rotation: new THREE.Euler(Math.PI / 2, 0, 0),
        });
      }
    }
    this._addInstances(
      new THREE.TorusGeometry(0.07, 0.025, 8, 16),
      material,
      transforms
    );
    this._registerStaticOBB(x, z, length / 2, 0.1, rotation, 0.14, 'tire-wall');
  }

  _addTracksideMarkers(accent, dark) {
    const locations = [
      [-3.92, -2.15, 0.08],
      [-2.55, -2.92, -0.04],
      [2.65, -2.9, 0.04],
      [3.92, -1.82, -0.08],
      [3.9, 1.88, 0.08],
      [2.48, 2.96, -0.04],
      [-2.58, 2.95, 0.04],
      [-3.94, 1.96, -0.08],
    ];
    this._addInstances(
      new THREE.BoxGeometry(0.04, 0.7, 0.04),
      dark,
      locations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.35, z),
      }))
    );
    this._addInstances(
      new THREE.BoxGeometry(0.3, 0.16, 0.045),
      accent,
      locations.map(([x, z, rotation]) => ({
        position: new THREE.Vector3(x, 0.68, z),
        rotation: new THREE.Euler(0, rotation, -0.08),
      }))
    );
    for (const [x, z] of locations) {
      this._registerStaticCircle(x, z, 0.04, 0.72, 'course-marker');
    }
  }

  _addBillboard(yellow, dark) {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 192;
    const context = canvas.getContext('2d');
    const toCssColor = (color) => `#${color.toString(16).padStart(6, '0')}`;
    context.fillStyle = toCssColor(this.track.palette.accent);
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = toCssColor(this.track.palette.dark);
    context.font = '900 88px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(this.track.sign, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sign = this._addMesh(
      new THREE.PlaneGeometry(2.7, 0.66),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.72 }),
      new THREE.Vector3(0.15, 0.93, -3.12)
    );
    sign.castShadow = false;
    this._addMesh(
      new THREE.BoxGeometry(0.055, 1.1, 0.055),
      dark,
      new THREE.Vector3(-1.1, 0.5, -3.12)
    );
    this._addMesh(
      new THREE.BoxGeometry(0.055, 1.1, 0.055),
      dark,
      new THREE.Vector3(1.4, 0.5, -3.12)
    );
    this._addMesh(
      new THREE.BoxGeometry(2.9, 0.045, 0.075),
      yellow,
      new THREE.Vector3(0.15, 1.29, -3.12)
    );
    this._registerStaticCircle(-1.1, -3.12, 0.055, 1.1, 'billboard-post');
    this._registerStaticCircle(1.4, -3.12, 0.055, 1.1, 'billboard-post');
  }

  _addThemeScenery() {
    if (this.track.scenery === 'backyard') {
      this._addConifers(
        [
          [-4.05, -2.72, 1],
          [4.03, -2.72, 0.9],
          [-4.08, 2.62, 1.15],
          [-0.9, -3.05, 0.75],
          [2.65, 3.02, 0.8],
        ],
        0x6f5137,
        [0x587047, 0x768d55]
      );
      return;
    }
    if (this.track.scenery === 'alpine') {
      this._addConifers(
        [
          [-4.05, -2.68, 1.15],
          [4.02, -2.66, 0.95],
          [-4.05, 2.62, 1.25],
          [3.98, 2.62, 1.08],
          [-0.95, -3.08, 0.8],
          [2.62, 3.02, 0.86],
        ],
        0x594b43,
        [0x355b5c, 0x467275],
        0xe8f0ed
      );
      return;
    }
    if (this.track.scenery === 'desert') {
      this._addDesertScenery();
      return;
    }
    if (this.track.scenery === 'harbor') {
      this._addHarborScenery();
      return;
    }
    if (this.track.scenery === 'sakura') {
      this._addSakuraScenery();
      return;
    }
    this._addLunarScenery();
  }

  _addConifers(locations, trunkColor, foliageColors, snowColor = null) {
    const trunkMaterial = this._standardMaterial(trunkColor, 1, 0);
    const leafMaterials = foliageColors.map((color) => this._standardMaterial(color, 0.95, 0));
    const trunkTransforms = [];
    const leafTransforms = [[], []];
    for (const [index, [x, z, scale]] of locations.entries()) {
      trunkTransforms.push({
        position: new THREE.Vector3(x, 0.25 * scale, z),
        scale: new THREE.Vector3(scale, scale, scale),
      });
      leafTransforms[index % 2].push({
        position: new THREE.Vector3(x, 0.68 * scale, z),
        scale: new THREE.Vector3(scale, scale, scale),
      });
    }
    this._addInstances(
      new THREE.CylinderGeometry(0.05, 0.075, 0.5, 8),
      trunkMaterial,
      trunkTransforms
    );
    const leafGeometry = new THREE.ConeGeometry(0.38, 0.78, 9);
    this._addInstances(leafGeometry, leafMaterials[0], leafTransforms[0]);
    this._addInstances(leafGeometry.clone(), leafMaterials[1], leafTransforms[1]);
    if (snowColor !== null) {
      this._addInstances(
        new THREE.ConeGeometry(0.3, 0.36, 9),
        this._standardMaterial(snowColor, 0.9, 0),
        locations.map(([x, z, scale]) => ({
          position: new THREE.Vector3(x, 0.86 * scale, z),
          scale: new THREE.Vector3(scale, scale, scale),
        }))
      );
    }
    for (const [x, z, scale] of locations) {
      this._registerStaticCircle(x, z, 0.09 * scale, 1.08 * scale, 'tree');
    }
  }

  _addDesertScenery() {
    const cactusMaterial = this._standardMaterial(0x47705a, 0.96, 0);
    const locations = [
      [-4.05, -2.65, 1],
      [4.02, -2.58, 0.86],
      [-4.08, 2.58, 1.12],
      [3.98, 2.6, 0.94],
      [-0.9, -3.08, 0.72],
    ];
    this._addInstances(
      new THREE.CylinderGeometry(0.065, 0.085, 0.58, 9),
      cactusMaterial,
      locations.map(([x, z, scale]) => ({
        position: new THREE.Vector3(x, 0.29 * scale, z),
        scale: new THREE.Vector3(scale, scale, scale),
      }))
    );
    const arms = [];
    for (const [x, z, scale] of locations) {
      arms.push(
        {
          position: new THREE.Vector3(x - 0.12 * scale, 0.34 * scale, z),
          rotation: new THREE.Euler(0, 0, Math.PI / 2),
          scale: new THREE.Vector3(scale, scale, scale),
        },
        {
          position: new THREE.Vector3(x + 0.1 * scale, 0.43 * scale, z),
          rotation: new THREE.Euler(0, 0, Math.PI / 2),
          scale: new THREE.Vector3(scale * 0.72, scale * 0.72, scale * 0.72),
        }
      );
    }
    this._addInstances(
      new THREE.CylinderGeometry(0.045, 0.055, 0.28, 9),
      cactusMaterial,
      arms
    );
    this._addInstances(
      new THREE.DodecahedronGeometry(0.2, 0),
      this._standardMaterial(0x8e5435, 1, 0),
      [
        [-3.85, 0.65, 1.2, 0.62],
        [3.88, 0.72, 0.9, 0.48],
        [-2.35, 3.02, 1.1, 0.52],
        [2.5, -3.0, 0.95, 0.46],
      ].map(([x, z, sx, sy]) => ({
        position: new THREE.Vector3(x, 0.11, z),
        rotation: new THREE.Euler(0.1, x, -0.08),
        scale: new THREE.Vector3(sx, sy, 0.86),
      }))
    );
    for (const [x, z, scale] of locations) {
      this._registerStaticCircle(x, z, 0.09 * scale, 0.65 * scale, 'cactus');
    }
    for (const [x, z, sx, sy] of [
      [-3.85, 0.65, 1.2, 0.62],
      [3.88, 0.72, 0.9, 0.48],
      [-2.35, 3.02, 1.1, 0.52],
      [2.5, -3.0, 0.95, 0.46],
    ]) {
      this._registerStaticCircle(x, z, 0.2 * Math.max(sx, 0.86), 0.3 * sy, 'rock');
    }
  }

  _addHarborScenery() {
    const containerGeometry = new THREE.BoxGeometry(0.92, 0.48, 0.44);
    const containerGroups = [[], []];
    [
      [-3.78, -2.86, 0.04, 0],
      [3.72, -2.83, -0.08, 1],
      [-3.8, 2.84, -0.03, 1],
      [3.76, 2.82, 0.06, 0],
    ].forEach(([x, z, rotation, group]) => {
      containerGroups[group].push({
        position: new THREE.Vector3(x, 0.24, z),
        rotation: new THREE.Euler(0, rotation, 0),
      });
    });
    this._addInstances(
      containerGeometry,
      this._standardMaterial(0xb44b35, 0.72, 0.15),
      containerGroups[0]
    );
    this._addInstances(
      containerGeometry.clone(),
      this._standardMaterial(0x536f76, 0.72, 0.15),
      containerGroups[1]
    );
    for (const [x, z, rotation] of [
      [-3.78, -2.86, 0.04],
      [3.72, -2.83, -0.08],
      [-3.8, 2.84, -0.03],
      [3.76, 2.82, 0.06],
    ]) {
      this._registerStaticOBB(x, z, 0.46, 0.22, rotation, 0.48, 'container');
    }

    const lightLocations = [
      [-4.02, -0.35],
      [4.02, 0.4],
      [-0.72, -3.08],
      [2.55, 3.02],
    ];
    this._addInstances(
      new THREE.CylinderGeometry(0.025, 0.035, 0.82, 8),
      this._standardMaterial(0x161d23, 0.76, 0.28),
      lightLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.41, z),
      }))
    );
    const lampColor = this.track.palette.accent;
    this._addInstances(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshStandardMaterial({
        color: lampColor,
        emissive: lampColor,
        emissiveIntensity: 2.2,
        roughness: 0.5,
      }),
      lightLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.84, z),
      })),
      { castShadow: false }
    );
    for (const [x, z] of lightLocations) {
      this._registerStaticCircle(x, z, 0.04, 0.86, 'light-pole');
    }
  }

  _addSakuraScenery() {
    const locations = [
      [-4.02, -2.68, 1],
      [4, -2.68, 0.88],
      [-4.04, 2.62, 1.12],
      [3.98, 2.65, 0.96],
      [-0.88, -3.05, 0.76],
      [2.62, 3.02, 0.82],
    ];
    this._addInstances(
      new THREE.CylinderGeometry(0.05, 0.075, 0.5, 8),
      this._standardMaterial(0x71504a, 1, 0),
      locations.map(([x, z, scale]) => ({
        position: new THREE.Vector3(x, 0.25 * scale, z),
        scale: new THREE.Vector3(scale, scale, scale),
      }))
    );
    const blossomTransforms = [[], []];
    locations.forEach(([x, z, scale], index) => {
      blossomTransforms[index % 2].push({
        position: new THREE.Vector3(x, 0.67 * scale, z),
        scale: new THREE.Vector3(0.44 * scale, 0.29 * scale, 0.4 * scale),
      });
    });
    const blossomGeometry = new THREE.IcosahedronGeometry(1, 1);
    this._addInstances(
      blossomGeometry,
      this._standardMaterial(0xe7a0af, 0.9, 0),
      blossomTransforms[0]
    );
    this._addInstances(
      blossomGeometry.clone(),
      this._standardMaterial(0xf1c0c8, 0.9, 0),
      blossomTransforms[1]
    );

    const lanternLocations = [
      [-3.9, 0.58],
      [3.9, -0.68],
      [-2.38, 2.96],
      [2.38, -3.0],
    ];
    this._addInstances(
      new THREE.CylinderGeometry(0.025, 0.035, 0.54, 8),
      this._standardMaterial(0x3b3134, 0.86, 0.08),
      lanternLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.27, z),
      }))
    );
    this._addInstances(
      new THREE.BoxGeometry(0.13, 0.18, 0.13),
      new THREE.MeshStandardMaterial({
        color: 0xf4d0b0,
        emissive: 0xd66f85,
        emissiveIntensity: 0.75,
        roughness: 0.72,
      }),
      lanternLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.59, z),
      })),
      { castShadow: false }
    );
    for (const [x, z, scale] of locations) {
      this._registerStaticCircle(x, z, 0.09 * scale, 1.02 * scale, 'sakura-tree');
    }
    for (const [x, z] of lanternLocations) {
      this._registerStaticCircle(x, z, 0.045, 0.68, 'lantern');
    }
  }

  _addLunarScenery() {
    this._addInstances(
      new THREE.TorusGeometry(0.18, 0.035, 8, 24),
      this._standardMaterial(0x565a63, 1, 0),
      [
        [-3.88, -2.7, 1.2],
        [3.86, 2.7, 0.88],
        [-0.82, -3.05, 0.72],
        [3.94, -0.18, 0.8],
        [-3.94, 0.92, 0.68],
      ].map(([x, z, scale]) => ({
        position: new THREE.Vector3(x, 0.012, z),
        rotation: new THREE.Euler(Math.PI / 2, 0, 0),
        scale: new THREE.Vector3(scale, scale, scale),
      })),
      { castShadow: false }
    );
    this._addInstances(
      new THREE.DodecahedronGeometry(0.13, 0),
      this._standardMaterial(0x8e9198, 1, 0),
      [
        [-4.08, -1.8, 1.1],
        [4.05, -1.7, 0.75],
        [-4.02, 2.48, 0.9],
        [4.02, 2.42, 1.2],
        [2.58, 3.04, 0.72],
      ].map(([x, z, scale]) => ({
        position: new THREE.Vector3(x, 0.1 * scale, z),
        rotation: new THREE.Euler(x * 0.1, z * 0.2, x * 0.05),
        scale: new THREE.Vector3(scale, scale * 0.7, scale * 0.9),
      }))
    );
    const beaconLocations = [
      [-3.98, -0.3],
      [3.98, 0.42],
      [-2.55, 2.98],
      [2.48, -3.02],
    ];
    this._addInstances(
      new THREE.CylinderGeometry(0.025, 0.045, 0.42, 8),
      this._standardMaterial(0x252a33, 0.58, 0.42),
      beaconLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.21, z),
      }))
    );
    this._addInstances(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0xe0b642,
        emissive: 0xe0b642,
        emissiveIntensity: 1.8,
        roughness: 0.5,
      }),
      beaconLocations.map(([x, z]) => ({
        position: new THREE.Vector3(x, 0.45, z),
      })),
      { castShadow: false }
    );
    for (const [x, z, scale] of [
      [-4.08, -1.8, 1.1],
      [4.05, -1.7, 0.75],
      [-4.02, 2.48, 0.9],
      [4.02, 2.42, 1.2],
      [2.58, 3.04, 0.72],
    ]) {
      this._registerStaticCircle(x, z, 0.14 * scale, 0.24 * scale, 'lunar-rock');
    }
    for (const [x, z] of beaconLocations) {
      this._registerStaticCircle(x, z, 0.045, 0.5, 'beacon');
    }
  }

  // Ramps ride the racing line, so each one is rotated to face along the
  // course tangent at its progress instead of sitting on a fixed axis.
  _addJump(red, yellow) {
    const ramps = this.jumpZones.map((zone, ordinal) => {
      const scale = ordinal % 2 === 0 ? 1 : 0.74;
      return {
        x: zone.x / COURSE_SCALE,
        z: zone.z / COURSE_SCALE,
        heading: zone.meshRotationY,
        scale,
        tilt: ordinal % 2 === 0 ? 0.3 : 0.24,
      };
    });
    this.jumpMesh = this._addInstances(
      new THREE.BoxGeometry(0.72, 0.055, 0.55),
      red,
      ramps.map(({ x, z, heading, scale, tilt }) => ({
        position: new THREE.Vector3(x, 0.12 * scale, z),
        rotation: new THREE.Euler(0, heading, tilt, 'YZX'),
        scale: new THREE.Vector3(scale, scale, scale),
      }))
    );
    this._addInstances(
      new THREE.BoxGeometry(0.1, 0.012, 0.56),
      yellow,
      ramps.map(({ x, z, heading, scale, tilt }) => ({
        position: new THREE.Vector3(
          x + Math.cos(heading) * Math.cos(tilt) * 0.2 * scale,
          0.19 * scale,
          z - Math.sin(heading) * Math.cos(tilt) * 0.2 * scale
        ),
        rotation: new THREE.Euler(0, heading, tilt, 'YZX'),
        scale: new THREE.Vector3(scale, scale, scale),
      })),
      { castShadow: false }
    );
  }

  // The loop straddles the racing line on the start/finish straight. stepLoop()
  // carries the car along x at a fixed z, so the torus stays axis-aligned and
  // only its position tracks the circuit.
  _addLoop(yellow, red) {
    const centerX = this.loopFeature.centerX / COURSE_SCALE;
    const centerZ = this.loopFeature.centerZ / COURSE_SCALE;
    const loop = this._addMesh(
      new THREE.TorusGeometry(0.5, 0.055, 14, 64),
      yellow,
      new THREE.Vector3(centerX, 0.52, centerZ),
      new THREE.Euler(0, 0, 0)
    );
    loop.name = 'stunt-loop';
    this.stuntLoop = loop;
    const base = this._addMesh(
      new THREE.BoxGeometry(0.32, 0.065, 0.7),
      red,
      new THREE.Vector3(centerX, 0.032, centerZ)
    );
    this._addInstances(
      new THREE.BoxGeometry(0.58, 0.035, 0.08),
      red,
      [
        {
          position: new THREE.Vector3(centerX - 0.5, 0.025, centerZ),
          rotation: new THREE.Euler(0, 0, 0.08),
        },
        {
          position: new THREE.Vector3(centerX + 0.5, 0.025, centerZ),
          rotation: new THREE.Euler(0, 0, -0.08),
        },
      ]
    );
    loop.castShadow = true;
    base.receiveShadow = true;
  }

  _addStreetKit(red, yellow, dark, white) {
    const coneMaterial = this._standardMaterial(0xf05a32, 0.66, 0.04);
    const coneBodies = [];
    const coneStripes = [];
    const coneBases = [];
    for (const [x, z, rotation] of [
      [-3.62, -1.45, 0.05],
      [-3.78, -1.18, -0.08],
      [3.46, -1.7, 0.12],
      [3.58, -1.42, -0.12],
      [-3.44, 1.9, 0.08],
      [3.5, 1.82, -0.06],
    ]) {
      const orientation = new THREE.Euler(0, rotation, 0);
      coneBodies.push({
        position: new THREE.Vector3(x, 0.1, z),
        rotation: orientation,
      });
      coneStripes.push({
        position: new THREE.Vector3(x, 0.09, z),
        rotation: orientation,
      });
      coneBases.push({
        position: new THREE.Vector3(x, 0.009, z),
        rotation: orientation,
      });
    }
    this._addInstances(
      new THREE.ConeGeometry(0.055, 0.17, 12),
      coneMaterial,
      coneBodies
    );
    this._addInstances(
      new THREE.CylinderGeometry(0.043, 0.05, 0.03, 12),
      white,
      coneStripes
    );
    this._addInstances(
      new THREE.BoxGeometry(0.13, 0.018, 0.13),
      dark,
      coneBases
    );
    for (const [x, z] of [
      [-3.62, -1.45],
      [-3.78, -1.18],
      [3.46, -1.7],
      [3.58, -1.42],
      [-3.44, 1.9],
      [3.5, 1.82],
    ]) {
      this._registerStaticCircle(x, z, 0.065, 0.18, 'traffic-cone');
    }

    this._addStartGantry(dark, red, yellow);
    this._addParkedCar(3.55, 2.63, 0x4b7a95, Math.PI / 2, dark);
    this._addParkedCar(3.95, 2.42, 0xe1b642, Math.PI / 2, dark);

    const paddock = new THREE.Group();
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(1.25, 0.05, 0.72),
      red
    );
    roof.position.y = 0.63;
    roof.rotation.z = -0.05;
    paddock.add(roof);
    for (const [x, z] of [
      [-0.55, -0.29],
      [0.55, -0.29],
      [-0.55, 0.29],
      [0.55, 0.29],
    ]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.62, 0.035),
        dark
      );
      post.position.set(x, 0.31, z);
      paddock.add(post);
    }
    paddock.position.set(3.58, 0, 2.55);
    this.courseRoot.add(paddock);
    for (const [x, z] of [
      [3.03, 2.26],
      [4.13, 2.26],
      [3.03, 2.84],
      [4.13, 2.84],
    ]) {
      this._registerStaticCircle(x, z, 0.04, 0.64, 'paddock-post');
    }
  }

  _addStartGantry(dark, red, yellow) {
    for (const z of [BASE_START_GRID.z - 0.78, BASE_START_GRID.z + 0.78]) {
      this._addMesh(
        new THREE.BoxGeometry(0.055, 0.95, 0.055),
        dark,
        new THREE.Vector3(BASE_START_GRID.x + 0.12, 0.475, z)
      );
      this._registerStaticCircle(
        BASE_START_GRID.x + 0.12,
        z,
        0.055,
        0.95,
        'start-gantry'
      );
    }
    this._addMesh(
      new THREE.BoxGeometry(0.065, 0.065, 1.62),
      dark,
      new THREE.Vector3(BASE_START_GRID.x + 0.12, 0.9, BASE_START_GRID.z)
    );
    for (let index = 0; index < 5; index += 1) {
      const color = index < 2 ? red.color : index < 4 ? yellow.color : 0x4c9b62;
      this._addMesh(
        new THREE.SphereGeometry(0.055, 14, 10),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: index === 4 ? 1.6 : 0.25,
        }),
        new THREE.Vector3(
          BASE_START_GRID.x + 0.06,
          0.82,
          BASE_START_GRID.z - 0.42 + index * 0.21
        )
      );
    }
    this._addMesh(
      new THREE.BoxGeometry(0.11, 0.035, 1.6),
      red,
      new THREE.Vector3(BASE_START_GRID.x + 0.12, 0.99, BASE_START_GRID.z)
    );
    this._addMesh(
      new THREE.BoxGeometry(0.11, 0.025, 1.6),
      yellow,
      new THREE.Vector3(BASE_START_GRID.x + 0.12, 1.04, BASE_START_GRID.z)
    );
  }

  _addParkedCar(x, z, color, rotation, dark) {
    const car = new THREE.Group();
    const body = this._standardMaterial(color, 0.42, 0.25);
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.34), body);
    chassis.position.y = 0.08;
    chassis.castShadow = true;
    car.add(chassis);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.07, 0.14), body);
    roof.position.set(0, 0.14, 0.01);
    roof.castShadow = true;
    car.add(roof);
    for (const [wheelX, wheelZ] of [
      [-0.115, -0.11],
      [0.115, -0.11],
      [-0.115, 0.11],
      [0.115, 0.11],
    ]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 0.035, 12),
        dark
      );
      wheel.position.set(wheelX, 0.045, wheelZ);
      wheel.rotation.z = Math.PI / 2;
      car.add(wheel);
    }
    car.position.set(x, 0, z);
    car.rotation.y = rotation;
    this.courseRoot.add(car);
    this._registerStaticOBB(x, z, 0.11, 0.18, rotation, 0.2, 'parked-car');
  }

  _addLights() {
    const light = this.track.lighting;
    this.scene.add(new THREE.HemisphereLight(
      light.hemisphereSky,
      light.hemisphereGround,
      light.hemisphereIntensity
    ));
    const sun = new THREE.DirectionalLight(light.sun, light.sunIntensity);
    sun.position.set(6.5, 11, 7);
    sun.castShadow = !this.isQuest;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -7;
    sun.shadow.camera.right = 7;
    sun.shadow.camera.top = 6;
    sun.shadow.camera.bottom = -6;
    this.scene.add(sun);
  }

  _createReticle() {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.11, 0.15, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xf1c644,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      })
    );
    const cross = new THREE.Mesh(
      new THREE.RingGeometry(0.025, 0.04, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe84a27, side: THREE.DoubleSide })
    );
    group.add(ring, cross);
    group.matrixAutoUpdate = false;
    group.visible = false;
    return group;
  }

  place(matrix) {
    if (matrix) {
      this.gameRoot.position.setFromMatrixPosition(matrix);
      this.gameRoot.quaternion.setFromRotationMatrix(matrix);
    }
    this.gameRoot.visible = true;
    this.reticle.visible = false;
    const placementHint = document.getElementById('place-hint');
    placementHint.classList.add('hidden');
    placementHint.setAttribute('aria-hidden', 'true');
    if (!this.isPlaced) {
      this.isPlaced = true;
      runCountdown(this);
    }
  }

  setActive(active) {
    this.localCar.setActive(active);
  }

  resetCar() {
    for (const [type, car] of this.worldCars) {
      if (car === this.localCar) continue;
      const distanceToGrid = Math.hypot(
        car.group.position.x - START_GRID.x,
        car.group.position.z - START_GRID.z
      );
      if (distanceToGrid < 1.05) {
        const stall = pitStallPosition(type);
        car.reset(stall.x, stall.z, stall.heading);
        car.setActive(false);
      }
    }
    this.localCar.reset();
    this.lastSafePose = {
      ...START_GRID,
      y: this.localCar.group.position.y,
    };
    this.stuckTimer = 0;
    this.raceState.nextCheckpoint = 0;
    this.raceState.progress = 0;
    this.raceState.lastProgress = 0;
    this.raceState.started = false;
    this.raceState.wasOnRoad = true;
    this.raceState.wrongWay = false;
    this.raceState.currentSectorTimes = [];
    this.raceState.sectorStartedAt = 0;
    this._syncRaceHud('road');
    this._broadcastRace();
    this.particles.burst(
      this.localCar.group.position.clone(),
      [0xf1c644, 0xe84a27, 0xf4ead2],
      16,
      0.35
    );
    audioManager.playCue('reset');
    showToast(I18n.t('race.reset'));
  }

  startDesktop() {
    this.desktopMode = true;
    this.scene.background = new THREE.Color(this.track.palette.sky);
    this.scene.fog = new THREE.Fog(this.track.palette.fog, 16, 35);
    this._positionDesktopCamera();
    this.place();
    this.renderer.setAnimationLoop(() => this.render());
  }

  _positionDesktopCamera() {
    if (!this.desktopMode) return;
    if (this.overviewCamera) {
      this.baseCameraFov = 40;
      this.cameraOffset.set(0, 15.5 * COURSE_SCALE / 2.15, 13.5 * COURSE_SCALE / 2.15);
    } else if (innerWidth / innerHeight < 0.72) {
      this.baseCameraFov = 54;
      this.cameraOffset.set(8.4, 9.2, 11);
    } else {
      this.baseCameraFov = 44;
      this.cameraOffset.set(7.8, 7.1, 9.2);
    }
    this.camera.fov = this.baseCameraFov;
    this.cameraTarget.set(
      this.overviewCamera ? 0 : (this.localCar?.group.position.x || 0),
      0.14,
      this.overviewCamera ? 0 : (this.localCar?.group.position.z || 0)
    );
    this.camera.position.copy(this.cameraTarget).add(this.cameraOffset);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.cameraTarget);
  }

  async startWebXR() {
    this.gameRoot.scale.setScalar(XR_WORLD_SCALE);
    if (typeof this.renderer.xr.setFramebufferScaleFactor === 'function') {
      this.renderer.xr.setFramebufferScaleFactor(this.isQuest ? 0.85 : 1);
    }
    const { hitTestSource, session } = await XRCore.startWebXRSession(
      navigator.xr,
      this.renderer,
      document.getElementById('overlay')
    );
    this.xrSession = session;
    this.hitTestSource = hitTestSource;
    if (typeof this.renderer.xr.setFoveation === 'function') {
      this.renderer.xr.setFoveation(this.isQuest ? 0.65 : 0);
    }
    this._placementHandler = () => {
      if (!this.gameRoot.visible && this.reticle.visible) this.place(this.reticle.matrix);
    };
    this.canvas.addEventListener('click', this._placementHandler);
    session.addEventListener('select', this._placementHandler);
    if (!hitTestSource) {
      this.gameRoot.position.set(0, 0, -2.7);
      this.place();
    }
    session.addEventListener('end', () => {
      if (this.hitTestSource) this.hitTestSource.cancel();
      this.hitTestSource = null;
      this.xrSession = null;
      window.XRRC_XR_INPUT = null;
      if (!this.destroyed && game === this) {
        restoreLobby(I18n.t('status.sessionEnded'));
      }
    });
    this.renderer.setAnimationLoop((time, frame) => {
      window.XRRC_XR_INPUT = ControlsCore.readXRInputSources(session.inputSources);
      if (frame && hitTestSource && !this.gameRoot.visible) {
        const pose = XRCore.getFirstHitPose(
          frame,
          hitTestSource,
          this.renderer.xr.getReferenceSpace()
        );
        this.reticle.visible = Boolean(pose);
        if (pose) XRCore.copyPoseMatrix(this.reticle.matrix, pose);
      }
      this.render();
    });
  }

  update() {
    const frameDelta = Math.min(this.clock.getDelta(), MAX_FRAME_CATCHUP);
    if (this.paused) {
      audioManager.update({ speed: 0, throttle: 0, steering: 0 });
      return;
    }
    let remaining = frameDelta;
    while (remaining > 0.000001) {
      const delta = Math.min(remaining, MAX_SIMULATION_STEP);
      this._step(delta);
      remaining -= delta;
    }
  }

  _step(delta) {
    if (this.raceState.status === 'racing') {
      this.raceState.elapsedMs += delta * 1000;
      this.raceState.lapElapsedMs += delta * 1000;
      this.ghostSampleTimer += delta;
    }
    this.boostTimer = Math.max(0, this.boostTimer - delta);
    let telemetry = null;
    const preSurface = this._sampleSurface(this.localCar.group.position);
    this._applySteeringAssist(preSurface);
    this._updateDemoAutopilot(preSurface);
    const rampZone = this.jumpZones.find((zone) => (
      Math.hypot(
        this.localCar.group.position.x - zone.x,
        this.localCar.group.position.z - zone.z
      ) <= zone.radius * 0.45
    ));
    // Ramps now sit on the circuit, so launching no longer requires the old
    // infield stunt strip - being on the road (or its shoulder) is enough.
    const rampLaunchSpeed = (
      this.props.jump &&
      this.localCar.spec.category === 'ground' &&
      preSurface.type !== 'offroad' &&
      rampZone
    )
      ? Core.getRampLaunchSpeed(
          this.localCar.group.position,
          this.localCar.velocity,
          this.jumpZones
        )
      : 0;
    const loopTrigger = (
      this.props.loop &&
      this.localCar.spec.category === 'ground' &&
      !this.localCar.airborne &&
      this.localCar.loopCooldown <= 0 &&
      Math.abs(this.localCar.velocity) > 1.05 &&
      Math.abs(this.localCar.group.position.x - this.loopFeature.centerX) < 0.32 &&
      Math.abs(this.localCar.group.position.z - this.loopFeature.centerZ) < 0.3
    );
    this.localCar.networkRaceState = this._serializeRaceState();
    for (const car of this.worldCars.values()) {
      const result = car.update(delta, car === this.localCar
        ? {
            boost: this.boostTimer > 0,
            loop: this.localCar.loopState || loopTrigger ? this.loopFeature : null,
            loopTrigger,
            rampLaunchSpeed,
            surface: preSurface,
          }
        : {});
      if (car === this.localCar) telemetry = result;
    }
    for (const car of remoteCars.values()) car.update(delta);
    this._updateAIRacers(delta);
    this._updateGhost();
    if (!telemetry) return;

    const boundaryCollision = telemetry.collided;
    this._resolveStaticCollisions(telemetry);
    this._resolveVehicleCollisions();
    this.particles.update(delta);
    this.skidMarks.update(delta);
    this.collisionCooldown = Math.max(0, this.collisionCooldown - delta);
    telemetry.surface = this._sampleSurface(this.localCar.group.position);
    if (this._handleRecovery(telemetry, delta, boundaryCollision)) {
      telemetry.velocity = 0;
      telemetry.collided = false;
      telemetry.airborne = this.localCar.airborne;
      telemetry.surface = this._sampleSurface(this.localCar.group.position);
    }
    this._updateRaceProgress(telemetry.surface, telemetry);
    this._recordGhostSample();
    this._updateBoost(telemetry, delta);

    audioManager.update({
      speed: telemetry.velocity,
      throttle: telemetry.throttle,
      steering: telemetry.steering,
    });
    this._updateEffects(telemetry, delta);
    this.telemetryTimer += delta;
    if (this.telemetryTimer > 0.06) {
      this.telemetryTimer = 0;
      document.getElementById('speed-value').textContent = String(
        Core.speedToKph(telemetry.velocity)
      ).padStart(2, '0');
      this._syncRaceTimingHud();
      this._syncStandings();
    }

    if (this.desktopMode) {
      // Overview framing holds the whole circuit in shot for showcase captures;
      // normal play keeps the close chase camera that sells the speed.
      const cameraGoal = this.overviewCamera
        ? new THREE.Vector3(0, 0.14, 0)
        : new THREE.Vector3(
            this.localCar.group.position.x,
            0.14 + this.localCar.group.position.y * 0.18,
            this.localCar.group.position.z
          );
      const blend = this.reducedMotion ? 1 : 1 - Math.exp(-4.6 * delta);
      this.cameraTarget.lerp(cameraGoal, blend);
      this.camera.position.copy(this.cameraTarget).add(this.cameraOffset);
      this.camera.lookAt(this.cameraTarget);
      const speedFov = Math.min(4.5, Math.abs(telemetry.velocity) * 2.2);
      const targetFov = this.baseCameraFov + speedFov + (this.boostTimer > 0 ? 6 : 0);
      const nextFov = THREE.MathUtils.lerp(this.camera.fov, targetFov, blend);
      if (Math.abs(nextFov - this.camera.fov) > 0.01) {
        this.camera.fov = nextFov;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  _applySteeringAssist(surface) {
    const car = this.localCar;
    if (
      !this.assistEnabled ||
      !car.active ||
      car.spec.category !== 'ground' ||
      surface.type !== 'road' ||
      car.velocity < 0.12 ||
      Math.abs(car.steering) > 0.82
    ) {
      return;
    }
    const forwardX = surface.tangent.x * this.raceDirection;
    const forwardZ = surface.tangent.z * this.raceDirection;
    const targetHeading = Math.atan2(-forwardX, -forwardZ);
    const correction = -wrappedAngleDelta(targetHeading, car.group.rotation.y) * 0.24;
    car.steering = Core.clamp(car.steering + correction, -1, 1);
  }

  _updateBoost(telemetry, delta) {
    const meter = document.getElementById('boost-meter');
    const drifting = (
      this.raceState.status === 'racing' &&
      this.localCar.spec.category === 'ground' &&
      !telemetry.airborne &&
      telemetry.surface.type !== 'offroad' &&
      telemetry.drifting
    );
    if (drifting) {
      this.boostCharge = Math.min(
        1,
        this.boostCharge + delta * (0.3 + telemetry.speedRatio * 0.2)
      );
      this.skidTimer -= delta;
      if (this.skidTimer <= 0) {
        this.skidTimer = 0.055;
        this.skidMarks.add(this.localCar);
      }
    } else if (this.wasDrifting && this.boostCharge >= 0.2) {
      this.boostTimer = 0.28 + this.boostCharge * 1.1;
      this.boostCharge = 0;
      audioManager.playCue('boost');
      document.dispatchEvent(new CustomEvent('car-boost'));
      this.particles.burst(
        this.localCar.pointFromLocal(0, 0.08, 0.22),
        [0xf1c644, 0x5fae7e, 0xf4ead2],
        18,
        0.48
      );
    } else if (this.boostTimer <= 0) {
      this.boostCharge = Math.max(0, this.boostCharge - delta * 0.025);
    }
    this.wasDrifting = drifting;
    meter.style.setProperty('--boost-charge', `${this.boostCharge * 100}%`);
    meter.setAttribute('aria-valuenow', String(Math.round(this.boostCharge * 100)));
    meter.dataset.active = String(this.boostTimer > 0);
  }

  _resetRaceState() {
    this.raceAttempt = Math.max(Date.now(), (this.raceAttempt || 0) + 1);
    this.raceState = {
      attempt: this.raceAttempt,
      completedLaps: 0,
      currentSectorTimes: [],
      elapsedMs: 0,
      finishTime: null,
      finished: false,
      lap: 1,
      lapElapsedMs: 0,
      lapTimes: [],
      lastProgress: 0,
      nextCheckpoint: 0,
      personalBest: false,
      progress: 0,
      revision: 0,
      sectorStartedAt: 0,
      started: false,
      status: 'countdown',
      wasOnRoad: true,
      wrongWay: false,
    };
    this.ghostSamples = [];
    this.localCar.networkRaceState = this._serializeRaceState();
    this._syncRaceHud('road');
    this._syncRaceTimingHud();
    this._syncStandings();
  }

  _normalizedProgress(progress) {
    const delta = this.raceDirection > 0
      ? progress - this.startProgress
      : this.startProgress - progress;
    return (delta + 1) % 1;
  }

  _updateRaceProgress(surface, telemetry) {
    const race = this.raceState;
    const progress = this._normalizedProgress(surface.progress);
    const tangentX = surface.tangent.x * this.raceDirection;
    const tangentZ = surface.tangent.z * this.raceDirection;
    const velocityDirection = Math.sign(telemetry.velocity || 1);
    const travelX = -Math.sin(this.localCar.group.rotation.y) * velocityDirection;
    const travelZ = -Math.cos(this.localCar.group.rotation.y) * velocityDirection;
    const alignment = travelX * tangentX + travelZ * tangentZ;
    race.wrongWay = (
      surface.type === 'road' &&
      Math.abs(telemetry.velocity) > 0.16 &&
      alignment < -0.28
    );

    if (surface.type !== 'road' || race.wrongWay) {
      race.nextCheckpoint = 0;
      race.started = false;
      race.wasOnRoad = false;
      race.currentSectorTimes = [];
      race.sectorStartedAt = 0;
      this._syncRaceHud(surface.type);
      return;
    }

    if (!race.wasOnRoad) {
      race.lastProgress = progress;
      race.progress = progress;
      race.wasOnRoad = true;
      this._syncRaceHud(surface.type);
      return;
    }

    const forwardDelta = (progress - race.lastProgress + 1) % 1;
    const isContinuous = forwardDelta <= 0.08;
    if (isContinuous && race.status === 'racing') {
      const nextThreshold = RACE_CHECKPOINTS[race.nextCheckpoint];
      if (
        nextThreshold !== undefined &&
        race.lastProgress < nextThreshold &&
        progress >= nextThreshold
      ) {
        this._completeSector(race.nextCheckpoint);
        race.nextCheckpoint += 1;
        race.started = true;
      }
      if (
        race.nextCheckpoint === RACE_CHECKPOINTS.length &&
        race.lastProgress > 0.82 &&
        progress < 0.18
      ) {
        this._completeLap();
      }
    }
    race.lastProgress = progress;
    race.progress = progress;
    this._syncRaceHud(surface.type);
  }

  _completeSector(index) {
    const race = this.raceState;
    const time = Math.max(1, race.lapElapsedMs - race.sectorStartedAt);
    race.currentSectorTimes[index] = time;
    race.sectorStartedAt = race.lapElapsedMs;
    audioManager.playCue('sector');
    showToast(I18n.t('race.sectorComplete', {
      sector: index + 1,
      time: RaceCore.formatTime(time),
    }));
    this._broadcastRace();
  }

  _completeLap() {
    const race = this.raceState;
    this._recordGhostSample(true);
    const finalSector = Math.max(1, race.lapElapsedMs - race.sectorStartedAt);
    race.currentSectorTimes[RACE_CHECKPOINTS.length] = finalSector;
    const completedLap = race.lap;
    const lapTime = Math.max(1, race.lapElapsedMs);
    race.lapTimes.push(lapTime);
    race.completedLaps += 1;

    const recorded = RaceCore.recordLap(
      this.raceSave,
      this.track.id,
      lapTime,
      race.currentSectorTimes,
      {
        samples: this.ghostSamples,
        vehicle: this.localCar.type,
      }
    );
    this.raceSave = recorded.save;
    persistRaceSave(this.raceSave);
    if (recorded.isPersonalBest) {
      race.personalBest = true;
      const ghost = this.raceSave.ghosts[this.track.id];
      if (ghost) this._replaceGhost(ghost);
      showToast(I18n.t('race.newBest', { time: RaceCore.formatTime(lapTime) }));
    } else {
      showToast(I18n.t('race.lapComplete', { lap: completedLap }));
    }
    this._syncBestLapHud();

    if (race.completedLaps >= this.totalLaps) {
      this._finishRace();
      return;
    }
    race.lap += 1;
    race.lapElapsedMs = 0;
    race.nextCheckpoint = 0;
    race.started = false;
    race.sectorStartedAt = 0;
    race.currentSectorTimes = [];
    this.ghostSamples = [];
    this.ghostSampleTimer = 0;
    this._recordGhostSample(true);
    this._broadcastRace();
  }

  _finishRace() {
    const race = this.raceState;
    race.finished = true;
    race.finishTime = race.elapsedMs;
    race.status = 'finished';
    race.progress = 0;
    this.setActive(false);
    audioManager.playCue('finish');
    this._broadcastRace();
    const standings = this._syncStandings();
    const local = standings.find(({ id }) => id === 'local');
    showToast(I18n.t('race.finished', { position: local?.position || 1 }));
    window.setTimeout(() => {
      if (game === this && this.raceState.finished) this._showResults();
    }, 650);
  }

  _showResults() {
    const standings = this._syncStandings();
    const local = standings.find(({ id }) => id === 'local');
    document.getElementById('results-position').textContent =
      `P${local?.position || 1} / ${standings.length}`;
    document.getElementById('results-time').textContent =
      RaceCore.formatTime(this.raceState.finishTime);
    document.getElementById('results-record').textContent = I18n.t(
      this.raceState.personalBest ? 'results.record' : 'results.complete'
    );
    const body = document.getElementById('results-laps');
    body.replaceChildren(...this.raceState.lapTimes.map((time, index) => {
      const row = document.createElement('tr');
      const lap = document.createElement('td');
      const value = document.createElement('td');
      lap.textContent = String(index + 1);
      value.textContent = RaceCore.formatTime(time);
      row.append(lap, value);
      return row;
    }));
    const dialog = document.getElementById('results-dialog');
    if (!dialog.open) dialog.showModal();
  }

  _syncBestLapHud() {
    const best = Number(this.raceSave.bestLaps[this.track.id]);
    document.getElementById('best-lap-time').textContent = RaceCore.formatTime(best);
  }

  _syncRaceTimingHud() {
    const race = this.raceState;
    const value = race.status === 'finished' ? race.finishTime : race.elapsedMs;
    document.getElementById('race-time').textContent = RaceCore.formatTime(value, '0:00.000');
  }

  _collectStandings() {
    const race = this.raceState;
    const racers = [{
      completedLaps: race.completedLaps,
      finishTime: race.finishTime,
      finished: race.finished,
      id: 'local',
      local: true,
      name: I18n.t('race.you'),
      progress: race.progress,
    }];
    for (const ai of this.aiRacers) {
      racers.push({
        completedLaps: ai.completedLaps,
        finishTime: ai.finishTime,
        finished: ai.finished,
        id: ai.id,
        name: ai.name,
        progress: ai.progress,
      });
    }
    let remoteIndex = 1;
    for (const [id, car] of remoteCars) {
      const remoteRace = car.raceState;
      const surface = this._sampleSurface(car.group.position);
      racers.push({
        completedLaps: remoteRace?.completedLaps || 0,
        finishTime: remoteRace?.finishTime || null,
        finished: Boolean(remoteRace?.finished),
        id,
        name: `${I18n.t('race.rival')} ${remoteIndex}`,
        progress: remoteRace?.progress ?? this._normalizedProgress(surface.progress),
      });
      remoteIndex += 1;
    }
    return RaceCore.rankRacers(racers);
  }

  _syncStandings() {
    const standings = this._collectStandings();
    this.standings = standings;
    const list = document.getElementById('standings-list');
    list.replaceChildren(...standings.map((racer) => {
      const item = document.createElement('li');
      item.dataset.local = String(Boolean(racer.local));
      const position = document.createElement('span');
      const name = document.createElement('span');
      const lap = document.createElement('span');
      position.textContent = `P${racer.position}`;
      name.textContent = racer.name;
      lap.textContent = racer.finished
        ? I18n.t('race.done')
        : `${Math.min(this.totalLaps, racer.completedLaps + 1)}/${this.totalLaps}`;
      item.append(position, name, lap);
      return item;
    }));
    const local = standings.find(({ id }) => id === 'local');
    document.getElementById('position-label').textContent =
      `P${local?.position || 1} / ${standings.length}`;
    return standings;
  }

  _syncRaceHud(surfaceType) {
    const guide = document.getElementById('race-guide');
    const lap = document.getElementById('lap-label');
    const sector = document.getElementById('sector-label');
    const status = document.getElementById('route-status');
    const progress = document.getElementById('race-progress-bar');
    if (!guide || !lap || !sector || !status || !progress) return;
    const race = this.raceState;
    const sectorNumber = Math.min(4, race.nextCheckpoint + 1);
    let state = surfaceType;
    let statusKey = surfaceType === 'offroad' ? 'race.offCourse' : 'race.onCourse';
    if (surfaceType === 'stunt') statusKey = 'race.stuntLane';
    if (race.wrongWay) {
      state = 'wrong-way';
      statusKey = 'race.wrongWay';
    } else if (this.localCar?.airborne) {
      state = 'airborne';
      statusKey = 'race.airborne';
    }
    guide.dataset.state = state;
    lap.textContent = I18n.t('race.lap', {
      lap: Math.min(this.totalLaps, race.lap),
      total: this.totalLaps,
    });
    sector.textContent = I18n.t('race.sector', { sector: sectorNumber });
    status.textContent = I18n.t(statusKey);
    progress.setAttribute('aria-valuenow', String(Math.round(race.progress * 100)));
    progress.style.setProperty('--race-progress', `${race.progress * 100}%`);
  }

  _handleRecovery(telemetry, delta, boundaryCollision) {
    if (this.recoveryEnabled === false) return false;
    const position = this.localCar.group.position;
    const finitePosition = [position.x, position.y, position.z].every(Number.isFinite);
    if (!finitePosition || boundaryCollision) {
      this._recoverVehicle();
      return true;
    }

    const surface = telemetry.surface;
    if (
      surface.type === 'road' &&
      !telemetry.airborne &&
      !telemetry.staticCollision &&
      surface.roadDistance < this.roadWidth * 0.4
    ) {
      this._saveRecoveryPose(surface);
    }

    const pushingWhileStuck = (
      this.localCar.active &&
      Math.abs(telemetry.throttle) > 0.62 &&
      Math.abs(telemetry.velocity) < 0.045 &&
      !telemetry.airborne &&
      (surface.type === 'offroad' || telemetry.staticCollision)
    );
    this.stuckTimer = pushingWhileStuck ? this.stuckTimer + delta : 0;
    if (this.stuckTimer < 1.35) return false;
    this._recoverVehicle();
    return true;
  }

  _isRecoveryPoseClear(pose) {
    const car = this.localCar;
    const candidate = {
      hx: car.halfExtents.x,
      hz: car.halfExtents.z,
      theta: pose.heading,
      x: pose.x,
      z: pose.z,
    };
    return this.staticColliders.every((collider) => {
      if (!Core.verticalRangesOverlap(
        car.spec.rideHeight,
        car.halfExtents,
        0,
        { minY: 0, maxY: collider.height }
      )) {
        return true;
      }
      return !testOBBCollision(candidate, collider);
    });
  }

  _saveRecoveryPose(surface) {
    const tangentX = surface.tangent.x * this.raceDirection;
    const tangentZ = surface.tangent.z * this.raceDirection;
    const alignedHeading = Math.atan2(-tangentX, -tangentZ);
    const current = this.localCar.group.position;
    const candidates = [
      {
        heading: alignedHeading,
        x: surface.nearest.x,
        y: this.localCar.spec.rideHeight,
        z: surface.nearest.z,
      },
      {
        heading: alignedHeading,
        x: current.x,
        y: this.localCar.spec.rideHeight,
        z: current.z,
      },
      {
        heading: this.localCar.group.rotation.y,
        x: current.x,
        y: this.localCar.spec.rideHeight,
        z: current.z,
      },
    ];
    const safePose = candidates.find((candidate) => this._isRecoveryPoseClear(candidate));
    if (safePose) this.lastSafePose = safePose;
  }

  _recoverVehicle() {
    const pose = this.lastSafePose || { ...START_GRID, y: this.localCar.spec.rideHeight };
    this.localCar.reset(
      pose.x,
      pose.z,
      pose.heading,
      this.localCar.spec.rideHeight
    );
    this.stuckTimer = 0;
    showToast(I18n.t('race.recovered'));
    this.particles.burst(
      this.localCar.group.position.clone(),
      [0xf1c644, 0xe84a27, 0xf4ead2],
      12,
      0.3
    );
  }

  _resolveStaticCollisions(telemetry) {
    const car = this.localCar;
    if (!car?.halfExtents) return;
    for (const collider of this.staticColliders) {
      if (!Core.verticalRangesOverlap(
        car.group.position.y,
        car.halfExtents,
        0,
        { minY: 0, maxY: collider.height }
      )) {
        continue;
      }
      const hit = testOBBCollision(vehicleOBB(car), collider);
      if (!hit) continue;
      const impact = Math.abs(car.velocity);
      car.group.position.x -= hit.normal.x * (hit.overlap + 0.008);
      car.group.position.z -= hit.normal.z * (hit.overlap + 0.008);
      clampToBounds(car.group.position);
      car.velocity *= -Math.max(0.08, car.spec.physics.collisionBounce || 0.16);
      addKnockback(car, -hit.normal.x, -hit.normal.z, Math.min(0.55, impact * 0.32));
      telemetry.collided = true;
      telemetry.staticCollision = collider.label;
      this.lastStaticCollision = {
        impact,
        label: collider.label,
        timestamp: performance.now(),
      };
      telemetry.impact = Math.max(telemetry.impact || 0, impact);
      if (impact > 0.2) this._triggerImpactFx(car.group.position, impact);
    }
  }

  _updateEffects(telemetry, delta) {
    const moving = Math.abs(telemetry.velocity) > 0.18;
    const isGroundVehicle = this.localCar.spec.category === 'ground';
    this.dustTimer -= delta;
    this.smokeTimer -= delta;
    this.boostFxTimer -= delta;

    if (this.boostTimer > 0 && this.boostFxTimer <= 0) {
      this.boostFxTimer = 0.035;
      this.particles.spawn(
        this.localCar.pointFromLocal((Math.random() - 0.5) * 0.12, 0.07, 0.23),
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.08,
          0.02 + Math.random() * 0.04,
          (Math.random() - 0.5) * 0.08
        ),
        Math.random() > 0.5 ? 0xf1c644 : 0x5fae7e,
        15 + Math.random() * 5,
        0.4
      );
    }

    if (moving && isGroundVehicle && this.dustTimer <= 0) {
      this.dustTimer = telemetry.drifting ? 0.025 : 0.065;
      const rear = this.localCar.pointFromLocal(
        (Math.random() - 0.5) * 0.18,
        0.055,
        0.2
      );
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.3,
        0.05 + Math.random() * 0.09,
        (Math.random() - 0.5) * 0.3
      );
      this.particles.spawn(
        rear,
        velocity,
        telemetry.drifting ? this.track.palette.shoulder : this.track.palette.dust,
        telemetry.drifting ? 18 : 13,
        0.55 + Math.random() * 0.35
      );
    }

    if (
      Math.abs(telemetry.throttle) > 0.72 &&
      this.localCar.type !== 'helicopter' &&
      this.smokeTimer <= 0
    ) {
      this.smokeTimer = 0.1;
      this.particles.spawn(
        this.localCar.pointFromLocal(0, 0.09, 0.23),
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.08,
          0.08 + Math.random() * 0.05,
          (Math.random() - 0.5) * 0.08
        ),
        0x6f7068,
        11 + Math.random() * 5,
        0.65
      );
    }

    if (this.localCar.type === 'helicopter' && this.dustTimer <= 0) {
      this.dustTimer = 0.045;
      const rotorWash = this.localCar.group.position.clone();
      rotorWash.y = 0.035;
      this.particles.spawn(
        rotorWash,
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.48,
          0.03 + Math.random() * 0.06,
          (Math.random() - 0.5) * 0.48
        ),
        this.track.palette.dust,
        14 + Math.random() * 6,
        0.72
      );
    }

    if (telemetry.collided && telemetry.impact > 0.24) {
      this._triggerImpactFx(this.localCar.group.position, telemetry.impact);
    }
    if (telemetry.landed && telemetry.landingImpact > 0.55) {
      this._triggerImpactFx(
        this.localCar.group.position,
        Math.min(1.4, telemetry.landingImpact * 0.45)
      );
    }
  }

  // Box-collider response: when the controlled vehicle's footprint
  // overlaps another vehicle's (parked locally, or a networked peer),
  // separate them along the minimum-penetration axis and give each a
  // knockback impulse - the controlled vehicle bounces back the way it
  // came, the vehicle it hit bounces the opposite way.
  _resolveVehicleCollisions() {
    const car = this.localCar;
    if (!car || !car.halfExtents) return;

    const others = [];
    for (const [type, other] of this.worldCars) {
      if (type !== car.type) others.push(other);
    }
    others.push(...remoteCars.values());
    const localSurface = this._sampleSurface(car.group.position);
    if (
      this.raceState.status === 'racing' &&
      localSurface.type === 'road' &&
      Math.abs(car.velocity) > 0.12
    ) {
      others.push(...this.aiRacers.map(({ avatar }) => avatar));
    }

    for (const other of others) {
      if (!other.halfExtents) continue;
      if (!Core.verticalRangesOverlap(
        car.group.position.y,
        car.halfExtents,
        other.group.position.y,
        other.halfExtents
      )) {
        continue;
      }
      const hit = testOBBCollision(vehicleOBB(car), vehicleOBB(other));
      if (!hit) continue;

      const { normal, overlap } = hit;
      car.group.position.x -= normal.x * overlap * 0.5;
      car.group.position.z -= normal.z * overlap * 0.5;
      other.group.position.x += normal.x * overlap * 0.5;
      other.group.position.z += normal.z * overlap * 0.5;
      clampToBounds(car.group.position);
      clampToBounds(other.group.position);

      const bounceSpeed = Core.clamp(Math.abs(car.velocity) * 1.3, 0.5, 1.6);
      addKnockback(car, -normal.x, -normal.z, bounceSpeed);
      addKnockback(other, normal.x, normal.z, bounceSpeed * 0.8);
      car.velocity *= -0.3;

      this._triggerImpactFx(car.group.position, bounceSpeed * 0.6);
    }
  }

  _triggerImpactFx(position, impact) {
    if (this.collisionCooldown > 0) return;
    this.collisionCooldown = 0.28;
    this.particles.burst(
      position.clone().add(new THREE.Vector3(0, 0.08, 0)),
      [0xf1c644, 0xe84a27, 0xf4ead2],
      18,
      Math.min(0.8, impact)
    );
    audioManager.playCue('impact');
    if (navigator.vibrate) navigator.vibrate(28);
    document.dispatchEvent(new CustomEvent('car-impact', {
      detail: {
        strength: Math.min(1, Math.max(0.2, impact)),
        duration: 85,
      },
    }));
  }

  render() {
    this.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    if (!this.ownsRenderer) return;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this._positionDesktopCamera();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.thumbnailGeneration += 1;
    cancelBackgroundTask(this.thumbnailTask);
    this.thumbnailTask = null;
    window.removeEventListener('resize', this._resizeHandler);
    document.removeEventListener('game-pause', this._pauseHandler);
    document.removeEventListener('visibilitychange', this._visibilityHandler);
    if (this._placementHandler) {
      this.canvas.removeEventListener('click', this._placementHandler);
      if (this.xrSession) this.xrSession.removeEventListener('select', this._placementHandler);
    }
    if (this.hitTestSource) {
      this.hitTestSource.cancel();
      this.hitTestSource = null;
    }
    const xrSession = this.xrSession;
    this.xrSession = null;
    if (xrSession && typeof xrSession.end === 'function') {
      xrSession.end().catch((error) => {
        console.warn('[xr] WebXR session could not be ended:', error);
      });
    }
    if (this.runtime && window.XR8 && typeof window.XR8.stop === 'function') {
      Promise.resolve(window.XR8.stop()).catch((error) => {
        console.warn('[xr] 8th Wall runtime could not be stopped:', error);
      });
    }
    window.XRRC_XR_INPUT = null;
    if (this.ownsRenderer) this.renderer.setAnimationLoop(null);
    for (const racer of this.aiRacers) racer.avatar.dispose();
    this.aiRacers = [];
    if (this.ghostAvatar) this.ghostAvatar.dispose();
    this.ghostAvatar = null;
    this.skidMarks.dispose();
    for (const car of this.worldCars.values()) car.dispose();
    this.worldCars.clear();
    this.scene.remove(this.gameRoot);
    this.scene.remove(this.reticle);
  }
}

function getRoom() {
  const input = document.getElementById('room-input');
  const room = Config.normalizeRoom(input.value);
  input.value = room;
  return room;
}

function getSignalValue() {
  return document.getElementById('signal-input').value.trim();
}

function getVehicleType() {
  const selected = document.querySelector('input[name="vehicle"]:checked');
  return normalizeVehicleSelection(selected ? selected.value : 'rally');
}

function syncVehicleProfile() {
  const type = getVehicleType();
  const spec = Core.getVehicleSpec(type);
  document.getElementById('vehicle-role').textContent = I18n.t(`vehicle.${type}Role`);
  document.getElementById('vehicle-note').textContent = I18n.t(`vehicle.${type}Note`);
  for (const [rating, value] of Object.entries(spec.ratings)) {
    const meter = document.getElementById(`vehicle-rating-${rating}`);
    meter.style.setProperty('--rating', value);
    meter.setAttribute('aria-valuenow', String(value));
    meter.setAttribute(
      'aria-label',
      `${I18n.t(`vehicle.${rating}`)}: ${value} / 5`
    );
  }
}

function getTrackId() {
  const selected = document.querySelector('input[name="track"]:checked');
  return TrackCore.normalizeTrackId(selected ? selected.value : TrackCore.DEFAULT_TRACK);
}

function syncTrackPresentation(value, updateUrl = false) {
  const trackId = TrackCore.normalizeTrackId(value);
  const input = document.querySelector(`input[name="track"][value="${trackId}"]`);
  if (input) input.checked = true;
  document.documentElement.dataset.track = trackId;
  const caption = document.querySelector('#garage-caption strong');
  if (caption) caption.textContent = I18n.t(`track.${trackId}`);

  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('track', trackId);
    history.replaceState(null, '', url);
  }
  return trackId;
}

function setupTrackPicker(requestedTrack) {
  syncTrackPresentation(requestedTrack, false);
  document.querySelectorAll('input[name="track"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) syncTrackPresentation(input.value, true);
    });
  });
}

function setSignalStatus(state, message, summary) {
  const output = document.getElementById('signal-status');
  output.dataset.state = state;
  output.textContent = message;
  document.getElementById('signal-summary').textContent = summary;
}

function setNetworkStatus(state, message) {
  const pill = document.getElementById('network-pill');
  pill.dataset.state = state;
  document.getElementById('network-label').textContent = message;
}

async function checkBackend() {
  const button = document.getElementById('check-signal-btn');
  const signalValue = getSignalValue();
  if (!signalValue) {
    setSignalStatus('idle', I18n.t('signal.solo'), I18n.t('common.solo'));
    return false;
  }

  button.disabled = true;
  button.textContent = I18n.t('setup.testing');
  setSignalStatus(
    'checking',
    I18n.t('signal.calling'),
    I18n.t('setup.testing')
  );
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4500);
  try {
    const healthUrl = Config.getHealthUrl(signalValue, location.protocol);
    const response = await fetch(healthUrl, {
      cache: 'no-store',
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Relay returned ${response.status}`);
    const health = await response.json();
    if (health.status !== 'ok') throw new Error('Relay health check failed');
    setSignalStatus(
      'ready',
      I18n.t('signal.ready', { count: health.connections }),
      I18n.t('common.ready')
    );
    return true;
  } catch (error) {
    const message = error.name === 'AbortError'
      ? I18n.t('signal.timeout')
      : I18n.t('signal.offline', { message: error.message });
    setSignalStatus('error', message, I18n.t('common.offline'));
    return false;
  } finally {
    window.clearTimeout(timeout);
    button.disabled = false;
    button.textContent = I18n.t('setup.test');
  }
}

function startNetwork(room, signalValue, trackId) {
  if (!signalValue) {
    setNetworkStatus('solo', I18n.t('race.solo'));
    return;
  }

  const signalingUrl = Config.buildSignalUrl(
    signalValue,
    room,
    location.protocol,
    trackId
  );
  networkManager = new window.NetworkManager();
  networkManager.addEventListener('status', ({ detail }) => {
    const translated = {
      connecting: I18n.t('network.connecting'),
      ready: I18n.t('network.ready'),
    };
    setNetworkStatus(detail.state, translated[detail.state] || detail.message);
  });
  networkManager.addEventListener('peer-join', ({ detail }) => {
    if (!game || remoteCars.has(detail.id)) return;
    const car = new Vehicle(detail.color, false);
    car.group.position.x = START_GRID.x + (remoteCars.size + 1) * 0.34;
    game.gameRoot.add(car.group);
    remoteCars.set(detail.id, car);
    document.getElementById('peer-count').textContent = remoteCars.size + 1;
    showToast(I18n.t('race.joined'));
    game._broadcastRace();
  });
  networkManager.addEventListener('peer-leave', ({ detail }) => {
    const car = remoteCars.get(detail.id);
    if (car) car.dispose();
    remoteCars.delete(detail.id);
    document.getElementById('peer-count').textContent = remoteCars.size + 1;
  });
  networkManager.addEventListener('peer-state', ({ detail }) => {
    const car = remoteCars.get(detail.id);
    if (car) {
      car.applyRemoteState(detail.state);
      if (!networkManager.isHost && detail.id === networkManager.hostId) {
        game.adoptRaceRules(detail.state.race);
      }
    }
  });
  networkManager.addEventListener('peer-race', ({ detail }) => {
    const car = remoteCars.get(detail.id);
    if (car) car.applyRaceState(detail.race);
    if (!networkManager.isHost && detail.id === networkManager.hostId) {
      game.adoptRaceRules(detail.race);
    }
  });
  networkManager.addEventListener('host-change', ({ detail }) => {
    if (detail.isHost && game) game._broadcastRace();
  });
  networkManager.connect(signalingUrl);
}

function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(value);
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
}

function loadQrCodeModule() {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import(QR_CODE_SOURCE)
      .then((module) => {
        const qrCode = module.default || module;
        if (typeof qrCode.toCanvas !== 'function') {
          throw new TypeError('The QR code renderer is unavailable.');
        }
        return qrCode;
      })
      .catch((error) => {
        qrCodeModulePromise = null;
        throw error;
      });
  }
  return qrCodeModulePromise;
}

function resetShareCopyButton() {
  window.clearTimeout(shareCopyTimer);
  shareCopyTimer = null;
  const button = document.getElementById('share-copy');
  button.dataset.state = 'idle';
  button.textContent = I18n.t('share.copy');
}

async function renderShareQrCode(shareUrl) {
  const request = ++shareQrRequest;
  const card = document.getElementById('share-qr-card');
  const canvas = document.getElementById('share-qr');
  const status = document.getElementById('share-qr-status');
  card.dataset.state = 'loading';
  canvas.setAttribute('aria-busy', 'true');
  status.textContent = I18n.t('share.qrLoading');

  try {
    const qrCode = await loadQrCodeModule();
    await qrCode.toCanvas(canvas, shareUrl, {
      color: {
        dark: '#24251fff',
        light: '#f4ead2ff',
      },
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    });
    if (request !== shareQrRequest) return;
    canvas.dataset.shareUrl = shareUrl;
    canvas.setAttribute('aria-busy', 'false');
    card.dataset.state = 'ready';
    status.textContent = I18n.t('share.qrReady');
  } catch (error) {
    if (request !== shareQrRequest) return;
    canvas.setAttribute('aria-busy', 'false');
    card.dataset.state = 'error';
    status.textContent = I18n.t('share.qrError');
    console.error('[share] QR code generation failed:', error);
  }
}

function setupShareLink(room, signalValue, trackId) {
  const button = document.getElementById('share-link');
  const dialog = document.getElementById('share-dialog');
  const closeButton = document.getElementById('share-close');
  const copyButton = document.getElementById('share-copy');
  const nativeButton = document.getElementById('share-native');
  const shareInput = document.getElementById('share-url');
  const shareUrl = Config.buildShareUrl(location.href, room, signalValue, trackId);
  const shareData = {
    title: I18n.t('race.roomTitle', { room }),
    text: I18n.t('race.roomInvite', { track: I18n.t(`track.${trackId}`) }),
    url: shareUrl,
  };
  const shareLocation = new URL(shareUrl);
  shareLocation.searchParams.set('laps', String(game?.totalLaps || 3));
  const configuredShareUrl = shareLocation.toString();
  shareData.url = configuredShareUrl;
  const targets = ShareCore.buildShareTargets(shareData);

  shareInput.value = configuredShareUrl;
  shareInput.onfocus = () => shareInput.select();
  document.getElementById('share-room-code').textContent = `#${room.toUpperCase()}`;
  document.getElementById('share-email').href = targets.email;
  document.getElementById('share-sms').href = targets.sms;
  document.getElementById('share-whatsapp').href = targets.whatsapp;

  nativeButton.hidden = typeof navigator.share !== 'function';
  nativeButton.onclick = async () => {
    try {
      await navigator.share(shareData);
    } catch (error) {
      if (error.name !== 'AbortError') showToast(I18n.t('race.shareFailed'));
    }
  };

  copyButton.onclick = async () => {
    try {
      await copyText(configuredShareUrl);
      copyButton.dataset.state = 'success';
      copyButton.textContent = I18n.t('share.copied');
      audioManager.playCue('copy');
      showToast(I18n.t('race.copied'));
      window.clearTimeout(shareCopyTimer);
      shareCopyTimer = window.setTimeout(resetShareCopyButton, 1800);
    } catch {
      showToast(I18n.t('race.shareFailed'));
    }
  };

  closeButton.onclick = () => dialog.close();
  dialog.onclick = (event) => {
    if (event.target === dialog) dialog.close();
  };

  button.hidden = false;
  button.onclick = () => {
    resetShareCopyButton();
    if (!dialog.open) dialog.showModal();
    const qrCanvas = document.getElementById('share-qr');
    if (qrCanvas.dataset.shareUrl !== configuredShareUrl) renderShareQrCode(configuredShareUrl);
  };
}

function showGameUi() {
  const lobby = document.getElementById('lobby');
  const hud = document.getElementById('hud');
  lobby.inert = true;
  lobby.classList.add('is-leaving');
  hud.hidden = false;
  requestAnimationFrame(() => hud.classList.add('is-ready'));
  window.setTimeout(() => {
    if (lobby.classList.contains('is-leaving')) lobby.hidden = true;
  }, 260);
}

function enterGame(runtime = null) {
  const room = getRoom();
  const signalValue = getSignalValue();
  if (signalValue) {
    Config.normalizeSignalUrl(signalValue, location.protocol);
  }
  const props = {
    aiCount: document.getElementById('ai-count').value,
    assist: document.getElementById('steering-assist').checked,
    jump: document.getElementById('prop-jump').checked,
    laps: document.getElementById('lap-count').value,
    loop: document.getElementById('prop-loop').checked,
    multiplayer: Boolean(signalValue),
    track: getTrackId(),
    traffic: document.getElementById('prop-traffic').checked,
  };

  audioManager.start();
  const placementHint = document.getElementById('place-hint');
  placementHint.classList.remove('hidden');
  placementHint.setAttribute('aria-hidden', 'false');
  showGameUi();
  game = new Game(
    document.getElementById('scene'),
    { ...props, vehicle: getVehicleType() },
    runtime
  );
  window.XRRC_DIAGNOSTICS = Object.freeze({
    recover() {
      game._recoverVehicle();
    },
    // Tests that park the car off the course need to observe it there. Auto
    // recovery would otherwise teleport it back to the last safe road pose
    // before the measurement window closes.
    setRecoveryEnabled(enabled) {
      game.recoveryEnabled = enabled !== false;
    },
    summonVehicle(type) {
      return game._summonVehicle(type);
    },
    setWorldVehicleState(type, state) {
      const car = game.worldCars.get(normalizeVehicleSelection(type));
      if (!car || !state || typeof state !== 'object') {
        throw new TypeError('setWorldVehicleState requires an existing vehicle and state');
      }
      for (const key of ['x', 'y', 'z', 'heading', 'velocity', 'verticalVelocity']) {
        if (state[key] !== undefined && !Number.isFinite(state[key])) {
          throw new TypeError(`${key} must be finite`);
        }
      }
      car.reset(
        state.x ?? car.group.position.x,
        state.z ?? car.group.position.z,
        state.heading ?? car.group.rotation.y,
        state.y ?? car.group.position.y
      );
      car.velocity = state.velocity ?? 0;
      car.verticalVelocity = state.verticalVelocity ?? 0;
    },
    sampleSurface(position) {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
        throw new TypeError('sampleSurface requires finite x and z coordinates');
      }
      return game._sampleSurface(position);
    },
    setCourseProgress(progress, state = {}) {
      if (!Number.isFinite(progress) || progress < 0 || progress >= 1) {
        throw new RangeError('setCourseProgress requires progress in [0, 1)');
      }
      const rawProgress = (
        game.startProgress +
        game.raceDirection * progress +
        1
      ) % 1;
      const point = game.trackCurve.getPointAt(rawProgress).multiplyScalar(COURSE_SCALE);
      const tangent = game.trackCurve.getTangentAt(rawProgress).normalize();
      const forwardX = tangent.x * game.raceDirection;
      const forwardZ = tangent.z * game.raceDirection;
      const car = game.localCar;
      car.group.position.set(
        point.x,
        state.y ?? car.spec.rideHeight,
        point.z
      );
      car.group.rotation.y = Math.atan2(-forwardX, -forwardZ);
      car.velocity = state.velocity ?? 0;
      car.verticalVelocity = state.verticalVelocity ?? 0;
      car.airborne = car.group.position.y >
        (car.spec.groundHeight ?? car.spec.rideHeight) + 0.01;
      car.rampContact = false;
    },
    setLocalVehicleState(state) {
      if (!state || typeof state !== 'object') {
        throw new TypeError('setLocalVehicleState requires a state object');
      }
      for (const key of ['x', 'y', 'z', 'heading', 'velocity', 'verticalVelocity']) {
        if (state[key] !== undefined && !Number.isFinite(state[key])) {
          throw new TypeError(`${key} must be finite`);
        }
      }
      const car = game.localCar;
      car.group.position.set(
        state.x ?? car.group.position.x,
        state.y ?? car.group.position.y,
        state.z ?? car.group.position.z
      );
      car.group.rotation.y = state.heading ?? car.group.rotation.y;
      car.velocity = state.velocity ?? car.velocity;
      car.verticalVelocity = state.verticalVelocity ?? car.verticalVelocity;
      car.knockback.x = 0;
      car.knockback.z = 0;
      car.peakY = car.group.position.y;
      car.airborne = car.group.position.y >
        (car.spec.groundHeight ?? car.spec.rideHeight) + 0.01;
      car.rampContact = false;
    },
    snapshot() {
      const render = game.renderer.info.render;
      const memory = game.renderer.info.memory;
      const contextAttributes = game.renderer.getContext().getContextAttributes();
      let objects = 0;
      game.scene.traverse(() => {
        objects += 1;
      });
      return {
        calls: render.calls,
        triangles: render.triangles,
        points: render.points,
        geometries: memory.geometries,
        jumpCount: game.jumpMesh ? game.jumpMesh.count : 0,
        loopRotationY: game.stuntLoop ? game.stuntLoop.rotation.y : null,
        // Ramps and the loop are derived per-circuit, so tests read their real
        // positions from here instead of hard-coding course coordinates.
        jumpZones: game.jumpZones
          ? game.jumpZones.map((zone) => ({ ...zone }))
          : [],
        loopFeature: game.loopFeature ? { ...game.loopFeature } : null,
        textures: memory.textures,
        objects,
        particles: game.particles.count,
        pixelRatio: game.renderer.getPixelRatio(),
        xrScale: game.gameRoot.scale.x,
        antialias: contextAttributes ? contextAttributes.antialias : null,
        courseScale: COURSE_SCALE,
        inputMode: window.XRRC_INPUT_MODE || 'keyboard',
        localVehicleSpeed: game.localCar.velocity,
        localVehicleVerticalSpeed: game.localCar.verticalVelocity,
        lastStaticCollision: game.lastStaticCollision
          ? { ...game.lastStaticCollision }
          : null,
        race: { ...game.raceState },
        totalLaps: game.totalLaps,
        standings: game.standings ? game.standings.map((racer) => ({ ...racer })) : [],
        paused: game.paused,
        assistEnabled: game.assistEnabled,
        boostCharge: game.boostCharge,
        boostActive: game.boostTimer > 0,
        network: networkManager
          ? {
              hostId: networkManager.hostId,
              isHost: networkManager.isHost,
              localId: networkManager.localId,
              peerCount: networkManager.peerCount,
            }
          : null,
        aiRacers: game.aiRacers.map((racer) => ({
          completedLaps: racer.completedLaps,
          finished: racer.finished,
          name: racer.name,
          progress: racer.progress,
        })),
        ghostAvailable: Boolean(game.ghostData),
        ghostVisible: Boolean(game.ghostAvatar?.group.visible),
        recoveryPose: { ...game.lastSafePose },
        recoveryPoseClear: game._isRecoveryPoseClear(game.lastSafePose),
        staticColliderCount: game.staticColliders.length,
        staticColliders: game.staticColliders.map((collider) => ({ ...collider })),
        surface: game._sampleSurface(game.localCar.group.position),
        trackBounds: { ...TRACK_BOUNDS },
        trackLength: game.trackCurve.getLength() * COURSE_SCALE,
        startGrid: { ...START_GRID },
        quality: game.isQuest ? 'quest' : 'standard',
        track: game.track.id,
        trackTheme: game.track.scenery,
        localVehicle: game.localCar.type,
        localVehiclePosition: {
          x: game.localCar.group.position.x,
          y: game.localCar.group.position.y,
          z: game.localCar.group.position.z,
        },
        localVehiclePeakY: game.localCar.peakY,
        localVehicleRender: game.localCar.getRenderDiagnostics(),
        worldVehicles: Array.from(game.worldCars.keys()),
        worldVehicleStates: Array.from(game.worldCars, ([type, car]) => ({
          airborne: car.airborne,
          bounds: { ...car.halfExtents },
          position: {
            x: car.group.position.x,
            y: car.group.position.y,
            z: car.group.position.z,
          },
          type,
        })),
        remoteVehicles: Array.from(remoteCars.values(), (car) => car.type),
        remoteRaceStates: Array.from(remoteCars.values(), (car) => (
          car.raceState ? { ...car.raceState } : null
        )),
        roadNormalY: game.road.geometry.getAttribute('normal').getY(0),
        shadows: game.renderer.shadowMap.enabled,
      };
    },
  });
  startNetwork(room, signalValue, props.track);
  setupShareLink(room, signalValue, props.track);
  return game;
}

function restoreLobby(message) {
  const shareDialog = document.getElementById('share-dialog');
  if (shareDialog.open) shareDialog.close();
  for (const id of ['pause-dialog', 'results-dialog']) {
    const dialog = document.getElementById(id);
    if (dialog.open) dialog.close();
  }
  shareQrRequest += 1;
  if (networkManager) networkManager.disconnect();
  networkManager = null;
  for (const car of remoteCars.values()) {
    car.dispose();
  }
  remoteCars.clear();
  if (game) game.destroy();
  game = null;
  document.getElementById('eighthwall-btn').disabled = false;
  syncWebXRControls();

  const lobby = document.getElementById('lobby');
  const hud = document.getElementById('hud');
  lobby.hidden = false;
  lobby.inert = false;
  lobby.classList.remove('is-leaving');
  hud.classList.remove('is-ready');
  hud.hidden = true;
  document.getElementById('lobby-status').textContent = message;
  // Resume the dream-car turntable preview (no-op if there is no generated car).
  startDreamPreviewLoop();
}

async function runCountdown(activeGame) {
  if (activeGame.countdownStarted) return;
  activeGame.countdownStarted = true;
  activeGame.setActive(false);
  const element = document.getElementById('countdown');
  for (const value of ['3', '2', '1', I18n.t('race.go')]) {
    if (game !== activeGame) return;
    element.textContent = value;
    element.classList.remove('is-visible');
    void element.offsetWidth;
    element.classList.add('is-visible');
    const isGo = value === I18n.t('race.go');
    audioManager.playCue(isGo ? 'go' : 'countdown');
    await new Promise((resolve) => window.setTimeout(resolve, isGo ? 520 : 580));
  }
  element.classList.remove('is-visible');
  element.textContent = '';
  if (game === activeGame) activeGame.beginRace();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function loadScript(source, attributes = {}) {
  const existing = document.querySelector(`script[src="${source}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    for (const [name, value] of Object.entries(attributes)) {
      script.setAttribute(name, value);
    }
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${source}`));
    document.head.appendChild(script);
  });
}

async function start8thWall() {
  const button = document.getElementById('eighthwall-btn');
  button.disabled = true;
  document.getElementById('lobby-status').textContent = I18n.t('status.loadingCamera');
  await audioManager.start();
  try {
    const xrReady = new Promise((resolve) => {
      if (window.XR8) resolve();
      else window.addEventListener('xrloaded', resolve, { once: true });
    });
    await Promise.all(EIGHTH_WALL_SCRIPTS.map(
      ({ url, attributes }) => loadScript(url, attributes)
    ));
    await xrReady;

    // The engine takes over the whole screen with a "continue on your phone"
    // landing page when it is loaded somewhere without a usable camera, and
    // there is no way back from it. Say so here instead.
    const estimate = window.XR8.XrDevice?.deviceEstimate?.();
    if (estimate && estimate.type !== 'mobile') {
      throw new Error(I18n.t('status.cameraMobileOnly'));
    }
    if (window.XR8.XrDevice?.isDeviceBrowserCompatible?.() === false) {
      const reasons = window.XR8.XrDevice.incompatibleReasons?.() || [];
      throw new Error(reasons.join(', ') || I18n.t('status.cameraUnsupported'));
    }

    const started = new Promise((resolve) => {
      notifyEighthWallStarted = resolve;
    });
    if (!eighthWallConfigured) {
      window.XR8.addCameraPipelineModules(
        XRCore.createEighthWallModules({
          LandingPage: window.LandingPage,
          XR8: window.XR8,
          XRExtras: window.XRExtras,
        }, {
          onStart: () => {
            const activeGame = enterGame(window.XR8.Threejs.xrScene());
            activeGame.place();
            if (notifyEighthWallStarted) notifyEighthWallStarted();
          },
          onUpdate: () => {
            if (game) game.update();
          },
        })
      );
      eighthWallConfigured = true;
    }

    // XR8.run() resolves once the pipeline has the canvas, not once the camera
    // feed is live, and a pipeline that fails to start never rejects it.
    // Awaiting it therefore left the lobby stuck on "Loading camera mode..."
    // with the button disabled and no error. Wait for our own onStart instead,
    // with a ceiling generous enough to cover the camera permission prompt.
    window.XR8.run({ canvas: document.getElementById('scene') });
    await Promise.race([
      started,
      new Promise((resolve, reject) => setTimeout(
        () => reject(new Error(I18n.t('status.cameraTimeout'))),
        EIGHTH_WALL_START_TIMEOUT_MS
      )),
    ]);
  } catch (error) {
    notifyEighthWallStarted = null;
    button.disabled = false;
    document.getElementById('lobby-status').textContent = I18n.t(
      'status.cameraError',
      { message: error.message }
    );
  }
}

function syncAudioControls() {
  document.querySelectorAll('[data-audio-toggle]').forEach((button) => {
    const isSfx = button.dataset.audioToggle === 'sfx';
    const enabled = isSfx ? audioManager.sfxEnabled : audioManager.musicEnabled;
    button.setAttribute('aria-pressed', String(enabled));
    const state = button.querySelector('strong');
    if (state) state.textContent = I18n.t(enabled ? 'common.on' : 'common.off');
  });
}

function setupAudioControls() {
  syncAudioControls();
  if (!audioManager.available) {
    document.querySelectorAll('[data-audio-toggle]').forEach((button) => {
      button.disabled = true;
      button.title = I18n.t('audio.unavailable');
    });
    return;
  }
  document.querySelectorAll('[data-audio-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.audioToggle === 'sfx') {
        await audioManager.setSfxEnabled(!audioManager.sfxEnabled);
      } else {
        await audioManager.setMusicEnabled(!audioManager.musicEnabled);
      }
      syncAudioControls();
    });
  });
  audioManager.addEventListener('change', syncAudioControls);
}

function syncWebXRControls() {
  if (!webXRSupportChecked) return;
  const webXRButton = document.getElementById('webxr-btn');
  webXRButton.disabled = !webXRSupported;
  webXRButton.querySelector('span').textContent = I18n.t(
    webXRSupported ? 'mode.webxr' : 'mode.webxrUnavailable'
  );
  webXRButton.querySelector('small').textContent = I18n.t(
    webXRSupported ? 'mode.webxrNote' : 'mode.webxrFallback'
  );
  document.getElementById('lobby-status').textContent = I18n.t(
    webXRSupported ? 'status.ready' : 'status.fallback'
  );
}

function applyLanguage(language, persist = true) {
  I18n.setLanguage(language, persist);
  I18n.applyDocument(document);
  syncTrackPresentation(getTrackId(), false);
  syncVehicleProfile();
  syncAudioControls();
  syncWebXRControls();
  const controllerStatus = document.getElementById('controller-status');
  const state = controllerStatus.dataset.state;
  controllerStatus.textContent = state === 'keyboard'
    ? I18n.t('controller.keyboard')
    : I18n.t(`controller.${state}`, { label: controllerStatus.dataset.label });
}

function updateControllerStatus({ connected, label }) {
  const controllerStatus = document.getElementById('controller-status');
  controllerStatus.dataset.state = connected ? 'connected' : 'disconnected';
  controllerStatus.dataset.label = label;
  controllerStatus.textContent = I18n.t(
    connected ? 'controller.connected' : 'controller.disconnected',
    { label }
  );
  showToast(controllerStatus.textContent);
}

function updateInputMode({ mode }) {
  if (!['gamepad', 'keyboard', 'touch', 'xr'].includes(mode)) return;
  const controllerStatus = document.getElementById('controller-status');
  controllerStatus.dataset.state = mode;
  controllerStatus.dataset.label = '';
  controllerStatus.textContent = I18n.t(`controller.${mode}`);
}

async function bootstrap() {
  const params = new URLSearchParams(location.search);
  applyLanguage(
    I18n.resolveLanguage(
      location.search,
      navigator.languages || [navigator.language],
      I18n.getStoredLanguage()
    ),
    false
  );
  document.getElementById('language-select').addEventListener('change', (event) => {
    applyLanguage(event.target.value);
  });
  document.addEventListener('controller-status', ({ detail }) => {
    updateControllerStatus(detail);
  });
  document.addEventListener('input-mode', ({ detail }) => {
    updateInputMode(detail);
  });
  if (window.XRRC_CONTROLLER_STATUS) {
    updateControllerStatus(window.XRRC_CONTROLLER_STATUS);
  }
  if (window.XRRC_INPUT_MODE) {
    updateInputMode({ mode: window.XRRC_INPUT_MODE });
  }
  const room = params.get('room');
  if (room) document.getElementById('room-input').value = Config.normalizeRoom(room);
  document.getElementById('lap-count').value = String(
    RaceCore.normalizeLapCount(params.get('laps'))
  );
  const rivals = params.get('rivals');
  if (['0', '3', '5'].includes(rivals)) {
    document.getElementById('ai-count').value = rivals;
  }
  let assistEnabled = params.get('assist') !== 'off';
  if (!params.has('assist')) {
    try {
      assistEnabled = window.localStorage.getItem('xrrc-steering-assist') !== 'false';
    } catch (error) {
      console.warn('[race] Steering assist preference is unavailable:', error);
    }
  }
  document.getElementById('steering-assist').checked = assistEnabled;
  setupTrackPicker(params.get('track'));
  const requestedVehicle = normalizeVehicleSelection(params.get('vehicle'));
  const vehicleInput = document.querySelector(
    `input[name="vehicle"][value="${requestedVehicle}"]`
  );
  if (vehicleInput) {
    vehicleInput.checked = true;
    syncVehicleProfile();
    requestAnimationFrame(() => {
      const rail = vehicleInput.closest('.vehicle-rail');
      const card = vehicleInput.closest('.vehicle-toggle');
      rail.scrollLeft = card.offsetLeft - (rail.clientWidth - card.clientWidth) / 2;
    });
  }
  document.querySelectorAll('input[name="vehicle"]').forEach((input) => {
    input.addEventListener('change', syncVehicleProfile);
  });
  document.getElementById('signal-input').value = Config.getInitialSignalValue(
    location,
    window.XRRC_DEPLOYMENT
  );

  setupAudioControls();
  document.getElementById('room-input').addEventListener('blur', getRoom);
  document.getElementById('check-signal-btn').addEventListener('click', checkBackend);
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (game) game.resetCar();
  });
  document.addEventListener('car-reset', () => {
    if (game) game.resetCar();
  });

  const webXRButton = document.getElementById('webxr-btn');
  webXRSupported = navigator.xr
    ? await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
    : false;
  webXRSupportChecked = true;
  syncWebXRControls();

  webXRButton.addEventListener('click', async () => {
    try {
      await enterGame().startWebXR();
    } catch (error) {
      restoreLobby(I18n.t('status.webxrError', { message: error.message }));
    }
  });
  const desktopButton = document.getElementById('desktop-btn');
  desktopButton.addEventListener('click', () => {
    try {
      enterGame().startDesktop();
    } catch (error) {
      restoreLobby(error.message);
      document.getElementById('signal-panel').open = true;
      document.getElementById('signal-input').focus();
    }
  });
  desktopButton.disabled = false;
  const eighthWallButton = document.getElementById('eighthwall-btn');
  eighthWallButton.addEventListener('click', start8thWall);
  eighthWallButton.disabled = false;
  document.getElementById('lobby').setAttribute('aria-busy', 'false');

  // Fill the lobby vehicle glyphs with real renders, and probe for a
  // Tripo-enabled server. initDreamLab is async and self-gating: with no Tripo
  // backend (e.g. the static Pages deploy) the dream lab stays hidden and
  // nothing else changes.
  populateLobbyVehicleThumbnails();
  initDreamLab();

  if (getSignalValue()) {
    document.getElementById('signal-panel').open = true;
    checkBackend();
  }
  if (params.get('controls') === 'touch') {
    document.documentElement.classList.add('force-touch');
  }
  if (params.get('demo') === 'drive') {
    // Constant steering used to trace the old oval, but it drives straight off
    // a circuit with real corners, so the demo now follows the racing line.
    window.XRRC_DEMO_AUTOPILOT = true;
    window.XRRC_DEMO_INPUT = { throttle: 0.88, steering: 0 };
  }
  if (params.get('view') === 'overview') {
    window.XRRC_OVERVIEW_CAMERA = true;
  }
  if (params.get('mode') === 'desktop') {
    window.setTimeout(() => document.getElementById('desktop-btn').click(), 80);
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
