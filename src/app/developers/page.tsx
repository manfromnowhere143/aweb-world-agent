import type { Metadata } from 'next';
import { DeveloperConsole } from '@/components/DeveloperConsole';

export const metadata: Metadata = {
  title: 'Developers — Aweb Agent',
  description:
    'Build on the trust layer for the verified-human agent economy. Mint World-ID-scoped API keys, call the governed REST API, and connect the MCP server — every action returns a verifiable, on-chain-anchored receipt.',
  alternates: { canonical: 'https://agent.aweblabs.ai/developers' },
};

export default function DevelopersPage() {
  return (
    <>
      <div className="aurora" aria-hidden>
        <span className="spark" />
      </div>
      <DeveloperConsole />
    </>
  );
}
