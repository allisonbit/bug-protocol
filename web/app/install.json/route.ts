import { NextResponse } from "next/server";
import {
  CHANNELS,
  CLI_COMMANDS,
  IMAGE,
  NPM_BIN,
  NPM_PACKAGE,
  NPM_VERSION,
  NOT_YET,
  PACKAGE_PATH,
  RELEASE_ASSET_URL,
  RELEASE_TAG,
  SINGLE_FILE_URL,
  TAP_FORMULA_URL,
  TAP_SLUG,
} from "@/lib/distribution";
import { bundleFacts } from "@/lib/downloads";
import { SITE_URL } from "@/lib/site";

/**
 * GET /install.json
 *
 * The install page is written for a person; this is the same file for a program. An agent that
 * has decided this host is worth adopting should not have to scrape prose to find out how, and
 * a registry or a package-manager integration should not have to guess which of several
 * commands is the real one.
 *
 * EVERY CLAIM IS THE SAME CLAIM the page makes, read from the same module, so the two cannot
 * disagree. The single file's hash is not restated here either: it is recomputed from the
 * bytes this deployment serves, and `state` says out loud whether the file agrees with its own
 * banner. A machine reading this gets a verdict, not a promise.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const bundle = bundleFacts();
  const live = CHANNELS.filter((c) => c.state === "live").length;
  return NextResponse.json(
    {
      site: SITE_URL,
      package: {
        name: NPM_PACKAGE,
        bin: NPM_BIN,
        version: NPM_VERSION,
        source: `${SITE_URL}/install`,
        repository: `${SITE_URL}/install#channels`,
        dependencies: 0,
      },
      single_file: {
        url: SINGLE_FILE_URL,
        bytes: bundle.bytes,
        sha256: bundle.actual,
        banner_sha256: bundle.claimed,
        state: bundle.state,
        body_starts_at_line: bundle.skipLine,
        self_check: "node swamp.mjs --self-sha256",
      },
      release: {
        tag: RELEASE_TAG,
        asset: RELEASE_ASSET_URL,
      },
      homebrew: {
        tap: TAP_SLUG,
        formula: TAP_FORMULA_URL,
        command: `brew install ${TAP_SLUG.split("/")[0]}/tap/${NPM_BIN}`,
      },
      container: {
        image: IMAGE,
        state: "not pushed",
      },
      channels: CHANNELS.map((c) => ({
        id: c.id,
        label: c.label,
        state: c.state,
        command: c.command,
        ...(c.remaining ? { remaining: c.remaining } : {}),
        ...(c.provenBy ? { proven_by: c.provenBy } : {}),
        note: c.note,
      })),
      counts: { live, total: CHANNELS.length },
      commands: CLI_COMMANDS.map((c) => ({ invocation: `${NPM_BIN} ${c.name}`, what: c.summary })),
      limits: NOT_YET,
      source_path: PACKAGE_PATH,
    },
    {
      headers: {
        "cache-control": "public, max-age=300, must-revalidate",
        "access-control-allow-origin": "*",
      },
    },
  );
}
