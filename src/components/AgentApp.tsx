'use client';
import { useState } from 'react';
import { login, requestApproval, inWorldApp, type Account } from '@/lib/world/client';
import type { MissionPlan, StepEvaluation } from '@/lib/trust/types';
import type { WorldProofPayload } from '@/lib/world/verify';
import { MissionConsole } from './MissionConsole';

const APPROVE_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION_APPROVE_MISSION || 'approve-mission';

type Stage = 'welcome' | 'task' | 'planning' | 'plan' | 'approve' | 'running';

const RISK_BADGE: Record<string, { cls: string; label: string }> = {
  READ_ONLY: { cls: 'read', label: 'read-only' },
  REVERSIBLE: { cls: 'rev', label: 'reversible' },
  SENSITIVE: { cls: 'sens', label: 'needs approval' },
  VALUE_MOVEMENT: { cls: 'value', label: 'value · approval' },
};

const EXAMPLES = [
  'Research the 3 most-used mini apps on World and brief me on what they do well.',
  'Draft a friendly announcement that my agent is now live on World App.',
  'Research proof-of-personhood for AI agents, then draft a short explainer to send.',
];

export function AgentApp() {
  const [stage, setStage] = useState<Stage>('welcome');
  const [account, setAccount] = useState<Account | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<MissionPlan | null>(null);
  const [planHash, setPlanHash] = useState('');
  const [signal, setSignal] = useState('');
  const [evaluation, setEvaluation] = useState<StepEvaluation[]>([]);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [missionId, setMissionId] = useState('');
  const [proof, setProof] = useState<WorldProofPayload | undefined>(undefined);

  async function activate() {
    setBusy(true); setError('');
    try { setAccount(await login()); setStage('task'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function createPlan() {
    setBusy(true); setError(''); setStage('planning');
    try {
      const r = await fetch('/api/mission/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'planning failed');
      setPlan(d.plan); setPlanHash(d.planHash); setSignal(d.signal); setEvaluation(d.evaluation);
      setNeedsApproval(d.needsApproval); setMissionId(d.missionId); setProof(undefined); setStage('plan');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStage('task'); }
    finally { setBusy(false); }
  }

  function startMission() {
    setError('');
    if (needsApproval) setStage('approve');
    else setStage('running');
  }

  async function approveAndRun() {
    setBusy(true); setError('');
    try {
      const p = await requestApproval(APPROVE_ACTION, signal);
      setProof(p); setStage('running');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function reset() {
    setGoal(''); setPlan(null); setProof(undefined); setError(''); setStage('task');
  }

  const Header = (
    <>
      <div className="brand"><div className="mark">A</div><div className="wordmark">Aweb&nbsp;Agent</div></div>
      <div className="kicker">Governed agent · verified human</div>
    </>
  );

  return (
    <div className="shell">
      {stage === 'welcome' && (
        <div className="fade-in">
          {Header}
          <h1 className="title">Your agent.<br />Verified. Governed.<br />Provable.</h1>
          <p className="lede">
            World proves a real human is behind your agent. <b>Aweb proves your agent behaved</b> —
            it plans, simulates, asks <i>you</i> to approve anything sensitive with World ID, and
            hands you a verifiable receipt for everything it did.
          </p>
          <div className="gap-lg" />
          <div className="glass pad">
            <Flow n="1" t="Verify you're human" d="One human, one agent. No bot armies." />
            <Flow n="2" t="Hand it a task" d="In plain words. It writes a typed plan." />
            <Flow n="3" t="Approve with World ID" d="Sensitive steps can't run without your proof." />
            <Flow n="4" t="Get a receipt" d="Hash-chained, signed, independently verifiable." last />
          </div>
          {!inWorldApp() && <><div className="gap" /><div className="pill">Preview mode — open inside World App for real World ID &amp; wallet.</div></>}
          {error && <Err msg={error} />}
          <div className="dock"><div className="inner">
            <button className="btn btn-world" disabled={busy} onClick={activate}>{busy ? <span className="spin" /> : 'Activate my agent'}</button>
          </div></div>
        </div>
      )}

      {stage === 'task' && (
        <div className="fade-in">
          {Header}
          <div className="gap-lg" />
          <div className="row top">
            <h1 className="title grow" style={{ fontSize: 26 }}>What should your<br />agent do?</h1>
            {account && <span className="pill" style={{ marginTop: 8 }}>{account.username || account.address.slice(0, 6) + '…'}</span>}
          </div>
          <div className="gap" />
          <textarea rows={3} value={goal} placeholder="e.g. Research the top mini apps on World and draft a short summary I can post." onChange={e => setGoal(e.target.value)} />
          <div className="gap-sm" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {EXAMPLES.map((ex, i) => (
              <button key={i} className="glass tight" style={{ textAlign: 'left', cursor: 'pointer', padding: 14, fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.45 }} onClick={() => setGoal(ex)}>{ex}</button>
            ))}
          </div>
          {error && <Err msg={error} />}
          <div className="dock"><div className="inner">
            <button className="btn btn-primary" disabled={busy || goal.trim().length < 3} onClick={createPlan}>Create mission plan</button>
          </div></div>
        </div>
      )}

      {stage === 'planning' && <Center title="Planning your mission…" sub="Decomposing your task into typed, governed steps." />}

      {stage === 'plan' && plan && (
        <div className="fade-in">
          {Header}
          <div className="gap-lg" />
          <h1 className="title" style={{ fontSize: 24 }}>Mission plan</h1>
          <p className="lede" style={{ fontSize: 15 }}>{plan.goal}</p>
          <div className="gap" />
          <div className="glass pad">
            {plan.steps.map((s, i) => {
              const b = RISK_BADGE[s.riskClass];
              return (
                <div className="step" key={s.id}>
                  <div className="num">{i + 1}</div>
                  <div className="body">
                    <div className="intent">{s.intent}</div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <span className="tool mono">{s.tool}{s.valueUsd ? ` · $${s.valueUsd}` : ''}</span>
                      <span className={`badge ${b.cls}`}><span className="dot" />{b.label}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="gap" />
          <div className="glass tight pad">
            <div className="row"><span className="faint">plan hash</span><span className="val">{planHash.slice(0, 22)}…</span></div>
            {needsApproval && <><div className="gap-sm" /><div className="dim" style={{ fontSize: 13 }}>🔐 Sensitive steps need your <b>World ID approval</b>, bound to this exact plan. Change one word and the approval is void.</div></>}
          </div>
          {error && <Err msg={error} />}
          <div className="dock"><div className="inner" style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ width: 'auto', padding: '17px 18px' }} onClick={reset}>Back</button>
            <button className="btn btn-primary" disabled={busy} onClick={startMission}>{needsApproval ? 'Review & approve' : 'Run mission'}</button>
          </div></div>
        </div>
      )}

      {stage === 'approve' && (
        <div className="fade-in">
          {Header}
          <div className="approve-stage">
            <div className="wid"><div className="core" /></div>
            <h1 className="title" style={{ fontSize: 27 }}>Approve with World ID</h1>
            <p className="lede">This mission has a sensitive step. Prove you’re the unique human behind it — your approval is cryptographically bound to this exact plan.</p>
          </div>
          <div className="gap" />
          <div className="glass tight pad"><div className="row"><span className="faint">binding</span><span className="val">{planHash.slice(0, 22)}…</span></div></div>
          {error && <Err msg={error} />}
          <div className="dock"><div className="inner" style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ width: 'auto', padding: '17px 18px' }} onClick={() => setStage('plan')}>Back</button>
            <button className="btn btn-world" disabled={busy} onClick={approveAndRun}>{busy ? <span className="spin" /> : 'Verify & approve'}</button>
          </div></div>
        </div>
      )}

      {stage === 'running' && plan && (
        <MissionConsole missionId={missionId} plan={plan} needsApproval={needsApproval} proof={proof} walletAddress={account?.address} onReset={reset} />
      )}
    </div>
  );
}

function Flow({ n, t, d, last }: { n: string; t: string; d: string; last?: boolean }) {
  return (
    <div className="step" style={last ? { borderBottom: 'none' } : undefined}>
      <div className="num" style={{ background: 'linear-gradient(140deg,var(--gold),#8a6a30)', color: '#1a1206', fontWeight: 700 }}>{n}</div>
      <div className="body"><div className="intent">{t}</div><div className="tool">{d}</div></div>
    </div>
  );
}
function Center({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="shell center fade-in" style={{ display: 'grid', placeContent: 'center', minHeight: '80dvh' }}>
      <div className="glass pad">
        <div style={{ margin: '0 auto 16px', width: 26, height: 26 }}><div className="spin" style={{ width: 26, height: 26, borderTopColor: 'var(--gold)', borderColor: 'rgba(217,180,106,0.25)' }} /></div>
        <div className="wordmark" style={{ fontSize: 20 }}>{title}</div>
        <div className="dim" style={{ marginTop: 8, fontSize: 14 }}>{sub}</div>
      </div>
    </div>
  );
}
function Err({ msg }: { msg: string }) {
  return <><div className="gap" /><div className="glass tight pad" style={{ borderColor: 'rgba(255,138,122,0.4)', color: 'var(--red)', fontSize: 14 }}>{msg}</div></>;
}
