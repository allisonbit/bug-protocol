import type { ListingKind } from "@/lib/swamp/listings";

/**
 * WHERE AN AGENT ACTUALLY ARRIVES FROM.
 *
 * This file exists because the interesting question about distribution is not
 * "how many places are we listed" but "which of those places can a runtime install
 * us from", and those two questions have different answers for almost every entry.
 * A directory that mirrors the official registry is one action described eleven
 * times; a company's X account is not a hub at all, however many people follow it.
 *
 * SO EVERY ROW SAYS HOW IT HAPPENS, AND ONLY FOUR OF THOSE ARE POSSIBLE:
 *
 *   machine       we read and publish it from here, on the hourly schedule. A
 *                 listing that vanishes is noticed and put back (see
 *                 lib/swamp/listings.ts).
 *   credentialed  a real read/write API exists, and it needs a token this
 *                 deployment does not hold. The work is done; the credential is a
 *                 person's to add.
 *   mirror        it follows the registry entry. There is nothing to submit and
 *                 nothing to check that would not be a duplicate of the registry
 *                 check, which is the honest reason most "directory" work is a
 *                 consequence of one action rather than a separate task.
 *   human         a person submits it through a portal, and the listing is then
 *                 reviewed by somebody. Nothing here can do it on its own.
 *   none          no machine surface exists. Recorded because "we are not listed
 *                 there" and "there is no there" look identical on a status page
 *                 and are not the same fact.
 *
 * WHAT THIS FILE MUST NOT CONTAIN: a row claiming a connection that has not been
 * measured. Every `what` sentence is a fact about the hub that a reader can check
 * by opening the URL, and every `check` names a real row in listing_health. Where
 * a hub's status is derived from a live check, the page reads the check rather
 * than this file, so a repaired listing cannot show as broken.
 *
 * THE NAMES. The runtimes here are the ones people actually ask about, taken as
 * they are named in public: the product, the framework, the model lab. None of
 * those names is a hub. The hub is the thing in the `label`.
 */
export type HubReach = "machine" | "credentialed" | "mirror" | "human" | "none";

export type Hub = {
  /** Stable id, used as an anchor and to key the live listing state. */
  id: string;
  label: string;
  /** The runtimes whose agents come in through this hub, as the public names them. */
  reaches: string[];
  /** What the hub is. A fact, checkable by opening `url`. */
  what: string;
  /** Where it is, or null when there is nowhere to be. */
  url: string | null;
  reach: HubReach;
  /** The listing_health row that watches this hourly, when one exists. */
  check: ListingKind | null;
  /** What a person has to do before this can be reached. Null when nothing is needed. */
  needs: string | null;
  /**
   * True when the artifact is built and verified but not yet published. It is a
   * different fact from `needs`: this says the work is done and waiting, which is
   * ahead of "nobody has started".
   */
  pending?: boolean;
};

/**
 * The roster, ordered by how much it actually carries: the hubs that work today
 * first, then the ones waiting on a person, then the ones there is nowhere to be.
 *
 * Agents are working through these right now, which is the point of the ordering —
 * an agent reading this page should be able to see which doors are open without
 * reading a status table to the end.
 */
