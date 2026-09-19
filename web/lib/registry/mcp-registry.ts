import "server-only";
import { createPrivateKey, sign as edSign } from "node:crypto";
import serverJson from "@/server.json";

/**
 * THE OFFICIAL MCP REGISTRY, AS A CLIENT RATHER THAN A CLI.
 *
 * The listing at `world.swampai/swamp` was published by hand with `mcp-publisher`,
 * a Go binary that lives on one machine. That makes the listing exactly as durable
 * as somebody remembering to check it, and the registry says of itself that it is
 * in preview and that **data resets may occur**. A listing that disappears and is
 * never noticed is the failure this module exists to remove: the platform can now
 * see its own listing, and put it back, without a human in the loop.
 *
 * WHY THIS IS REIMPLEMENTED AND NOT SHELLED OUT TO. A serverless function cannot
 * run `mcp-publisher`: it is a compiled binary that is not in the deployment, and
 * the publish flow is three HTTP calls and one signature, which is smaller than
 * the machinery needed to ship a binary would be. The contract below was read off
 * the registry's own OpenAPI description (`/openapi.yaml`, under an API freeze at
 * v0.1) rather than guessed, and the signature scheme was confirmed against the
 * live service before it was relied on. See MCP-REGISTRY.md.
 *
 * THE SIGNATURE SCHEME, WHICH IS THE ONE THING EASY TO GET WRONG.
 *
 * Two routes accept the same body: `/v0.1/auth/http` verifies against the proof
 * file the registry fetches from the domain, and `/v0.1/auth/dns` verifies against
 * the apex TXT record. **Only the DNS route can work for this domain**, and that
 * is not a preference. The apex `swampai.world` redirects to `www` with a 308, and
 * the registry's fetcher does not follow redirects, so the HTTP route fails with
 * "failed to fetch public key: HTTP 308" no matter how correct the signature is.
 * That is precisely why the namespace is DNS-verified. Measured, not assumed:
 * the HTTP route was tried first and returned 401 three times.
 *
 * The body is `{ domain, timestamp, signed_timestamp }` where the timestamp is
 * RFC3339 **without fractional seconds** and `signed_timestamp` is the hex Ed25519
 * signature over the timestamp's UTF-8 bytes. Milliseconds were tried and rejected:
 * Go's `time.RFC3339` does not carry them.
 *
 * WHAT IS DELIBERATELY NOT HERE. The private key is not in this file, not in the
 * repository and not in git. It arrives in the deployment's environment as
 * `MCP_REGISTRY_PRIVATE_KEY`, which the operator set from the key file they hold.
 * Only the public half is served at /.well-known/mcp-registry-auth, and holding
 * that file proves ownership without granting the ability to sign. Putting the
 * private half on the deployment is a real trade — anything that reads that
 * environment can sign as this namespace — and it was made deliberately so that a
 * vanished listing can be restored without waiting for a person.
 */

const REGISTRY = (process.env.MCP_REGISTRY_BASE || "https://registry.modelcontextprotocol.io").replace(/\/+$/, "");

/** The namespace, and the version this deployment claims. Both from the manifest. */
export const REGISTRY_SERVER_NAME: string = serverJson.name;
export const REGISTRY_VERSION: string = serverJson.version;

/** What the registry says about a version's lifecycle. */
export type RegistryStatus = "active" | "deprecated" | "deleted";

export type RegistryListing = {
  name: string;
  version: string;
  status: RegistryStatus | "unknown";
  updatedAt: string | null;
};

/** Whether this deployment can sign as the namespace at all. */
export function registryConfigured(): boolean {
  return typeof process.env.MCP_REGISTRY_PRIVATE_KEY === "string" && process.env.MCP_REGISTRY_PRIVATE_KEY.length > 0;
}

/**
 * The key, from either shape the environment might hold it in.
 *
 * A PEM is multi-line and an environment variable is a hostile place for
 * newlines: a dashboard that trims or folds them turns a valid key into an
 * unreadable one, and the failure looks like a signature error rather than a
 * storage error. So a base64 form is accepted and preferred, and a raw PEM is
 * still honoured for anyone who pasted one.
 */
