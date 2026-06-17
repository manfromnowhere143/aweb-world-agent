# Aweb Agent for World — Architecture

**Web3 department of Aweb. Self-contained. Does not touch the core Aweb build.**
Prepared 2026-06-17. Companion to `docs/grants/WORLD_AWEB_SOTA_APP_THESIS_2026-06-17.md`.

---

## 0. Isolation contract (read first)

- Lives entirely under `web3/world-agent/`. The pnpm workspace only globs `packages/*`, `apps/*`, `services/*`, so **this app is invisible to the main Aweb build** — its own `package.json`, its own `node_modules`, its own deploy. We never import from or edit `apps/web` or `packages/*`. Governance/receipt logic is **re-implemented clean** here (concepts proven in `packages/solana-agent-kit`), so there is zero coupling.

---

## 1. The thesis, in one diagram

```
        WORLD                                AWEB
  ┌───────────────────┐            ┌──────────────────────────────┐
  │ World ID / AgentKit│  identity  │  Trust Runtime                │
  │ "a unique human    │ ─────────► │  plan → simulate → APPROVE    │
  │  is behind this     │           │  → execute → RECEIPT          │
  │  agent"             │ ◄───────── │  "and here is exactly what    │
  │ World Wallet / x402 │  approval  │   the agent did, provably"    │
  └───────────────────┘  +payments  └──────────────────────────────┘
        the WHO                              the WHAT + the PROOF
```

World gives the agent an identity. **Aweb is the governance + evidence layer World's AgentKit explicitly does not provide** (no governance, no real-time approval, no receipts, no accountability, no non-repudiation). This app is that layer, shipped as a World Mini App.

---

## 2. The killer primitive — World-ID-bound approval

The single most important design decision:

> **A sensitive agent step cannot execute until a verified unique human produces a World ID proof whose `signal` is the SHA-256 hash of the exact mission plan.**

- `action`: `approve-mission` (per-app World ID action)
- `signal`: `planHash` = SHA-256 of the canonical, frozen mission plan
- result: `nullifier_hash` (this unique human), `proof`, `merkle_root`, `verification_level` (orb/device)

This yields a **non-repudiable, zero-knowledge proof that one unique human approved precisely this plan** — exactly the accountability AgentKit lacks, expressed in World's own primitive. The proof is embedded in the receipt. If the plan changes by one byte, the approval is void (hash mismatch). Single-use: the `nullifier_hash` for that `signal` is recorded and cannot be replayed.

One-human-one-agent: onboarding uses a `verify-human` action; the returned `nullifier_hash` is the human's stable pseudonymous id → at most one agent per verified human (sybil-resistant, no bot armies).

---

## 3. Components

| Layer | Tech | Role |
|---|---|---|
| Mini App shell | **Next.js 15 (App Router) + React + TS**, `@worldcoin/minikit-js` (MiniKit 2.0), `MiniKitProvider` | Runs inside World App; `MiniKit.isInstalled()` env detection; dev/mock mode outside World App |
| Login | **walletAuth (SIWE)** — `/api/nonce` → `MiniKit.walletAuth` → `verifySiweMessage` | Wallet address + World username = the account (NOT World ID — per guidelines) |
| Proof of human + approval | **World ID via IDKit** (unified) — verify server-side at `developer.worldcoin.org/api/v2/verify/{app_id}` | One-human-one-agent onboarding; plan-hash-bound approval for sensitive steps |
| Trust Runtime | clean TS (`lib/trust/`) | Policy engine (risk classes, allowlists, value caps), lifecycle state machine, plan freeze + hashing |
| Agent brain | **Claude** (Anthropic) via clean client (`lib/agent/`) | NL task → typed mission plan → simulate → execute safe tools; structured output enforced |
| Tools (MVP, safe) | `lib/tools/` | research/summarize, draft, compare, monitor-alert (no-payment first); x402/Wallet pay path designed but gated off |
| Receipts | `lib/receipt/` + `/receipt/[id]` page + verifier | SHA-256 **hash-chained**, redaction-by-design, embeds the World ID approval proof; shareable + independently verifiable |
| Store | SQLite (dev) / Postgres (prod) via a thin repo | Missions, receipts, used-nullifier registry |
| UI | liquid-glass design system (`app/`, `styles/`) | Aweb-organism top-2026 liquid glass, mobile-first, 2–3s load, World UI-Kit aligned, localized |

---

## 4. The governed mission lifecycle (the product)

```
1. ONBOARD     walletAuth (SIWE) → account.  Optional World ID verify-human → bind the one agent.
2. ASK         human gives the agent a task in natural language.
3. PLAN        Claude returns a TYPED mission plan: ordered steps, tool per step, risk class,
               data boundaries, value cap. Plan is FROZEN and hashed (planHash).
4. SIMULATE    agent dry-runs every step; shows expected effects + which steps are SENSITIVE.
               No external side effects, no signature yet (simulate-by-default).
5. APPROVE     for sensitive/irreversible/pay steps → World ID proof with signal = planHash.
               Lifecycle blocks signing/execution until APPROVED. Nullifier recorded (anti-replay).
6. EXECUTE     agent runs the approved plan via governed tools; value capped; allowlist enforced.
7. RECEIPT     hash-chained receipt: authority (wallet + World ID nullifier + verification_level),
               each step's tool/outcome/cost/redaction, what stayed BLOCKED, and the approval proof.
               Shareable, independently verifiable.
```

Risk classes: `READ_ONLY` (auto), `REVERSIBLE` (auto, logged), `SENSITIVE` (needs World ID approval), `VALUE_MOVEMENT` (needs World ID approval + value cap + allowlist). Default-deny anything unclassified.

---

## 5. MVP scope (first vertical slice — ship-able, compliant, not a toy)

A genuinely useful **governed personal agent** with the full loop working end-to-end on a sharp first capability set:
- **Research & brief** — agent researches a real question and returns a sourced brief (READ_ONLY).
- **Draft & prepare** — drafts a message/document for the human (REVERSIBLE).
- **Send / commit** — the irreversible step → **World ID approval** required → produces the receipt (SENSITIVE).
- **(Designed, gated)** pay/transact via World Wallet + x402 (VALUE_MOVEMENT) — wired but off for MVP until payments are reviewed.

Every run ends with a shareable, verifiable receipt. This proves the thesis with real work, stays inside Mini App guidelines (no trading/yield/tokens/chance), and is the seed of the billion-scale "every verified human has a safe agent" product.

Compliance: World ID for identity, mobile-first 2–3s UX, UI Kit alignment, localization (EN/ES/TH/JA/KO/PT), no "official World" branding.

---

## 6. Build order

1. Scaffold isolated Next.js app (no workspace coupling) — installs/builds standalone. ✅ gate
2. Trust Runtime core + tests (governance, lifecycle, plan-hash, hash-chained receipts, nullifier registry).
3. World ID + MiniKit wiring (walletAuth, IDKit verify, plan-hash-bound approval) + dev/mock mode.
4. Agent brain + safe governed tools (Claude planner, simulate, execute).
5. SOTA liquid-glass UI/UX across the 7 lifecycle screens.
6. Local end-to-end run + receipt verification.
7. Developer Portal app + grant materials; apply to Spark + continuous + any open program (gated on Daniel).

---

## 7. Open inputs from Daniel (non-blocking for the build; needed before submit)

World Developer Portal account + **App ID** (`app_...`) and an Action id for `approve-mission`/`verify-human`; jurisdiction confirm (grants exclude US persons); individual vs Aweb Labs; WLD vs USDC; approve app name + public description. Until these exist, the app runs in **dev/mock mode** so the full flow is buildable and testable now.
