'use client';
import { useEffect, useRef, useState } from 'react';
import type { MissionPlan, ReceiptChain } from '@/lib/trust/types';
import type { WorldProofPayload } from '@/lib/world/verify';
import type { MissionVerdict } from '@/lib/agent/verifier';
import { requestPayment } from '@/lib/world/client';
import { ReceiptVerifier } from './ReceiptVerifier';

interface PendingPay { stepId: string; to: string; amountUsd: number; currency: string }
function pendingPayments(receipt: ReceiptChain): PendingPay[] {
  const settled = new Set(receipt.entries.filter(e => e.kind === 'settle').map(e => (e.data as { stepId?: string }).stepId));
  return receipt.entries
    .filter(e => e.kind === 'execute_step' && (e.data as { output?: { awaitingSettlement?: boolean } }).output?.awaitingSettlement)
    .map(e => {
      const o = (e.data as { stepId?: string; output?: Record<string, unknown> });
      return { stepId: String(o.stepId), to: String(o.output?.to ?? ''), amountUsd: Number(o.output?.amountUsd ?? 0), currency: String(o.output?.currency ?? 'USDC') };
    })
    .filter(p => !settled.has(p.stepId));
}

type NodeState = 'pending' | 'active' | 'done' | 'blocked';
interface TLNode { id: string; name: string; detail?: string; state: NodeState; sources?: string[] }

const TOOL_NAME: Record<string, string> = {
  research: 'Research the live web', fetch: 'Read a web page', draft: 'Draft the content', send: 'Deliver — World-ID approved', pay: 'Pay — governed', compute: 'Run code (sandbox)',
};

function initialNodes(plan: MissionPlan, needsApproval: boolean): TLNode[] {
  const nodes: TLNode[] = [
    { id: 'plan', name: 'Mission planned', detail: 'Decomposed into typed, governed steps', state: 'active' },
    { id: 'simulate', name: 'Simulated — no side effects', detail: 'Dry-run before anything real happens', state: 'pending' },
  ];
  if (needsApproval) nodes.push({ id: 'approval', name: 'Verified-human approval', detail: 'World ID proof bound to this exact plan', state: 'pending' });
  for (const s of plan.steps) nodes.push({ id: s.id, name: TOOL_NAME[s.tool] ?? s.tool, detail: s.intent, state: 'pending' });
  nodes.push({ id: 'verify', name: 'Self-verified', detail: 'The agent grades whether it met your goal', state: 'pending' });
  nodes.push({ id: 'seal', name: 'Sealed & receipted', detail: 'Hash-chained + Ed25519-signed evidence', state: 'pending' });
  return nodes;
}

