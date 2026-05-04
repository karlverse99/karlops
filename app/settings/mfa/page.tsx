'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function MfaSettingsPage() {
  const [ready, setReady] = useState(false);
  const [hasVerifiedTotp, setHasVerifiedTotp] = useState(false);
  const [factorId, setFactorId] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        window.location.href = '/login';
        return;
      }
      const { data: factors, error: lfErr } = await supabase.auth.mfa.listFactors();
      if (lfErr) {
        setError(lfErr.message);
        setReady(true);
        return;
      }
      const verified = factors.totp.filter((f) => f.status === 'verified');
      if (verified.length > 0) {
        setHasVerifiedTotp(true);
        setReady(true);
        return;
      }
      const { data, error: enErr } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (enErr || !data) {
        setError(enErr?.message ?? 'Could not start authenticator enrollment.');
        setReady(true);
        return;
      }
      setFactorId(data.id);
      setQrDataUrl(data.totp.qr_code);
      setSecret(data.totp.secret ?? '');
      setReady(true);
    })();
  }, []);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    const code = verifyCode.replace(/\s/g, '');
    if (!code || !factorId) return;
    setBusy(true);
    setError('');
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !challenge) {
      setError(chErr?.message ?? 'Challenge failed');
      setBusy(false);
      return;
    }
    const { error: verErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    setBusy(false);
    if (verErr) {
      setError(verErr.message);
      return;
    }
    setDone(true);
  }

  async function handleUnenroll(fId: string) {
    if (!confirm('Remove authenticator from this account? You can set it up again later.')) return;
    setBusy(true);
    setError('');
    const { error: unErr } = await supabase.auth.mfa.unenroll({ factorId: fId });
    setBusy(false);
    if (unErr) {
      setError(unErr.message);
      return;
    }
    window.location.reload();
  }

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#888', fontFamily: 'monospace', fontSize: '0.85rem' }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'monospace', padding: '1.5rem', maxWidth: '480px', margin: '0 auto' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/workspace" style={{ color: '#fbbf24', textDecoration: 'none' }}>← Workspace</Link>
      </p>
      <h1 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Authenticator (2FA)</h1>
      <p style={{ color: '#888', fontSize: '0.75rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
        Use an app such as Google Authenticator, Authy, or 1Password. After you verify a code here, your next sign-in will ask for a code as well.
      </p>
      {error && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '1rem' }}>{error}</div>}

      {hasVerifiedTotp && (
        <VerifiedFactors onUnenroll={handleUnenroll} busy={busy} />
      )}

      {!hasVerifiedTotp && !done && factorId && (
        <>
          {qrDataUrl && (
            <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
              {/* Supabase returns SVG suitable for img src (often data URL) */}
              <img src={qrDataUrl} alt="Scan QR code with your authenticator app" style={{ maxWidth: 220, height: 'auto', borderRadius: 8 }} />
            </div>
          )}
          {secret && (
            <p style={{ color: '#666', fontSize: '0.7rem', wordBreak: 'break-all', marginBottom: '1rem' }}>
              If you cannot scan the QR code, enter this secret manually: <span style={{ color: '#aaa' }}>{secret}</span>
            </p>
          )}
          <form onSubmit={handleVerify}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#888', marginBottom: '0.35rem' }}>Enter the 6-digit code to confirm</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              disabled={busy}
              style={{
                width: '100%',
                maxWidth: '280px',
                background: '#111',
                border: '1px solid #333',
                color: '#e5e5e5',
                padding: '0.65rem 0.75rem',
                borderRadius: 6,
                fontSize: '0.85rem',
                fontFamily: 'monospace',
                marginBottom: '0.75rem',
              }}
              maxLength={12}
            />
            <button
              type="submit"
              disabled={busy}
              style={{
                background: '#1a1a1a',
                border: '1px solid #333',
                color: '#e5e5e5',
                padding: '0.65rem 1.25rem',
                borderRadius: 6,
                fontSize: '0.85rem',
                fontFamily: 'monospace',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? '…' : 'Enable two-step login'}
            </button>
          </form>
        </>
      )}

      {done && (
        <p style={{ color: '#4ade80', fontSize: '0.85rem' }}>
          Authenticator is enabled. <Link href="/workspace" style={{ color: '#fbbf24' }}>Back to workspace</Link>
        </p>
      )}
    </div>
  );
}

function VerifiedFactors({ onUnenroll, busy }: { onUnenroll: (id: string) => void; busy: boolean }) {
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string }[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      if (data) {
        setFactors(data.totp.filter((f) => f.status === 'verified').map((f) => ({ id: f.id, friendly_name: f.friendly_name })));
      }
    })();
  }, []);

  return (
    <div>
      <p style={{ color: '#4ade80', fontSize: '0.85rem', marginBottom: '1rem' }}>Two-step login is active on this account.</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {factors.map((f) => (
          <li key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '0.5rem 0', borderBottom: '1px solid #222' }}>
            <span style={{ fontSize: '0.8rem', color: '#aaa' }}>{f.friendly_name || 'Authenticator app'}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onUnenroll(f.id)}
              style={{
                background: 'transparent',
                border: '1px solid #444',
                color: '#888',
                fontSize: '0.7rem',
                fontFamily: 'monospace',
                padding: '0.35rem 0.6rem',
                borderRadius: 4,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
