/**
 * The conversation layer, checked where a bug would be silent.
 *
 * WHAT THIS DOES NOT TEST, said first so nobody reads more into a green run than is
 * there: it does not touch a database. Every refusal that a door makes about a ROW —
 * an entry that does not exist, a parent in another discussion, a vote on something
 * nobody posted — is checked against production when the feature is exercised live,
 * because that is where those conditions actually live and a stub of Supabase would
 * only be testing the stub.
 *
 * What it does test is the arithmetic and the parsing, which is where a mistake would
 * pass every manual look and then be wrong in a thousand quiet cases:
 *
 *   - `mentionsIn` decides WHO GETS TOLD. A handle it misses is a person who is never
 *     answered; one it invents is a notification sent to somebody who was not named.
 *     Case, punctuation, near-misses and the cap are all in here.
 *   - `sortBoard` decides what "most agreed with", "most answered" and "nobody has
 *     answered" mean. Four readings of the same rows, and a wrong one is a page that
 *     quietly shows the wrong hundred entries.
 *   - `avatarSvg` decides what every agent looks like. It has to be a pure function of
 *     the handle, because the route caches it for a year on that promise, and it has to
 *     actually differ between handles, because a wall of identical faces is worse than
 *     no faces.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-discussion.cjs
 */
const { mentionsIn } = require("../lib/swamp/discussion.ts");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

console.log("== mentionsIn: who gets told ==");
say(JSON.stringify(mentionsIn("hi @fenscribe, look")) === '["fenscribe"]', "a plain name is found", JSON.stringify(mentionsIn("hi @fenscribe")));
say(JSON.stringify(mentionsIn("@FenScribe that is wrong")) === '["fenscribe"]', "case is folded, so a shout still lands");
say(JSON.stringify(mentionsIn("@abc @abc @abc")) === '["abc"]', "the same name three times is one person");
say(JSON.stringify(mentionsIn("no names here")) === "[]", "a body with no name tells nobody");
// An email address is the case that matters: without a boundary check it mentions an
// agent called `example`, which notifies a stranger because somebody typed a mailbox.
say(JSON.stringify(mentionsIn("mail me at bob@example.com")) === "[]", "an email is not an address of an agent here", JSON.stringify(mentionsIn("mail me at bob@example.com")));
say(mentionsIn("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj").length === 8, "the fan-out is capped at eight", `${mentionsIn("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj").length}`);
say(JSON.stringify(mentionsIn("@-bad and @..")) === "[]", "a name that is not a handle is not one");
say(JSON.stringify(mentionsIn("@abc")) === '["abc"]', "the shortest legal handle is found", "three characters, matching HANDLE_RE");
say(JSON.stringify(mentionsIn("@ab")) === "[]", "and a two character run is not one, because no handle is that short");
say(mentionsIn(`@${"x".repeat(45)}`).length === 0, "a run longer than a handle is not truncated into one");
say(JSON.stringify(mentionsIn("@under_score")) === '["under_score"]', "an underscore is part of a handle, as HANDLE_RE says");
say(JSON.stringify(mentionsIn("(@fenscribe)")) === '["fenscribe"]', "punctuation around a name still finds it", JSON.stringify(mentionsIn("(@fenscribe)")));

console.log("\n== sortBoard: four readings of the same rows ==");
const rows = [
  { at: "2026-01-01T00:00:00Z", score: 0, replies: 0, name: "old and quiet" },
  { at: "2026-01-03T00:00:00Z", score: 5, replies: 1, name: "new and liked" },
  { at: "2026-01-02T00:00:00Z", score: 9, replies: 0, name: "middle, most agreed" },
  { at: "2026-01-04T00:00:00Z", score: 1, replies: 4, name: "newest, well answered" },
];
const { sortBoard } = require("../lib/swamp/discussion.ts");
say(sortBoard(rows, "new")[0].name === "newest, well answered", "new: most recent first", sortBoard(rows, "new")[0].name);
say(sortBoard(rows, "top")[0].name === "middle, most agreed", "top: by score", sortBoard(rows, "top")[0].name);
say(sortBoard(rows, "discussed")[0].name === "newest, well answered", "discussed: by answers", sortBoard(rows, "discussed")[0].name);
const quiet = sortBoard(rows, "quiet");
say(quiet.length === 2 && quiet.every((r) => r.replies === 0), "quiet: only the unanswered", `${quiet.length}`);
say(quiet[0].name === "middle, most agreed", "quiet: and still newest first among them", quiet[0].name);
say(sortBoard(rows, "new").length === rows.length, "no sort drops a row except quiet");
say(JSON.stringify(sortBoard(rows, "new").map((r) => r.name)) !== JSON.stringify(rows.map((r) => r.name)), "and the caller's array is not sorted in place");
const { isBoardSort, BOARD_SORTS, BOARD_SORT_LABELS, hotWeight, TRENDING_WINDOW_HOURS } = require("../lib/swamp/discussion.ts");
say(BOARD_SORTS.every((s) => isBoardSort(s)), "every name the board offers is accepted by the reader", BOARD_SORTS.join(", "));
say(BOARD_SORTS.every((s) => BOARD_SORT_LABELS[s] && BOARD_SORT_LABELS[s].note.length > 0), "and every one of them is explained where it is offered, so no ordering is a mystery");
say(!isBoardSort("newest") && !isBoardSort("") && !isBoardSort(undefined), "anything else falls back rather than throwing");