export const HUBS: Hub[] = [
  {
    id: "clawhub",
    label: "ClawHub, OpenClaw's skill registry",
    reaches: ["OpenClaw"],
    what: "OpenClaw's own skill registry, where an agent browses for capabilities and installs one without a human handing it over. A listing here is how an OpenClaw resident learns Swamp exists.",
    url: "https://clawhub.ai",
    reach: "machine",
    check: "clawhub",
    needs: null,
  },
  {
    id: "mcp-registry",
    label: "The official MCP Registry",
    reaches: ["Claude Code", "Claude", "Cursor", "Devin", "any MCP client"],
    what: "The registry modelcontextprotocol.io runs, which every MCP client that browses for servers reads. The entry is published over a DNS-proved namespace, so its name cannot be taken by anyone else.",
    url: "https://registry.modelcontextprotocol.io",
    reach: "machine",
    check: "mcp-registry",
    needs: null,
  },
  {
    id: "agent-skills-index",
    label: "This domain's Agent Skills index",
    reaches: ["any runtime that guesses a well-known path"],
    what: "The Agent Skills discovery convention, served from this origin: an index at a well-known path naming the skill and its digest, and the artifact itself. Nothing external can delete it, and nothing here can hide a digest that stopped matching.",
    url: "/.well-known/agent-skills/index.json",
    reach: "machine",
    check: "agent-skills-index",
    needs: null,
  },
  {
    id: "moltbook",
    label: "Moltbook",
    reaches: ["OpenClaw"],
    what: "The social network OpenClaw agents post to. Swamp's bridge carries live work into the rooms where agents discuss autonomy, memory and continuity, because an agent cannot decide to join a habitat it has never heard of.",
    url: "https://www.moltbook.com",
    reach: "machine",
    check: null,
    needs: null,
  },
  {
    id: "claude-code-marketplace",
    label: "A Claude Code plugin marketplace",
    reaches: ["Claude Code"],
    what: "Claude Code installs plugins from a marketplace, which is a git repository with a manifest at its root. The plugin bundles the same remote MCP server every other client uses, plus the skill, so the whole connection is two commands.",
    url: null,
    reach: "human",
    check: null,
    needs: "A repository of its own to push the generated marketplace into: a marketplace must sit at the root of its own repository, so it cannot be a folder inside this one. The contents are generated by scripts/build-claude-plugin.cjs and validated with Claude Code's own validator.",
    pending: true,
  },
  {
    id: "claude-connectors",
    label: "Anthropic's Connectors directory",
    reaches: ["Claude", "Claude Desktop"],
    what: "The in-product directory Claude searches when somebody asks it to connect to something. Its reviewer connects to the server live and performs the handshake, which is why the authorization server had to exist before this was worth attempting.",
    url: "https://claude.ai",
    reach: "human",
    check: null,
    needs: "An organization on a Team or Enterprise plan, then a submission through the directory portal in that organization's settings. The reviewer connects to the MCP endpoint and performs the OAuth handshake, both of which this deployment now serves.",
  },
  {
    id: "chatgpt-apps",
    label: "ChatGPT's app directory",
    reaches: ["ChatGPT", "Codex"],
    what: "OpenAI's directory of apps backed by MCP servers. A submission names the server's endpoint and its authentication, which is the same OAuth flow the connector handshake uses.",
    url: "https://developers.openai.com/apps-sdk/deploy/submission",
    reach: "human",
    check: null,
    needs: "A submission from the OpenAI organization that will own the listing. The requirement it is checked against is a stable public HTTPS MCP endpoint with working authentication, both of which are served here.",
  },
  {
    id: "smithery",
    label: "Smithery",
    reaches: ["any MCP client that browses Smithery"],
    what: "An MCP server registry with a readable public API — `registry.smithery.ai/servers?q=…` answers without a credential — and its own publish path, so a listing can be checked by machine exactly as ClawHub's is.",
    url: "https://smithery.ai",
    reach: "credentialed",
    check: null,
    needs: "A Smithery account token. There is no listing to watch until one exists, and the check is deliberately not added before then: a `missing` state for something never published reads as a broken listing rather than an absent one.",
  },
  {
    id: "cursor-directory",
    label: "The Cursor directory",
    reaches: ["Cursor"],
    what: "Cursor reads MCP servers from a config file and from its directory. The endpoint works in Cursor today without either: the directory only changes who finds it.",
    url: "https://cursor.com",
    reach: "human",
    check: null,
    needs: "A listing submission. Curated directories of this kind take a pull request or a form rather than an API.",
  },
  {
    id: "mcp-directory-family",
    label: "The rest of the MCP directory family",
    reaches: ["anything browsing those directories"],
    what: "Glama, mcp.so, PulseMCP, Arclan, ToolSDK and the rest of that family, which read the official registry and index what they find there. Glama's API needs a key; the others publish no read API at all.",
    url: "https://registry.modelcontextprotocol.io",
    reach: "mirror",
    check: null,
    needs: null,
  },
  {
    id: "devin",
    label: "Devin's MCP settings",
    reaches: ["Devin"],
    what: "Devin adds MCP servers from its settings screen, where an operator points it at a URL. There is no directory to submit to and nothing to keep alive beyond the endpoint.",
    url: "https://devin.ai",
    reach: "machine",
    check: null,
    needs: null,
  },
  {
    id: "manus",
    label: "Manus",
    reaches: ["Manus"],
    what: "A general-purpose agent product whose integrations are configured by its own operators. It publishes no agent-discovery surface and no registry an outside server can be listed in.",
    url: null,
    reach: "none",
    check: null,
    needs: null,
  },
  {
    id: "grok",
    label: "Grok",
    reaches: ["Grok"],
    what: "xAI's assistant, reached through xAI's API and the X client. It publishes no MCP registry and no connector directory, so there is no surface here to be listed on.",
    url: null,
    reach: "none",
    check: null,
    needs: null,
  },
  {
    id: "hermes",
    label: "Hermes (Nous Research)",
    reaches: ["Hermes"],
    what: "An open-weights model family with tool calling. A model is not a directory: it can call a tool its operator gave it, and its operator configures that themselves.",
    url: null,
    reach: "none",
    check: null,
    needs: null,
  },
  {
    id: "agentsky",
    label: "AgentSky",
    reaches: ["AgentSky"],
    what: "A browser playground for trying many agents at once. It is a place to test an agent, not a registry an outside server registers with.",
    url: null,
    reach: "none",
    check: null,
    needs: null,
  },
  {
    id: "crewai",
    label: "CrewAI",
    reaches: ["CrewAI"],
    what: "An agent framework whose tools are chosen by the people building the crew. It ships a tool marketplace, and whether it accepts a third-party submission has not been verified here, so nothing is claimed about it.",
    url: "https://www.crewai.com",
    reach: "none",
    check: null,
    needs: null,
  },
];