function privateKey() {
  const raw = process.env.MCP_REGISTRY_PRIVATE_KEY;
  if (!raw) throw new Error("MCP_REGISTRY_PRIVATE_KEY is not set, so this deployment cannot sign as the namespace.");
  const text = raw.includes("BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
  if (!text.includes("BEGIN")) {
    throw new Error("MCP_REGISTRY_PRIVATE_KEY is neither a PEM nor base64 of one.");
  }
  return createPrivateKey(text);
}

/**
 * Sign a fresh timestamp and exchange it for a registry JWT.
 *
 * The timestamp is minted per call rather than reused, because it is the thing
 * the signature is over: a token obtained from an old timestamp is a token that
 * proves nothing about the present. The registry returns `expires_at` and the
 * token is cached only until then, so a check on a schedule signs in at most once
 * per token lifetime rather than on every beat.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function registryToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  // RFC3339, no fractional seconds: what Go's time.RFC3339 produces and what the
  // exchange accepted when it was measured.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const signed = edSign(null, Buffer.from(timestamp, "utf8"), privateKey()).toString("hex");

  const res = await fetch(`${REGISTRY}/v0.1/auth/dns`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ domain: apexDomain(), timestamp, signed_timestamp: signed }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    // The registry's own words, because "401" alone has sent people looking for a
    // problem in the wrong half of the exchange.
    throw new Error(`MCP Registry sign-in returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { registry_token?: string; expires_at?: number };
  if (!body.registry_token) throw new Error("MCP Registry sign-in returned no token.");
  // expires_at is seconds since the epoch; some deployments omit it, and a
  // conservative five minutes is the safe reading of "we do not know".
  const expiresAt = body.expires_at ? body.expires_at * 1000 : Date.now() + 300_000;
  cached = { token: body.registry_token, expiresAt };
  return body.registry_token;
}

/**
 * The domain the TXT record lives on, which is the apex and not `www`.
 *
 * Taken from the namespace rather than from the site URL, because they are
 * different things that happen to describe the same organisation: the namespace
 * is reverse DNS of the domain the record is at, and the site is served from a
 * subdomain of it.
 */
export function apexDomain(): string {
  // world.swampai/swamp -> swampai.world
  const label = REGISTRY_SERVER_NAME.split("/")[0] ?? "";
  const parts = label.split(".").filter(Boolean).reverse();
  if (parts.length >= 2) return parts.join(".");
  return process.env.SWAMP_APEX_DOMAIN || "swampai.world";
}

/** Does the listing exist, and in what state? Never throws: a check reports. */
export async function readListing(): Promise<
  { ok: true; listing: RegistryListing | null } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${REGISTRY}/v0.1/servers?search=${encodeURIComponent(REGISTRY_SERVER_NAME)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `registry returned ${res.status}` };
    const body = (await res.json()) as {
      servers?: { server?: { name?: string; version?: string }; _meta?: Record<string, { status?: string; updatedAt?: string }> }[];
    };
    const hit = (body.servers ?? []).find((s) => s.server?.name === REGISTRY_SERVER_NAME);
    if (!hit) return { ok: true, listing: null };
    const meta = hit._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
    return {
      ok: true,
      listing: {
        name: String(hit.server?.name),
        version: String(hit.server?.version ?? REGISTRY_VERSION),
        status: (meta.status as RegistryStatus) ?? "unknown",
        updatedAt: meta.updatedAt ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Publish, or republish, the manifest this repository carries. */
export async function publishListing(): Promise<{ version: string; status: string }> {
  const token = await registryToken();
  const res = await fetch(`${REGISTRY}/v0.1/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(serverJson),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP Registry publish returned ${res.status}: ${text.slice(0, 400)}`);
  const body = JSON.parse(text) as { server?: { version?: string }; _meta?: Record<string, { status?: string }> };
  return {
    version: String(body.server?.version ?? REGISTRY_VERSION),
    status: String(body._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active"),
  };
}

/**
 * Set a version's lifecycle status.
 *
 * This is the repair for the most likely accident, and it is the reason the
 * reconciler does not simply always republish. The registry keeps versions, so
 * publishing an already-published version is a no-op rather than a restore: if a
 * listing was flipped to `deleted`, republishing changes nothing and the entry
 * stays gone. Flipping the status back is the operation that actually fixes it.
 */
export async function setListingStatus(status: RegistryStatus, message?: string): Promise<void> {
  const token = await registryToken();
  const name = encodeURIComponent(REGISTRY_SERVER_NAME);
  const version = encodeURIComponent(REGISTRY_VERSION);

  // A message is not allowed alongside `active`: the registry rejects the whole
  // request with 400 "status_message cannot be provided when setting status to
  // active", which is correct of it and easy to get wrong. Setting a listing back
  // to active is precisely what this function exists to do, so the message is
  // dropped rather than the caller having to know the rule. Found by running the
  // repair against the live registry, not by reading the schema, which does not
  // express the constraint.
  const body: { status: RegistryStatus; statusMessage?: string } = { status };
  if (message && status !== "active") body.statusMessage = message.slice(0, 500);

  const res = await fetch(`${REGISTRY}/v0.1/servers/${name}/versions/${version}/status`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP Registry status update returned ${res.status}: ${text.slice(0, 300)}`);
}

/** The manifest as published, for a page that wants to show what we claim. */
export const LISTING_MANIFEST = serverJson;
