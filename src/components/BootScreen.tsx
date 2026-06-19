'use client';
import { useEffect, useState } from 'react';

/**
 * Cinematic opening — "Aweb Core awakening". The medallion draws on, the glyph
 * inks in, the verification halo and the receipt-chain nodes light in sequence,
 * then the wordmark + tagline rise and the whole thing dissolves into the app.
 * Shows once per session; respects prefers-reduced-motion (CSS handles the fast path).
 */
export function BootScreen() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('aweb-booted')) return; // already shown this session
      sessionStorage.setItem('aweb-booted', '1');
    } catch { /* ignore */ }
    setShow(true);
    const t = setTimeout(() => setShow(false), 3500); // after the CSS dissolve completes (2.7s + 0.7s)
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;

  return (
    <div className="boot" aria-hidden onClick={() => setShow(false)}>
      <div className="boot-stage">
        <svg className="boot-mark" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bgold" x1="240" y1="200" x2="800" y2="860" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#9DBEFF" /><stop offset="0.5" stopColor="#2563EB" /><stop offset="1" stopColor="#1E40AF" />
            </linearGradient>
            <radialGradient id="bfield" cx="0.5" cy="0.4" r="0.75">
              <stop offset="0" stopColor="#161A22" /><stop offset="1" stopColor="#0B0D14" />
            </radialGradient>
          </defs>
          <circle cx="512" cy="512" r="428" fill="url(#bfield)" stroke="url(#bgold)" strokeWidth="28" className="ring" pathLength={1} />
          <circle cx="512" cy="512" r="388" stroke="#5B8DEF" strokeOpacity="0.28" strokeWidth="8" className="innerring" />
          <circle cx="512" cy="360" r="78" stroke="url(#bgold)" strokeWidth="20" className="halo" pathLength={1} />
          <path d="M360 716 L512 360 L664 716" stroke="url(#bgold)" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" className="glyph" pathLength={1} />
          <path d="M416 592 H608" stroke="url(#bgold)" strokeWidth="22" strokeLinecap="round" className="glyph" pathLength={1} />
          <g fill="url(#bgold)">
            <circle cx="512" cy="360" r="32" className="node n1" />
            <circle cx="360" cy="716" r="30" className="node n2" />
            <circle cx="664" cy="716" r="30" className="node n3" />
            <circle cx="416" cy="592" r="15" className="node n4" />
            <circle cx="512" cy="592" r="20" className="node n5" />
            <circle cx="608" cy="592" r="15" className="node n6" />
          </g>
        </svg>
        <div className="boot-word">Aweb&nbsp;Agent</div>
        <div className="boot-tag">Verified · Governed · Provable</div>
        <div className="boot-bar" />
      </div>
    </div>
  );
}
