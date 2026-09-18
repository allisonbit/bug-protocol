import * as THREE from "three";
import type { FormId, TraitId } from "@/lib/world/types";

/**
 * The body: a person, built from primitives, with a walk cycle.
 *
 * WHY PROCEDURAL AND NOT A MODEL FILE. This site ships no binary assets at all
 * and the whole point of these eight hundred lines around it is that a body is a
 * projection of a record, not a downloaded costume. A rig built in code can be
 * varied by tier, dressed by earned traits, and coloured from the page's own CSS
 * variables, none of which a fixed GLB can do without a loader, a file, and a
 * licensing story. It also means there is nothing to fetch before somebody can
 * be seen walking.
 *
 * PROPORTIONS ARE HUMAN ON PURPOSE. Head about a seventh of height, shoulders
 * wider than hips, two arms and two legs with knees and elbows that bend the
 * correct way. The requirement was a real character rather than a glowing orb,
 * so this is a figure with a skeleton, and the skeleton is what makes the walk
 * read as walking rather than as sliding.
 *
 * THE WALK IS A CYCLE, NOT A TWEEN. Legs swing in antiphase, knees bend on the
 * backswing only, arms counter-swing, the torso counter-rotates against the hips
 * and the whole body bobs twice per stride. That is what stops it looking like a
 * chess piece being dragged. Everything is a function of phase, so a body that
 * slows down takes slower steps rather than fewer of them.
 *
 * WHAT IS STYLE, stated once: the stride, the breathing, the sway. None of it
 * encodes anything. What is real is that a body is here, who it is, which zone
 * the row put it in, and whether it is moving at all. `renderer.ts` interpolates
 * the position; this file only decides what walking looks like.
 */

/** Shared geometry, so forty bodies do not allocate forty sets of shapes. */
type Geo = {
  head: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  chest: THREE.BufferGeometry;
  hips: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
};

let GEO: Geo | null = null;

function geometries(): Geo {
  if (GEO) return GEO;
  GEO = {
    head: new THREE.SphereGeometry(0.115, 12, 10),
    neck: new THREE.CapsuleGeometry(0.042, 0.05, 2, 6),
    // Chest and hips as capsules: a rounded box reads as a torso much more
    // cheaply than a tapered lathe, and at world scale the difference is invisible.
    chest: new THREE.CapsuleGeometry(0.145, 0.26, 3, 10),
    hips: new THREE.CapsuleGeometry(0.125, 0.1, 3, 10),
    upperArm: new THREE.CapsuleGeometry(0.052, 0.2, 2, 7),
    foreArm: new THREE.CapsuleGeometry(0.045, 0.19, 2, 7),
    thigh: new THREE.CapsuleGeometry(0.068, 0.25, 2, 7),
    shin: new THREE.CapsuleGeometry(0.055, 0.24, 2, 7),
    foot: new THREE.BoxGeometry(0.09, 0.05, 0.19),
    hand: new THREE.SphereGeometry(0.045, 6, 5),
  };
  return GEO;
}

export type BodyPalette = {
  /** The figure itself. */
  skin: THREE.Color;
  /** Clothing: the torso and upper legs. */
  cloth: THREE.Color;
  /** The accent: rings, aura, carried light. */
  accent: THREE.Color;
  /** The face marker, so a body has a front. */
  face: THREE.Color;
};

/** The sockets a trait can hang off, resolved per body at build time. */
type Sockets = {
  group: THREE.Group;
  head: THREE.Group;
  chest: THREE.Group;
  leftHand: THREE.Group;
  rightHand: THREE.Group;
  hip: THREE.Group;
  back: THREE.Group;
  shoulders: THREE.Group;
};

export type Humanoid = {
  /** Add to the scene. Position is the world position; rotation.y is facing. */
  group: THREE.Group;
  /** The ring under the feet: activity colour, painted from the topic table. */
  setRing(rgb: [number, number, number], intensity: number): void;
  /** Aura: a soft shell whose opacity is reputation. Measured, not decorative. */
  setAura(rgb: [number, number, number], strength: number): void;
  /** Which form's build was used, and the height multiplier applied. */
  form: FormId;
  /** Advance the animation. `moving` picks the walk over the idle stance. */
  pose(t: number, dt: number, opts: { moving: boolean; speed: number; action: ActionId | null }): void;
  /** Free GPU resources. Geometries are shared, so this only drops materials. */
  dispose(): void;
};

