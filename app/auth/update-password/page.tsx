'use client';

/**
 * Password reset completion. Linked from email; `redirectTo` must be allow-listed in Supabase
 * (e.g. https://app.karlops.com/auth/update-password).
 *
 * Supports PKCE (?code= from email) and legacy hash recovery sessions.
 */

import { useEffect, useState, FormEvent } from 'react';
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

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;

    (async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');

      if (code) {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        window.history.replaceState({}, '', '/auth/update-password');
        if (exErr) {
          setError(exErr.message);
          setChecked(true);
          return;
        }
        setRecovery(true);
        setChecked(true);
        return;
      }

      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      });
      subscription = data.subscription;

      const hash = window.location.hash;
      if (hash.includes('type=recovery')) setRecovery(true);

      await new Promise((r) => setTimeout(r, 200));
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user && hash.includes('access_token')) setRecovery(true);

      setChecked(true);
    })();

    return () => subscription?.unsubscribe();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { error: upErr } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await supabase.auth.signOut();
    router.replace('/login?reset=success');
    router.refresh();
  }

  if (!checked) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#888', fontFamily: 'monospace', fontSize: '0.85rem' }}>
        …
      </div>
    );
  }

  if (error && !recovery) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace', padding: '1rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '380px' }}>
          <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</p>
          <Link href="/login/forgot-password" style={{ color: '#fbbf24', fontSize: '0.85rem' }}>Request a new link</Link>
          <span style={{ color: '#444', margin: '0 0.5rem' }}>|</span>
          <Link href="/login" style={{ color: '#666', fontSize: '0.85rem' }}>Sign in</Link>
        </div>
      </div>
    );
  }

  if (!recovery) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace', padding: '1rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '380px' }}>
          <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>This reset link is invalid or expired.</p>
          <p style={{ color: '#888', fontSize: '0.75rem', marginBottom: '1rem' }}>Request a new one from the login page.</p>
          <Link href="/login/forgot-password" style={{ color: '#fbbf24', fontSize: '0.85rem' }}>Forgot password</Link>
          <span style={{ color: '#444', margin: '0 0.5rem' }}>|</span>
          <Link href="/login" style={{ color: '#666', fontSize: '0.85rem' }}>Sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace' }}>
      <div style={{ textAlign: 'center', width: '100%', padding: '1rem' }}>
        <div style={{ color: '#fff', fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Set new password</div>
        <p style={{ color: '#888', fontSize: '0.75rem', maxWidth: '320px', margin: '0 auto 1rem', lineHeight: 1.5 }}>
          Choose a password you can remember (or store in a password manager). You will sign in again after saving.
        </p>
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem' }}>{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            disabled={loading}
            style={inputStyle}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            required
            minLength={8}
            disabled={loading}
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              background: '#1a1a1a',
              border: '1px solid #333',
              color: '#e5e5e5',
              padding: '0.75rem 1.5rem',
              borderRadius: '6px',
              fontSize: '0.85rem',
              fontFamily: 'monospace',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '…' : 'Save password'}
          </button>
        </form>
        <Link href="/login" style={{ display: 'inline-block', marginTop: '1.25rem', color: '#666', fontSize: '0.75rem' }}>Cancel</Link>
      </div>
    </div>
  );
}
