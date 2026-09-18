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
   * check recorded that neither existed.
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