export function MissionConsole({ missionId, plan, needsApproval, proof, walletAddress, onReset }: {
  missionId: string; plan: MissionPlan; needsApproval: boolean; proof?: WorldProofPayload; walletAddress?: string; onReset: () => void;
}) {
  const [nodes, setNodes] = useState<TLNode[]>(() => initialNodes(plan, needsApproval));
  const [receipt, setReceipt] = useState<ReceiptChain | null>(null);
  const [verdict, setVerdict] = useState<MissionVerdict | null>(null);
  const [error, setError] = useState('');
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState('');
  const started = useRef(false);

  async function settle(pay: PendingPay) {
    setSettling(true); setSettleError('');
    try {
      const r = await requestPayment({ to: pay.to, amountUsd: pay.amountUsd, currency: pay.currency, reference: `${missionId}:${pay.stepId}`, description: 'Aweb Agent — governed payment' });
      const res = await fetch('/api/mission/settle', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ missionId, stepId: pay.stepId, txId: r.txId, to: pay.to, amountUsd: pay.amountUsd, currency: pay.currency }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'settlement failed');
      setReceipt(d.receipt);
    } catch (e) { setSettleError(e instanceof Error ? e.message : String(e)); }
    finally { setSettling(false); }
  }

  useEffect(() => {
    if (started.current) return; started.current = true;
    const set = (id: string, patch: Partial<TLNode>) => setNodes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n));

    (async () => {
      try {
        const res = await fetch('/api/mission/run', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ missionId, proof, walletAddress }),
        });
        if (!res.body) throw new Error('no stream');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'entry') {
              const k = ev.entry.kind, d = ev.entry.data || {};
              if (k === 'plan') { set('plan', { state: 'done' }); set('simulate', { state: 'active' }); }
              else if (k === 'simulate') { set('simulate', { state: 'done' }); if (needsApproval) set('approval', { state: 'active' }); }
              else if (k === 'await_approval') set('approval', { state: 'active' });
              else if (k === 'approve') set('approval', { state: 'done' });
              else if (k === 'execute_step') set(d.stepId, { state: 'done', sources: Array.isArray(d.output?.sources) ? d.output.sources : undefined });
              else if (k === 'blocked') set(d.stepId, { state: 'blocked' });
            } else if (ev.type === 'step_start') set(ev.stepId, { state: 'active' });
            else if (ev.type === 'verifying') set('verify', { state: 'active' });
            else if (ev.type === 'verified') { set('verify', { state: 'done' }); setVerdict(ev.verdict); }
            else if (ev.type === 'sealing') { set('verify', { state: 'done' }); set('seal', { state: 'active' }); }
            else if (ev.type === 'anchoring') {
              set('seal', { state: 'done' });
              setNodes(ns => ns.some(n => n.id === 'anchor') ? ns : [...ns, { id: 'anchor', name: 'Anchored on World Chain', detail: 'Receipt root committed on-chain — permanent public proof', state: 'active' }]);
            }
            else if (ev.type === 'anchored') set('anchor', { state: 'done' });
            else if (ev.type === 'done') {
              set('verify', { state: 'done' }); set('seal', { state: 'done' }); set('anchor', { state: 'done' });
              setReceipt(ev.receipt);
              const ve = (ev.receipt?.entries ?? []).find((e: { kind: string }) => e.kind === 'verify');
              if (ve) setVerdict(ve.data as MissionVerdict);
            }
            else if (ev.type === 'error') setError(ev.error);
            else if (ev.type === 'need_approval') setError('Approval required — World ID proof missing.');
          }
        }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, [missionId, proof, walletAddress, needsApproval]);

  const allDone = !!receipt;

  return (
    <div className="fade-in">
      <div className="brand"><div className="mark">A</div><div className="wordmark">Aweb&nbsp;Agent</div></div>
      <div className="gap-lg" />
      <div className="console-head">
        <div className="console-orb" style={allDone ? { background: 'var(--green)', animation: 'none' } : undefined} />
        <div>
          <div className="console-title">{allDone ? 'Mission complete' : 'Agent at work'}</div>
          <div className="console-sub">{allDone ? 'Every action governed, proven, and sealed.' : 'Governed live — watch each step.'}</div>
        </div>
      </div>

      <div className="tl">
        {nodes.map((n, i) => (
          <div className={`tl-step ${n.state}`} key={n.id}>
            <div className="tl-rail">
              <div className="tl-node">
                {n.state === 'done' ? '✓' : n.state === 'active' ? <span className="tl-spin" /> : n.state === 'blocked' ? '✕' : i + 1}
              </div>
              {i < nodes.length - 1 && <div className="tl-line" />}
            </div>
            <div className="tl-body">
              <div className="tl-name">{n.name}</div>
              {n.detail && <div className="tl-detail">{n.detail}</div>}
              {n.sources && n.sources.length > 0 && (
                <div className="srcs">
                  {n.sources.slice(0, 4).map((s, j) => (
                    <span className="src-chip" key={j}>{s.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30)}</span>
                  ))}
                  {n.sources.length > 4 && <span className="src-chip">+{n.sources.length - 4} more</span>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="glass tight pad" style={{ borderColor: 'rgba(255,138,122,0.4)', color: 'var(--red)', fontSize: 14 }}>{error}</div>}

      {allDone && receipt && (() => {
        const pend = pendingPayments(receipt);
        return (
        <div className="fade-in">
          <div className="gap" />
          {verdict && (
            <div className={`glass tight pad verdict ${verdict.goalMet ? 'met' : 'unmet'}`} style={{ marginBottom: 14 }}>
              <div className="row">
                <span className="tl-name" style={{ fontSize: 15 }}>Self-verification</span>
                <span className={`badge ${verdict.goalMet ? 'ok' : 'sens'}`}><span className="dot" />{verdict.goalMet ? 'goal met' : 'gaps found'}</span>
              </div>
              <div className="cbar"><div className={`cfill ${verdict.goalMet ? 'met' : 'unmet'}`} style={{ width: `${Math.round(verdict.confidence * 100)}%` }} /></div>
              <div className="cnum">confidence {Math.round(verdict.confidence * 100)}%{verdict.model ? '' : ' · heuristic'}</div>
              {verdict.rationale && <div className="tl-detail" style={{ marginTop: 8 }}>{verdict.rationale}</div>}
              {verdict.gaps?.length > 0 && <div className="gaps">{verdict.gaps.map((g, i) => <div className="gap-item" key={i}>{g}</div>)}</div>}
            </div>
          )}
          {pend.map(pay => (
            <div key={pay.stepId} className="glass pad" style={{ borderColor: 'rgba(37,99,235,0.35)', marginBottom: 14 }}>
              <div className="row"><span className="tl-name" style={{ fontSize: 16 }}>Payment authorized</span><span className="badge value"><span className="dot" />needs settlement</span></div>
              <div className="tl-detail" style={{ marginTop: 8 }}>Your World ID approval authorized <b>{pay.amountUsd} {pay.currency}</b> → <span className="mono">{pay.to.slice(0, 14)}…</span>. Settle it from your World Wallet.</div>
              {settleError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{settleError}</div>}
              <div className="gap-sm" />
              <button className="btn btn-world" disabled={settling} onClick={() => settle(pay)}>{settling ? <span className="spin" /> : `Pay ${pay.amountUsd} ${pay.currency} with World Wallet`}</button>
            </div>
          ))}
          {receipt.entries.some(e => e.kind === 'settle') && (
            <div className="glass tight pad" style={{ borderColor: 'rgba(87,224,166,0.4)', marginBottom: 14 }}>
              <div className="row"><span className="tl-name" style={{ fontSize: 15 }}>Payment settled on-chain</span><span className="badge ok"><span className="dot" />settled</span></div>
              {receipt.entries.filter(e => e.kind === 'settle').map((e, i) => {
                const d = e.data as { txId?: string; explorer?: string | null; asset?: string; amountUsd?: number; amountWei?: string };
                const ethAmt = d.amountWei ? Number(d.amountWei) / 1e18 : 0;
                const ethStr = ethAmt > 0 ? String(Number(ethAmt.toPrecision(3))) : '';
                return (
                  <div key={i} style={{ marginTop: 8 }}>
                    {ethStr && <div className="tl-detail">{ethStr} {d.asset ?? 'ETH'}{d.amountUsd ? ` (≈ $${d.amountUsd})` : ''} — governed agent-treasury transfer on World Chain</div>}
                    <div className="hash" style={{ marginTop: 4 }}>{d.explorer ? <a href={d.explorer} target="_blank" rel="noreferrer">{String(d.txId).slice(0, 30)}… ↗</a> : `${String(d.txId).slice(0, 30)}… (dev)`}</div>
                  </div>
                );
              })}
            </div>
          )}
          {receipt.anchor && (
            <div className="glass tight pad" style={{ borderColor: 'rgba(122,162,255,0.45)', marginBottom: 14 }}>
              <div className="row"><span className="tl-name" style={{ fontSize: 15 }}>Anchored on World Chain</span><span className="badge ok"><span className="dot" />on-chain</span></div>
              <div className="tl-detail" style={{ marginTop: 8 }}>The sealed receipt root is committed on World Chain — a permanent, public proof anyone can audit.</div>
              <div className="hash" style={{ marginTop: 8 }}><a href={receipt.anchor.explorer} target="_blank" rel="noreferrer">{receipt.anchor.txHash.slice(0, 30)}… ↗</a></div>
            </div>
          )}
          <ReceiptVerifier chain={receipt} />
          <div className="gap" />
          <a className="glass tight pad" style={{ display: 'block', textAlign: 'center' }} href={`/receipt/${missionId}`} target="_blank" rel="noreferrer">Open full verifiable receipt ↗</a>
          <div className="dock"><div className="inner">
            <button className="btn btn-primary" onClick={onReset}>New mission</button>
          </div></div>
        </div>
        );
      })()}
    </div>
  );
}