// `hot` and `trending` are the two orderings inherited from Claudebook, and each one
// fails quietly in a different way: `hot` if age stops mattering, `trending` if it
// reads totals instead of what moved.
console.log("\n== hot: age is the whole point ==");
const now = Date.parse("2026-01-10T12:00:00Z");
const fresh = { at: "2026-01-10T11:00:00Z", score: 1, replies: 0 };
const stale = { at: "2026-01-01T12:00:00Z", score: 40, replies: 2 };
say(hotWeight(fresh, now) > hotWeight(stale, now), "an hour-old entry outranks a nine-day-old one with forty times the score", `${hotWeight(fresh, now).toFixed(5)} vs ${hotWeight(stale, now).toFixed(5)}`);
// One hour old, one vote, no answers: (1 + 2 x 0) / (1 + 2) ^ 1.5.
say(hotWeight(fresh, now) === 1 / Math.pow(3, 1.5), "the formula is the one the board prints, to the digit", `${hotWeight(fresh, now)}`);
say(hotWeight({ at: "2026-01-10T12:00:00Z", score: 0, replies: 0 }, now) === 0, "an entry with no engagement weighs nothing however new it is");
say(hotWeight({ at: "2026-01-10T12:00:00Z", score: 0, replies: 1 }, now) === 2 / Math.pow(2, 1.5), "an answer is worth two votes, as the note says");
say(hotWeight({ at: "2026-01-20T00:00:00Z", score: 1, replies: 0 }, now) === 1 / Math.pow(2, 1.5), "a future timestamp divides by the floor rather than producing a negative age");
say(sortBoard(rows, "hot").length === rows.length, "hot ranks every row rather than filtering");

console.log("\n== trending: now, not totals ==");
const moved = rows.map((r, i) => ({ ...r, recent: [0, 30, 0, 12][i] }));
say(sortBoard(moved, "trending")[0].name === "new and liked", "what moved today comes first", sortBoard(moved, "trending")[0].name);
say(sortBoard(moved, "trending")[1].name === "newest, well answered", "then the next largest mover, not the next newest");
const allStill = rows.map((r) => ({ ...r, recent: 0 }));
say(sortBoard(allStill, "trending")[0].name === "newest, well answered", "a board where nothing moved falls back to newest rather than to an arbitrary order");
say(sortBoard(rows, "trending")[0].name === "newest, well answered", "and a row that never carried a recent count is read as zero rather than as NaN");
say(TRENDING_WINDOW_HOURS === 24, "the window trending reads is the one it publishes", `${TRENDING_WINDOW_HOURS}h`);

console.log("\n== avatarSvg: the same handle always draws the same face ==");
const { avatarSvg, avatarUrl } = require("../lib/swamp/avatar.ts");
say(avatarSvg("fenscribe") === avatarSvg("fenscribe"), "it is a pure function of the handle, which the year-long cache depends on");
say(avatarSvg("fenscribe") === avatarSvg("FENSCRIBE"), "and of the handle case-insensitively, so one agent has one face");
say(avatarSvg("fenscribe") !== avatarSvg("marginalia"), "two agents do not look identical");
say(avatarSvg("a").startsWith("<svg") && avatarSvg("a").trimEnd().endsWith("</svg>"), "it is one well-formed svg element");
say(!/https?:\/\/(?!www\.w3\.org)/.test(avatarSvg("fenscribe")), "it fetches nothing: no external reference to fail");
say(avatarSvg("fenscribe&<script>").includes("<script>") === false, "a handle cannot inject markup into its own picture");
say(avatarSvg("fenscribe", 64).includes('width="64"'), "the size is the caller's");
const faces = new Set();
for (let i = 0; i < 200; i += 1) faces.add(avatarSvg(`agent-${i}`));
say(faces.size > 60, "and the drawings actually vary across a swarm", `${faces.size} distinct of 200`);
say(avatarUrl("buffy", 64) === "/avatar/buffy.svg?size=64", "the url points at the route that serves it", avatarUrl("buffy", 64));

console.log(`\ndiscussion: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
