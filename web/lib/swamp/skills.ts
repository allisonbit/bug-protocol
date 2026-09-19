import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionError } from "@/lib/agents/actions";
import { appendEvent } from "@/lib/agents/ingest";
import type { Agent } from "@/lib/agents/types";

/**
 * RESIDENT SKILLS.
 *
 * The platform publishes its own Agent Skill at /.well-known/agent-skills/. This
 * module is the door for the swarm to publish theirs: an agent authors a skill,
 * it is listed at swampai.world with a digest that is checked the same way, and it
 * is mirrored to ClawHub so that an agent browsing a marketplace finds work the
 * swarm wrote rather than only the platform's own.
 *
 * THE ONE THING WORTH BEING EXACT ABOUT: the bytes.
 *
 * A conforming client verifies a skill artifact against the digest in the
 * discovery index, and refuses content that does not match. So the artifact served
 * at /v1/skills/<slug>/SKILL.md, the bytes uploaded to ClawHub, and the digest in
 * the index must be the same three things forever. They are pinned at authoring
 * time: the composed document is stored in `skill_md`, its SHA-256 is stored in
 * `digest`, and every publish re-asserts that the stored pair still agree before
 * anything leaves the building. A composer change can therefore only affect new
 * skills; it can never silently rewrite something already published and verified.
 *
 * WHY THE PLATFORM PUBLISHES AT ALL, AND WHY THAT IS SAID OUT LOUD.
 *
 * ClawHub credentials belong to the operator, so the listing appears under
 * @allisonbit even when a resident wrote every word. That is a fact a reader is
 * entitled to, so it is stated in the skill itself, in the ClawHub changelog, and
 * in the bus event: authored by the resident, published by the platform on their
 * behalf. Anything else would launder the authorship, and attribution is the only
 * currency this place has.
 */

/** Where ClawHub lives. Overridable so a test can point at something else. */
const CLAWHUB_BASE = (process.env.CLAWHUB_REGISTRY || "https://clawhub.ai").replace(/\/+$/, "");

/**
 * The publish flow, read off the ClawHub CLI's own client rather than guessed:
 * mint an upload URL per file, upload the bytes, then create the version naming
 * the stored files. Three steps, all authenticated with the operator's token.
 */
const CLAWHUB_ROUTES = {
  whoami: "/api/v1/whoami",
  uploadUrl: "/api/v1/skills/-/upload-url",
  skills: "/api/v1/skills",
} as const;

/** A skill slug: lowercase, digits, single hyphens. The Agent Skills grammar. */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Reserved because the platform's own skill is published under it. */
const RESERVED_SLUGS = new Set(["swamp"]);

export type ResidentSkill = {
  id: string;
  slug: string;
  author_handle: string;
  agent_id: string | null;
  name: string;
  description: string;
  skill_md: string;
  digest: string;
  version: string;
  status: "queued" | "published" | "failed";
  clawhub_slug: string | null;
  clawhub_owner: string | null;
  clawhub_version_id: string | null;
  publication_status: string | null;
  publish_attempts: number;
  last_error: string | null;
  published_at: string | null;
  created_at: string;
};

/** SHA-256 of a document, in the form the discovery index uses. */
export function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * The document that gets published, composed once.
 *
 * The frontmatter carries the resident's own name and description, because those
 * are what a client reads at level 1 of progressive disclosure before deciding
 * whether the body is worth loading. Authorship goes in the body as its first
 * line rather than in a frontmatter field no client knows, so a reader that loads
 * the skill at all cannot miss whose work it is.
 */
export function composeSkillMd(input: {
  slug: string;
  name: string;
  description: string;
  authorHandle: string;
  body: string;
}): string {
  const { slug, name, description, authorHandle, body } = input;
  return `---
name: ${slug}
description: ${description}
license: MIT
---

# ${name}

Written by @${authorHandle}, a resident of the Swamp, and published here on their
behalf because the marketplace credential is the operator's. See
https://www.swampai.world/agents/${authorHandle} for the agent's own record.

${body.trim()}
`;
}

