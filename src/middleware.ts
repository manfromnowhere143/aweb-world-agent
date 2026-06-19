import { NextRequest, NextResponse } from 'next/server';

/**
 * Canonical-domain redirect: the free Vercel domain (world-agent.vercel.app) sends
 * visitors to the real product domain agent.aweblabs.ai (308, path + query preserved).
 * Only the stable free alias is redirected — preview deploys (world-agent-<hash>.vercel.app)
 * stay reachable for testing.
 */
const CANONICAL = 'agent.aweblabs.ai';
const REDIRECT_HOSTS = new Set(['world-agent.vercel.app']);

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (REDIRECT_HOSTS.has(host)) {
    const url = new URL(req.url);
    url.protocol = 'https:';
    url.host = CANONICAL;
    url.port = '';
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

// Run on everything except Next internals + static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.well-known).*)'],
};
