// URDF parsing and a three.js kinematic model (visual / collision geometry, joints, mimic).
import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type Rgba = [number, number, number, number];

export interface Origin {
  xyz: Vec3;
  rpy: Vec3;
}
export type Geometry =
  | { type: 'box'; size: Vec3 }
  | { type: 'cylinder'; radius: number; length: number }
  | { type: 'capsule'; radius: number; length: number }
  | { type: 'sphere'; radius: number }
  | { type: 'mesh'; filename: string; scale: Vec3 };
export interface Visual {
  origin: Origin;
  geometry: Geometry;
  color?: Rgba;
  materialName?: string;
}
export interface Link {
  name: string;
  visuals: Visual[];
  collisions: Visual[];
}
export type JointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar';
export interface Joint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  origin: Origin;
  axis: Vec3;
  limit?: { lower: number; upper: number };
  mimic?: { joint: string; multiplier: number; offset: number };
}
export interface Robot {
  name: string;
  links: Map<string, Link>;
  joints: Map<string, Joint>;
  roots: string[];
}

function nums(s: string | null | undefined, n: number, def: number): number[] {
  const out = (s ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  while (out.length < n) out.push(def);
  return out.slice(0, n).map((v) => (Number.isFinite(v) ? v : def));
}

function childrenNamed(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === tag);
}

function first(el: Element, tag: string): Element | undefined {
  return childrenNamed(el, tag)[0];
}

function parseOrigin(el: Element | undefined): Origin {
  return { xyz: nums(el?.getAttribute('xyz'), 3, 0) as Vec3, rpy: nums(el?.getAttribute('rpy'), 3, 0) as Vec3 };
}

function parseColor(mat: Element | undefined): Rgba | undefined {
  const c = mat && first(mat, 'color');
  return c ? (nums(c.getAttribute('rgba'), 4, 1) as Rgba) : undefined;
}

function parseGeometry(el: Element | undefined): Geometry | undefined {
  const g = el && Array.from(el.children)[0];
  if (!g) return undefined;
  switch (g.localName) {
    case 'box':
      return { type: 'box', size: nums(g.getAttribute('size'), 3, 0) as Vec3 };
    case 'cylinder':
      return { type: 'cylinder', radius: Number(g.getAttribute('radius') ?? 0), length: Number(g.getAttribute('length') ?? 0) };
    case 'capsule':
      return { type: 'capsule', radius: Number(g.getAttribute('radius') ?? 0), length: Number(g.getAttribute('length') ?? 0) };
    case 'sphere':
      return { type: 'sphere', radius: Number(g.getAttribute('radius') ?? 0) };
    case 'mesh':
      return { type: 'mesh', filename: g.getAttribute('filename') ?? '', scale: nums(g.getAttribute('scale'), 3, 1) as Vec3 };
  }
  return undefined;
}

export function parseUrdf(xml: string): Robot {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`invalid XML: ${err.textContent?.trim().split('\n')[0] ?? ''}`);
  const root = doc.documentElement;
  if (root.localName !== 'robot') throw new Error(`root element is <${root.localName}>, expected <robot>`);
  const materials = new Map<string, Rgba>();
  for (const m of childrenNamed(root, 'material')) {
    const c = parseColor(m);
    if (c && m.getAttribute('name')) materials.set(m.getAttribute('name')!, c);
  }
  const links = new Map<string, Link>();
  for (const l of childrenNamed(root, 'link')) {
    const name = l.getAttribute('name') ?? '';
    const parseVis = (v: Element): Visual | undefined => {
      const geometry = parseGeometry(first(v, 'geometry'));
      if (!geometry) return undefined;
      const mat = first(v, 'material');
      const materialName = mat?.getAttribute('name') ?? undefined;
      let color = parseColor(mat);
      if (!color && materialName) color = materials.get(materialName);
      return { origin: parseOrigin(first(v, 'origin')), geometry, color, materialName };
    };
    links.set(name, {
      name,
      visuals: childrenNamed(l, 'visual').map(parseVis).filter((x): x is Visual => !!x),
      collisions: childrenNamed(l, 'collision').map(parseVis).filter((x): x is Visual => !!x),
    });
  }
  const joints = new Map<string, Joint>();
  const children = new Set<string>();
  for (const j of childrenNamed(root, 'joint')) {
    const name = j.getAttribute('name') ?? '';
    const lim = first(j, 'limit');
    const mim = first(j, 'mimic');
    const joint: Joint = {
      name,
      type: (j.getAttribute('type') ?? 'fixed') as JointType,
      parent: first(j, 'parent')?.getAttribute('link') ?? '',
      child: first(j, 'child')?.getAttribute('link') ?? '',
      origin: parseOrigin(first(j, 'origin')),
      axis: nums(first(j, 'axis')?.getAttribute('xyz') ?? '1 0 0', 3, 0) as Vec3,
      limit: lim ? { lower: Number(lim.getAttribute('lower') ?? 0), upper: Number(lim.getAttribute('upper') ?? 0) } : undefined,
      mimic: mim
        ? {
            joint: mim.getAttribute('joint') ?? '',
            multiplier: Number(mim.getAttribute('multiplier') ?? 1),
            offset: Number(mim.getAttribute('offset') ?? 0),
          }
        : undefined,
    };
    joints.set(name, joint);
    children.add(joint.child);
  }
  const roots = [...links.keys()].filter((l) => !children.has(l));
  return { name: root.getAttribute('name') ?? 'robot', links, joints, roots };
}

