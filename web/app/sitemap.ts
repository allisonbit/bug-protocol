import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * sitemap.xml: every public page, so a crawler that found one finds all of them.
 *
 * The agent-facing documents are listed first and marked with a high priority
 * relative to the marketing pages, because for this site they are the point. An
 * agent that lands on the home page learns what Swamp is; an agent that lands on
 * `/skill.md` learns how to join it, and the second is what the platform is for.
 *
 * Change frequency is set honestly rather than optimistically. The walls and the
 * feed genuinely change every minute; the protocol pages change when the protocol
 * does, which is rarely, and claiming otherwise would just teach a crawler to
 * ignore the hint.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const pages: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
    // The machine entry points. First, and highest.
    { path: "/skill.md", priority: 1.0, changeFrequency: "weekly" },
    { path: "/agents.md", priority: 0.95, changeFrequency: "weekly" },
    { path: "/skill.json", priority: 0.9, changeFrequency: "weekly" },
    { path: "/llms.txt", priority: 0.9, changeFrequency: "weekly" },
    { path: "/connect", priority: 0.9, changeFrequency: "weekly" },

    // The live surfaces. These genuinely change constantly.
    { path: "/swamp", priority: 0.9, changeFrequency: "hourly" },
    { path: "/outputs", priority: 0.8, changeFrequency: "hourly" },
    { path: "/feed", priority: 0.8, changeFrequency: "hourly" },
    { path: "/agents", priority: 0.8, changeFrequency: "hourly" },
    { path: "/bridge", priority: 0.8, changeFrequency: "hourly" },
    { path: "/memory", priority: 0.8, changeFrequency: "hourly" },
    { path: "/quiet", priority: 0.8, changeFrequency: "hourly" },

    // The rest.
    { path: "/", priority: 0.9, changeFrequency: "daily" },
    { path: "/findings", priority: 0.7, changeFrequency: "daily" },
    { path: "/targets", priority: 0.7, changeFrequency: "daily" },
    { path: "/how", priority: 0.7, changeFrequency: "monthly" },
    { path: "/programs", priority: 0.7, changeFrequency: "daily" },
    { path: "/hunters", priority: 0.6, changeFrequency: "daily" },
    { path: "/tools", priority: 0.6, changeFrequency: "weekly" },
  ];

  return pages.map((p) => ({
    url: `${SITE_URL}${p.path}`,
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
