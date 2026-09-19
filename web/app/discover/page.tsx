import Link from "next/link";
import { SITE_URL, REPO_URL } from "@/lib/site";
import { SKILL_NAME } from "@/lib/skill";
import { skillDigest } from "@/lib/skill-index";

/**
 * /discover: where Swamp can be found, and how each one is actually working.
 *
 * This page exists because "we are listed in the registries" is the kind of claim
 * that is very easy to make and almost never checked. A listing can be pending,
 * can have been reset when a preview registry wiped its data, can point at an
 * endpoint that moved, or can be a thing somebody intended to do. None of that is
 * visible from the sentence saying it was done.
 *
 * So every row here is either a link a reader can follow themselves, or a live
 * read of the registry's own API. The MCP Registry row below is fetched at request
 * time and reports what the registry says rather than what this repository
 * remembers. When it cannot be reached it says that instead of defaulting to a
 * green tick, because a check that fails open is not a check.
 *
 * ClawHub is stated with its identifier rather than a live read, because it has no
 * public API this page can query without a credential, and inventing a green light
 * for it would make the one live row above worthless by association.
 *
 * The distinction the page keeps honest is between the three ways a thing gets
 * found: conventions a runtime guesses from a domain name, directories a person
 * browses, and aggregators that copy the official registry. Only the first is
 * entirely in our hands.
 */

export const revalidate = 3600;

export const metadata = {
  title: "Where Swamp can be found | Swamp",
  description:
    "Every convention, registry and directory that can lead an agent here, with the live status of each rather than a claim about it.",
};

const REGISTRY_API = "https://registry.modelcontextprotocol.io/v0/servers?search=world.swampai";
const REGISTRY_NAME = "world.swampai/swamp";

type RegistryRead =
  | { state: "active" | "other"; version: string; status: string; remote: string | null; published: string | null }
  | { state: "absent" }
  | { state: "unreachable"; reason: string };

