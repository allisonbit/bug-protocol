import * as THREE from "three";
import { PLAN, planFor } from "@/lib/world/city";
import type { CityState, StructureKind, StructureState, ZoneState } from "@/lib/world/types";

/**
 * The place: land, sea, sky, streets, greenery and the town the swarm builds.
 *
 * WHAT IS REAL HERE. Which plots are built, how tall each building is, which of
 * them are lit, and how far the town has expanded. Every one of those reads off
 * `world.structures` and `world.city`, which are folds over the rows.
 *
 * WHAT IS STYLE. The land, the coast, the sea, the sky, the sun, the trees, the
 * colour of the stone and the pattern of lit windows. None of it is a claim about
 * the swarm. Two style rules in here are worth naming because they are the two
 * things that make the place feel alive rather than decorated:
 *
 *   1. THE PAVING GROWS. The built ground reaches as far as the town has actually
 *      expanded, and no further, so the settlement is a clearing in the land whose
 *      edge moves as the swarm does more. At nothing built it is a hamlet; later
 *      it is a town.
 *   2. THE GREEN GIVES WAY. A plot that is planned but unbuilt carries a tree, and
 *      the tree is replaced when a row fills that plot. So an empty street is a
 *      street with gardens in it, and development is visible as the loss of green
 *      rather than only as the arrival of boxes.
 *
 * Neither rule invents anything: both are driven by `city.phase` and by which
 * plots the structures occupy, which are readings of the record.
 */

/** The land, the sea and the light. All style: the hour the town is seen at. */
export const PLACE = {
  sea: "#1d4a63",
  seaEmissive: "#0d2531",
  shallow: "#2f6f86",
  sand: "#8d8163",
  grass: "#46552f",
  dry: "#6b6444",
  rock: "#6f6a5c",
  road: "#6f6a5c",
  paving: "#5f5a4c",
  zenith: "#22406e",
  horizon: "#a9c2d6",
  warm: "#e8a86a",
  sun: "#ffe9c0",
  fog: "#9db4c6",
  trunk: "#4a3b2c",
  leaf: "#3f5a30",
  leafDry: "#556b31",
} as const;

export type Cityscape = {
  /** Project the town: raise the new, upgrade the grown, remove the gone, and re-plan the streets. */
  apply(structures: StructureState[], city: CityState): void;
  /** Called every frame. Rises a new building, pulses one that gained a storey. */
  update(dt: number): void;
  /** With motion reduced a new building simply exists at full height rather than rising. */
  setReducedMotion(on: boolean): void;
  /** What is really in the scene, so a probe can check the place rather than trust it. */
  counts(): { buildings: number; trees: number; streets: number; heights: number[] };
  /**
   * Everything here a click can land on, so the renderer can cast one ray at the
   * place and get an answer for the land, the water, the streets, the trees and
   * the buildings alike. A thing that is drawn and cannot be asked about is the
   * one kind of object this world does not have.
   */
  pickables(): THREE.Object3D[];
  /** Which plot a tree instance stands on, or null for the countryside. */
  treePlot(instanceId: number): { zone: string; index: number; ring: number } | null;
  dispose(): void;
};

/**
 * A pick, tagged onto the object itself with `userData`.
 *
 * Kept as a plain tag rather than a registry: an object that is removed from the
 * scene takes its pick with it, so a building the swarm has not raised yet cannot
 * be clicked by a stale lookup. `userData` is also inherited by walking up the
 * parents, which is how a beacon on a monument answers for the monument.
 */
export type PickTag =
  | { kind: "agent"; agentId: string }
  | { kind: "structure"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "plot"; zone: string; index: number; ring: number }
  | { kind: "tree" }
  | { kind: "street"; zone: string | null; ring: number | null }
  | { kind: "land" }
  | { kind: "sea" };

export function tag(object: THREE.Object3D, pick: PickTag): void {
  object.userData.pick = pick;
}

/** The pick an object answers for, found by walking up to whoever tagged it. */
export function pickTagOf(object: THREE.Object3D | null): PickTag | null {
  let node: THREE.Object3D | null = object;
  while (node) {
    const tag = node.userData.pick as PickTag | undefined;
    if (tag) return tag;
    node = node.parent;
  }
  return null;
}

