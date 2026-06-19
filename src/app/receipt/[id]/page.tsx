import { getMission } from '@/lib/store';
import { ReceiptVerifier } from '@/components/ReceiptVerifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mission = await getMission(id);

  if (!mission?.receipt) {
    return (
      <div className="shell center">
        <div className="brand"><div className="mark">A</div><div className="wordmark">Aweb&nbsp;Agent</div></div>
        <div className="gap-lg" />
        <div className="glass pad">Receipt not found.</div>
      </div>
    );
  }

  const { receipt } = mission;
  const auth = receipt.authority;

  const planData = (receipt.entries.find(e => e.kind === 'plan')?.data ?? {}) as { reasoning?: string; critique?: string };
  const verdict = receipt.entries.find(e => e.kind === 'verify')?.data as
    | { goalMet?: boolean; confidence?: number; rationale?: string; gaps?: string[]; model?: boolean }
    | undefined;
  const conf = Math.round((verdict?.confidence ?? 0) * 100);

  return (
    <div className="shell">
      <div className="brand"><div className="mark">A</div><div className="wordmark">Aweb&nbsp;Agent</div></div>
      <div className="kicker">Verifiable agent receipt</div>
      <div className="gap-lg" />
      <h1 className="title" style={{ fontSize: 24 }}>{mission.plan.goal}</h1>
      <div className="gap" />

      <div className="glass tight pad">
        <div className="row"><span className="faint">mission</span><span className="val">{mission.missionId}</span></div>
        <div className="gap-sm" />
        <div className="row"><span className="faint">plan hash</span><span className="val">{mission.planHash.slice(0, 24)}…</span></div>
        <div className="gap-sm" />
        <div className="row"><span className="faint">state</span><span className="badge ok"><span className="dot" />{mission.state}</span></div>
      </div>

      <div className="gap" />
      <div className="glass tight pad">
        <div className="dim" style={{ fontSize: 13, marginBottom: 10 }}>Authority — who stood behind this agent</div>
        <div className="row"><span className="faint">wallet</span><span className="val">{auth.walletAddress ? `${auth.walletAddress.slice(0, 10)}…` : '—'}</span></div>
        <div className="gap-sm" />
        <div className="row"><span className="faint">World ID</span><span className="val">{auth.worldIdNullifier ? `${auth.worldIdNullifier.slice(0, 16)}…` : 'no sensitive step'}</span></div>
        {auth.verificationLevel && <><div className="gap-sm" /><div className="row"><span className="faint">level</span><span className="badge sens"><span className="dot" />{auth.verificationLevel}</span></div></>}
      </div>

      {(planData.reasoning || planData.critique) && (
        <>
          <div className="gap" />
          <div className="glass tight pad reason-panel">
            {planData.reasoning && <><div className="reason-label">How the agent reasoned</div><p className="reason-text">{planData.reasoning}</p></>}
            {planData.critique && <><div className="reason-label" style={{ marginTop: 14 }}>Self-critique</div><p className="reason-text">{planData.critique}</p></>}
          </div>
        </>
      )}

      {verdict && (
        <>
          <div className="gap" />
          <div className={`glass tight pad verdict ${verdict.goalMet ? 'met' : 'unmet'}`}>
            <div className="row">
              <span className="dim" style={{ fontSize: 13 }}>Self-verification — did the agent meet the goal</span>
              <span className={`badge ${verdict.goalMet ? 'ok' : 'sens'}`}><span className="dot" />{verdict.goalMet ? 'goal met' : 'gaps found'}</span>
            </div>
            <div className="cbar"><div className={`cfill ${verdict.goalMet ? 'met' : 'unmet'}`} style={{ width: `${conf}%` }} /></div>
            <div className="cnum">confidence {conf}%{verdict.model ? '' : ' · heuristic'}</div>
            {verdict.rationale && <div className="tl-detail" style={{ marginTop: 8 }}>{verdict.rationale}</div>}
            {verdict.gaps && verdict.gaps.length > 0 && <div className="gaps">{verdict.gaps.map((g, i) => <div className="gap-item" key={i}>{g}</div>)}</div>}
          </div>
        </>
      )}

      {receipt.anchor && (
        <>
          <div className="gap" />
          <div className="glass tight pad" style={{ borderColor: 'rgba(122,162,255,0.45)' }}>
            <div className="dim" style={{ fontSize: 13, marginBottom: 10 }}>On-chain anchor — permanent public proof (World Chain)</div>
            <div className="row"><span className="faint">tx</span><span className="val"><a href={receipt.anchor.explorer} target="_blank" rel="noreferrer">{receipt.anchor.txHash.slice(0, 18)}… ↗</a></span></div>
            <div className="gap-sm" />
            <div className="row"><span className="faint">root</span><span className="val">{receipt.anchor.rootHash.slice(0, 18)}…</span></div>
            <div className="gap-sm" />
            <div className="row"><span className="faint">chain</span><span className="badge ok"><span className="dot" />World Chain · {receipt.anchor.chainId}</span></div>
          </div>
        </>
      )}

      <div className="gap" />
      <ReceiptVerifier chain={receipt} />

      <div className="gap" />
      <div className="glass pad">
        {receipt.entries.map((e, i) => {
          const out = (e.data as { output?: { sources?: unknown; grounded?: boolean } }).output;
          const sources = Array.isArray(out?.sources) ? (out!.sources as string[]) : [];
          return (
            <div className="rcpt" key={i}>
              <div className="rail"><div className="node" />{i < receipt.entries.length - 1 && <div className="line" />}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="what">{e.summary}</div>
                {out?.grounded && <span className="badge ok" style={{ marginTop: 6 }}><span className="dot" />web-grounded</span>}
                {sources.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>sources</div>
                    {sources.slice(0, 5).map((s, j) => (
                      <div key={j} className="hash"><a href={s} target="_blank" rel="noreferrer">{s.replace(/^https?:\/\//, '').slice(0, 48)}</a></div>
                    ))}
                  </div>
                )}
                <div className="hash" style={{ marginTop: 6 }}>{e.kind} · {e.at}</div>
                <div className="hash">{e.hash}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="gap-lg" />
      <div className="center faint" style={{ fontSize: 12 }}>Governed by Aweb · Verified human by World ID</div>
      <div className="gap-lg" />
    </div>
  );
}