export type ActionId = "reach" | "raise" | "carry" | "still";

/** Palette index 0..5, all inside the brand family: neutral figure, lime accent. */
export function palettesFrom(theme: { chalk: string; mist: string; accent: string; accentDeep: string; line: string }): BodyPalette[] {
  const neutral = new THREE.Color(theme.chalk);
  const soft = new THREE.Color(theme.mist);
  const accent = new THREE.Color(theme.accent);
  const deep = new THREE.Color(theme.accentDeep);
  const body = (skin: THREE.Color, cloth: THREE.Color): BodyPalette => ({ skin, cloth, accent, face: deep });
  return [
    body(neutral, neutral),
    body(neutral, soft),
    body(soft, neutral),
    body(accent, neutral),
    body(neutral, accent),
    body(soft, deep),
  ];
}

/**
 * Build one person.
 *
 * The hierarchy is the skeleton: root, then bob, then hips; legs hang off the
 * hips, the chest hangs off the hips, arms hang off the chest, and the head and
 * every trait hang off sockets inside that chain. So a swing of the hips carries
 * everything below it and a turn of the chest carries the arms, without a single
 * per-frame matrix being written by hand.
 */
export function buildHumanoid(palette: BodyPalette, form: FormId, traits: TraitId[], scale: number): Humanoid {
  const g = geometries();
  const group = new THREE.Group();
  group.scale.setScalar(scale);

  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.72, metalness: 0.04 });
  const clothMat = new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: 0.84, metalness: 0.02 });
  const accentMat = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.4, metalness: 0.12, emissive: palette.accent, emissiveIntensity: 0.22 });
  const faceMat = new THREE.MeshStandardMaterial({ color: palette.face, roughness: 0.5 });
  const materials: THREE.Material[] = [bodyMat, clothMat, accentMat, faceMat];

  // ---- the chain ----------------------------------------------------------
  const bob = new THREE.Group();
  group.add(bob);
  const hips = new THREE.Group();
  hips.position.y = 0.86;
  bob.add(hips);

  const hipMesh = new THREE.Mesh(g.hips, clothMat);
  hipMesh.rotation.x = Math.PI / 2;
  hips.add(hipMesh);

  const chest = new THREE.Group();
  chest.position.y = 0.2;
  hips.add(chest);
  const chestMesh = new THREE.Mesh(g.chest, clothMat);
  chestMesh.rotation.x = Math.PI / 2;
  chestMesh.position.y = 0.17;
  chest.add(chestMesh);

  // Shoulders: a slightly wider bar, so the silhouette reads as a person at
  // distance rather than as a capsule with a head.
  const shoulders = new THREE.Group();
  shoulders.position.y = 0.3;
  chest.add(shoulders);

  const neck = new THREE.Mesh(g.neck, bodyMat);
  neck.position.y = 0.07;
  shoulders.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.19;
  shoulders.add(head);
  const headMesh = new THREE.Mesh(g.head, bodyMat);
  head.add(headMesh);
  // A face marker rather than eyes at this scale: a small paler wedge that says
  // which way the head is looking, which is the only thing a viewer needs.
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.02), faceMat);
  face.position.set(0, 0.01, 0.1);
  head.add(face);

  type Limb = { upper: THREE.Group; lower: THREE.Group; hand: THREE.Group };
  function buildArm(side: -1 | 1): Limb {
    const upper = new THREE.Group();
    upper.position.set(side * 0.17, 0.02, 0);
    shoulders.add(upper);
    const upperMesh = new THREE.Mesh(g.upperArm, clothMat);
    upperMesh.position.y = -0.1;
    upper.add(upperMesh);
    const lower = new THREE.Group();
    lower.position.y = -0.21;
    upper.add(lower);
    const lowerMesh = new THREE.Mesh(g.foreArm, bodyMat);
    lowerMesh.position.y = -0.095;
    lower.add(lowerMesh);
    const hand = new THREE.Group();
    hand.position.y = -0.2;
    lower.add(hand);
    hand.add(new THREE.Mesh(g.hand, bodyMat));
    return { upper, lower, hand };
  }
  const armL = buildArm(-1);
  const armR = buildArm(1);

  function buildLeg(side: -1 | 1): Limb {
    const upper = new THREE.Group();
    upper.position.set(side * 0.085, 0, 0);
    hips.add(upper);
    const upperMesh = new THREE.Mesh(g.thigh, clothMat);
    upperMesh.position.y = -0.13;
    upper.add(upperMesh);
    const lower = new THREE.Group();
    lower.position.y = -0.27;
    upper.add(lower);
    const lowerMesh = new THREE.Mesh(g.shin, bodyMat);
    lowerMesh.position.y = -0.12;
    lower.add(lowerMesh);
    const foot = new THREE.Group();
    foot.position.y = -0.26;
    lower.add(foot);
    const footMesh = new THREE.Mesh(g.foot, bodyMat);
    footMesh.position.z = 0.03;
    foot.add(footMesh);
    return { upper, lower, hand: foot };
  }
  const legL = buildLeg(-1);
  const legR = buildLeg(1);

  // ---- what the record earned --------------------------------------------
  const sockets: Sockets = { group, head, chest, leftHand: armL.hand, rightHand: armR.hand, hip: hips, back: chest, shoulders };
  for (const trait of traits) dressTrait(sockets, trait, accentMat, bodyMat, materials);

  // ---- the ring, at the feet ---------------------------------------------
  //
  // Flat on the ground rather than under the body, so a crowd of rings reads as
  // a floor plan and does not z-fight with the walking.
  const ringMat = new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.31, 24), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  group.add(ring);
  materials.push(ringMat);

  // ---- the aura ----------------------------------------------------------
  //
  // A shell whose opacity is reputation. It is the one visual here that can go
  // down, which is why it is separate from the ring: the ring says what the agent
  // is doing now, the aura says what it is worth so far, and they are different
  // questions.
  const auraMat = new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.0, side: THREE.BackSide, depthWrite: false });
  const aura = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), auraMat);
  aura.position.y = 0.95;
  group.add(aura);
  materials.push(auraMat);

  let phase = 0;
  const idleStart = Math.random() * Math.PI * 2;

  return {
    group,
    form,
    setRing(rgb, intensity) {
      ringMat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      ringMat.opacity = 0.28 + Math.min(1, Math.max(0, intensity)) * 0.5;
    },
    setAura(rgb, strength) {
      auraMat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      auraMat.opacity = Math.min(0.34, strength * 0.34);
    },
    pose(t, dt, opts) {
      const speed = Math.min(1.7, Math.max(0, opts.speed));
      const moving = opts.moving && speed > 0.02;

      if (moving) {
        // Stride frequency scales with speed, so hurrying reads as hurrying.
        phase += dt * (2.6 + speed * 4.4);
      } else {
        phase += dt * 0.7;
      }

      const s = moving ? Math.min(1, speed + 0.25) : 0;
      const swing = Math.sin(phase) * 0.62 * s;
      const counter = Math.sin(phase + Math.PI) * 0.62 * s;

      legL.upper.rotation.x = swing;
      legR.upper.rotation.x = counter;
      // A knee bends on the backswing only. Bending on both is the single most
      // common way a procedural walk reads as broken.
      legL.lower.rotation.x = Math.max(0, -Math.sin(phase)) * 0.85 * s;
      legR.lower.rotation.x = Math.max(0, -Math.sin(phase + Math.PI)) * 0.85 * s;
      legL.hand.rotation.x = -legL.lower.rotation.x * 0.45;
      legR.hand.rotation.x = -legR.lower.rotation.x * 0.45;

      // Arms counter-swing, and the elbows carry a little of it.
      let armSwingL = counter * 0.62;
      let armSwingR = swing * 0.62;
      let armRaiseL = 0;
      let armRaiseR = 0;

      if (opts.action === "reach") {
        armRaiseR = -1.25;
        armSwingR = 0;
      } else if (opts.action === "raise") {
        armRaiseR = -2.05;
        armSwingR = 0;
      } else if (opts.action === "carry") {
        armRaiseL = -0.75;
        armRaiseR = -0.75;
        armSwingL = 0;
        armSwingR = 0;
      }

      armL.upper.rotation.x = armSwingL + armRaiseL;
      armR.upper.rotation.x = armSwingR + armRaiseR;
      armL.lower.rotation.x = -0.12 - Math.max(0, -armSwingL) * 0.4 - armRaiseL * 0.3;
      armR.lower.rotation.x = -0.12 - Math.max(0, -armSwingR) * 0.4 - armRaiseR * 0.3;

      // Body mechanics: two bobs per stride, hips sway, chest counter-rotates.
      const breathe = Math.sin(t * 1.5 + idleStart) * 0.006;
      bob.position.y = moving ? Math.abs(Math.sin(phase)) * 0.045 * s : breathe;
      hips.rotation.z = moving ? Math.sin(phase) * 0.05 * s : 0;
      chest.rotation.y = moving ? Math.sin(phase) * 0.09 * s : Math.sin(t * 0.4 + idleStart) * 0.04;
      chest.rotation.x = moving ? 0.06 * s : 0;
      // Standing still, the head drifts as if looking around. Never while walking:
      // a body that swings its head while striding looks drunk.
      head.rotation.y = moving ? Math.sin(phase) * 0.05 * s : Math.sin(t * 0.23 + idleStart) * 0.42;
      head.rotation.x = moving ? 0 : Math.sin(t * 0.31 + idleStart) * 0.06;
    },
    dispose() {
      for (const m of materials) m.dispose();
    },
  };
}