/** URDF rpy (fixed axes X, Y, Z) == intrinsic Z-Y'-X'' Euler. */
function applyOrigin(obj: THREE.Object3D, o: Origin): void {
  obj.position.set(o.xyz[0], o.xyz[1], o.xyz[2]);
  obj.rotation.set(o.rpy[0], o.rpy[1], o.rpy[2], 'ZYX');
}

export type MeshLoader = (filename: string) => Promise<THREE.Object3D>;

export interface JointHandle {
  joint: Joint;
  motion: THREE.Object3D;
  value: number;
}

export interface ModelOptions {
  loadMesh: MeshLoader;
  defaultColor: string;
  onMeshError: (filename: string, err: Error) => void;
}

/**
 * Three.js scene graph for a URDF:
 *   link group -> joint origin group -> motion group -> child link group.
 * Visual / collision geometry lives in per-link "visual" / "collision" groups so
 * links can be highlighted without affecting their descendants.
 */
export class RobotModel {
  readonly root = new THREE.Group();
  readonly links = new Map<string, THREE.Group>();
  readonly visualGroups = new Map<string, THREE.Group>();
  readonly collisionGroups = new Map<string, THREE.Group>();
  readonly joints = new Map<string, JointHandle>();
  readonly frames: THREE.AxesHelper[] = [];
  pending = 0;
  failed: string[] = [];

  constructor(
    readonly robot: Robot,
    private readonly opts: ModelOptions,
  ) {
    for (const [name] of robot.links) {
      const g = new THREE.Group();
      g.name = name;
      g.userData.link = name;
      const vis = new THREE.Group();
      vis.userData.link = name;
      const col = new THREE.Group();
      col.userData.link = name;
      col.visible = false;
      g.add(vis, col);
      this.links.set(name, g);
      this.visualGroups.set(name, vis);
      this.collisionGroups.set(name, col);
    }
    for (const j of robot.joints.values()) {
      const parent = this.links.get(j.parent);
      const child = this.links.get(j.child);
      if (!parent || !child) continue;
      const originGroup = new THREE.Group();
      applyOrigin(originGroup, j.origin);
      const motion = new THREE.Group();
      originGroup.add(motion);
      motion.add(child);
      parent.add(originGroup);
      this.joints.set(j.name, { joint: j, motion, value: 0 });
    }
    for (const r of robot.roots) this.root.add(this.links.get(r)!);
    for (const [name, link] of robot.links) {
      for (const v of link.visuals) this.addGeometry(this.visualGroups.get(name)!, v, false);
      for (const v of link.collisions) this.addGeometry(this.collisionGroups.get(name)!, v, true);
    }
  }

  /** Movable joints (not fixed, not mimic). */
  get movable(): JointHandle[] {
    return [...this.joints.values()].filter((h) => ['revolute', 'continuous', 'prismatic'].includes(h.joint.type) && !h.joint.mimic);
  }

  setJoint(name: string, value: number): boolean {
    const h = this.joints.get(name);
    if (!h || !Number.isFinite(value)) return false;
    h.value = value;
    this.applyJoint(h);
    return true;
  }

  /** Re-evaluates mimic joints from their masters. */
  updateMimic(): void {
    for (const h of this.joints.values()) {
      const m = h.joint.mimic;
      if (!m) continue;
      const master = this.joints.get(m.joint);
      if (!master) continue;
      h.value = master.value * m.multiplier + m.offset;
      this.applyJoint(h);
    }
  }

