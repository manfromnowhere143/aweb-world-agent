'use client';
import { useEffect, useState } from 'react';
import { verifyChainInBrowser, verifySealInBrowser } from '@/lib/trust/verify-web';
import type { ReceiptChain } from '@/lib/trust/types';

export function ReceiptVerifier({ chain }: { chain: ReceiptChain }) {
  const [chainStatus, setChainStatus] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [sealStatus, setSealStatus] = useState<'checking' | 'valid' | 'invalid' | 'unsealed'>('checking');
  const [reason, setReason] = useState('');

  useEffect(() => {
    verifyChainInBrowser(chain).then(r => { setChainStatus(r.valid ? 'valid' : 'invalid'); if (!r.valid) setReason(r.reason || ''); });
    verifySealInBrowser(chain).then(r => { setSealStatus(r.status); if (r.status === 'invalid') setReason(p => p || r.reason || ''); });
  }, [chain]);

  const allGood = chainStatus === 'valid' && (sealStatus === 'valid' || sealStatus === 'unsealed');
  const bad = chainStatus === 'invalid' || sealStatus === 'invalid';

  return (
    <div className="glass tight pad" style={{ borderColor: bad ? 'rgba(255,138,122,0.45)' : allGood ? 'rgba(87,224,166,0.45)' : undefined }}>
      <div className="dim" style={{ fontSize: 13, marginBottom: 12 }}>Verified in your browser — no trust in us required</div>
      <div className="row">
        <span className="faint" style={{ fontSize: 13 }}>Integrity (hash chain)</span>
        {chainStatus === 'checking' && <span className="pill">checking…</span>}
        {chainStatus === 'valid' && <span className="badge ok"><span className="dot" />intact</span>}
        {chainStatus === 'invalid' && <span className="badge value"><span className="dot" />tampered</span>}
      </div>
      <div className="gap-sm" />
      <div className="row">
        <span className="faint" style={{ fontSize: 13 }}>Authenticity (Ed25519 seal)</span>
        {sealStatus === 'checking' && <span className="pill">checking…</span>}
        {sealStatus === 'valid' && <span className="badge ok"><span className="dot" />signed</span>}
        {sealStatus === 'unsealed' && <span className="pill">unsealed</span>}
        {sealStatus === 'invalid' && <span className="badge value"><span className="dot" />forged</span>}
      </div>
      {bad && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{reason}</div>}
    </div>
  );
}
