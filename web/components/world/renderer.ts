import * as THREE from "three";
import { rgbForTopic } from "@/lib/world/mapping";
import type { BodyState, VisualEvent, WorldState } from "@/lib/world/types";
import { createCityscape, NIGHT } from "./cityscape";
import { buildHumanoid, palettesFrom, type ActionId, type BodyPalette, type Humanoid } from "./humanoid";

/**
 * The world, in three.js, lazily loaded.
 *
 * WHAT IS REAL: who is standing where, which zone each body's last act put it in,
 * the colour of the ring, the strength of the aura, the name, the sentence in a
 * bubble (the same sentence `/feed` prints, from the same function), the pad that
 * lights because a row landed in that zone, and the beam that leaves a body when
 * it writes to the shared brain.
 *
 * WHAT IS STYLE: the water, the drift of the camera, the sky colour, the length
 * of a stride, and the exact spot inside a zone, which is a hash of the agent id.
 * `bodies` are placed by `project.ts` and this file only interpolates toward them.
 *
 * The budget this file is written to: sixty frames a second with every agent
 * drawn, on a laptop, while the rest of the site stays interactive. That means
 * shared geometry, one material per body rather than per part, no shadows, a
 * capped device pixel ratio, and a render loop that stops the moment the band
 * leaves the viewport or the tab goes to the background.
 */

export type CameraMode = "orbit" | "free" | "follow" | "top";

export type Overlays = {
  names: boolean;
  speech: boolean;
  thoughts: boolean;
  connections: boolean;
  groups: boolean;
  memory: boolean;
};

export type RendererStats = { fps: number; drawn: number; paused: boolean };

export type WorldRenderer = {
  setWorld(world: WorldState): void;
  pushEvent(e: VisualEvent): void;
  setOverlays(o: Overlays): void;
  setCameraMode(m: CameraMode): void;
  follow(agentId: string | null): void;
  onPick(cb: (agentId: string | null) => void): void;
  setReducedMotion(reduced: boolean): void;
  setPaused(paused: boolean): void;
  resize(): void;
  stats(): RendererStats;
  dispose(): void;
};

type BodyEntry = {
  humanoid: Humanoid;
  target: THREE.Vector3;
  /** Current rendered position, interpolated toward `target`. */
  current: THREE.Vector3;
  facing: number;
  label: THREE.Sprite;
  traitKey: string;
  bubble: { sprite: THREE.Sprite; until: number } | null;
  pulseUntil: number;
  activity: string;
  zone: string;
};

/** A short lived mark: a finding dropping, a beam to the vaults, a tip. */
type Mark = {
  object: THREE.Object3D;
  /** Held directly rather than reached for through `object`, which is not typed to have one. */
  material: THREE.Material & { opacity: number };
  born: number;
  life: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** A line only fades; a shard also rises and turns. */
  line: boolean;
};

const SPEECH_MS = 10 * 60 * 1000;
/** How long a transient mark stays on screen. */
const MARK_MS = 4200;

/**
 * The palette, read from the page rather than duplicated here.
 *
 * The fallbacks are the dark palette because dark is the only theme: they are
 * what the world draws with if a variable has not resolved yet, and a light
 * fallback would flash a white ground onto a black page.
 */
function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    chalk: v("--color-chalk", "#ffffff"),
    mist: v("--color-mist", "#b8b8b8"),
    accent: v("--color-bug", "#d4fc50"),
    accentDeep: v("--color-bug-deep", "#6f9f18"),
    lime: v("--color-lime", "#d4fc50"),
    line: v("--color-line", "#262626"),
    surface: v("--color-ink-soft", "#161616"),
  };
}

/**
 * Text as a sprite.
 *
 * Canvas rather than a font loader, because the page already has its fonts and a
 * second typography system for labels would be a second thing to keep in step.
 * Sized in pixels and then scaled into world units, so the labels stay crisp.
 */
