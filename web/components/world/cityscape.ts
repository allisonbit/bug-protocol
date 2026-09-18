import * as THREE from "three";
import type { StructureKind, StructureState, ZoneState } from "@/lib/world/types";

/**
 * The city, the sky above it and the streets between.
 *
 * WHAT IS REAL HERE. Every building is a row, drawn where the projector put it,
 * standing for good. Nothing in this file decides that something exists: it draws
 * `world.structures` and nothing else, so if the swarm is quiet the skyline does
 * not move, and when a row lands a building appears.
 *
 * WHAT IS STYLE. The sky's colours, the tint of each kind of building, the pattern
 * of lit windows, the streets and the lamps. None of it is a claim about the
 * swarm: a lit window means the row behind that building is settled, and the
 * pattern of which windows are lit within a wall is a fixed texture, the same on
 * every machine, so two people looking at one moment see the same city.
 *
 * WHY A CITY AT ALL. A body is present tense and leaves. A building is the record
 * given a place to stand, so the habitat accumulates instead of resetting: the
 * Wall gets a monument per finding, the Vaults a block per shared fact, the Docks
 * a house per agent whose height is the tier that agent has earned. The swarm
 * grows the city by doing its work, and nobody has to be told to build.
 */

/** Per kind: wall stone, and what its windows glow. Style, not data. */
const LOOK: Record<StructureKind, { stone: number; glow: number }> = {
  house: { stone: 0x2b2a2e, glow: 0xffb066 },
  vault: { stone: 0x242a33, glow: 0x9fd8ff },
  lab: { stone: 0x2a2634, glow: 0xb39cff },
  archive: { stone: 0x2e2a22, glow: 0xffd28a },
  source: { stone: 0x22302f, glow: 0x7fe3d0 },
  monument: { stone: 0x2b3126, glow: 0xd4fc50 },
  hall: { stone: 0x302c26, glow: 0xfff0cc },
  guild: { stone: 0x312722, glow: 0xff9a5c },
  post: { stone: 0x262b33, glow: 0xcfe8ff },
};

/** The sky, fog and water. Style: the night the city stands in. */
export const NIGHT = {
  zenith: "#080c16",
  horizon: "#2b3a5e",
  warm: "#55432a",
  fog: "#1d2740",
  water: "#121d2d",
} as const;

export type Cityscape = {
  /** Project a new set of buildings: raise the new, upgrade the grown, remove the gone. */
  apply(structures: StructureState[]): void;
  /** Called every frame. Rises a new building, pulses one that gained a storey. */
  update(dt: number): void;
  /** With motion reduced a new building simply exists at full height rather than rising. */
  setReducedMotion(on: boolean): void;
  /** What is actually in the scene, so a probe can check the city rather than trust it. */
  counts(): { buildings: number; heights: number[] };
  dispose(): void;
};

/**
 * The window wall: a fixed texture, one pixel grid of lit and dark windows.
 *
 * A seeded generator rather than `Math.random`, so every visitor sees the same
 * building with the same windows and a shared moment renders identically. Fixed
 * numbers because this is texture, not information.
 */
function windowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  if (g) {
    // Wall first, windows second. Most of a facade at night is stone: a texture
    // that is mostly lit reads as a grid of pixels rather than as a building, and
    // that is exactly what the first version of this looked like.
    g.fillStyle = "#0c0f14";
    g.fillRect(0, 0, 64, 64);
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = rnd();
        // Two thirds dark, so a facade has structure, and one window in ten is
        // bright: a city where every window is lit is a city nobody lives in.
        const v = r > 0.9 ? 225 : r > 0.66 ? 120 : r > 0.5 ? 56 : 22;
        g.fillStyle = `rgb(${v},${Math.round(v * 0.94)},${Math.round(v * 0.82)})`;
        g.fillRect(2 + col * 8, 2 + row * 8, 3, 3);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Repeat a box's UVs so windows tile per storey instead of stretching over it. */
function tileUv(geo: THREE.BufferGeometry, across: number, up: number): void {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * across, uv.getY(i) * up);
  uv.needsUpdate = true;
}

