import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// World's own brand fallback fonts (World Pro → Inter / Inter Tight). Mobile-first,
// crisp at small sizes — the World-native, Apple-grade type system.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const interTight = Inter_Tight({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-inter-tight', display: 'swap' });

const SITE = 'https://agent.aweblabs.ai';
const V = '20260617'; // icon/asset cache-bust (house standard ?v=YYYYMMDD)
const a = (p: string) => `${p}?v=${V}`;
const DESCRIPTION =
  'A governed personal agent for verified humans, on World. It plans, simulates, asks you to approve anything sensitive with World ID, executes across governed tools, and hands you a hash-chained, Ed25519-sealed receipt you can verify yourself.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  applicationName: 'Aweb Agent',
  title: {
    default: 'Aweb Agent — Verified. Governed. Provable.',
    template: '%s · Aweb Agent',
  },
  description: DESCRIPTION,
  keywords: [
    'Aweb', 'Aweb Agent', 'Aweb Labs', 'World App', 'World ID', 'World mini app',
    'proof of personhood', 'verified human', 'AI agent', 'agent governance',
    'agentic commerce', 'verifiable receipts', 'Ed25519 receipts', 'AgentKit', 'World Chain',
  ],
  authors: [{ name: 'Aweb Labs', url: 'https://aweblabs.ai' }],
  creator: 'Aweb Labs',
  publisher: 'Aweb Labs',
  category: 'productivity',
  alternates: { canonical: SITE },
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Aweb Agent' },
  formatDetection: { telephone: false },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-video-preview': -1, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE,
    siteName: 'Aweb Agent',
    title: 'Aweb Agent — Verified. Governed. Provable.',
    description: DESCRIPTION,
    images: [{ url: a('/og-agent.png'), width: 1200, height: 630, alt: 'Aweb Agent — governed AI execution for World' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Aweb Agent — Verified. Governed. Provable.',
    description: DESCRIPTION,
    images: [a('/og-agent.png')],
  },
  icons: {
    icon: [
      { url: a('/favicon.svg'), type: 'image/svg+xml' },
      { url: a('/favicon.ico'), sizes: '32x32' },
      { url: a('/icon-16x16.png'), sizes: '16x16', type: 'image/png' },
      { url: a('/icon-32x32.png'), sizes: '32x32', type: 'image/png' },
      { url: a('/icon-48x48.png'), sizes: '48x48', type: 'image/png' },
      { url: a('/icon-192x192.png'), sizes: '192x192', type: 'image/png' },
      { url: a('/icon-512x512.png'), sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: a('/apple-touch-icon.png'), sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#F4F6FA',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light',
};

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://aweblabs.ai/#organization',
      name: 'Aweb Labs',
      url: 'https://aweblabs.ai',
      founder: { '@type': 'Person', name: 'Daniel Wahnich' },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#app`,
      name: 'Aweb Agent',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'World App',
      url: SITE,
      description: DESCRIPTION,
      publisher: { '@id': 'https://aweblabs.ai/#organization' },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable}`}>
      <body>
        <div className="aurora" aria-hidden><span className="spark" /></div>
        <Providers>{children}</Providers>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      </body>
    </html>
  );
}
