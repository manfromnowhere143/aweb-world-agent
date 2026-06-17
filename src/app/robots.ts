import type { MetadataRoute } from 'next';

const BASE = 'https://agent.aweblabs.ai';

/** House-standard robots: open marketing surface, block API, welcome AI crawlers. */
export default function robots(): MetadataRoute.Robots {
  const disallow = ['/api/'];
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow },
      { userAgent: ['GPTBot', 'Claude-Web', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'], allow: '/', disallow },
      { userAgent: 'Googlebot', allow: '/', disallow },
      { userAgent: 'Bingbot', allow: '/', disallow },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
