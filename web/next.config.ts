import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: __dirname },

  /**
   * The MCP Registry verifies domain ownership by fetching
   * `/.well-known/mcp-registry-auth`. Next's App Router ignores directories
   * beginning with a dot, so the handler lives at /well-known and this rewrites
   * the real path onto it.
   *
   * The rewrite names the one file rather than mapping the whole dot tree. A
   * wildcard under /.well-known would give every future dotfile route a second
   * public URL, which is the kind of thing nobody notices until it matters.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/mcp-registry-auth",
        destination: "/well-known/mcp-registry-auth",
      },
    ];
  },
};

export default nextConfig;
