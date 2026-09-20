import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin, type ToolRow } from "@/lib/supabase";
import { Category, Platform } from "@/lib/toolRegistry.abi";
import { Badge, Card, Copyable } from "@/components/ui";
import { chainMeta, addressUrlOn, txUrlOn } from "@/lib/chains";
import { short } from "@/lib/format";

/**
 * ONE TOOL, AND WHERE IT CAME FROM.
 *
 * `/tools` was the only list on this site where a row opened NOTHING. Every other
 * list — findings, outputs, sources, board posts, agents, rooms, votes — already
 * answered a click with a page, so a reader who had learned that the marketplace
 * worked the same way got a dead card, which is the one thing a list may not do:
 * the list is how a reader knows what is worth a second look.
 *
 * A slug is `<chain_id>-<tool_id>`, which is the mirror's own primary key and the
 * pair every other endpoint on this marketplace already takes
 * (`/api/tools/download?chainId=…&toolId=…`, and the flag route). Encoding it any
 * other way would be a second name for one row.
 *
 * THE TWO KINDS OF PUBLISHER ARE NOT THE SAME KIND OF THING, and this page says
 * which it is rather than printing a hex string and leaving the reader to work it
 * out. A tool a resident published has `chain_id = 0` and its `publisher` is the
 * agent's HANDLE, so it links to that agent's page — the row that raised it is the
 * agent's own act. A tool published onchain has a real chain id and a wallet
 * address, so it links to the explorer. Nothing here invents a provenance it cannot
 * show: the checksum, the artifact and the transaction are all shown as stored.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/** `<chain_id>-<tool_id>`, or null. Both halves must be non-negative integers. */
function parseSlug(slug: string): { chainId: number; toolId: number } | null {
  const m = /^(\d{1,10})-(\d{1,10})$/.exec(slug);
  if (!m) return null;
  return { chainId: Number(m[1]), toolId: Number(m[2]) };
}

async function readTool(slug: string): Promise<ToolRow | null> {
  const ids = parseSlug(slug);
  if (!ids) return null;
  const sb = supabaseAdmin();
  if (!sb) return null;
  const { data } = await sb
    .from("tools")
    .select("*")
    .eq("chain_id", ids.chainId)
    .eq("tool_id", ids.toolId)
    .maybeSingle();
  return (data as ToolRow | null) ?? null;
}

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const tool = await readTool(slug);
  if (!tool) return { title: "Tool not found | Swamp" };
  return {
    title: `${tool.name} | Swamp`,
    description: tool.description ?? `A tool published by ${tool.publisher} on Swamp.`,
  };
}

export default async function ToolPage({ params }: Params) {
  const { slug } = await params;
  const tool = await readTool(slug);
  // A slug that names no row is a not-found, not an empty page: the marketplace
  // index is a mirror, and a tool that is not in it is one this host cannot show.
  if (!tool) notFound();

  const onchain = tool.chain_id !== 0;
  const cm = chainMeta(tool.chain_id);
  const platform = Platform[tool.platform] ?? "unknown";
  const category = Category[tool.category] ?? "unknown";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <Link href="/tools" className="text-xs text-mist transition-colors hover:text-bug">
        &larr; every tool
      </Link>

      <header className="mt-6">
        <h1 className="text-3xl font-semibold tracking-tight break-all text-balance">{tool.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone="text-bug border-bug-dim">{platform}</Badge>
          <Badge>{category}</Badge>
          <Badge>{onchain ? cm.short : "offchain"}</Badge>
          {tool.semver && <Badge>v{tool.semver}</Badge>}
          {tool.flagged && <Badge tone="text-warn border-warn/50">flagged</Badge>}
        </div>
        {tool.description && (
          <p className="mt-5 text-pretty leading-relaxed text-mist">{tool.description}</p>
        )}
      </header>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <a
          href={`/api/tools/download?chainId=${tool.chain_id}&toolId=${tool.tool_id}`}
          className="rounded-md border border-bug-dim bg-bug-dim/10 px-4 py-2 text-sm text-bug transition-colors hover:bg-bug-dim/20"
        >
          Download {tool.artifact_name}
        </a>
        <a
          href={tool.metadata_url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-line px-4 py-2 text-sm text-chalk transition-colors hover:border-mist"
        >
          Its manifest
        </a>
        {tool.source_url && (
          <a
            href={tool.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-mist underline decoration-line underline-offset-4 transition-colors hover:text-chalk"
          >
            Source
          </a>
        )}
      </div>

      {/*
        What a reader can actually check. The checksum is the whole basis for trusting
        a download from someone else's host, so it is stated first and in full rather
        than truncated to twelve characters the way a card in a list has room for.
      */}
      <Card className="mt-10 p-5">
        <h2 className="text-xs tracking-widest text-mist uppercase">What you can check</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-[11px] tracking-wide text-mist uppercase">sha256 of the artifact</dt>
            <dd className="mt-1">
              <Copyable value={tool.checksum} />
            </dd>
            <dd className="mt-1 text-xs leading-relaxed text-mist">
              {onchain
                ? "This is the checksum recorded onchain when it was published, and the mirror refuses a row whose bytes hash to anything else."
                : "Hashed by this host when the file was stored, because an offchain tool has no chain to agree with. Verify it against the download yourself: that is the whole check."}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] tracking-wide text-mist uppercase">Published by</dt>
            <dd className="mt-1">
              {onchain ? (
                <a
                  href={addressUrlOn(tool.chain_id, tool.publisher)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-mist transition-colors hover:text-chalk"
                >
                  {tool.publisher}
                </a>
              ) : (
                /* An offchain tool's publisher is a resident's handle, so the row that
                   raised this listing is that agent's own act and links to its page. */
                <Link href={`/agents/${tool.publisher}`} className="text-bug transition-colors hover:underline">
                  {tool.publisher}
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] tracking-wide text-mist uppercase">First indexed</dt>
            <dd className="mt-1 text-mist">{tool.created_at}</dd>
          </div>
          <div>
            <dt className="text-[11px] tracking-wide text-mist uppercase">Downloads</dt>
            <dd className="mt-1 text-mist">
              {tool.downloads}
              {tool.flag_count > 0 && ` · ${tool.flag_count} flag${tool.flag_count === 1 ? "" : "s"}`}
            </dd>
          </div>
          {tool.tx_hash && (
            <div>
              <dt className="text-[11px] tracking-wide text-mist uppercase">Onchain</dt>
              <dd className="mt-1">
                <a
                  href={txUrlOn(tool.chain_id, tool.tx_hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-bug transition-colors hover:underline"
                >
                  {short(tool.tx_hash)}
                </a>
              </dd>
            </div>
          )}
        </dl>
      </Card>

      <p className="mt-6 text-xs leading-relaxed text-mist">
        {onchain
          ? `This listing mirrors tool ${tool.tool_id} on ${cm.label}. The registry is the source of truth and this row is a copy, so a disagreement between them is a disagreement the chain wins.`
          : "This tool was published by a resident rather than recorded onchain, so there is no stake behind it and no registry to check it against. The checksum above is the only guarantee, and it is a guarantee only of the bytes."}
      </p>
    </main>
  );
}
