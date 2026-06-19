/**
 * GET /api/v1/registry/receipt-schema — the OPEN Aweb Agent Receipt standard.
 * A versioned, public schema any World mini app / x402 service can build on:
 * off-chain evidence (hash-chained entries) + on-chain root + Ed25519 session proof,
 * with a deterministic, zero-trust verification procedure. (EAS / ERC-8004 aligned.)
 */
import { json, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';

export function OPTIONS() {
  return preflight();
}

export function GET() {
  return json({
    name: 'Aweb Agent Receipt',
    version: '1.0',
    standards: ['EAS-execution-receipts', 'ERC-8004'],
    summary: 'A verifiable, non-repudiable record of exactly what a governed agent did on behalf of one verified human — checkable by anyone, with zero trust in the issuer.',
    structure: {
      missionId: 'string',
      planHash: 'sha256 of the frozen plan (the World ID approval signal)',
      authority: { walletAddress: 'string?', worldIdNullifier: 'string? — the unique verified human', verificationLevel: "'orb' | 'device'?" },
      entries: [{
        seq: 'number (0-based, contiguous)',
        kind: "'plan'|'simulate'|'await_approval'|'approve'|'execute_step'|'blocked'|'complete'|'reject'|'settle'|'verify'|'replan'|'anchor'",
        at: 'ISO-8601',
        summary: 'string',
        data: 'object (secrets redacted to "[redacted]" BEFORE hashing)',
        prevHash: 'string|null (previous entry hash — the chain link)',
        hash: 'sha256(canonicalJson({seq,kind,at,summary,data,prevHash}))',
      }],
      seal: { algorithm: 'Ed25519', publicKey: 'base64 SPKI', signature: 'base64 over UTF-8 of signedHash', signedHash: 'the chain head hash', signedAt: 'ISO-8601' },
      anchor: { chain: "'world-chain'", chainId: 'number', txHash: 'string', explorer: 'string', rootHash: 'the sealed chain-head committed on-chain', anchoredAt: 'ISO-8601' },
    },
    verification: {
      integrity: 'Recompute each entry hash from canonical JSON; check seq is contiguous and prevHash links forward. Any tamper breaks the chain.',
      authenticity: 'Ed25519-verify seal.signature over seal.signedHash using seal.publicKey; signedHash must equal the chain head.',
      anchor: 'Read the anchor tx calldata from World Chain; it must equal 0x+rootHash. Trustless on-chain proof.',
      redaction: 'Keys named proof/apiKey/api_key/secret/token/password/authorization/privateKey are replaced with "[redacted]" before hashing — receipts prove behavior without leaking credentials.',
    },
    canonicalJson: 'JSON with recursively key-sorted objects (stable serialization), then SHA-256.',
    hostedVerifier: 'https://agent.aweblabs.ai/api/v1/receipts/{missionId}/verify?onchain=1',
    license: 'Apache-2.0 — intended as shared ecosystem infrastructure.',
  });
}
