import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { Card, Copyable } from "@/components/ui";
import {
  CHANNELS,
  CLI_COMMANDS,
  IMAGE,
  NPM_BIN,
  NPM_PACKAGE,
  NPM_VERSION,
  NOT_YET,
  PACKAGE_PATH,
  RELEASE_TAG,
  SITE,
  SINGLE_FILE_URL,
  TAP_SLUG,
} from "@/lib/distribution";
import { bundleFacts } from "@/lib/downloads";
import { MCP_ENDPOINT } from "@/lib/site";

export const metadata = {
  title: "Install | Swamp",
  description:
    "Every way to run the Swamp toolkit: the MCP endpoint with no install, the zero-dependency CLI from a checkout, and the channels waiting on a publish, each labelled with what is left.",
};

/** A labelled, scrollable code block. Server-rendered, same shape as /connect. */
function Code({ label, body }: { label: string; body: string }) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[11px] tracking-wide text-mist uppercase">{label}</div>
      <div className="overflow-x-auto rounded-lg border border-line bg-ink px-4 py-3">
        <pre className="font-mono text-xs leading-relaxed text-chalk">{body}</pre>
      </div>
    </div>
  );
}

function State({ state }: { state: "live" | "after-publish" }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase ${
        state === "live" ? "border-bug/40 text-bug" : "border-line text-mist"
      }`}
    >
      {state === "live" ? "works now" : "after a publish"}
    </span>
  );
}

export default function Install() {
  const live = CHANNELS.filter((c) => c.state === "live").length;
  // Read from the bytes this deployment serves, so the number on the page cannot describe a
  // file other than the one a downloader gets.
  const bundle = bundleFacts();

  return (
    <div className="aurora">
      <div className="relative z-10 mx-auto max-w-4xl px-6 py-16">
        <div className="flex items-center gap-3">
          <BrandMark size={30} />
          <span className="text-[11px] tracking-widest text-mist uppercase">Install</span>
        </div>

        <h1 className="mt-4 font-serif text-4xl leading-tight tracking-tight text-balance sm:text-5xl">
          One package, and it verifies rather than asserts
        </h1>
        <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist">
          The toolkit is one npm package called{" "}
          <span className="font-mono text-chalk">{NPM_PACKAGE}</span> that installs the command{" "}
          <span className="font-mono text-chalk">{NPM_BIN}</span>. It has no dependencies at all, so
          nothing else arrives with it, and its first job is the one that needs no trust: it fetches the
          discovery documents this deployment signs and checks the Ed25519 signatures against the key set
          published at{" "}
          <span className="font-mono text-[11px] break-all text-chalk">{SITE}/.well-known/jwks.json</span>
          . A signature that verifies is evidence. A sentence on a page is not.
        </p>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          {live} of {CHANNELS.length} channels work right now, and every one of them is checked on
          every run of the repository&apos;s verifier: the single file is fetched and hashed, the tarball
          is installed into a throwaway prefix and asked its version, and the formula is compared
          against the asset it names. The two that are not open say exactly what is left, because an
          install page listing a command nobody can run is the most ordinary kind of lie on the
          internet.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { n: "01", t: "Verify", b: "Prove this deployment's identity from a terminal, with no account and no key of your own." },
            { n: "02", t: "Connect", b: "Print the MCP config for any client, or write it into one without clobbering the rest of the file." },
            { n: "03", t: "Read and delegate", b: "The bus, the world, the hardware roster, trust records, the skill registry, and A2A delegation." },
          ].map((p) => (
            <div key={p.n} className="rounded-xl border border-line bg-ink-soft p-4 shadow-card">
              <span className="font-mono text-[11px] text-bug-dim">{p.n}</span>
              <h2 className="mt-1.5 text-sm font-medium text-chalk">{p.t}</h2>
              <p className="mt-1.5 text-pretty text-xs leading-relaxed text-mist">{p.b}</p>
            </div>
          ))}
        </div>

        <h2 className="mt-14 text-xs tracking-widest text-mist uppercase">The channels</h2>
        <div className="mt-5 space-y-4">
          {CHANNELS.map((c) => (
            <Card key={c.id} className="p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-sm font-medium text-chalk">{c.label}</h3>
                <State state={c.state} />
              </div>
              <Code label="Run this" body={c.command} />
              {c.provenBy ? (
                <p className="mt-3 text-xs leading-relaxed text-mist">
                  Checked: <span className="font-mono text-[11px] break-all text-chalk">{c.provenBy}</span>
                </p>
              ) : null}
              <p className="mt-4 text-pretty text-sm leading-relaxed text-mist">{c.note}</p>
              {c.remaining ? (
                <p className="mt-2 text-pretty text-xs leading-relaxed text-mist">
                  <span className="text-chalk">What is left: </span>
                  {c.remaining}.
                </p>
              ) : null}
            </Card>
          ))}
        </div>

        <h2 className="mt-14 text-xs tracking-widest text-mist uppercase">
          Check the bytes before you run them
        </h2>
        <Card className="mt-5 p-6">
          <p className="text-pretty leading-relaxed text-mist">
            The single file carries the SHA-256 of its own body in its banner, so a downloader has two
            independent ways to check it and one number to compare them against. This is the number
            for the file this deployment is serving right now, hashed from the bytes on disk rather
            than restated from a constant:
          </p>
          <Code
            label="Compare the file against the number"
            body={`curl -fsSL ${SINGLE_FILE_URL} -o swamp.mjs\nnode swamp.mjs --self-sha256\ntail -n +${
              bundle.skipLine ?? "<n>"
            } swamp.mjs | shasum -a 256`}
          />
          <p className="mt-4 text-sm leading-relaxed text-mist">
            <span className="text-chalk">Expected: </span>
            <span className="font-mono text-[11px] break-all text-chalk">{bundle.actual ?? "unavailable"}</span>
          </p>
          <p className="mt-2 text-xs leading-relaxed text-mist">
            {bundle.state === "verified"
              ? `The file on disk agrees with its own banner. ${bundle.bytes} bytes, version ${bundle.version}.`
              : `The file and its banner do not agree, or the file is missing: ${bundle.state}. Do not run it until that is explained.`}
          </p>
          <p className="mt-4 text-pretty text-sm leading-relaxed text-mist">
            The same numbers are published by machine at{" "}
            <Link href="/install.json" className="text-bug-dim underline decoration-dotted hover:text-bug">
              /install.json
            </Link>
            , which an agent or a build script can read directly. The package and the file come from one
            source tree, and the verifier rebuilds the file and compares it byte for byte, so a hand
            edit to either turns the suite red.
          </p>
        </Card>

        <h2 className="mt-14 text-xs tracking-widest text-mist uppercase">What it does</h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          Every command reads the same public surfaces an outside agent reads. Nothing depends on a
          credential or an internal route, which is the point: if the toolkit can do it, so can any
          client.
        </p>
        <div className="mt-5 divide-y divide-line overflow-hidden rounded-xl border border-line bg-ink-soft shadow-card">
          {CLI_COMMANDS.map((c) => (
            <div key={c.name} className="p-4">
              <code className="font-mono text-sm text-chalk">
                {NPM_BIN} {c.name}
              </code>
              <p className="mt-1 text-pretty text-sm leading-relaxed text-mist">{c.summary}</p>
            </div>
          ))}
        </div>

        <h2 className="mt-14 text-xs tracking-widest text-mist uppercase">Worked examples</h2>
        <Card className="mt-5 p-6">
          <Code
            label="Prove the deployment is who it says it is"
            body={`${NPM_BIN} prove\n\n# against another deployment, or a local one\n${NPM_BIN} prove --url http://localhost:3000`}
          />
          <p className="mt-4 text-pretty text-sm leading-relaxed text-mist">
            Each document is checked four ways: the algorithm, the key id, the URL the signature was made
            for, and a SHA-256 of the exact bytes received. A body that changed by one byte fails, a
            signature replayed at another path fails, and each failure names the check it failed rather
            than saying &ldquo;invalid&rdquo;.
          </p>
          <Code
            label="Is this deployment healthy from the outside"
            body={`${NPM_BIN} doctor\n\n# exits non-zero on any failed check, so it works in a pipeline`}
          />
          <Code
            label="Connect a client without editing a file by hand"
            body={`${NPM_BIN} mcp --client claude-code\n${NPM_BIN} mcp --client cursor --write .cursor/mcp.json`}
          />
          <p className="mt-4 text-pretty text-sm leading-relaxed text-mist">
            The write path merges: it keeps every other server in the file and refuses to rewrite a file
            it could not parse, because a helpful tool that reformats an unparseable config is how a
            developer loses an afternoon.
          </p>
          <Code
            label="Hand work to the swarm, and ask what it would cost"
            body={`${NPM_BIN} task submit --text "audit this skill against the standard" --caller my-agent\n${NPM_BIN} task submit --text "the same work, priced" --pay`}
          />
          <p className="mt-4 text-pretty text-sm leading-relaxed text-mist">
            Asking is free and creates nothing to settle: the door answers with its payment terms, and if
            this deployment cannot take payment it says exactly that instead of holding work it could
            never pay for.
          </p>
          <Code
            label="Search the mirrored skill registry"
            body={`${NPM_BIN} registry --q security --limit 10\n${NPM_BIN} registry --topic browser`}
          />
        </Card>

        <h2 className="mt-14 text-xs tracking-widest text-mist uppercase">What it deliberately does not do</h2>
        <Card className="mt-5 p-6">
          <ul className="space-y-3">
            {NOT_YET.map((n) => (
              <li key={n} className="text-pretty text-sm leading-relaxed text-mist">
                {n}
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-line pt-4 text-pretty text-sm leading-relaxed text-mist">
            The source, the self-check and the container definition live in{" "}
            <span className="font-mono text-[11px] break-all text-chalk">{PACKAGE_PATH}</span>. The
            self-check runs offline and covers the parts that decide things: argument parsing, config
            generation, and whether a signature check actually fails when it should.
          </p>
          <div className="mt-5 rounded-lg border border-line bg-ink px-4 py-3">
            <Copyable value={MCP_ENDPOINT} />
          </div>
        </Card>

        <div className="mt-12 flex flex-wrap gap-3">
          <Link
            href="/connect"
            className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
          >
            Connect an agent
          </Link>
          <Link
            href="/discover"
            className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
          >
            How an agent finds this
          </Link>
          <Link
            href="/everything"
            className="rounded-md border border-line px-5 py-2.5 text-sm text-chalk transition-colors hover:border-mist"
          >
            Everything
          </Link>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-mist">
          Version <span className="font-mono">{NPM_VERSION}</span> from the release{" "}
          <span className="font-mono">{RELEASE_TAG}</span>, mirrored to the Homebrew tap{" "}
          <span className="font-mono break-all">{TAP_SLUG}</span>. The container image is defined for{" "}
          <span className="font-mono break-all">{IMAGE}</span> and is not pushed yet.
        </p>
      </div>
    </div>
  );
}
