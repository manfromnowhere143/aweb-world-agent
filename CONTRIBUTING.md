# Contributing

Thanks for your interest — this is an open governance primitive for the World ecosystem, and contributions that make agent work **more verifiable** are especially welcome.

## Ground rules

- Be respectful — see the [Code of Conduct](./CODE_OF_CONDUCT.md).
- This repo is the **open client + Trust Runtime**. It must not depend on any private Aweb internals; the Aweb backend is reached only over HTTP via env config and must always degrade gracefully when absent.
- **Never commit secrets.** Configuration is by environment variable; see [`.env.local.example`](./.env.local.example).

## Dev setup

```bash
npm install
cp .env.local.example .env.local   # set ANTHROPIC_API_KEY; dev mode on by default
npm run dev                        # http://localhost:3210
```

## Before you open a PR

Run the same gates CI runs — both must be green:

```bash
npm run typecheck   # strict TypeScript, no errors
npm test            # governance · signing · sandbox invariants
```

- Keep changes focused and additive. If you touch the **Trust Runtime** (`src/lib/trust/`), add or extend a test that proves the invariant you rely on (governance, anti-replay, chain integrity, seal authenticity).
- Match the existing style: small, well-commented modules; deterministic core (no `Date`/random inside the runtime — inject `now()`); default-deny in the policy engine.
- Update docs (`README.md` / `ARCHITECTURE.md`) when behavior or architecture changes.

## What makes a great PR here

- A new **risk-classed tool** that does real, useful work and is correctly governed.
- Stronger verification (e.g., richer in-browser checks, Merkle proofs over receipt trees).
- Better resilience, accessibility, localization, or World App UX.
- Tests that turn a "should never happen" into a guarded invariant.

By contributing, you agree your contributions are licensed under the project's [Apache-2.0](./LICENSE) license.