/**
 * Wear an earned trait.
 *
 * Every one of these is a thing you can see from across the plaza, which is the
 * bar: a trait nobody can spot from a distance is not carrying any information,
 * it is just more polygons. The set is closed (`TraitId`) and each maps to one
 * attachment here, so a trait cannot exist in the record and be invisible.
 */
function dressTrait(sockets: Sockets, trait: TraitId, accent: THREE.Material, body: THREE.Material, sink: THREE.Material[]): void {
  void body;
  const add = (mesh: THREE.Mesh, where: THREE.Group, pos: [number, number, number]) => {
    mesh.position.set(pos[0], pos[1], pos[2]);
    where.add(mesh);
    // Trait attachments share the body's accent material rather than owning one,
    // so a body with five traits still costs one material for all of them.
    mesh.material = accent;
  };

  if (trait === "first_light") {
    // A small lamp at the chest: the first thing everybody earns.
    add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), accent), sockets.chest, [0, 0.26, 0.13]);
  }
  if (trait === "sigil") {
    // A flat badge: work published.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.012), accent), sockets.chest, [0.0, 0.15, 0.16]);
  }
  if (trait === "lantern") {
    // Held in the left hand, so it swings with the arm and reads as a possession.
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), accent), sockets.leftHand, [0, -0.09, 0]);
  }
  if (trait === "crest") {
    // A fin over the shoulder line: verified somebody else's work.
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.17, 6), accent);
    fin.rotation.x = -0.35;
    add(fin, sockets.shoulders, [0, 0.15, -0.06]);
  }
  if (trait === "tools") {
    // A satchel on the hip: a body of published work.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.08), accent), sockets.hip, [0.15, 0.06, -0.04]);
  }
  if (trait === "wings") {
    // Two planes at the back. The only trait that changes the silhouette from
    // behind, which is exactly why it is the late one.
    for (const side of [-1, 1] as const) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.4), accent);
      wing.position.set(side * 0.13, 0.26, -0.14);
      wing.rotation.set(0.25, side * 0.55, side * 0.5);
      sockets.chest.add(wing);
    }
  }
  if (trait === "sash") {
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.02), accent);
    sash.rotation.z = 0.5;
    add(sash, sockets.chest, [0.02, 0.16, 0.14]);
  }
  if (trait === "crown") {
    // The top step: a ring of small points above the head, visible over a crowd.
    const crown = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 5), accent);
      const a = (i / 5) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.07, 0.03, Math.sin(a) * 0.07);
      crown.add(spike);
    }
    crown.position.y = 0.11;
    sockets.head.add(crown);
  }
}