/** Deterministic 32 bit hash. The same one the projector uses. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Two textures from one seeded generator: what a wall looks like by day, and
 * which of its windows are lit. They have to be separate: one texture used as both
 * `map` and `emissiveMap` would make the wall itself glow, which is what turned
 * every building into a slab of light the first time this was drawn.
 */
function facadeTextures(): { map: THREE.Texture; emissive: THREE.Texture } {
  const wall = document.createElement("canvas");
  const glow = document.createElement("canvas");
  wall.width = wall.height = 64;
  glow.width = glow.height = 64;
  const gw = wall.getContext("2d");
  const gg = glow.getContext("2d");
  if (gw && gg) {
    // Wall: a light neutral so the material's own colour decides the stone, with
    // the window openings darker than the wall they are cut into.
    gw.fillStyle = "#cfc9bd";
    gw.fillRect(0, 0, 64, 64);
    gg.fillStyle = "#000000";
    gg.fillRect(0, 0, 64, 64);
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let row = 0; row < 8; row++) {
      // Every storey gets a floor band, so a tall building reads as storeys.
      gw.fillStyle = "#b3ada2";
      gw.fillRect(0, row * 8 + 6, 64, 1.4);
      for (let col = 0; col < 8; col++) {
        const r = rnd();
        const x = 2 + col * 8;
        const y = 1 + row * 8;
        gw.fillStyle = "#3b3a38";
        gw.fillRect(x, y, 4, 4);
        // Roughly one window in three is lit; about half of those brightly.
        if (r > 0.66) {
          const v = r > 0.9 ? 255 : 150;
          gg.fillStyle = `rgb(${v},${Math.round(v * 0.86)},${Math.round(v * 0.62)})`;
          gg.fillRect(x, y, 4, 4);
        }
      }
    }
  }
  const map = new THREE.CanvasTexture(wall);
  const emissive = new THREE.CanvasTexture(glow);
  for (const t of [map, emissive]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
  }
  return { map, emissive };
}

/** Repeat a box's UVs so windows tile per storey instead of stretching over it. */
function tileUv(geo: THREE.BufferGeometry, across: number, up: number): void {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * across, uv.getY(i) * up);
  uv.needsUpdate = true;
}

/** The coast is not a circle: a few harmonics give the shore an outline that reads as land. */
function coastRadius(angle: number): number {
  return 31 + 3.1 * Math.sin(angle * 3 + 0.7) + 1.5 * Math.sin(angle * 7 + 2.1) + 0.8 * Math.sin(angle * 11 + 0.3);
}

/** Where the sun sits, and where its light comes from. */
const SUN_DIR = new THREE.Vector3(0.62, 0.32, 0.42).normalize();

function makeSky(): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(260, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(PLACE.zenith) },
      horizon: { value: new THREE.Color(PLACE.horizon) },
      warm: { value: new THREE.Color(PLACE.warm) },
      sunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: "varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: [
      "uniform vec3 top; uniform vec3 horizon; uniform vec3 warm; uniform vec3 sunDir;",
      "varying vec3 vPos;",
      "void main(){",
      "  vec3 n = normalize(vPos);",
      "  float t = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);",
      "  vec3 c = mix(horizon, top, pow(t, 0.75));",
      // A warm band where the sun is low, strongest towards the sun itself, so the
      // sky has a direction rather than being a gradient.
      "  float toSun = max(0.0, dot(normalize(vec3(n.x, 0.0, n.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))));",
      "  c += warm * pow(1.0 - abs(n.y), 5.0) * (0.35 + 0.65 * pow(toSun, 2.0));",
      "  gl_FragColor = vec4(c, 1.0);",
      "}",
    ].join("\n"),
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -2;
  group.add(dome);

  // The sun itself, and a halo around it, both unlit so the hour is visible from
  // anywhere in the scene rather than only from a camera facing the light.
  const sun = new THREE.Mesh(new THREE.SphereGeometry(6.5, 20, 12), new THREE.MeshBasicMaterial({ color: PLACE.sun, fog: false }));
  sun.position.copy(SUN_DIR).multiplyScalar(215);
  sun.renderOrder = -1;
  group.add(sun);

  const haloCanvas = document.createElement("canvas");
  haloCanvas.width = haloCanvas.height = 128;
  const hg = haloCanvas.getContext("2d");
  if (hg) {
    const grad = hg.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,236,196,0.85)");
    grad.addColorStop(0.35, "rgba(255,206,150,0.28)");
    grad.addColorStop(1, "rgba(255,190,130,0)");
    hg.fillStyle = grad;
    hg.fillRect(0, 0, 128, 128);
  }
  const haloTex = new THREE.CanvasTexture(haloCanvas);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  halo.position.copy(sun.position);
  halo.scale.setScalar(120);
  group.add(halo);
  return group;
}