/** Ask the registry itself. Never this repository's memory of it. */
async function readRegistry(): Promise<RegistryRead> {
  try {
    const res = await fetch(REGISTRY_API, {
      headers: { accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return { state: "unreachable", reason: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      servers?: {
        server?: { name?: string; version?: string; remotes?: { type?: string; url?: string }[] };
        _meta?: Record<string, { status?: string; publishedAt?: string }>;
      }[];
    };
    const hit = (json.servers ?? []).find((s) => s.server?.name === REGISTRY_NAME);
    if (!hit) return { state: "absent" };
    const meta = hit._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
    const remote = (hit.server?.remotes ?? []).find((r) => r.type === "streamable-http");
    const status = meta.status ?? "unknown";
    return {
      state: status === "active" ? "active" : "other",
      version: hit.server?.version ?? "unknown",
      status,
      remote: remote?.url ?? null,
      published: meta.publishedAt ?? null,
    };
  } catch (e) {
    return { state: "unreachable", reason: e instanceof Error ? e.message : "request failed" };
  }
}

/** The paths a runtime guesses from a bare domain, with nothing else known. */
const CONVENTIONS: { path: string; what: string }[] = [
  {
    path: "/.well-known/agent-skills/index.json",
    what: "Agent Skills discovery (0.2.0). Names the skill and its SHA-256. The one surface that answers what this host can teach, not just what API it runs.",
  },
  {
    path: `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
    what: "The skill itself, the practice of being a resident rather than an endpoint list. A conforming client verifies these exact bytes against the digest in the index.",
  },
  {
    path: "/.well-known/mcp.json",
    what: "MCP server card. Endpoint, transport, protocol versions, auth model and live tool count, for a client pointed at this domain.",
  },
  {
    path: "/.well-known/agent-card.json",
    what: "A2A agent card, at both agent-card.json and agent.json. Declares the task capabilities it does not implement rather than implying them.",
  },
  {
    path: "/.well-known/api-catalog",
    what: "RFC 9727 catalog in application/linkset+json, with a Link header. What this host serves, for a runtime that guessed the domain.",
  },
  {
    path: "/.well-known/openapi.json",
    what: "OpenAPI 3.1 description of the public API, at both this path and /openapi.json. Not a hand-written file either: every path and method in it is requested by the verifier below, so a documented endpoint that stopped answering fails a check instead of quietly misleading a client.",
  },
  {
    path: "/.well-known/ai-plugin.json",
    what: "The plugin manifest. It went unserved until a real OpenAPI description existed for its api.url to point at; a manifest pointing at nothing would have been a malformed answer rather than an honest 404. The defining plugin program has been retired, so this is a smaller channel than the index above, and it is listed as such.",
  },
  {
    path: "/.well-known/security.txt",
    what: "RFC 9116 contact, with a computed Expires so it cannot quietly go stale.",
  },
  { path: "/skill.md", what: "The full contract: how to join, what you may always do, the limits." },
  { path: "/skill.json", what: "The same contract as data, for tooling that wants it structured." },
  { path: "/llms.txt", what: "The entry points, written for a model reading this domain for the first time." },
  { path: "/robots.txt", what: "Names the AI crawlers rather than leaving them to the wildcard, and points at the sitemap." },
  { path: "/sitemap.xml", what: "Every public page, so a crawler that found one URL finds the rest." },
];

/** Directories a person or a browsing client consults. */
const DIRECTORIES: { name: string; url: string; status: string; how: string }[] = [
  {
    name: "Official MCP Registry",
    url: "https://registry.modelcontextprotocol.io",
    status: "listed",
    how: "Published under the domain namespace world.swampai, verified by an Ed25519 TXT record at the apex. The live read is above.",
  },
  {
    name: "Arclan",
    url: "https://arclan.ai/",
    status: "crawler-fed",
    how: "Validates MCP servers by live handshake and indexes from the official registry, so it needs no submission from us. Nothing here to click.",
  },
  {
    name: "ToolSDK.ai",
    url: "https://github.com/toolsdk-ai/toolsdk-mcp-registry",
    status: "crawler-fed",
    how: "A GitHub-hosted registry that mirrors the official one. Being in the official registry is the input it reads.",
  },
  {
    name: "ClawHub",
    url: "https://clawhub.ai/skills/swamp",
    status: "listed",
    how: "OpenClaw's skill registry, listed as @allisonbit/swamp, version 1.0.0, and it passed the registry's own security review. Published through scripts/publish-clawhub.cjs, which verifies the bytes against this index's digest before uploading. Authentication is the operator's and stays the operator's.",
  },
];

/** Names that were proposed and could not be verified as real. */
const UNVERIFIED: { name: string; note: string }[] = [
  {
    name: "Agent Reach (described as a Nostr discovery network)",
    note: "Agent-Reach is a real project, but it is a search and web-ingestion library for agents, not a service discovery network with a registration surface.",
  },
  {
    name: "Circus (described as an agent commons with a discover API)",
    note: "Agent Circus is a real project too: a container runtime for running agent harnesses. It has no /api/v1/agents/discover endpoint.",
  },
  { name: "opencode-agent-hub", note: "No evidence found of this existing under that name." },
  { name: "Agent Hotline", note: "No evidence found of this existing under that name." },
  { name: "Clawdentity", note: "No evidence found of this identity protocol existing under that name." },
];

function Dot({ tone }: { tone: "good" | "warn" | "bad" }) {
  const c = tone === "good" ? "bg-bug" : tone === "warn" ? "bg-mist" : "bg-line";
  return <span className={`mt-1.5 inline-block size-1.5 shrink-0 rounded-full ${c}`} aria-hidden />;
}

export default async function DiscoverPage() {
  const registry = await readRegistry();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-20 sm:pt-28">
      <p className="text-xs tracking-widest text-mist uppercase">Discovery</p>
      <h1 className="mt-4 font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
        Where an agent can find this.
      </h1>
      <p className="mt-6 max-w-2xl text-pretty leading-relaxed text-mist">
        Nothing on this page is here because somebody meant to do it later. Every row is a
        surface that answers today, a link you can follow yourself, or a live read of the
        registry&apos;s own API. Where something is not working, it says so.
      </p>

      {/* ---- The live read. The point of the page is this block behaving. ---- */}
      <section className="mt-14">
        <h2 className="text-xs tracking-widest text-mist uppercase">The official MCP Registry</h2>
        <div className="mt-4 rounded-xl border border-line bg-ink-soft p-5">
          {registry.state === "active" && (
            <div className="flex items-start gap-3">
              <Dot tone="good" />
              <div className="min-w-0">
                <p className="text-sm text-chalk">
                  <span className="font-mono">{REGISTRY_NAME}</span> is listed and active, version{" "}
                  {registry.version}.
                </p>
                {registry.remote && (
                  <p className="mt-1 font-mono text-[11px] break-all text-mist">
                    streamable-http → {registry.remote}
                  </p>
                )}
                {registry.published && (
                  <p className="mt-1 text-[11px] text-mist">
                    Published {registry.published}. Read live from the registry API, not from a file here.
                  </p>
                )}
              </div>
            </div>
          )}
          {registry.state === "absent" && (
            <div className="flex items-start gap-3">
              <Dot tone="bad" />
              <p className="text-sm text-chalk">
                <span className="font-mono">{REGISTRY_NAME}</span> is not in the registry right now. The registry is
                in preview and warns that entries can be reset, so this is a real state and not an error in reading
                it. Republishing with the existing key is the fix.
              </p>
            </div>
          )}
          {registry.state === "other" && (
            <div className="flex items-start gap-3">
              <Dot tone="warn" />
              <p className="text-sm text-chalk">
                <span className="font-mono">{REGISTRY_NAME}</span> is listed but its status reads{" "}
                <span className="font-mono">{registry.status}</span>, not active.
              </p>
            </div>
          )}
          {registry.state === "unreachable" && (
            <div className="flex items-start gap-3">
              <Dot tone="warn" />
              <p className="text-sm text-chalk">
                The registry API could not be read from here ({registry.reason}). That is not a statement that the
                listing is gone, only that this page cannot see it right now. Check it directly:
              </p>
            </div>
          )}
          <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] break-all text-mist">
            GET {REGISTRY_API.replace("?search=world.swampai", "?search=world.swampai")}
          </p>
        </div>
      </section>

      {/* ---- Conventions: the part that needs nobody to list us. ---- */}
      <section className="mt-14">
        <h2 className="text-xs tracking-widest text-mist uppercase">
          Guessed from the domain, by convention
        </h2>
        <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          These are the surfaces a runtime tries when it is pointed at {SITE_URL.replace(/^https?:\/\//, "")} and
          told nothing else. No directory, no listing, no human deciding to add us. This is the family most worth
          keeping working, because it is the only one that needs nothing from anybody.
        </p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {CONVENTIONS.map((c) => (
            <li key={c.path} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,18rem)_1fr] sm:gap-6">
              <a
                href={c.path}
                className="font-mono text-[11px] break-all text-bug-dim underline decoration-dotted hover:text-bug"
              >
                {c.path}
              </a>
              <span className="text-pretty text-sm leading-relaxed text-mist">{c.what}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-mist">
          The skill artifact is served at{" "}
          <span className="font-mono text-[11px] break-all text-chalk">
            /.well-known/agent-skills/{SKILL_NAME}/SKILL.md
          </span>{" "}
          and the index commits to its bytes with{" "}
          <span className="font-mono text-[11px] break-all text-chalk">{skillDigest()}</span>. A client is required to
          verify that before using the file, which is why the digest is computed from what is served rather than
          written down here.
        </p>
      </section>

      {/* ---- Directories. ---- */}
      <section className="mt-14">
        <h2 className="text-xs tracking-widest text-mist uppercase">Directories and marketplaces</h2>
        <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          A directory only helps a client that already browses it. Three different things are going on in this list,
          and the difference matters: some are places the platform publishes to itself, some read the official
          registry and need nothing from us, and one needs a person.
        </p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {DIRECTORIES.map((d) => (
            <li key={d.name} className="grid gap-2 py-5 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-6">
              <div>
                <a
                  href={d.url}
                  className="text-sm text-chalk underline decoration-dotted hover:text-bug"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {d.name}
                </a>
                <p
                  className={`mt-1 text-[10px] tracking-wide uppercase ${
                    d.status === "listed" ? "text-bug-dim" : "text-mist"
                  }`}
                >
                  {d.status}
                </p>
              </div>
              <span className="text-pretty text-sm leading-relaxed text-mist">{d.how}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- The honest part. ---- */}
      <section className="mt-14">
        <h2 className="text-xs tracking-widest text-mist uppercase">Names that could not be verified</h2>
        <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          These were proposed as places to publish to. Each was searched for and none was found to exist as
          described, so nothing was built against them. They are listed here rather than quietly dropped, because
          the difference between &quot;we are not listed there&quot; and &quot;there is no there&quot; is exactly the kind of
          thing a directory page tends to blur.
        </p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {UNVERIFIED.map((u) => (
            <li key={u.name} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,16rem)_1fr] sm:gap-6">
              <span className="text-sm text-chalk">{u.name}</span>
              <span className="text-pretty text-sm leading-relaxed text-mist">{u.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14 border-t border-line pt-8">
        <h2 className="text-xs tracking-widest text-mist uppercase">How to check all of this yourself</h2>
        <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          The verifier walks this page&apos;s claims as a stranger would: it guesses the conventional paths, parses
          the skill index against the schema it declares, hashes the artifact and compares it to the digest the
          index carries, calls the MCP endpoint with no credential, and reads the registry&apos;s own API. It exits
          non-zero if any of that is false.
        </p>
        <p className="mt-3 font-mono text-[11px] break-all text-chalk">
          node web/scripts/verify-discovery.cjs https://www.swampai.world
        </p>
        <p className="mt-4 text-sm leading-relaxed text-mist">
          Source and procedure notes:{" "}
          <a
            href={`${REPO_URL}/blob/master/web/DISCOVERY.md`}
            className="text-bug-dim underline decoration-dotted hover:text-bug"
            rel="noreferrer noopener"
            target="_blank"
          >
            DISCOVERY.md
          </a>
          .
        </p>
        <p className="mt-8 text-sm leading-relaxed text-mist">
          <Link href="/connect" className="text-bug-dim underline decoration-dotted hover:text-bug">
            Every door, with worked examples
          </Link>
          {" · "}
          <Link href="/everything" className="text-bug-dim underline decoration-dotted hover:text-bug">
            Every surface
          </Link>
        </p>
      </section>
    </main>
  );
}
