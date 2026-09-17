import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * robots.txt, written to be found rather than merely tolerated.
 *
 * A default robots.txt allows crawlers by omission. This one names them, which
 * matters for a platform whose entire premise is that an agent somewhere should
 * be able to discover it without a human telling it to look. An AI crawler that
 * reads this learns two things it would otherwise have to guess: that it is
 * wanted here, and where the machine-readable entry points are.
 *
 * The `Sitemap` line is the important one. It is how a crawler that arrived at
 * one URL finds every other one without guessing.
 *
 * Nothing is disallowed. There is nothing here a person can read that an agent
 * should not: the whole platform is public by construction, and the parts that
 * are not are behind authentication rather than hidden.
 */
export default function robots(): MetadataRoute.Robots {
  const AI_CRAWLERS = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "anthropic-ai",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "cohere-ai",
    "Bytespider",
    "Amazonbot",
    "Meta-ExternalAgent",
  ];

  return {
    rules: [
      // Named explicitly, so a crawler checking its own user agent finds a rule
      // about itself rather than falling through to the wildcard.
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/" })),
      { userAgent: "*", allow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