/**
 * The island: a plateau where the town stands, gentle hills outside it, a beach,
 * and a sea floor below the waterline.
 */
function makeTerrain(): THREE.Mesh {
  const size = 116;
  const geo = new THREE.PlaneGeometry(size, size, 150, 150);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(PLACE.grass);
  const dry = new THREE.Color(PLACE.dry);
  const sand = new THREE.Color(PLACE.sand);
  const rock = new THREE.Color(PLACE.rock);
  const seabed = new THREE.Color("#16222c");
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    const coast = coastRadius(angle);
    let y: number;
    if (r < coast) {
      // Flat where the town is, because a building cannot stand on a slope, and
      // gently rising beyond it so the island has a shape.
      const t = Math.max(0, Math.min(1, (r - 21) / 8));
      y = t * t * (1.5 + 0.9 * Math.sin(angle * 4 + 1.3)) + Math.sin(x * 0.35) * Math.cos(z * 0.31) * 0.035;
      // Beach: the last two and a half units fall away into the water.
      const edge = coast - 2.5;
      if (r > edge) y -= ((r - edge) / 2.5) * 1.9;
    } else {
      y = -1.9 - Math.min(1.4, (r - coast) * 0.1);
    }
    pos.setY(i, y);

    // Colour by height and distance from the shore: grass, dry grass, sand, rock.
    const above = y + 0.35;
    if (r > coast - 0.4) c.copy(seabed).lerp(sand, Math.max(0, Math.min(1, (coast + 1 - r) / 1.6)));
    else if (r > coast - 3) c.copy(sand);
    else if (above > 0.9) c.copy(rock).lerp(dry, 0.5);
    else c.copy(grass).lerp(dry, Math.max(0, Math.min(1, (r - 14) / 20)) * 0.8);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 });
  return new THREE.Mesh(geo, mat);
}

type Entry = {
  group: THREE.Group;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  beacon: THREE.Mesh | null;
  floors: number;
  height: number;
  lit: boolean;      trouble: boolean;
      /** True while a live lease authorizes an actuation here. Diffed like trouble. */
      leased: boolean;
      /** Tasks only: the work text, diffed so a changed card rebuilds the post. */
      work: string | null;
      mark: THREE.Mesh | null;
      leaseRing: THREE.Mesh | null;
  rise: number;
  pulse: number;
};

