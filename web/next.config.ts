import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: __dirname },

  /**
   * Next's App Router ignores directories beginning with a dot, so every
   * /.well-known/ path is served by a real route under /well-known and rewritten
   * onto it here.
   *
   * Each rewrite names one file rather than mapping the whole dot tree. A
   * wildcard under /.well-known would give every future dotfile route a second
   * public URL, which is the kind of thing nobody notices until it matters.
   *
   * agent-card.json and agent.json are the same document. agent-card.json is what
   * the A2A convention currently recommends, agent.json is the path the earlier
   * spec text names, and a runtime that learned either one looks there; both
   * answered 404 before this, which is how a domain tells a roaming agent it has
   * never heard of it. security.txt is served at both of its conventional
   * locations for the same reason, and because the target's own security_txt
   * check recorded that neither existed. api-catalog is RFC 9727, the standard
   * host-level discovery document, and it has no extension so it is the one path
   * here a wildcard would have served by accident — which is exactly why the
   * rewrite is named explicitly instead.
   *
   * mcp.json is the MCP discovery card, and it is aliased at the two paths that
   * convention has used (`mcp.json` and `mcp/server-card.json`), so an MCP client
   * pointed at the domain finds the endpoint by guessing rather than by being
   * listed in a directory.
   *
   * agent-skills is the Agent Skills discovery convention: an index at
   * /.well-known/agent-skills/index.json naming skills and their digests, each
   * pointing at a SKILL.md. It is the one mechanism here that a runtime guesses
   * from a bare domain name, so both its paths are rewritten: the canonical
   * `agent-skills` one and the `skills` one the superseded 0.1 draft used. Each
   * also answers without the `.json` on the index, because clients have probed
   * both shapes and a 404 answers the wrong question.
   *
   * The SKILL.md rewrites point at route directories without the dot in them. The
   * public URL is what a client fetches; making the App Router depend on a dotted
   * path segment buys nothing and risks the segment being treated as a file type.
   *
   * A missing rewrite is silent: the route compiles, the build lists it, and the
   * public path 404s. That is how the api-catalog path was briefly broken after
   * the route itself was correct.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/mcp-registry-auth",
        destination: "/well-known/mcp-registry-auth",
      },
      {
        source: "/.well-known/agent-card.json",
        destination: "/well-known/agent-card",
      },
      {
        source: "/.well-known/agent.json",
        destination: "/well-known/agent-card",
      },
      {
        source: "/.well-known/mcp.json",
        destination: "/well-known/mcp",
      },
      {
        // The other path the MCP discovery convention has used. Same document,
        // so a client that learned either one is answered rather than 404'd.
        source: "/.well-known/mcp/server-card.json",
        destination: "/well-known/mcp",
      },
      {
        source: "/.well-known/api-catalog",
        destination: "/well-known/api-catalog",
      },
      {
        source: "/.well-known/agent-skills/index.json",
        destination: "/well-known/agent-skills/index",
      },
      {
        // A client that treated the index as a directory listing rather than a
        // named document. Serving the index is the useful answer here; a 404
        // would read as "this domain publishes no skills".
        source: "/.well-known/agent-skills/index",
        destination: "/well-known/agent-skills/index",
      },
      {
        source: "/.well-known/agent-skills/swamp/SKILL.md",
        destination: "/well-known/agent-skills/swamp",
      },
      {
        source: "/.well-known/skills/index.json",
        destination: "/well-known/skills/index",
      },
      {
        source: "/.well-known/skills/index",
        destination: "/well-known/skills/index",
      },
      {
        source: "/.well-known/skills/swamp/SKILL.md",
        destination: "/well-known/skills/swamp",
      },
      {
        // A resident skill's artifact address. The route directory is `skill`, so
        // the App Router is never asked to treat `SKILL.md` as a path segment; the
        // public URL is the conventional one either way.
        source: "/v1/skills/:slug/SKILL.md",
        destination: "/v1/skills/:slug/skill",
      },
      {
        source: "/.well-known/security.txt",
        destination: "/well-known/security",
      },
      {
        source: "/security.txt",
        destination: "/well-known/security",
      },
    ];
  },
};

export default nextConfig;
