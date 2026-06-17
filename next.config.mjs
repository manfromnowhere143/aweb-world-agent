import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained tracing root (this app is isolated from the parent pnpm workspace).
  outputFileTracingRoot: __dirname,
  // World App loads the mini app in an in-app webview; allow embedding.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Allow World App to frame the mini app.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://worldcoin.org https://world.org https://*.worldcoin.org https://*.world.org" },
        ],
      },
    ];
  },
};

export default nextConfig;