export function createCityscape(scene: THREE.Scene, zones: ZoneState[]): Cityscape {
  const facade = facadeTextures();
  const root = new THREE.Group();
  scene.add(root);

  const sky = makeSky();
  scene.add(sky);

  const terrain = makeTerrain();
  root.add(terrain);
  tag(terrain, { kind: "land" });

  // ---- the sea --------------------------------------------------------------
  // Wider than the island by a long way, so its own edge is lost in the haze and
  // the land reads as surrounded rather than as floating on a plate.
  const seaGeo = new THREE.PlaneGeometry(460, 460, 64, 64);
  const seaMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PLACE.sea),
    emissive: new THREE.Color(PLACE.seaEmissive),
    emissiveIntensity: 1,
    roughness: 0.18,
    metalness: 0.5,
    transparent: true,
    opacity: 0.94,
  });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.42;
  root.add(sea);
  tag(sea, { kind: "sea" });
  const seaBase = Float32Array.from(seaGeo.attributes.position.array as Float32Array);

  // ---- the paved ground the town stands on ----------------------------------
  // Its radius is a reading, not a constant: it reaches as far as the town has
  // actually expanded, so the clearing in the land grows as the swarm builds.
  const pavingMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PLACE.paving), roughness: 0.92, metalness: 0.03 });
  const pavingGroup = new THREE.Group();
  root.add(pavingGroup);

  // ---- streets --------------------------------------------------------------
  const streetGroup = new THREE.Group();
  root.add(streetGroup);
  const streetMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PLACE.road), transparent: true, opacity: 0.55 });
  let streetCount = 0;

  // ---- greenery -------------------------------------------------------------
  // Instanced, because a countryside is a lot of trees and a few hundred separate
  // meshes would cost frames this world does not have to spend.
  const TREES = 900;
  const trunkGeo = new THREE.CylinderGeometry(0.06, 0.09, 0.55, 5);
  const canopyGeo = new THREE.ConeGeometry(0.44, 1.15, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PLACE.trunk), roughness: 0.9 });
  // White on purpose: an instanced canopy carries its colour per instance, and a
  // coloured material multiplies with it. Setting both turned every tree almost
  // black, which is what the first pass looked like: black spikes on green land.
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREES);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, TREES);
  trunks.frustumCulled = false;
  canopies.frustumCulled = false;
  root.add(trunks);
  root.add(canopies);
  trunks.count = 0;
  canopies.count = 0;
  // Both halves of a tree answer for the tree, and which plot it stands on is
  // resolved from the instance number when a click lands.
  tag(trunks, { kind: "tree" });
  tag(canopies, { kind: "tree" });
  const frozen = new THREE.Object3D();
  let treeCount = 0;

  /**
   * Where every tree instance stands.
   *
   * Kept as a list index-aligned with the instanced meshes, because a click on a
   * canopy comes back as an instance number and nothing else: without this, a tree
   * would be a thing you can hit and not a thing you can ask about.
   */
  const treePlots: { zone: string; index: number; ring: number }[] = [];

  function plant(x: number, z: number, seedKey: string, plot: { zone: string; index: number; ring: number } | null): void {
    if (treeCount >= TREES) return;
    const h = hash(seedKey);
    const scale = 0.8 + ((h % 100) / 100) * 0.7;
    const yaw = ((h >>> 8) % 360) * (Math.PI / 180);
    frozen.position.set(x, 0.27 * scale, z);
    frozen.rotation.set(0, yaw, 0);
    frozen.scale.setScalar(scale);
    frozen.updateMatrix();
    trunks.setMatrixAt(treeCount, frozen.matrix);
    frozen.position.y = 0.9 * scale;
    frozen.updateMatrix();
    canopies.setMatrixAt(treeCount, frozen.matrix);
    canopies.setColorAt(treeCount, new THREE.Color(PLACE.leaf).lerp(new THREE.Color(PLACE.leafDry), (h % 1000) / 1000));
    // A garden stands on a plot; a countryside tree stands on the island.
    treePlots[treeCount] = plot ?? { zone: "", index: -1, ring: -1 };
    treeCount++;
  }

  // ---- lamps ----------------------------------------------------------------
  const lampGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.9, 5);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x2f2f33, roughness: 0.7, metalness: 0.2 });
  const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });
  for (const zone of zones) {
    if (zone.sealed) continue;
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(zone.position.x, 0.45, zone.position.z + zone.radius * 0.9);
    root.add(lamp);
    tag(lamp, { kind: "zone", id: zone.id });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(lamp.position.x, 0.95, lamp.position.z);
    root.add(bulb);
    tag(bulb, { kind: "zone", id: zone.id });
  }

  // ---- the buildings --------------------------------------------------------
  const cityGroup = new THREE.Group();
  root.add(cityGroup);
  const entries = new Map<string, Entry>();
  const BEACON = 1.9;
  /** The trouble red. Cooler than the warn page colour, so it reads on dark stone. */
  const TROUBLE = 0xff4d3d;
  /**
   * The lease green. Deliberately not the trouble red and not the warm window glow:
   * the ring says a person authorized an act here, which is a different claim about
   * the same building and must never be mistaken for either of the other two.
   */
  const LEASED = 0x6ef2a8;

  /** Light warm stone to dark slate, so a street of houses has tone in it. */
  const LOOK: Record<StructureKind, { stone: number; glow: number }> = {
    house: { stone: 0x8d7a63, glow: 0xffb066 },
    vault: { stone: 0x77808f, glow: 0x9fd8ff },
    lab: { stone: 0x8a7fa0, glow: 0xb39cff },
    archive: { stone: 0x9a8a6f, glow: 0xffd28a },
    source: { stone: 0x6f8c86, glow: 0x7fe3d0 },
    monument: { stone: 0x8e9a72, glow: 0xd4fc50 },
    hall: { stone: 0x9c8f78, glow: 0xfff0cc },
    guild: { stone: 0x9a7a5e, glow: 0xff9a5c },
    post: { stone: 0x7d8794, glow: 0xcfe8ff },
    task: { stone: 0x8a8f76, glow: 0xffd76a },
    // Something an agent put somewhere on purpose, so it is warmer than the
    // record material around it: the town's own colour, for the town's own work.
    fixture: { stone: 0x8f8468, glow: 0xffcf7a },
    // Hardware at the shore. Sea-worn teal stone with a warm lamp: a machine is
    // a guest with a body, and its light means it reported recently, so the
    // Harbour reads as inhabited exactly when the hardware is alive.
    machine: { stone: 0x5f7d78, glow: 0xffe2a8 },
  };

  function build(s: StructureState): Entry {
    const look = LOOK[s.kind] ?? { stone: 0x8a8f96, glow: 0xcfe8ff };
    const w = s.footprint * 2;
    const geo = new THREE.BoxGeometry(w, s.height, w);
    tileUv(geo, Math.max(1, Math.round(w * 1.6)), Math.max(1, s.floors));
    const mat = new THREE.MeshStandardMaterial({
      map: facade.map,
      emissiveMap: facade.emissive,
      color: new THREE.Color(look.stone),
      emissive: new THREE.Color(look.glow),
      // A settled row is a building with its lights on. An open question is a dark
      // one: the difference between a record and a claim is visible from outside.
      // A task post glows harder while the work is open, because at the Docks
      // light means "someone can take this" — and goes fully dark once it cannot.
      emissiveIntensity: s.kind === "task" ? (s.lit ? 1.15 : 0.0) : s.lit ? 0.95 : 0.16,
      roughness: 0.82,
      metalness: 0.05,
    });
    // A roof is stone, not windows: BoxGeometry's material order is +x, -x, +y, -y, +z, -z.
    const roof = new THREE.MeshStandardMaterial({ color: new THREE.Color(look.stone).multiplyScalar(0.55), roughness: 0.9, metalness: 0.04 });
    const mesh = new THREE.Mesh(geo, [mat, mat, roof, roof, mat, mat]);
    mesh.position.y = s.height / 2;

    const group = new THREE.Group();
    group.position.set(s.position.x, 0, s.position.z);
    group.rotation.y = s.facing;
    group.add(mesh);
    // The building answers for the rows beneath it, so clicking a roof, a wall or
    // the beacon above a monument all land on the same record.
    tag(group, { kind: "structure", id: s.id });

    let beacon: THREE.Mesh | null = null;
    if (s.lit && (s.kind === "monument" || s.kind === "lab")) {
      beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.11, BEACON, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(look.glow), transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }),
      );
      beacon.position.y = s.height + BEACON / 2;
      group.add(beacon);
    }
    // The trouble mark: a red disc set slightly off the wall, drawn ONLY when
    // the machine's newest reading is an alert. It is the record made visible,
    // not a diagnosis: the words are the machine's own, on its page. Deterministic
    // placement, so the same building carries the mark in the same spot in every
    // projection and replay.
    let mark: THREE.Mesh | null = null;
    if (s.kind === "machine" && s.trouble) {
      mark = new THREE.Mesh(
        new THREE.CircleGeometry(0.09, 20),
        new THREE.MeshBasicMaterial({ color: TROUBLE, toneMapped: false }),
      );
      const a = Math.sin(s.position.x * 12.9898) * 43758.5453;
      mark.position.set(0.28 + (a - Math.floor(a)) * 0.06, Math.min(s.height * 0.72, 0.62), s.footprint / 2 + 0.012);
      mark.rotation.y = 0;
      group.add(mark);
    }
    // The lease ring: a thin band of light laid on the ground around the machine,
    // drawn ONLY while a live lease authorizes an actuation on it. The disc is the
    // machine's own report of trouble; this is a person's written authority, so the
    // two are drawn differently and never merge into one mark. Laid flat and slightly
    // wider than the footprint, so it reads as ground the machine stands on rather
    // than a storey it has gained.
    let leaseRing: THREE.Mesh | null = null;
    if (s.kind === "machine" && s.leased) {
      leaseRing = new THREE.Mesh(
        new THREE.RingGeometry(s.footprint * 0.95, s.footprint * 1.22, 32),
        new THREE.MeshBasicMaterial({ color: LEASED, toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      leaseRing.rotation.x = -Math.PI / 2;
      leaseRing.position.y = 0.012;
      group.add(leaseRing);
    }

    cityGroup.add(group);
    return {
      group,
      mesh,
      geo,
      mat,
      beacon,
      floors: s.floors,
      height: s.height,
      lit: s.lit,
      trouble: !!s.trouble,
      leased: !!s.leased,
      work: s.kind === "task" ? (s.work ?? "") : null,
      mark,
      leaseRing,
      rise: 0,
      pulse: 0,
    };
  }

  function teardown(entry: Entry): void {
    cityGroup.remove(entry.group);
    entry.geo.dispose();
    entry.mat.dispose();
    if (entry.beacon) {
      entry.beacon.geometry.dispose();
      (entry.beacon.material as THREE.Material).dispose();
    }
    if (entry.mark) {
      entry.mark.geometry.dispose();
      (entry.mark.material as THREE.Material).dispose();
    }
    if (entry.leaseRing) {
      entry.leaseRing.geometry.dispose();
      (entry.leaseRing.material as THREE.Material).dispose();
    }
  }

  const reduced = { on: false };

  /**
   * Lay the streets, the paving and the greenery for a given state of the town.
   *
   * Everything here is rebuilt from the plan each time the town changes, because
   * the town's extent changes with it: a street that has no plots on it yet is not
   * drawn, and a tree stands on a plot until a row builds there.
   */
  function planGround(structures: StructureState[], city: CityState): void {
    for (const child of [...streetGroup.children]) {
      streetGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
    }
    streetCount = 0;
    treeCount = 0;

    for (const child of [...pavingGroup.children]) {
      pavingGroup.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }

    // How far each district's built ground reaches: the outermost ring in use,
    // plus a plot. Rewritten every time the town changes, so the built ground is
    // exactly as large as the town has actually grown to.
    const reach = PLAN.inner + (city.phase + 1) * PLAN.ringStep + 0.9;
    for (const zone of zones) {
      if (zone.sealed) continue;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.min(zone.radius + PLAN.districtBonus, reach), 64), pavingMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(zone.position.x, 0.012, zone.position.z);
      pavingGroup.add(disc);
      tag(disc, { kind: "zone", id: zone.id });
    }

    // Which plots are taken, per district, so a street can be drawn where the
    // town is and a garden where it is not.
    const taken = new Map<string, Set<number>>();
    for (const s of structures) {
      const set = taken.get(s.zone) ?? new Set<number>();
      set.add(s.plot);
      taken.set(s.zone, set);
    }

    for (const zone of zones) {
      if (zone.sealed) continue;
      const plots = planFor(zone.position, zone.radius + PLAN.districtBonus);
      const occupied = taken.get(zone.id) ?? new Set<number>();
      let ringSeen = -1;

      for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];
        // Beyond the town's reach is open country: it is planned, and nothing is
        // drawn there, because drawing a street nobody has built would be the plan
        // claiming work the swarm has not done.
        if (plot.ring > city.phase) continue;

        if (plot.ring !== ringSeen) {
          ringSeen = plot.ring;
          // One street per ring, which is what a ring of plots faces.
          const ring = new THREE.Mesh(new THREE.RingGeometry(plot.radius - 0.22, plot.radius + 0.22, 64), streetMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(zone.position.x, 0.03, zone.position.z);
          streetGroup.add(ring);
          tag(ring, { kind: "street", zone: zone.id, ring: plot.ring });
          streetCount++;
        }

        // A planned but unbuilt plot: a garden. This is the greenery that
        // development takes away. Only every third one, because a garden on every
        // open plot buries the town in woodland and hides the plan the streets are
        // drawn to: a built street with room still on it looks like one.
        if (!occupied.has(i) && hash(`${zone.id}:${i}`) % 3 === 0) {
          plant(plot.x, plot.z, `${zone.id}:${i}`, { zone: zone.id, index: i, ring: plot.ring });
        }
      }

      // Radial avenues from the district centre to its outer ring, so the streets
      // form a town plan rather than a set of circles.
      const outer = PLAN.inner + city.phase * PLAN.ringStep;
      for (let a = 0; a < 4; a++) {
        const angle = (a / 4) * Math.PI * 2 + Math.PI / 8;
        const len = outer - PLAN.inner * 0.5;
        const avenue = new THREE.Mesh(new THREE.PlaneGeometry(0.34, len), streetMat);
        avenue.rotation.x = -Math.PI / 2;
        avenue.rotation.z = -angle - Math.PI / 2;
        avenue.position.set(zone.position.x + Math.cos(angle) * (PLAN.inner * 0.5 + len / 2), 0.03, zone.position.z + Math.sin(angle) * (PLAN.inner * 0.5 + len / 2));
        streetGroup.add(avenue);
        tag(avenue, { kind: "street", zone: zone.id, ring: null });
        streetCount++;
      }
    }

    // The main road that connects the districts, and the roads into the plaza.
    const real = zones.filter((z) => !z.sealed && z.id !== "plaza");
    const ringR = real.reduce((m, z) => Math.max(m, Math.hypot(z.position.x, z.position.z)), 0);
    if (ringR > 1) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(ringR - 0.42, ringR + 0.42, 128), streetMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.025;
      streetGroup.add(ring);
      tag(ring, { kind: "street", zone: null, ring: null });
      streetCount++;
    }
    for (const zone of real) {
      const dist = Math.hypot(zone.position.x, zone.position.z);
      if (dist < 1) continue;
      const spoke = new THREE.Mesh(new THREE.PlaneGeometry(0.3, dist), streetMat);
      spoke.rotation.x = -Math.PI / 2;
      spoke.rotation.z = -Math.atan2(zone.position.x, zone.position.z);
      spoke.position.set(zone.position.x / 2, 0.025, zone.position.z / 2);
      streetGroup.add(spoke);
      tag(spoke, { kind: "street", zone: null, ring: null });
      streetCount++;
    }

    // Countryside: the land outside the town, thinned by a low discrepancy walk so
    // it reads as scattered woodland rather than as a ring or a grid.
    const golden = 2.399963;
    const country = 260;
    for (let i = 0; i < country && treeCount < TREES; i++) {
      const angle = i * golden;
      const t = (i + 0.5) / country;
      const r = 25 + Math.sqrt(t) * 8.5;
      if (r > coastRadius(angle) - 1.6) continue;
      // Nothing inside a district's plan, even outside its reach: that land is
      // reserved by the plan, and a forest in the middle of a street grid would
      // contradict the plan the town is actually being built to.
      const inside = zones.some((z) => !z.sealed && Math.hypot(z.position.x - Math.cos(angle) * r, z.position.z - Math.sin(angle) * r) < z.radius + PLAN.districtBonus + 0.4);
      if (inside) continue;
      plant(Math.cos(angle) * r, Math.sin(angle) * r, `country:${i}`, null);
    }

    trunks.count = treeCount;
    canopies.count = treeCount;
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
  }

  return {
    apply(structures, city) {
      planGround(structures, city);

      const live = new Set<string>();
      for (const s of structures) {
        live.add(s.id);
        const entry = entries.get(s.id);
        if (!entry) {
          entries.set(s.id, build(s));
          continue;
        }
        if (entry.floors !== s.floors) {
          // The record grew and the building grew with it. Rebuilt rather than
          // scaled, because storeys are structure, and pulsed so a visitor who is
          // watching sees the minute in which it happened.
          teardown(entry);
          const next = build(s);
          next.rise = 1;
          next.pulse = 1;
          entries.set(s.id, next);
          continue;
        }
        if (entry.lit !== s.lit) {
          entry.lit = s.lit;
          entry.mat.emissiveIntensity = s.kind === "task" ? (s.lit ? 1.15 : 0.0) : s.lit ? 0.95 : 0.16;
        }
        if (entry.work !== (s.kind === "task" ? (s.work ?? "") : null)) {
          // A task post's text changed, which means the row it stands for was
          // replaced: rebuild so the label and the pulse follow the record.
          teardown(entry);
          const next = build(s);
          next.pulse = 1;
          entries.set(s.id, next);
        } else if (entry.leased !== !!s.leased) {
          // Authority was granted or withdrawn. Same treatment as the trouble mark,
          // for the same reason: the ring is geometry on the building, not a sprite,
          // so the honest way to change it is to rebuild and pulse.
          teardown(entry);
          const next = build(s);
          next.pulse = 1;
          entries.set(s.id, next);
        } else if (entry.trouble !== !!s.trouble) {
          // Trouble arrived or cleared. Rebuild, because the mark is part of the
          // building's geometry rather than a sprite to toggle; a rebuild pulses
          // the emissive too, which is the right announcement either way.
          teardown(entry);
          const next = build(s);
          next.pulse = 1;
          entries.set(s.id, next);
        }
      }
      for (const [id, entry] of [...entries]) {
        if (live.has(id)) continue;
        teardown(entry);
        entries.delete(id);
      }
    },

    update(dt) {
      // The sea breathes in crossing swells, like the waterline in the mark. With
      // motion reduced it holds still, because a moving sea is the one thing here
      // that runs whether or not anything has happened.
      if (!reduced.on) {
        const pos = seaGeo.attributes.position as THREE.BufferAttribute;
        const t = performance.now() / 1000;
        for (let i = 0; i < pos.count; i++) {
          const x = seaBase[i * 3];
          const y = seaBase[i * 3 + 1];
          pos.setZ(i, Math.sin(x * 0.06 + t * 0.4) * 0.16 + Math.cos(y * 0.07 - t * 0.31) * 0.13);
        }
        pos.needsUpdate = true;
      }

      const riseStep = dt / 1.5;
      for (const entry of entries.values()) {
        if (entry.rise < 1) {
          entry.rise = Math.min(1, entry.rise + riseStep);
          const e = 1 - Math.pow(1 - entry.rise, 3);
          entry.group.scale.y = reduced.on ? 1 : Math.max(0.02, e);
        }
        if (entry.pulse > 0) {
          entry.pulse = Math.max(0, entry.pulse - dt / 1.4);
          const base = entry.lit ? 0.95 : 0.16;
          entry.mat.emissiveIntensity = base + entry.pulse * 1.5;
        }
      }
    },

    setReducedMotion(on) {
      reduced.on = on;
      if (on) for (const entry of entries.values()) entry.group.scale.y = 1;
    },

    pickables() {
      // The land and the water first, so a hit on them is found even where a tree
      // or a street overlaps: the ray is sorted by distance, not by this order, so
      // this is only the list of things worth asking about.
      return [terrain, sea, trunks, canopies, pavingGroup, streetGroup, cityGroup];
    },

    treePlot(instanceId) {
      const plot = treePlots[instanceId];
      if (!plot || plot.index < 0) return null;
      return plot;
    },

    counts() {
      return {
        buildings: entries.size,
        trees: treeCount,
        streets: streetCount,
        heights: [...entries.values()].slice(0, 8).map((e) => Math.round(e.height * 100) / 100),
      };
    },

    dispose() {
      for (const entry of entries.values()) teardown(entry);
      entries.clear();
      scene.remove(sky);
      sky.traverse((o) => {
        const m = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
        if (m.geometry) m.geometry.dispose();
      });
      scene.remove(root);
      facade.map.dispose();
      facade.emissive.dispose();
      for (const child of [...streetGroup.children]) (child as THREE.Mesh).geometry?.dispose();
      streetMat.dispose();
      pavingMat.dispose();
      for (const child of [...pavingGroup.children]) (child as THREE.Mesh).geometry?.dispose();
      trunkGeo.dispose();
      canopyGeo.dispose();
      trunkMat.dispose();
      canopyMat.dispose();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    },
  };
}
