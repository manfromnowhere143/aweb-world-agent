# Security Policy

This project is a **governance and proof layer** — security and verifiability are the product, not an afterthought.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a vulnerability.

- Email: **security@aweblabs.ai**
- Or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository.

We aim to acknowledge within 72 hours and to coordinate a fix and disclosure timeline with you. Responsible disclosure is appreciated and credited (with your consent).

## Scope we especially care about

- **Receipt forgeability** — any way to produce a receipt that passes the in-browser integrity (hash-chain) or authenticity (Ed25519) checks without the corresponding actions having occurred.
- **Approval bypass** — executing a `SENSITIVE` / `VALUE_MOVEMENT` step without a valid World-ID proof whose `signal` matches the frozen plan hash.
- **Anti-replay defeats** — reusing a `(nullifier_hash, signal)` pair, or otherwise replaying an approval.
- **Policy escapes** — running a tool that is not allow-listed, exceeding the value cap, or coercing the model into mis-classifying a step's risk.
- **Redaction leaks** — secrets, tokens, or raw proofs surviving into a hashed/sealed receipt.

## Secrets

This repository contains **no credentials**. All configuration is by environment variable (see [`.env.local.example`](./.env.local.example)). Never commit a real `.env.local`, signing key, or API key. If you believe a secret was ever committed, treat it as compromised and rotate it.

## Trust model (what the receipts do and don't prove)

- The receipt **proves** the recorded sequence of governed steps is internally consistent (hash chain) and was sealed by the holder of a specific Ed25519 key (signature).
- It **does not** vouch for the truthfulness of external tool outputs beyond what each tool/adapter attests, nor for actions taken outside the governed loop.
- Verification is **client-side** (Web Crypto) and requires no trust in our server.
