#!/usr/bin/env node
/**
 * Walk the whole of somebody else's registry, through this deployment's own door.
 *
 * WHY A DRIVER RATHER THAN A BIGGER SCHEDULE. A page of the ClawHub catalogue takes about ten
 * seconds to answer. The whole catalogue is roughly a hundred and fifty pages, which is about
 * half an hour, and a scheduled pass is deliberately three pages because this deployment is a
 * guest on that server and because a serverless route has to return. So the first walk is done
 * once, from a terminal, by driving the same door the beat drives, in a loop that resumes from
 * the cursor the door stores. Every pass is small, every pass is the production code path, and
 * the loop can be killed at any point without losing anything: the cursor is in a row.
 *
 * WHY IT DOES NOT TALK TO THE DATABASE ITSELF. It could, and that would skip a layer. It does
 * not on purpose: driving the door means the backfill exercises the same projection, the same
 * upsert, the same topic rollup and the same error handling the scheduled pass uses. A driver
 * with its own copy of the crawl would be a second implementation of the thing being tested.
 *
 * AFTER THE FIRST WALK THIS IS MOSTLY UNNECESSARY. Once the sweep is complete, an ordinary
 * pass fetches one page and stops as soon as it holds nothing new, so the beat keeps the mirror
 * current for one request every ten minutes. Run this again with `--mode=sweep` to re-walk
 * everything, which is the only thing that notices a skill that was edited or delisted.
 *
 *   SWAMP_BEAT_SECRET=... node scripts/registry-backfill.cjs
 *   SWAMP_BEAT_SECRET=... node scripts/registry-backfill.cjs --mode=sweep --pages=6
 *   node scripts/registry-backfill.cjs https://www.swampai.world --until-complete
 *
 * The secret is read from the environment and never printed. A pass that stops early because
 * the registry asked this deployment to slow down ends the loop rather than retrying through
 * it, and says how long to wait.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TARGET = (args.find((a) => !a.startsWith("--")) || process.env.REGISTRY_TARGET || "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.SWAMP_BEAT_SECRET || process.env.CRON_SECRET || "";
const PAGES = Math.min(Math.max(Number(flag("pages", 6)) || 6, 1), 40);
const MODE = flag("mode", "sweep");
const MAX_PASSES = Math.min(Math.max(Number(flag("max-passes", 300)) || 300, 1), 2000);
const UNTIL_COMPLETE = args.includes("--until-complete") || MODE === "sweep";

if (!SECRET) {
  console.error(
    "SWAMP_BEAT_SECRET is not set, and the crawl door requires it: every pass makes outbound requests\n" +
      "to a server this deployment does not own, so the door is not open to a caller with no key.",
  );
  process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many times a pass that could not reach the network is tried again before the walk
// gives up. A page of this catalogue takes about ten seconds and the whole walk is hundreds
// of pages, so a single dropped connection ending a half-hour job was the difference between
// a mirror and a partial one: one live run stopped at page 157 on one aborted request. A
// refused STATUS is not retried, because a 401 or a 429 is the registry answering, not the
// network failing, and hammering a host that has just told us to slow down is the opposite
// of what it asked for.
const PASS_ATTEMPTS = 3;
const RETRY_WAIT_MS = 30_000;

(async () => {
  console.log(`sweeping ${TARGET} in ${MODE} mode, ${PAGES} page(s) per pass, up to ${MAX_PASSES} pass(es)`);
  let pass = 0;
  let totalRows = 0;

  while (pass < MAX_PASSES) {
    pass += 1;
    let body = null;
    let unreachable = null;
    for (let attempt = 1; attempt <= PASS_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(`${TARGET}/api/registry/crawl?pages=${PAGES}${MODE === "sweep" ? "&mode=sweep" : ""}`, {
          method: "POST",
          headers: { authorization: `Bearer ${SECRET}`, accept: "application/json" },
          signal: AbortSignal.timeout(180_000),
        });
        body = await res.json();
        if (!res.ok) {
          console.log(`${stamp()} pass ${pass}: refused (${res.status}) ${JSON.stringify(body).slice(0, 200)}`);
          process.exitCode = 1;
          body = null;
        }
        break;
      } catch (e) {
        unreachable = e.message;
        body = null;
        if (attempt < PASS_ATTEMPTS) {
          console.log(
            `${stamp()} pass ${pass}: the door could not be reached (${unreachable}); ` +
              `waiting ${Math.round(RETRY_WAIT_MS / 1000)}s and trying again, attempt ${attempt + 1} of ${PASS_ATTEMPTS}`,
          );
          await sleep(RETRY_WAIT_MS);
        }
      }
    }
    if (!body) {
      if (unreachable) console.log(`${stamp()} pass ${pass}: gave up after ${PASS_ATTEMPTS} attempt(s): ${unreachable}`);
      process.exitCode = 1;
      break;
    }

    totalRows += Number(body.written ?? 0);
    // A null count is printed as "unknown" rather than as 0: the door says null when it could
    // not count the mirror, and printing that as zero would read as an empty mirror.
    const mirrored = typeof body.mirrored === "number" ? body.mirrored : "unknown";
    console.log(
      `${stamp()} pass ${pass}: ${body.mode}, ${body.pages} page(s), ${body.written} row(s) written, ` +
        `${body.refused} refused, ${mirrored} mirrored, ${body.topics} topic(s), ${body.complete ? "complete" : "walking"} — ${body.note}`,
    );

    if (body.throttled) {
      console.log(
        `\nthe registry asked this deployment to slow down${body.waitMs ? ` for about ${Math.round(body.waitMs / 1000)}s` : ""}.\n` +
          "The pass stopped rather than retrying through it. Wait and run this again: the cursor is stored, so nothing is lost.",
      );
      break;
    }
    if (body.complete && body.mode === "sweep") {
      console.log(
        `\nthe whole catalogue has been walked: ` +
          `${typeof body.mirrored === "number" ? body.mirrored : "an uncounted number of"} published skills mirrored, ` +
          `${totalRows} row(s) written across ${pass} pass(es).`,
      );
      break;
    }
    if (body.caughtUp) {
      console.log(`\ncaught up: nothing has been published since the last walk, so there is nothing to do.`);
      break;
    }
    if (!body.ok) {
      console.log(`\nstopping: the door reported ${body.note}`);
      break;
    }
    if (!UNTIL_COMPLETE) {
      console.log(`\nstopping after ${pass} pass(es) as asked.`);
      break;
    }
  }

  const final = await fetch(`${TARGET}/api/registry/crawl`).then((r) => r.json()).catch(() => null);
  if (final?.sweep) {
    console.log(
      `\nsweep state: ${final.sweep.complete ? "complete" : "in progress"}, ${final.sweep.skills_seen} row(s) seen over ` +
        `${final.sweep.pages_seen} page(s), ${final.sweep.sweeps} full sweep(s), last run ${final.sweep.last_run_at ?? "never"}` +
        `${final.sweep.last_error ? `, last error: ${final.sweep.last_error}` : ""}.`,
    );
  }
  if (pass >= MAX_PASSES && UNTIL_COMPLETE) {
    console.log(`\nstopped at the ${MAX_PASSES} pass ceiling. Run this again to continue from the stored cursor.`);
  }
})();
