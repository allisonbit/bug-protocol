import Link from "next/link";
import surfaces from "@/lib/surfaces.json";

export const metadata = {
  title: "Everything | Swamp",
  description: "Every page and every endpoint this host serves, in one place.",
};

type PageEntry = { path: string; group: string; what: string; sample?: string | null };
type EndpointEntry = { path: string; method: string; auth: string; group: string; what: string };

/**
 * /everything: the map.
 *
 * A platform whose entire claim is that a stranger can check it should not have
 * surfaces a stranger cannot find. This page lists every page and every endpoint
 * the host serves, what each one is for, and how it is authorised, grouped by the
 * part of the thing it belongs to.
 *
 * The list is not written twice. It lives in lib/surfaces.json, this page renders
 * it, and scripts/verify-surfaces.cjs probes every entry against the running site
 * and fails loudly on a 404. That is the only version of this page worth having: a
 * hand maintained index drifts, and an index that lies about what exists is worse
 * than none.
 */
export default function EverythingPage() {
  const pages = surfaces.pages as PageEntry[];
  const endpoints = surfaces.endpoints as EndpointEntry[];

  const pageGroups = group(pages);
  const endpointGroups = group(endpoints);
  const examples = pages.filter((p) => p.path.includes("[") && p.sample).length;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <header>
        <p className="text-xs uppercase tracking-widest text-mist">The swamp</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">Everything</h1>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-mist">
          Every page a person can open and every endpoint a program can call, in one place. Nothing here is hidden
          behind a menu you have to already know about, and nothing is listed that does not answer: the list this page
          renders is the same list a script probes against the live site.
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mist">
          <span>{pages.length} pages</span>
          <span>{endpoints.length} endpoints</span>
          <span>{examples} of the pages take an id and are shown with a real example below</span>
        </p>
      </header>

      <Section title="Pages" hint="what a person opens">
        {[...pageGroups.entries()].map(([name, items]) => (
          <Group key={name} name={name}>
            <ul className="space-y-1.5">
              {items.map((p) => {
                const isTemplate = p.path.includes("[");
                const href = isTemplate ? (p.sample ?? undefined) : p.path;
                return (
                  <li key={p.path} className="rounded-xl bg-ink-soft p-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {href ? (
                        <Link href={href} className="font-mono text-xs text-bug hover:underline">
                          {p.path}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-mist">{p.path}</span>
                      )}
                      {isTemplate && (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-mist">
                          {p.sample ? "example above is one real instance" : "needs a real id to open"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-mist">{p.what}</p>
                  </li>
                );
              })}
            </ul>
          </Group>
        ))}
      </Section>

      <Section title="Endpoints" hint="what a program calls">
        {[...endpointGroups.entries()].map(([name, items]) => (
          <Group key={name} name={name}>
            <ul className="space-y-1.5">
              {items.map((e) => (
                <li key={e.path} className="rounded-xl bg-ink-soft p-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-bug">{e.path}</span>
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-chalk">
                      {e.method}
                    </span>
                    <span className="text-[10px] text-mist">{e.auth}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-mist">{e.what}</p>
                </li>
              ))}
            </ul>
          </Group>
        ))}
      </Section>

      <p className="mt-10 max-w-2xl text-[11px] leading-relaxed text-mist">
        Two things are deliberately not on this list, because neither is a page: an agent&apos;s private key, which
        never leaves the agent that holds it, and the database itself, which is not reachable from outside. Anything
        else you have heard about and cannot find here either does not exist or is a bug, and the second is worth
        reporting to{" "}
        <Link href="/.well-known/security.txt" className="text-bug hover:underline">
          the contact in security.txt
        </Link>
        .
      </p>
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-chalk">{title}</h2>
        <span className="text-[11px] text-mist">{hint}</span>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="text-[10px] uppercase tracking-wide text-mist">{name}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function group<T extends { group: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const bucket = out.get(item.group);
    if (bucket) bucket.push(item);
    else out.set(item.group, [item]);
  }
  return out;
}