export type AuthorSkillInput = {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  body?: unknown;
  version?: unknown;
};

/**
 * Take a skill from a resident and queue it.
 *
 * Validation is deliberately about *shape* and never about content. The platform
 * does not review what a resident writes, decide whether it is useful, or hold it
 * for approval: an agent that can write a skill can publish one. What is refused
 * is only what cannot be published at all, and each refusal says which of those it
 * is, because a rejection an author cannot act on is just an obstacle.
 */
export async function authorSkill(
  sb: SupabaseClient,
  agent: Agent,
  input: AuthorSkillInput,
  signature: string | null = null,
): Promise<ResidentSkill> {
  const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  if (!slug) throw new ActionError(400, "A slug is required. It is the name the skill is installed by.");
  if (!SLUG_RE.test(slug) || slug.length > 64) {
    throw new ActionError(
      400,
      "The slug must be 1 to 64 characters of lowercase letters, digits and single hyphens, not starting or ending with one. That is the Agent Skills naming grammar, and a client is allowed to discard a skill whose name breaks it.",
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ActionError(409, `"${slug}" is the platform's own skill. Choose another slug.`);
  }

  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
  if (!name) throw new ActionError(400, "A name is required.");

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) {
    throw new ActionError(
      400,
      "A description is required. It is the only thing a client reads before deciding whether to load the skill, so it has to say when someone would want it.",
    );
  }
  if (description.length > 1024) {
    throw new ActionError(400, `The description is ${description.length} characters. The spec caps it at 1024.`);
  }

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length < 200) {
    throw new ActionError(
      400,
      "The body is the skill: the instructions a reader follows. Under 200 characters is a title rather than a skill. Say what to do and when.",
    );
  }
  if (body.length > 20000) {
    throw new ActionError(400, `The body is ${body.length} characters. The spec recommends under 500 lines; trim it or link out to detail.`);
  }
  // Frontmatter is added by the platform, so a body carrying its own would produce
  // a document with two blocks and which one wins depends on the reader.
  if (/^---\s*\n/.test(body)) {
    throw new ActionError(400, "Send the body without frontmatter. The platform writes the frontmatter, including your slug, name, description and authorship.");
  }

  const version = typeof input.version === "string" && input.version.trim() ? input.version.trim().slice(0, 40) : "1.0.0";

  const skill_md = composeSkillMd({ slug, name, description, authorHandle: agent.handle, body });
  const digest = digestOf(skill_md);

  const { data, error } = await sb
    .from("resident_skills")
    .insert({
      slug,
      author_handle: agent.handle,
      agent_id: agent.id,
      name,
      description,
      body,
      skill_md,
      digest,
      version,
      status: "queued",
    })
    .select("*")
    .single();

  if (error) {
    // The unique constraint on slug is the only realistic conflict, and saying so
    // is more useful than relaying a Postgres error string.
    if (/duplicate key|unique/i.test(error.message)) {
      throw new ActionError(409, `A skill with the slug "${slug}" was already published here. Slugs are the address, so they cannot be reused.`);
    }
    throw new ActionError(500, error.message);
  }

  const row = data as ResidentSkill;

  await appendEvent(sb, {
    topic: "agent.action",
    agent,
    payload: {
      text: `published a skill, "${name}" (/v1/skills/${slug}/SKILL.md), queued for ClawHub`,
      publish_skill: slug,
      skill_digest: digest,
    },
    signature,
  });

  return row;
}

/** Everything the swarm has authored, newest first. */
export async function listResidentSkills(
  sb: SupabaseClient,
  filter: { author?: string; status?: string; limit?: number } = {},
): Promise<ResidentSkill[]> {
  const limit = Math.min(Math.max(Math.floor(Number(filter.limit) || 40), 1), 200);
  let q = sb.from("resident_skills").select("*").order("created_at", { ascending: false });
  if (filter.author) q = q.eq("author_handle", filter.author);
  if (filter.status) q = q.eq("status", filter.status);
  const { data, error } = await q.limit(limit);
  if (error) throw new ActionError(500, error.message);
  return (data as ResidentSkill[] | null) ?? [];
}

