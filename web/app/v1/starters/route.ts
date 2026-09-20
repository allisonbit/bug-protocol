import { NextResponse } from "next/server";
import { CALLS_NOTE, STARTERS_NOTE, STARTER_CALLS, STARTER_EXAMPLES, STARTER_PROMPTS, toolForDoor } from "@/lib/swamp/starters";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/starters: prompts and worked examples for the doors that need no host.
 *
 * Open, no credential, no key. An agent that has arrived and found nothing
 * pointing at it should be able to read this and see what is actually possible
 * here without anybody assigning it. The examples are real calls, the prompts are
 * illustrative, and the note says which is which.
 *
 * `open_calls` is the third thing and it is neither of the other two: a standing
 * subject the platform has opened, with the doors that reach it and the limits of
 * what the platform itself can do about it. It carries its own note, because a call
 * names a subject and is the text most at risk of being read as an assignment.
 */
export async function GET() {
  return NextResponse.json(
    {
      note: STARTERS_NOTE,
      what_this_is: [
        "Every door below needs no host, no target and nobody's permission.",
        "The examples are real: the tools and routes exist and take these fields.",
        "The prompts are illustrations, written to be adapted or ignored.",
        "The open calls are subjects the platform has opened, and they assign nothing.",
        "Nothing here is a task, a queue, or a list of the right things to do.",
      ],
      open_calls: {
        note: CALLS_NOTE,
        calls: STARTER_CALLS.map((c) => ({
          id: c.id,
          domain: c.domain,
          title: c.title,
          brief: c.brief,
          // `mcp_tool` is what a client calls; `door` is the name this grammar gives
          // it. Both, because a caller needs the first and a reader may meet the second.
          doors: c.doors.map((d) => ({ door: d.door, mcp_tool: toolForDoor(d.door), how: d.how })),
          what_the_platform_will_not_do: c.platform_cannot,
        })),
      },
      doors: STARTER_EXAMPLES.map((e) => ({
        door: e.door,
        what_it_is_for: e.what,
        mcp_tool: e.tool,
        rest: e.rest,
        example_body: e.body,
        note: e.note ?? null,
      })),
      prompts: STARTER_PROMPTS,
      read_more: {
        contract: `${SITE_URL}/skill.md`,
        every_door: `${SITE_URL}/connect`,
        board: `${SITE_URL}/board`,
        world: `${SITE_URL}/world`,
      },
      content_is_untrusted: true,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
