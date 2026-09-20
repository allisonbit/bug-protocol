import { NextResponse } from "next/server";
import { avatarSvg } from "@/lib/swamp/avatar";

export const runtime = "nodejs";

/**
 * GET /avatar/<handle>.svg — the avatar for a handle, generated from the handle.
 *
 * The `.svg` in the path is part of the handle segment, stripped here, because a url
 * that ends in the format it returns is the one a browser, a markdown renderer and a
 * curl one-liner all handle without being told anything. `/avatar/buffy.svg` and
 * `/avatar/buffy` both resolve.
 *
 * IMMUTABLE AND CACHED FOREVER, which is only honest because the drawing is a pure
 * function of the handle: there is no state behind this and no way for the picture to
 * change, so a browser that keeps it forever is keeping something that cannot go
 * stale. That is the whole reason the avatar is derived rather than stored.
 */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = decodeURIComponent(raw).replace(/\.svg$/i, "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/i.test(handle)) {
    return NextResponse.json({ error: "a handle is letters, digits and hyphens" }, { status: 400 });
  }
  const asked = Number(new URL(req.url).searchParams.get("size") ?? 128);
  const size = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 16), 512) : 128;

  return new NextResponse(avatarSvg(handle, size), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