  private applyJoint(h: JointHandle): void {
    const a = new THREE.Vector3(...h.joint.axis);
    if (a.lengthSq() === 0) a.set(1, 0, 0);
    a.normalize();
    if (h.joint.type === 'revolute' || h.joint.type === 'continuous') {
      h.motion.quaternion.setFromAxisAngle(a, h.value);
    } else if (h.joint.type === 'prismatic') {
      h.motion.position.copy(a.multiplyScalar(h.value));
    }
  }

  showCollision(on: boolean): void {
    for (const g of this.collisionGroups.values()) g.visible = on;
  }

  showVisual(on: boolean): void {
    for (const g of this.visualGroups.values()) g.visible = on;
  }

  showFrames(on: boolean, size: number): void {
    if (on && !this.frames.length) {
      for (const g of this.links.values()) {
        const ax = new THREE.AxesHelper(size);
        ax.userData.helper = true;
        (ax.material as THREE.Material).depthTest = false;
        ax.renderOrder = 10;
        g.add(ax);
        this.frames.push(ax);
      }
    }
    for (const f of this.frames) f.visible = on;
  }

  /** Pose of a link in the robot root frame. */
  linkPose(name: string): { xyz: THREE.Vector3; quat: THREE.Quaternion } | undefined {
    const g = this.links.get(name);
    if (!g) return undefined;
    this.root.updateMatrixWorld(true);
    const m = new THREE.Matrix4().copy(this.root.matrixWorld).invert().multiply(g.matrixWorld);
    const xyz = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    m.decompose(xyz, quat, new THREE.Vector3());
    return { xyz, quat };
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) mat.dispose();
    });
  }

  private material(color: Rgba | undefined, collision: boolean): THREE.MeshStandardMaterial {
    if (collision) {
      return new THREE.MeshStandardMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.35, roughness: 0.8, depthWrite: false });
    }
    const c = color ? new THREE.Color(color[0], color[1], color[2]) : new THREE.Color(this.opts.defaultColor);
    const alpha = color ? color[3] : 1;
    return new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.15, transparent: alpha < 1, opacity: alpha });
  }

  private addGeometry(parent: THREE.Group, v: Visual, collision: boolean): void {
    const holder = new THREE.Group();
    applyOrigin(holder, v.origin);
    holder.userData.link = parent.userData.link;
    parent.add(holder);
    const g = v.geometry;
    let geom: THREE.BufferGeometry | undefined;
    switch (g.type) {
      case 'box':
        geom = new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]);
        break;
      case 'sphere':
        geom = new THREE.SphereGeometry(g.radius, 32, 16);
        break;
      case 'cylinder':
        // URDF cylinders are along Z, three.js cylinders along Y
        geom = new THREE.CylinderGeometry(g.radius, g.radius, g.length, 32).rotateX(Math.PI / 2);
        break;
      case 'capsule':
        geom = new THREE.CapsuleGeometry(g.radius, g.length, 8, 24).rotateX(Math.PI / 2);
        break;
      case 'mesh':
        this.pending++;
        this.opts
          .loadMesh(g.filename)
          .then((obj) => {
            obj.scale.set(g.scale[0], g.scale[1], g.scale[2]);
            obj.traverse((o) => {
              const m = o as THREE.Mesh;
              o.userData.link = parent.userData.link;
              if (!m.isMesh) return;
              if (m.geometry && !m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
              const keepOwn = !v.color && !collision && hasOwnMaterial(m);
              if (!keepOwn) m.material = this.material(v.color, collision);
              else m.material = cloneMaterial(m.material);
            });
            holder.add(obj);
          })
          .catch((e: Error) => {
            this.failed.push(g.filename);
            this.opts.onMeshError(g.filename, e);
          })
          .finally(() => this.pending--);
        return;
    }
    if (geom) {
      const mesh = new THREE.Mesh(geom, this.material(v.color, collision));
      mesh.userData.link = parent.userData.link;
      holder.add(mesh);
    }
  }
}

function hasOwnMaterial(m: THREE.Mesh): boolean {
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return mats.some((x) => x && !(x as THREE.Material & { userData: { generic?: boolean } }).userData.generic && x.type !== 'MeshNormalMaterial');
}

function cloneMaterial(mat: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  return Array.isArray(mat) ? mat.map((m) => m.clone()) : mat.clone();
}
