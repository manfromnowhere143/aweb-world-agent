/**
 * Single-use registry for World ID approvals (anti-replay).
 *
 * A given (nullifierHash, signalHash) pair may be consumed exactly once: a human
 * approving plan A cannot have that proof replayed against plan B, and the same
 * approval cannot be reused to execute twice.
 */
export interface NullifierRegistry {
  isUsed(nullifierHash: string, signalHash: string): boolean | Promise<boolean>;
  markUsed(nullifierHash: string, signalHash: string): void | Promise<void>;
}

/** In-memory implementation (dev / tests). Swap for a DB-backed impl in prod. */
export class InMemoryNullifierRegistry implements NullifierRegistry {
  private used = new Set<string>();
  private key(n: string, s: string) {
    return `${n}::${s}`;
  }
  isUsed(nullifierHash: string, signalHash: string): boolean {
    return this.used.has(this.key(nullifierHash, signalHash));
  }
  markUsed(nullifierHash: string, signalHash: string): void {
    this.used.add(this.key(nullifierHash, signalHash));
  }
}