function makeLabel(text: string, color: string, opts: { size?: number; bg?: string; max?: number } = {}): THREE.Sprite {
  const size = opts.size ?? 30;
  const trimmed = text.length > (opts.max ?? 46) ? text.slice(0, (opts.max ?? 46) - 1) + "\u2026" : text;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
  const width = Math.ceil(ctx.measureText(trimmed).width) + 22;
  const height = size + 18;
  canvas.width = width;
  canvas.height = height;

  const c2 = canvas.getContext("2d")!;
  if (opts.bg) {
    c2.fillStyle = opts.bg;
    const r = height / 2;
    c2.beginPath();
    c2.moveTo(r, 0);
    c2.lineTo(width - r, 0);
    c2.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
    c2.lineTo(r, height);
    c2.arc(r, r, r, Math.PI / 2, -Math.PI / 2);
    c2.closePath();
    c2.fill();
  }
  c2.font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
  c2.fillStyle = color;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  c2.fillText(trimmed, width / 2, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  // World units: roughly 0.5 units tall regardless of the text length.
  const scale = 0.62;
  sprite.scale.set((width / height) * scale * 0.62, scale * 0.62, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function disposeSprite(sprite: THREE.Sprite): void {
  const m = sprite.material as THREE.SpriteMaterial;
  m.map?.dispose();
  m.dispose();
}

/** The action a body's current activity implies, so a claim reads as reaching for the board. */
function actionFor(activityTopic: string | null): ActionId {
  if (!activityTopic) return "still";
  if (activityTopic === "agent.claim" || activityTopic === "finding.new" || activityTopic === "output.published") return "reach";
  if (activityTopic === "swamp.vote" || activityTopic === "swamp.meeting") return "raise";
  if (activityTopic === "finding.review" || activityTopic === "source.checked") return "carry";
  return "still";
}

export function createWorldRenderer(canvas: HTMLCanvasElement, initial: WorldState): WorldRenderer {
  const theme = readTheme();
  const palettes: BodyPalette[] = palettesFrom(theme);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new THREE.Scene();
  // Fog takes the far edge into the night rather than into the page colour: the
  // world has a horizon now, and a horizon that dissolved into the site's own
  // near-black would read as a rectangle pasted onto the page. The near bound sits
  // beyond the sealed ring, because the camera is about forty units out and a
  // nearer fog would grey the far half of the habitat a visitor came to watch.
  scene.fog = new THREE.Fog(new THREE.Color(NIGHT.fog), 70, 205);

  const camera = new THREE.PerspectiveCamera(42, 2, 0.5, 400);
  const clock = new THREE.Clock();

  // Night lighting, deliberately dim: the city lights itself. The windows and the
  // lamps are emissive, so the work these three lights do is to give the walls,
  // the water and the bodies shape, not to illuminate the scene. Raising them to
  // daylight levels would flatten every lit window into the same grey wall.
  const hemi = new THREE.HemisphereLight(new THREE.Color("#3d4a6b"), new THREE.Color("#0b0e14"), 0.62);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(new THREE.Color("#cdd9ff"), 0.5);
  key.position.set(18, 30, 14);
  scene.add(key);
  const rim = new THREE.DirectionalLight(new THREE.Color("#8d7bd6"), 0.3);
  rim.position.set(-22, 14, -18);
  scene.add(rim);

  // ---- the ground: the brand's own waterline, in three dimensions -----------
  // Wide enough that its own edge is past the fog and never shows as a line
  // across the sky, which is what a 190 unit plane did once the horizon existed.
  const waterGeo = new THREE.PlaneGeometry(420, 420, 120, 120);
  const waterMat = new THREE.MeshStandardMaterial({
    // Water rather than the page's own surface: the city stands on something, and
    // a metalness this high is what lets the lamp and window light gather on it.
    color: new THREE.Color(NIGHT.water),
    roughness: 0.24,
    metalness: 0.42,
    transparent: true,
    // Opaque enough to catch the city's light instead of letting the page's black
    // through it, which is what kept the ground a void in the first pass.
    opacity: 0.86,
    // A floor of its own light, because the night lights are deliberately dim and
    // a lit city standing on pitch black water is still a city in a void: that is
    // exactly how the second pass looked, with the light pool reading as an island
    // and everything past it black. This is the ground being visible rather than
    // the ground being illuminated, and it is the darkest value that still reads.
    emissive: new THREE.Color("#0c1524"),
    emissiveIntensity: 1,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.05;
  scene.add(water);
  const waterBase = Float32Array.from(waterGeo.attributes.position.array as Float32Array);

  // ---- the zones -----------------------------------------------------------
  const zonePads = new THREE.Group();
  scene.add(zonePads);

  type PadHandle = { id: string; ring: THREE.MeshBasicMaterial; disc: THREE.MeshStandardMaterial };
  const padHandles = new Map<string, PadHandle>();

  for (const zone of initial.zones) {
    const sealed = zone.sealed != null;
    const discMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(sealed ? theme.mist : theme.accent),
      roughness: 0.9,
      transparent: true,
      opacity: sealed ? 0.05 : 0.09,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(zone.radius, 40), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(zone.position.x, 0.005, zone.position.z);
    zonePads.add(disc);

    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(sealed ? theme.mist : theme.accent),
      transparent: true,
      opacity: sealed ? 0.22 : 0.3,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(zone.radius * 0.97, zone.radius, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(zone.position.x, 0.008, zone.position.z);
    zonePads.add(ring);

    const label = makeLabel(zone.name, sealed ? theme.mist : theme.mist, { size: 26, bg: theme.surface });
    label.position.set(zone.position.x, 0.35, zone.position.z + zone.radius + 0.9);
    label.scale.multiplyScalar(1.35);
    zonePads.add(label);

    padHandles.set(zone.id, { id: zone.id, ring: ringMat, disc: discMat });
  }

  // ---- bodies --------------------------------------------------------------
  const bodyGroup = new THREE.Group();
  scene.add(bodyGroup);
  const bodies = new Map<string, BodyEntry>();
  const bodyMeshes: THREE.Object3D[] = [];

  const overlayState: Overlays = { names: true, speech: true, thoughts: true, connections: false, groups: true, memory: true };
  let reducedMotion = false;
  let cameraMode: CameraMode = "orbit";
  let followedId: string | null = null;
  let paused = false;
  let pickCb: ((id: string | null) => void) | null = null;

  // ---- the city ------------------------------------------------------------
  //
  // Every building the swarm has raised, drawn from `structures` and from nothing
  // else. It stands apart from the bodies on purpose: a body is present tense and
  // leaves when its agent stops, while a building is the record given a place to
  // stand, so the habitat accumulates instead of resetting every time the swarm
  // goes quiet. The sky and the streets come with it, because a city with no
  // ground and no sky is a scatter plot.
  const city = createCityscape(scene, initial.zones);
  city.setReducedMotion(reducedMotion);
  city.apply(initial.structures);

  // Orbit state: spherical around a moving focus.
  const focus = new THREE.Vector3(0, 0.8, 0);
  let orbitTheta = 0.6;
  let orbitPhi = 1.02;
  let orbitRadius = 40;
  let dragging = false;
  let lastPointer = { x: 0, y: 0 };

  // ---- connections and groups ---------------------------------------------
  //
  // A line means two agents are really connected: one answered the other, or
  // they hold claims on the same target, or they are in the same declared team.
  // The pair list is rebuilt when a projection lands, and the endpoints are
  // rewritten every frame from the bodies' CURRENT positions, so lines follow a
  // walking body instead of snapping when the next poll arrives.
  const linkGroup = new THREE.Group();
  scene.add(linkGroup);
  const linkMat = new THREE.LineBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.28 });
  let linkPairs: [string, string][] = [];
  let linkGeo = new THREE.BufferGeometry();
  let linkLines = new THREE.LineSegments(linkGeo, linkMat);
  linkGroup.add(linkLines);
  linkGroup.visible = false;

  // A team is drawn as ground under its members, sized by how many are in it, and
  // it disappears when nobody is. An empty hall draws nothing rather than a ring
  // around nobody.
  const groupGroup = new THREE.Group();
  scene.add(groupGroup);

  function rebuildGroups(world: WorldState): void {
    for (const child of [...groupGroup.children]) {
      groupGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    for (const group of world.groups) {
      const here = group.members.map((id) => bodies.get(id)).filter((e): e is BodyEntry => Boolean(e) && e!.zone === group.zone);
      if (here.length === 0) continue;
      const cx = here.reduce((n, e) => n + e.current.x, 0) / here.length;
      const cz = here.reduce((n, e) => n + e.current.z, 0) / here.length;
      const radius = 0.85 + here.length * 0.3;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(group.kind === "cabal" ? theme.lime : theme.accent),
        transparent: true,
        // Open teams read brighter than ones that have ended, which is the
        // difference between a crew at work and a crew that is a record.
        opacity: group.open ? 0.3 : 0.14,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.86, radius, 40), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cx, 0.02, cz);
      groupGroup.add(ring);
    }
  }

  // ---- marks: the transient shapes an event makes --------------------------
  const marks: Mark[] = [];
  const markGroup = new THREE.Group();
  scene.add(markGroup);

  function spawnMark(e: VisualEvent, at: THREE.Vector3): void {
    const rgb = e.rgb;
    const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const now = performance.now();

    if (e.kind === "beam" || e.kind === "learn") {
      // A line from the body to the vaults: the shape of a memory write.
      const vaults = initial.zones.find((z) => z.id === "vaults");
      const to = new THREE.Vector3(vaults?.position.x ?? 0, 0.9, vaults?.position.z ?? 0);
      const geo = new THREE.BufferGeometry().setFromPoints([at.clone().setY(1.1), to]);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(geo, mat);
      markGroup.add(line);
      marks.push({ object: line, material: mat, born: now, life: MARK_MS, from: at.clone(), to, line: true });
      return;
    }

    // Artifacts and verdicts: a shard that rises out of the water and settles.
    const geo = e.kind === "artifact" ? new THREE.OctahedronGeometry(0.32, 0) : new THREE.TetrahedronGeometry(0.28, 0);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.35, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(at).setY(0.2);
    markGroup.add(mesh);
    marks.push({ object: mesh, material: mat, born: now, life: MARK_MS, from: at.clone().setY(0.2), to: at.clone().setY(1.5), line: false });
  }

  function updateMarks(now: number): void {
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      const age = now - m.born;
      if (age >= m.life) {
        markGroup.remove(m.object);
        if (m.object instanceof THREE.Mesh || m.object instanceof THREE.Line) m.object.geometry.dispose();
        m.material.dispose();
        marks.splice(i, 1);
        continue;
      }
      const p = age / m.life;
      if (m.line) {
        m.material.opacity = 0.85 * (1 - p);
      } else {
        m.object.position.lerpVectors(m.from, m.to, Math.min(1, p * 1.6));
        m.object.rotation.y += 0.02;
        m.material.opacity = 0.95 * (1 - p * p);
      }
    }
  }

  // ---- applying a world ----------------------------------------------------
  let world: WorldState = initial;

  function bodyKey(b: BodyState): string {
    return `${b.form}|${b.earned.traits.map((t) => t.id).join(",")}|${b.authored?.traits.join(",") ?? ""}|${b.authored?.palette ?? 0}`;
  }

  function applyWorld(next: WorldState): void {
    world = next;
    const live = new Set<string>();

    for (const b of next.bodies) {
      live.add(b.agentId);
      const key = bodyKey(b);
      let entry = bodies.get(b.agentId);
      const target = new THREE.Vector3(b.position.x, 0, b.position.z);

      if (!entry) {
        const palette = palettes[b.authored?.palette ?? (hashIndex(b.agentId, palettes.length))];
        const traits = [...b.earned.traits.map((t) => t.id), ...(b.authored?.traits ?? [])];
        const humanoid = buildHumanoid(palette, b.form, traits.slice(0, 11), b.scale);
        humanoid.group.position.copy(target);
        bodyGroup.add(humanoid.group);
        bodyMeshes.push(humanoid.group);
        const label = makeLabel(b.displayName ?? b.handle, theme.chalk, { size: 30, bg: theme.surface, max: 28 });
        label.position.set(0, 2.05, 0);
        humanoid.group.add(label);
        entry = {
          humanoid,
          target,
          current: target.clone(),
          facing: 0,
          label,
          traitKey: key,
          bubble: null,
          pulseUntil: 0,
          activity: b.activity,
          zone: b.zone,
        };
        bodies.set(b.agentId, entry);
      } else {
        entry.target.copy(target);
        if (entry.traitKey !== key) {
          // The record changed its body. Rebuild rather than mutate: forms, traits
          // and tiers are all structural.
          bodyGroup.remove(entry.humanoid.group);
          entry.humanoid.dispose();
          disposeSprite(entry.label);
          const palette = palettes[b.authored?.palette ?? hashIndex(b.agentId, palettes.length)];
          const traits = [...b.earned.traits.map((t) => t.id), ...(b.authored?.traits ?? [])];
          const humanoid = buildHumanoid(palette, b.form, traits.slice(0, 11), b.scale);
          humanoid.group.position.copy(entry.current);
          const label = makeLabel(b.displayName ?? b.handle, theme.chalk, { size: 30, bg: theme.surface, max: 28 });
          label.position.set(0, 2.05, 0);
          humanoid.group.add(label);
          bodyGroup.add(humanoid.group);
          entry.humanoid = humanoid;
          entry.label = label;
          entry.traitKey = key;
        }
      }

      entry.activity = b.activity;
      entry.zone = b.zone;
      entry.label.visible = overlayState.names;
      entry.humanoid.group.scale.setScalar(b.scale);

      // Ring and aura are the two values that can change every second.
      const topic = b.activityTopic;
      entry.humanoid.setRing(topic ? rgbForTopic(topic) : [120, 120, 120], entry.pulseUntil > performance.now() ? 1 : 0.35);
      entry.humanoid.setAura(rgbForTopic(topic ?? "agent.thought"), b.aura);

      // Speech and thought, drawn only when a real event says so. The text is the
      // stored payload; when an event carries no prose the topic's own label is
      // shown, so a bubble is never empty.
      const bubble: { seq: number; text: string } | null =
        b.speaking && overlayState.speech
          ? { seq: b.speaking.seq, text: b.speaking.text || b.speaking.label }
          : b.thinking && overlayState.thoughts
            ? { seq: b.thinking.seq, text: b.thinking.text }
            : null;
      if (bubble) {
        if (!entry.bubble || entry.bubble.sprite.userData.seq !== bubble.seq) {
          if (entry.bubble) {
            entry.humanoid.group.remove(entry.bubble.sprite);
            disposeSprite(entry.bubble.sprite);
          }
          const sprite = makeLabel(bubble.text, theme.chalk, { size: 26, bg: theme.surface, max: 54 });
          sprite.userData.seq = bubble.seq;
          sprite.position.set(0, 2.55, 0);
          entry.humanoid.group.add(sprite);
          entry.bubble = { sprite, until: Date.now() + SPEECH_MS };
          entry.pulseUntil = performance.now() + 1400;
        }
      } else if (entry.bubble) {
        entry.humanoid.group.remove(entry.bubble.sprite);
        disposeSprite(entry.bubble.sprite);
        entry.bubble = null;
      }
    }

    // Agents that are gone from the projection leave the world.
    for (const [id, entry] of [...bodies]) {
      if (live.has(id)) continue;
      bodyGroup.remove(entry.humanoid.group);
      entry.humanoid.dispose();
      disposeSprite(entry.label);
      if (entry.bubble) disposeSprite(entry.bubble.sprite);
      bodies.delete(id);
    }

    // Connections. The pair list is recomputed here, once per projection; the
    // geometry is reused and only its endpoints are rewritten each frame.
    const seenPair = new Set<string>();
    const pairs: [string, string][] = [];
    for (const b of next.bodies) {
      if (!bodies.has(b.agentId)) continue;
      for (const other of b.connections) {
        if (!bodies.has(other)) continue;
        const key = b.agentId < other ? `${b.agentId}|${other}` : `${other}|${b.agentId}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        pairs.push([b.agentId, other]);
      }
    }
    linkPairs = pairs;
    linkGroup.remove(linkLines);
    linkGeo.dispose();
    linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
    linkLines = new THREE.LineSegments(linkGeo, linkMat);
    linkLines.frustumCulled = false;
    linkGroup.add(linkLines);
    rebuildGroups(next);

    // The city, rebuilt from the same projection. New rows raise buildings and a
    // deeper record raises one already standing; nothing here decides that
    // anything exists.
    city.apply(next.structures);

    // Pads: lit by whether a row landed there recently, not on a timer.
    const nowMs = Date.now();
    for (const zone of next.zones) {
      const pad = padHandles.get(zone.id);
      if (!pad) continue;
      const age = zone.lastEventAt ? nowMs - Date.parse(zone.lastEventAt) : Infinity;
      const heat = zone.sealed ? 0 : Math.max(0, 1 - age / (1000 * 60 * 10));
      pad.ring.opacity = 0.18 + heat * 0.5;
      pad.disc.opacity = 0.06 + heat * 0.16 + Math.min(0.1, zone.occupancy * 0.01);
    }
  }

  function hashIndex(s: string, n: number): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h >>> 0) % n;
  }

  // ---- the loop ------------------------------------------------------------
  let lastFrame = performance.now();
  let frames = 0;
  let fpsAt = performance.now();
  let fps = 0;
  let rafId = 0;

  function frame(): void {
    rafId = requestAnimationFrame(frame);
    if (paused) return;

    const nowMs = performance.now();
    const dt = Math.min(0.06, (nowMs - lastFrame) / 1000);
    lastFrame = nowMs;
    const t = clock.getElapsedTime();

    frames++;
    if (nowMs - fpsAt > 800) {
      fps = Math.round((frames * 1000) / (nowMs - fpsAt));
      frames = 0;
      fpsAt = nowMs;
    }

    // Water: two crossing swells, offset so it never reads as a single pulse.
    if (!reducedMotion) {
      const pos = waterGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = waterBase[i * 3];
        const y = waterBase[i * 3 + 1];
        pos.setZ(i, Math.sin(x * 0.11 + t * 0.5) * 0.28 + Math.cos(y * 0.13 - t * 0.37) * 0.22);
      }
      pos.needsUpdate = true;
    }

    // Bodies walk toward where the record put them.
    for (const entry of bodies.values()) {
      const dx = entry.target.x - entry.current.x;
      const dz = entry.target.z - entry.current.z;
      const dist = Math.hypot(dx, dz);
      const maxStep = 3.6 * dt;
      if (dist > 0.02) {
        // A far jump (a claim moving an agent across the habitat) is a walk, not
        // a teleport, but it is a swift one, and the speed is capped so a replay
        // scrub does not fling bodies across the map.
        const step = Math.min(dist, Math.max(maxStep, dist * 0.35 * dt * 6));
        entry.current.x += (dx / dist) * step;
        entry.current.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);
        let diff = want - entry.facing;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        entry.facing += diff * Math.min(1, dt * 6);
      }
      const speed = Math.min(1.6, dist);
      entry.humanoid.group.position.set(entry.current.x, 0, entry.current.z);
      entry.humanoid.group.rotation.y = entry.facing;
      entry.humanoid.pose(t, dt, { moving: dist > 0.06, speed, action: actionFor(null) });
    }

    // Rewrite the line endpoints from where the bodies actually are now.
    if (overlayState.connections && linkPairs.length > 0) {
      const attr = linkGeo.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < linkPairs.length; i++) {
        const a = bodies.get(linkPairs[i][0]);
        const b = bodies.get(linkPairs[i][1]);
        if (!a || !b) continue;
        attr.setXYZ(i * 2, a.current.x, 1.0, a.current.z);
        attr.setXYZ(i * 2 + 1, b.current.x, 1.0, b.current.z);
      }
      attr.needsUpdate = true;
    }

    updateMarks(nowMs);

    // Growth: a new building rises out of the ground, one that gained a storey
    // pulses. This is the only animation in the file that reports a fact, and it
    // reports it once, when the row lands.
    city.update(dt);

    // Camera.
    let radius = orbitRadius;
    if (cameraMode === "top") {
      orbitPhi = lerp(orbitPhi, 0.12, 0.05);
      radius = 52;
    } else if (cameraMode === "orbit" || cameraMode === "follow") {
      orbitPhi = lerp(orbitPhi, 1.02, 0.05);
      if (!dragging && !reducedMotion) orbitTheta += dt * (cameraMode === "follow" ? 0.16 : 0.045);
    }
    if (cameraMode === "follow" && followedId) {
      const e = bodies.get(followedId);
      if (e) focus.lerp(new THREE.Vector3(e.current.x, 1, e.current.z), Math.min(1, dt * 3));
      radius = 13;
    } else {
      focus.lerp(new THREE.Vector3(0, 0.8, 0), Math.min(1, dt * 1.4));
    }
    const px = focus.x + Math.sin(orbitTheta) * Math.sin(orbitPhi) * radius;
    const py = focus.y + Math.cos(orbitPhi) * radius;
    const pz = focus.z + Math.cos(orbitTheta) * Math.sin(orbitPhi) * radius;
    camera.position.set(px, py, pz);
    camera.lookAt(focus.x, focus.y + 0.6, focus.z);

    renderer.render(scene, camera);
  }

  // ---- input ---------------------------------------------------------------
  function pointerDown(ev: PointerEvent): void {
    dragging = true;
    lastPointer = { x: ev.clientX, y: ev.clientY };
    canvas.setPointerCapture(ev.pointerId);
  }
  function pointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    const dx = ev.clientX - lastPointer.x;
    const dy = ev.clientY - lastPointer.y;
    lastPointer = { x: ev.clientX, y: ev.clientY };
    if (cameraMode === "orbit" || cameraMode === "follow" || cameraMode === "top") cameraMode = "free";
    orbitTheta -= dx * 0.006;
    orbitPhi = Math.max(0.08, Math.min(1.45, orbitPhi - dy * 0.005));
  }
  function pointerUp(ev: PointerEvent): void {
    dragging = false;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  }
  function wheel(ev: WheelEvent): void {
    ev.preventDefault();
    orbitRadius = Math.max(6, Math.min(78, orbitRadius + ev.deltaY * 0.035));
  }
  function click(ev: MouseEvent): void {
    if (!pickCb) return;
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects(bodyMeshes, true);
    if (hits.length === 0) {
      pickCb(null);
      return;
    }
    // Walk up to the group we registered as a body.
    let node: THREE.Object3D | null = hits[0].object;
    while (node && !bodyMeshes.includes(node)) node = node.parent;
    if (!node) return pickCb(null);
    for (const [id, entry] of bodies) if (entry.humanoid.group === node) return pickCb(id);
    pickCb(null);
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("click", click);

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, reducedMotion ? 1 : 1.75);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width === w && canvas.height === h) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }

  applyWorld(initial);
  linkGroup.visible = false;
  groupGroup.visible = overlayState.groups;
  resize();
  clock.start();
  rafId = requestAnimationFrame(frame);

  // A development only handle, so a probe can ask what the band actually drew
  // rather than inferring it from a screenshot. Production exports nothing: the
  // point is to verify the world, not to grow an API for it.
  if (process.env.NODE_ENV !== "production") {
    (window as unknown as { __swampWorld?: unknown }).__swampWorld = {
      stats: () => ({ fps, drawn: bodies.size, paused, camera: cameraMode, followedId }),
      zones: () => initial.zones.length,
      // The city, so a probe can check that buildings are really in the scene
      // rather than trusting that the projection was called.
      city: () => city.counts(),
      cameraPosition: () => camera.position.toArray().map((n) => Math.round(n * 10) / 10),
      nearest: () => {
        // Where the drawn bodies are, so a probe can prove the scene carries them
        // rather than trusting a frame count.
        return [...bodies.values()].slice(0, 5).map((e) => ({ x: Math.round(e.current.x * 10) / 10, z: Math.round(e.current.z * 10) / 10 }));
      },
    };
  }

  return {
    setWorld(next) {
      applyWorld(next);
    },
    pushEvent(e) {
      // A new row: flash the body that wrote it, and leave a mark where it landed.
      const entry = e.agentId ? bodies.get(e.agentId) : null;
      if (entry) {
        entry.pulseUntil = performance.now() + 2200;
        entry.humanoid.setRing(e.rgb, 1);
      }
      if (overlayState.memory || (e.kind !== "beam" && e.kind !== "learn")) {
        const pad = padHandles.get(e.zone);
        const zone = initial.zones.find((z) => z.id === e.zone);
        const at = new THREE.Vector3(zone?.position.x ?? 0, 0, zone?.position.z ?? 0);
        void pad;
        spawnMark({ ...e, kind: e.kind === "beam" && !overlayState.memory ? "speak" : e.kind }, entry ? entry.current.clone() : at);
      }
      // A message or thought shows as a bubble immediately, before the next
      // projection lands, so the world reacts on the row rather than on the poll.
      if (entry && (e.kind === "speak" || e.kind === "think")) {
        const wantSpeech = e.kind === "speak" && overlayState.speech;
        const wantThought = e.kind === "think" && overlayState.thoughts;
        if (wantSpeech || wantThought) {
          if (entry.bubble) {
            entry.humanoid.group.remove(entry.bubble.sprite);
            disposeSprite(entry.bubble.sprite);
          }
          const sprite = makeLabel(e.text || e.label, theme.chalk, { size: 26, bg: theme.surface, max: 54 });
          sprite.userData.seq = e.seq;
          sprite.position.set(0, 2.55, 0);
          entry.humanoid.group.add(sprite);
          entry.bubble = { sprite, until: Date.now() + SPEECH_MS };
        }
      }
    },
    setOverlays(o) {
      Object.assign(overlayState, o);
      linkGroup.visible = overlayState.connections;
      groupGroup.visible = overlayState.groups;
      for (const entry of bodies.values()) {
        entry.label.visible = overlayState.names;
        if (entry.bubble && !overlayState.speech && !overlayState.thoughts) {
          entry.humanoid.group.remove(entry.bubble.sprite);
          disposeSprite(entry.bubble.sprite);
          entry.bubble = null;
        }
      }
    },
    setCameraMode(m) {
      cameraMode = m;
      if (m !== "follow") followedId = null;
    },
    follow(agentId) {
      followedId = agentId;
      cameraMode = agentId ? "follow" : "orbit";
    },
    onPick(cb) {
      pickCb = cb;
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
      city.setReducedMotion(reduced);
      resolveReduced();
    },
    setPaused(next) {
      paused = next;
    },
    resize,
    stats() {
      return { fps, drawn: bodies.size, paused };
    },
    dispose() {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("click", click);
      for (const entry of bodies.values()) {
        entry.humanoid.dispose();
        disposeSprite(entry.label);
        if (entry.bubble) disposeSprite(entry.bubble.sprite);
      }
      bodies.clear();
      city.dispose();
      waterGeo.dispose();
      waterMat.dispose();
      renderer.dispose();
    },
  };

  /** With motion reduced the world still exists, it just stops turning. */
  function resolveReduced(): void {
    if (reducedMotion) {
      renderer.setPixelRatio(1);
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
