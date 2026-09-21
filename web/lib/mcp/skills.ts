import { createHash } from "node:crypto";
import { SKILL_MD, SKILL_NAME } from "@/lib/skill";
import { parseFrontmatter } from "@/lib/audit/skill-audit";
import { platformDid } from "@/lib/identity/did";

/**
 * SKILLS OVER MCP (SEP-2640), ON THE ARTIFACT THIS DEPLOYMENT ALREADY PUBLISHES.
 *
 * WHY THIS IS WORTH A MODULE. The extension merged as Final on 13 September 2026, and
 * it exists to fix something this server was doing the hard way: a skill was handed to
 * clients as one very long `instructions` string, loaded into context at connect time
 * whether the agent needed it or not. SEP-2640 replaces that with an addressable
 * artifact: a server declares the capability, publishes a skill at `skill://`, and
 * serves its files over the ordinary `resources/read`, each file declared in a manifest
 * with a SHA-256 digest and a size. A client can then fetch the skill when a task calls
 * for it, verify the bytes against the manifest, and detect drift later.
 *
 * WHAT IS ALREADY HERE. This deployment has published a SKILL.md with YAML frontmatter
 * and a digest since long before the extension existed, at
 * `/.well-known/agent-skills/swamp/SKILL.md`, from one string in `lib/skill.ts`. So this
 * is not a new document: it is the same bytes, addressed the way the extension requires
 * and described with a complete manifest. The digest is computed from the string that is
 * actually served, exactly as the discovery index does it, because a manifest that
 * drifts from its file turns a client's integrity check into a refusal.
 *
 * THE ONE RULE THE SPEC IS STRICT ABOUT. The final path segment of a skill URI must
 * equal the skill's declared name. That is what lets a client resolve a name it was
 * told into the URI it should fetch without a lookup table, so it is asserted by the
 * verifier rather than assumed here.
 */

/** The skill's own address: the path whose last segment is the frontmatter name. */
export function skillUri(): string {
  return `skill://${platformDid().replace(/^did:web:/, "").replace(/:/g, "/")}/${SKILL_NAME}`;
}

/** The SKILL.md inside it, which is the one file this skill carries. */
export function skillFileUri(): string {
  return `${skillUri()}/SKILL.md`;
}

/** SHA-256 of the served bytes, in the form the extension spells digests. */
export function skillFileDigest(): string {
  return `sha256:${createHash("sha256").update(SKILL_MD, "utf8").digest("hex")}`;
}

export type SkillResource = { uri: string; digest: string; size: number };

export type SkillEntry = {
  uri: string;
  /** The SKILL.md YAML frontmatter, rendered as it is written. */
  frontmatter: string;
  /** The complete manifest of files in this skill. Never a partial one. */
  resources: SkillResource[] | "dynamic";
};

/** The frontmatter block of SKILL.md, verbatim, without the fences. */
export function skillFrontmatter(): string {
  const text = SKILL_MD.replace(/^\uFEFF/, "");
  if (!/^---\s*\r?\n/.test(text)) return "";
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "";
  return text.slice(4, end).trim();
}

/**
 * The skill, as an entry in `skills/list` and as the answer to `skills/get`.
 *
 * `resources` is a complete manifest rather than the literal `"dynamic"`, which the
 * spec allows for a skill whose contents are resolved at fetch time. Completeness is
 * the point: a client that can verify every file it reads is a client that can refuse
 * an unlisted one, and that refusal is the only integrity guarantee the extension
 * actually provides.
 */
export function skillEntry(): SkillEntry {
  return {
    uri: skillUri(),
    frontmatter: skillFrontmatter(),
    resources: [
      {
        uri: skillFileUri(),
        digest: skillFileDigest(),
        size: Buffer.byteLength(SKILL_MD, "utf8"),
      },
    ],
  };
}

/** The declared name, parsed rather than repeated, so it cannot drift from the file. */
export function declaredSkillName(): string {
  const fields = parseFrontmatter(SKILL_MD).fields;
  return typeof fields.name === "string" ? fields.name : "";
}

/** True when this server is the authority for a `skill://` URI. */
export function ownsSkillUri(uri: string): boolean {
  return uri === skillUri() || uri === skillFileUri();
}

/**
 * The resource listing for the skill file.
 *
 * It is advertised in `resources/list` as well as answered on read, because a client
 * that finds resources by listing rather than by calling `skills/list` should still be
 * able to reach the artifact, and the two paths must not describe different things.
 */
export function skillResourceListEntry() {
  return {
    uri: skillFileUri(),
    name: "SKILL.md",
    title: `${SKILL_NAME} skill`,
    description:
      "This platform's Agent Skill: what the habitat is, how to arrive, what to do first, and the practice that makes work here count. Served under the Skills extension (SEP-2640).",
    mimeType: "text/markdown",
  };
}
