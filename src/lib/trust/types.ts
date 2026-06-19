/**
 * Core types for the Aweb Trust Runtime (the governance + evidence layer that
 * World's AgentKit does not provide).
 */

/** Risk classification drives the approval policy. Default-deny anything else. */
export type RiskClass = 'READ_ONLY' | 'REVERSIBLE' | 'SENSITIVE' | 'VALUE_MOVEMENT';

/** Lifecycle of a governed mission — enforced as a state machine. */
export type MissionState =
  | 'planned'
  | 'simulated'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'failed';

/** A single typed step the agent intends to take. */
export interface MissionStep {
  id: string;
  index: number;
  tool: string; // tool slug, must be allow-listed by policy
  intent: string; // human-readable description of the effect
  args: Record<string, unknown>;
  riskClass: RiskClass;
  /** For VALUE_MOVEMENT steps — the amount the agent would move/spend, USD. */
  valueUsd?: number;
}

/** The frozen plan the human reviews and (for sensitive steps) approves. */
export interface MissionPlan {
  missionId: string;
  goal: string; // the human's natural-language task
  createdAt: string;
  steps: MissionStep[];
  dataBoundaries: string[]; // what data the agent may touch
  valueCapUsd: number; // hard ceiling across the whole mission
  reasoning?: string; // the agent's deliberation — how it decomposed the goal (auditable)
  critique?: string; // the agent's self-critique of its own plan before committing
}

/** Governance configuration for a mission. */
export interface PolicyConfig {
  allowedTools: string[];
  valueCapUsd: number;
  /** Risk classes that may run without a human approval (logged regardless). */
  autoApproveRiskClasses: RiskClass[];
}

/** Per-step policy verdict. */
export type StepDecision = 'auto' | 'needs_approval' | 'denied';

export interface StepEvaluation {
  stepId: string;
  decision: StepDecision;
  reason: string;
}

/**
 * A World ID approval: a zero-knowledge proof that a unique verified human
 * approved EXACTLY this plan (signalHash === hash bound to the planHash).
 */
export interface WorldIdApproval {
  action: string;
  /** Hash bound to the World ID `signal` — derived from the mission planHash. */
  signalHash: string;
  nullifierHash: string; // unique-human handle; single-use per signal (anti-replay)
  merkleRoot: string;
  proof: string;
  verificationLevel: 'orb' | 'device';
  verifiedAt: string;
}

/** Who stands behind the mission. */
export interface MissionAuthority {
  walletAddress?: string;
  worldIdNullifier?: string;
  verificationLevel?: 'orb' | 'device';
}

export type ReceiptKind =
  | 'plan'
  | 'simulate'
  | 'await_approval'
  | 'approve'
  | 'execute_step'
  | 'blocked'
  | 'complete'
  | 'reject'
  | 'settle' // on-chain settlement of an authorized value movement
  | 'verify' // post-execution self-verification: did the agent actually meet the goal
  | 'replan' // self-repair: corrective steps generated from real execution feedback
  | 'anchor'; // receipt root anchored on World Chain (permanent public proof)

/** One hash-chained receipt entry. */
export interface ReceiptEntry {
  seq: number;
  kind: ReceiptKind;
  at: string;
  summary: string;
  data: Record<string, unknown>; // redaction applied before hashing
  prevHash: string | null;
  hash: string; // sha256(canonicalJson({seq,kind,at,summary,data,prevHash}))
}

/** Ed25519 seal over the receipt chain head — proves authenticity, not just integrity. */
export interface ReceiptSeal {
  algorithm: 'Ed25519';
  publicKey: string; // base64 SPKI DER
  signature: string; // base64 over UTF-8 bytes of signedHash
  signedHash: string; // the chain head hash that was signed
  signedAt: string;
}

/** A permanent on-chain anchor of the sealed receipt root (World Chain). */
export interface ReceiptAnchor {
  chain: 'world-chain';
  chainId: number;
  txHash: string;
  explorer: string;
  rootHash: string; // the sealed chain-head hash committed on-chain
  anchoredAt: string;
}

/** The full verifiable receipt for a mission. */
export interface ReceiptChain {
  missionId: string;
  planHash: string;
  authority: MissionAuthority;
  entries: ReceiptEntry[];
  seal?: ReceiptSeal;
  anchor?: ReceiptAnchor;
}

/** Result of running one step (returned by the injected execute fn). */
export interface StepResult {
  stepId: string;
  ok: boolean;
  outcome: string;
  /** Redacted, receipt-safe output summary. */
  output?: Record<string, unknown>;
  costUsd?: number;
  error?: string;
}
