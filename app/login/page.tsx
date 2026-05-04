'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

const inputStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '280px',
  boxSizing: 'border-box',
  background: '#111',
  border: '1px solid #333',
  color: '#e5e5e5',
  padding: '0.65rem 0.75rem',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontFamily: 'monospace',
  marginBottom: '0.75rem',
};

const btnStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  color: '#e5e5e5',
  padding: '0.75rem 1.5rem',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontFamily: 'monospace',
  cursor: 'pointer',
  marginTop: '0.25rem',
};

type Phase = 'password' | 'mfa';

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetOk, setResetOk] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(decodeURIComponent(err));
    if (params.get('reset') === 'success') setResetOk(true);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!aalErr && aal?.nextLevel === 'aal2' && aal.currentLevel !== aal.nextLevel) {
        setPhase('mfa');
      }
    })();
  }, []);

  async function finishLoginIfNoMfaRequired() {
    const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalErr) {
      setError(aalErr.message);
      await supabase.auth.signOut();
      return;
    }
    if (aal.nextLevel === 'aal2' && aal.currentLevel !== aal.nextLevel) {
      setPhase('mfa');
      return;
    }
    router.replace('/workspace');
    router.refresh();
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error: signErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (signErr) {
      setError(signErr.message);
      return;
    }
    await finishLoginIfNoMfaRequired();
  }

  async function handleMfaSubmit(e: FormEvent) {
    e.preventDefault();
    const code = totpCode.replace(/\s/g, '');
    if (!code) {
      setError('Enter the code from your authenticator app.');
      return;
    }
    setLoading(true);
    setError('');
    const { data: factors, error: lfErr } = await supabase.auth.mfa.listFactors();
    if (lfErr) {
      setError(lfErr.message);
      setLoading(false);
      return;
    }
    const totpFactor = factors.totp.find((f) => f.status === 'verified');
    if (!totpFactor) {
      setError('No verified authenticator on this account.');
      setLoading(false);
      return;
    }
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
    if (chErr || !challenge) {
      setError(chErr?.message ?? 'MFA challenge failed');
      setLoading(false);
      return;
    }
    const { error: verErr } = await supabase.auth.mfa.verify({
      factorId: totpFactor.id,
      challengeId: challenge.id,
      code,
    });
    setLoading(false);
    if (verErr) {
      setError(verErr.message);
      return;
    }
    router.replace('/workspace');
    router.refresh();
  }

  async function cancelMfaAndSignOut() {
    setTotpCode('');
    setError('');
    await supabase.auth.signOut();
    setPhase('password');
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace' }}>
      <div style={{ textAlign: 'center', width: '100%', padding: '1rem' }}>
        <div style={{ color: '#fff', fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>KarlOps</div>
        <div style={{ color: '#555', fontSize: '0.75rem', marginBottom: '1.5rem' }}>Chaos, polished.</div>
        {resetOk && (
          <div style={{ color: '#4ade80', fontSize: '0.75rem', marginBottom: '1rem', maxWidth: '320px', marginLeft: 'auto', marginRight: 'auto' }}>
            Password updated. Sign in with your new password.
          </div>
        )}
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem', maxWidth: '320px', marginLeft: 'auto', marginRight: 'auto' }}>{error}</div>}

        {phase === 'password' && (
          <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <input
              type="email"
              name="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              style={inputStyle}
            />
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              style={inputStyle}
            />
            <button type="submit" disabled={loading} style={{ ...btnStyle, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? '…' : 'Sign in'}
            </button>
            <Link
              href="/login/forgot-password"
              style={{ marginTop: '1rem', color: '#666', fontSize: '0.72rem', textDecoration: 'underline' }}
            >
              Forgot password?
            </Link>
          </form>
        )}

        {phase === 'mfa' && (
          <form onSubmit={handleMfaSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <p style={{ color: '#888', fontSize: '0.75rem', maxWidth: '300px', marginBottom: '1rem', lineHeight: 1.5 }}>
              Two-step verification is on for this account. Enter the 6-digit code from your authenticator app.
            </p>
            <input
              type="text"
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              disabled={loading}
              style={inputStyle}
              maxLength={12}
            />
            <button type="submit" disabled={loading} style={{ ...btnStyle, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? '…' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={cancelMfaAndSignOut}
              disabled={loading}
              style={{
                marginTop: '1rem',
                background: 'transparent',
                border: 'none',
                color: '#666',
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                cursor: loading ? 'not-allowed' : 'pointer',
                textDecoration: 'underline',
              }}
            >
              Use a different account
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