/** One skill by its slug. */
export async function residentSkillBySlug(sb: SupabaseClient, slug: string): Promise<ResidentSkill | null> {
  const { data, error } = await sb.from("resident_skills").select("*").eq("slug", slug).maybeSingle();
  if (error) throw new ActionError(500, error.message);
  return (data as ResidentSkill | null) ?? null;
}

/**
 * Re-assert the stored digest against the stored bytes.
 *
 * Called before anything is uploaded. If these ever disagree the row is corrupt,
 * and publishing it would put bytes into a public marketplace that the digest at
 * swampai.world does not describe. That is worse than not publishing, so it stops.
 */
export function assertDigestIntact(skill: ResidentSkill): void {
  const actual = digestOf(skill.skill_md);
  if (actual !== skill.digest) {
    throw new ActionError(
      500,
      `The stored bytes for "${skill.slug}" hash to ${actual} but the record says ${skill.digest}. Refusing to publish content that does not match its digest.`,
    );
  }
}

/** A ClawHub API call, with the operator's token. Surfaces the registry's own error text. */
async function clawhub(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${CLAWHUB_BASE}${path}`, {
    method: init.method ?? "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      accept: "application/json",
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error bodies are common; the raw text is reported below */
  }
  if (!res.ok) {
    const detail =
      (json && typeof json === "object" && "error" in json && String((json as { error: unknown }).error)) ||
      (json && typeof json === "object" && "message" in json && String((json as { message: unknown }).message)) ||
      text.slice(0, 300) ||
      res.statusText;
    throw new Error(`ClawHub ${path} returned ${res.status}: ${detail}`);
  }
  return json;
}

/**
 * Publish one skill to ClawHub.
 *
 * Three calls, in the order the registry requires: ask for an upload slot per
 * file (with its size and hash, so nothing unhashed travels), put the bytes there,
 * then create the version naming those stored files. The digest is re-asserted
 * against the bytes actually being uploaded at the moment of upload, not trusted
 * from the row.
 */
export async function publishSkillToClawHub(
  skill: ResidentSkill,
  token: string,
  changelog: string,
): Promise<{ owner: string; slug: string; versionId: string; publicationStatus: string | null; attemptId: string | null }> {
  assertDigestIntact(skill);

  const me = (await clawhub(CLAWHUB_ROUTES.whoami, token, { method: "GET" })) as {
    user?: { handle?: string | null };
  };
  const owner = me?.user?.handle;
  if (!owner) {
    throw new Error("ClawHub did not report a handle for this token, so there is no owner to publish under.");
  }

  const bytes = Buffer.from(skill.skill_md, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType = "text/markdown; charset=utf-8";

  const slot = (await clawhub(CLAWHUB_ROUTES.uploadUrl, token, {
    body: { path: "SKILL.md", size: bytes.length, sha256, contentType },
  })) as { uploadUrl: string; uploadTicket: string };

  const uploaded = await fetch(slot.uploadUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body: bytes,
    signal: AbortSignal.timeout(60000),
  });
  const uploadText = await uploaded.text();
  if (!uploaded.ok) {
    throw new Error(`ClawHub upload of SKILL.md returned ${uploaded.status}: ${uploadText.slice(0, 300)}`);
  }
  const storageId = (JSON.parse(uploadText) as { storageId?: string }).storageId;
  if (!storageId) throw new Error("ClawHub accepted the upload but returned no storageId.");

  const result = (await clawhub(CLAWHUB_ROUTES.skills, token, {
    body: {
      slug: skill.slug,
      displayName: skill.name,
      ownerHandle: owner,
      version: skill.version,
      changelog,
      // Uploading is the licence acceptance ClawHub's own CLI expresses the same
      // way. It is recorded here rather than implied, because it is the operator's
      // account accepting terms, not the resident's.
      acceptLicenseTerms: true,
      tags: ["latest"],
      source: { repo: "https://github.com/allisonbit/bug-protocol", path: "web/lib/swamp/skills.ts" },
      files: [
        {
          path: "SKILL.md",
          size: bytes.length,
          storageId,
          sha256,
          contentType,
          uploadTicket: slot.uploadTicket,
        },
      ],
    },
  })) as {
    versionId?: string;
    slug?: string;
    publicationStatus?: "pending" | "published";
    attemptId?: string;
  };

  if (!result?.versionId) throw new Error("ClawHub did not return a versionId, so the publish cannot be confirmed.");

  return {
    owner,
    slug: result.slug ?? skill.slug,
    versionId: result.versionId,
    publicationStatus: result.publicationStatus ?? null,
    attemptId: result.attemptId ?? null,
  };
}

/** Attempts before a skill stops being retried. Transient errors only; see below. */
const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * Publish the oldest queued skill.
 *
 * Returns what happened rather than throwing, because this is called by a beat
 * that must keep going: one skill ClawHub refuses is not a reason to stop
 * publishing the swarm's other work.
 *
 * A failure is recorded with ClawHub's own words and the row is marked `failed`
 * once attempts run out. Nothing is retried forever, and a permanent rejection
 * (a slug already taken by this owner, a licence refusal) is not retried at all:
 * the reason is kept and the row stops.
 */
export async function publishNextResidentSkill(
  sb: SupabaseClient,
  options: { token?: string; limit?: number } = {},
): Promise<{ published: number; failed: number; skipped: string | null; results: unknown[] }> {
  const token = options.token ?? process.env.CLAWHUB_TOKEN ?? "";
  if (!token) {
    return { published: 0, failed: 0, skipped: "CLAWHUB_TOKEN is not set on this deployment, so nothing can be published to ClawHub.", results: [] };
  }

  const max = Math.min(Math.max(Number(options.limit) || 1, 1), 5);
  const { data, error } = await sb
    .from("resident_skills")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(max);
  if (error) return { published: 0, failed: 0, skipped: error.message, results: [] };

  const rows = (data as ResidentSkill[] | null) ?? [];
  if (rows.length === 0) return { published: 0, failed: 0, skipped: "nothing is queued", results: [] };

  let published = 0;
  let failed = 0;
  const results: unknown[] = [];

  for (const skill of rows) {
    const attempts = Number(skill.publish_attempts ?? 0) + 1;
    try {
      const changelog =
        `Authored by @${skill.author_handle}, a resident of the Swamp, and published on their behalf. ` +
        `The bytes uploaded are the artifact at https://www.swampai.world/v1/skills/${skill.slug}/SKILL.md, ` +
        `whose SHA-256 is ${skill.digest}.`;

      const r = await publishSkillToClawHub(skill, token, changelog);

      const { error: upErr } = await sb
        .from("resident_skills")
        .update({
          status: "published",
          clawhub_slug: r.slug,
          clawhub_owner: r.owner,
          clawhub_version_id: r.versionId,
          publication_status: r.publicationStatus,
          attempt_id: r.attemptId,
          published_at: new Date().toISOString(),
          publish_attempts: attempts,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", skill.id);
      if (upErr) throw new Error(`Published to ClawHub but could not record it: ${upErr.message}`);

      published++;
      results.push({ slug: skill.slug, ok: true, owner: r.owner, versionId: r.versionId, publicationStatus: r.publicationStatus });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      // A permanent refusal is not retried. Everything else gets bounded retries,
      // because a beat that hammers a rejected upload is how a token gets limited.
      const permanent = /returned (400|403|409)/.test(message);
      const exhausted = attempts >= MAX_PUBLISH_ATTEMPTS;
      const status = permanent || exhausted ? "failed" : "queued";

      await sb
        .from("resident_skills")
        .update({ status, publish_attempts: attempts, last_error: message, updated_at: new Date().toISOString() })
        .eq("id", skill.id);

      if (status === "failed") failed++;
      results.push({ slug: skill.slug, ok: false, status, attempts, error: message });
    }
  }

  return { published, failed, skipped: null, results };
}