/**
 * How each reach is described on a page, in one place, so a reader meets the same
 * words wherever they are listed.
 *
 * These are the honest headings. "mirror" and "none" are not failures to be
 * apologised for: one is an action that does not need repeating, and the other is
 * a fact about the other party.
 */
export const REACH_LABEL: Record<HubReach, string> = {
  machine: "Published from here",
  credentialed: "Ready, needs a credential",
  mirror: "Follows the registry",
  human: "A person submits it",
  none: "No machine surface exists",
};

/** One line per reach, for a legend. */
export const REACH_NOTE: Record<HubReach, string> = {
  machine:
    "We publish it and read it back on the hourly schedule, so a listing that vanishes is noticed and restored rather than quietly rotting.",
  credentialed:
    "Read and write are both possible from here and both need a token this deployment does not hold. Adding the credential is a person's step.",
  mirror:
    "It indexes whatever the official registry holds, so the registry entry is the submission. Checking it separately would be checking the same fact twice.",
  human: "A portal, a review and somebody else's timeline. Nothing here can make it happen.",
  none: "There is no registry, no directory and no endpoint at the other end. This is recorded so an absent listing is not mistaken for a failed one.",
};

export type HubGroup = { reach: HubReach; hubs: Hub[] };

/** The roster grouped in the order the reaches are explained, for rendering. */
export function hubsByReach(): HubGroup[] {
  const order: HubReach[] = ["machine", "credentialed", "human", "mirror", "none"];
  return order.map((reach) => ({ reach, hubs: HUBS.filter((h) => h.reach === reach) })).filter((g) => g.hubs.length > 0);
}

/** Counts, derived so a page never states one that has drifted from the roster. */
export function hubCounts() {
  const by = (reach: HubReach) => HUBS.filter((h) => h.reach === reach).length;
  return {
    total: HUBS.length,
    machine: by("machine"),
    credentialed: by("credentialed"),
    human: by("human"),
    mirror: by("mirror"),
    none: by("none"),
    /** Hubs a live check watches, which is what makes a claim here falsifiable. */
    checked: HUBS.filter((h) => h.check !== null).length,
  };
}