/** A sky that has a horizon instead of an edge, so the band is a place rather than a rectangle. */
function makeSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(250, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(NIGHT.zenith) },
      horizon: { value: new THREE.Color(NIGHT.horizon) },
      warm: { value: new THREE.Color(NIGHT.warm) },
    },
    vertexShader: "varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: [
      "uniform vec3 top; uniform vec3 horizon; uniform vec3 warm;",
      "varying vec3 vPos;",
      "void main(){",
      "  float h = normalize(vPos).y;",
      "  float t = clamp(h * 0.5 + 0.5, 0.0, 1.0);",
      "  vec3 c = mix(horizon, top, pow(t, 0.55));",
      "  c += warm * pow(1.0 - abs(h), 6.0) * 0.85;",
      "  gl_FragColor = vec4(c, 1.0);",
      "}",
    ].join("\n"),
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

type Entry = {
  group: THREE.Group;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  beacon: THREE.Mesh | null;
  floors: number;
  height: number;
  lit: boolean;
  /** 0 while a building is still rising out of the ground, 1 once it is up. */
  rise: number;
  /** Set when a storey was added, so growth is visible and not only counted. */
  pulse: number;
};

export function createCityscape(scene: THREE.Scene, zones: ZoneState[]): Cityscape {
  const tex = windowTexture();
  const root = new THREE.Group();
  scene.add(root);

  // ---- the sky and the water the city stands on -----------------------------
  const sky = makeSky();
  scene.add(sky);

  // ---- streets: a ring connecting the eight places, and a road to each ------
  const streets = new THREE.Group();
  root.add(streets);
  const real = zones.filter((z) => !z.sealed && z.id !== "plaza");
  const ringR = real.reduce((m, z) => Math.max(m, Math.hypot(z.position.x, z.position.z)), 0);
  if (ringR > 1) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ringR - 0.4, ringR + 0.4, 128),
      // Lighter than the water it crosses, so it reads as a lit road rather than as
      // a black band cut out of the ground, which is how it read the first time.
      new THREE.MeshBasicMaterial({ color: 0x33415f, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    streets.add(ring);
  }
  for (const zone of real) {
    const dist = Math.hypot(zone.position.x, zone.position.z);
    if (dist < 1) continue;
    const spoke = new THREE.Mesh(
      new THREE.PlaneGeometry(0.32, dist),
      new THREE.MeshBasicMaterial({ color: 0x2b3752, transparent: true, opacity: 0.45 }),
    );
    spoke.rotation.x = -Math.PI / 2;
    spoke.rotation.z = -Math.atan2(zone.position.x, zone.position.z);
    spoke.position.set(zone.position.x / 2, 0.011, zone.position.z / 2);
    streets.add(spoke);
  }

  // ---- the pool of light the city stands in -------------------------------
  //
  // Style, and the thing that made the difference between a habitat on dark ground
  // and a place: a soft warm pool under the ring, so the ground the swarm actually
  // uses is lit and the water beyond it falls away into the night.
  const poolCanvas = document.createElement("canvas");
  poolCanvas.width = 256;
  poolCanvas.height = 256;
  const pg = poolCanvas.getContext("2d");
  if (pg) {
    const grad = pg.createRadialGradient(128, 128, 8, 128, 128, 128);
    grad.addColorStop(0, "rgba(150,175,235,0.26)");
    grad.addColorStop(0.45, "rgba(96,120,180,0.16)");
    grad.addColorStop(0.78, "rgba(52,70,110,0.06)");
    grad.addColorStop(1, "rgba(20,28,48,0)");
    pg.fillStyle = grad;
    pg.fillRect(0, 0, 256, 256);
  }
  const poolTex = new THREE.CanvasTexture(poolCanvas);
  // Wide, with a long tail, so the city's light reaches the outer ring and fades
  // rather than ending in a visible circle.
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.006;
  root.add(pool);

  // ---- lamps: one per place, so a zone reads as somewhere someone stands -----
  const lampGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.8, 5);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.7, metalness: 0.2 });
  const bulbGeo = new THREE.SphereGeometry(0.085, 8, 6);
  for (const zone of zones) {
    if (zone.sealed) continue;
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(zone.position.x, 0.4, zone.position.z + zone.radius * 0.92);
    root.add(lamp);
    const bulb = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xffe6b0 }));
    bulb.position.set(lamp.position.x, 0.85, lamp.position.z);
    root.add(bulb);
  }

  // ---- the buildings --------------------------------------------------------
  const cityGroup = new THREE.Group();
  root.add(cityGroup);
  const entries = new Map<string, Entry>();

  /** Height of the beacon a settled monument throws upward: a lit record, visible from far off. */
  const BEACON = 1.9;

  function build(s: StructureState): Entry {
    const look = LOOK[s.kind] ?? { stone: 0x2a2f38, glow: 0xcfe8ff };
    const w = s.footprint * 2;
    const geo = new THREE.BoxGeometry(w, s.height, w);
    tileUv(geo, Math.max(1, Math.round(w * 1.5)), Math.max(1, s.floors));
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      color: new THREE.Color(look.stone),
      emissive: new THREE.Color(look.glow),
      // A settled row is a building with its lights on. An open question is a dark
      // one: the difference between a record and a claim is visible from outside.
      emissiveIntensity: s.lit ? 1.0 : 0.22,
      roughness: 0.86,
      metalness: 0.04,
    });
    // A roof is stone, not windows. The first version tiled the window texture over
    // the top face too, which turned every building into a slab of glowing pixels
    // seen from above, which is the angle most of this world is actually viewed
    // from. BoxGeometry's material order is +x, -x, +y, -y, +z, -z.
    const roof = new THREE.MeshStandardMaterial({ color: new THREE.Color(look.stone).multiplyScalar(0.7), roughness: 0.92, metalness: 0.04 });
    const mesh = new THREE.Mesh(geo, [mat, mat, roof, roof, mat, mat]);
    mesh.position.y = s.height / 2;

    const group = new THREE.Group();
    group.position.set(s.position.x, 0, s.position.z);
    // A little yaw from the id, so a row of identical houses reads as a street
    // rather than as a grid, and still lands the same way every time.
    group.rotation.y = ((s.id.length * 37) % 360) * (Math.PI / 180) * 0.1;
    group.add(mesh);

    let beacon: THREE.Mesh | null = null;
    if (s.lit && (s.kind === "monument" || s.kind === "lab")) {
      const bg = new THREE.CylinderGeometry(0.045, 0.11, BEACON, 6, 1, true);
      beacon = new THREE.Mesh(
        bg,
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(look.glow),
          transparent: true,
          opacity: 0.36,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      beacon.position.y = s.height + BEACON / 2;
      group.add(beacon);
    }
    cityGroup.add(group);
    return { group, mesh, geo, mat, beacon, floors: s.floors, height: s.height, lit: s.lit, rise: 0, pulse: 0 };
  }

  function teardown(entry: Entry): void {
    cityGroup.remove(entry.group);
    entry.geo.dispose();
    entry.mat.dispose();
    if (entry.beacon) {
      entry.beacon.geometry.dispose();
      (entry.beacon.material as THREE.Material).dispose();
    }
  }

  const reduced = { on: false };

  return {
    apply(structures) {
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
          entry.mat.emissiveIntensity = s.lit ? 1.05 : 0.26;
        }
      }
      for (const [id, entry] of [...entries]) {
        if (live.has(id)) continue;
        teardown(entry);
        entries.delete(id);
      }
    },

    update(dt) {
      const riseStep = dt / 1.5;
      for (const entry of entries.values()) {
        if (entry.rise < 1) {
          entry.rise = Math.min(1, entry.rise + riseStep);
          const e = 1 - Math.pow(1 - entry.rise, 3);
          entry.group.scale.y = reduced.on ? 1 : Math.max(0.02, e);
        }
        if (entry.pulse > 0) {
          entry.pulse = Math.max(0, entry.pulse - dt / 1.4);
          const base = entry.lit ? 1.05 : 0.26;
          entry.mat.emissiveIntensity = base + entry.pulse * 1.5;
        }
      }
    },

    setReducedMotion(on) {
      reduced.on = on;
      if (on) for (const entry of entries.values()) entry.group.scale.y = 1;
    },

    counts() {
      return {
        buildings: entries.size,
        heights: [...entries.values()].slice(0, 8).map((e) => Math.round(e.height * 100) / 100),
      };
    },

    dispose() {
      for (const entry of entries.values()) teardown(entry);
      entries.clear();
      tex.dispose();
      poolTex.dispose();
      scene.remove(sky);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      scene.remove(root);
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
