'use client';

import { useState, FormEvent } from 'react';
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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${origin}/auth/update-password`,
    });
    setLoading(false);
    if (resetErr) {
      setError(resetErr.message);
      return;
    }
    setSent(true);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace' }}>
      <div style={{ textAlign: 'center', width: '100%', padding: '1rem' }}>
        <div style={{ color: '#fff', fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>KarlOps</div>
        <div style={{ color: '#555', fontSize: '0.75rem', marginBottom: '1.5rem' }}>Reset password</div>

        {sent ? (
          <div style={{ maxWidth: '360px', margin: '0 auto' }}>
            <p style={{ color: '#4ade80', fontSize: '0.85rem', marginBottom: '1rem' }}>
              If an account exists for that email, we sent a reset link. Check inbox and spam.
            </p>
            <p style={{ color: '#666', fontSize: '0.72rem', marginBottom: '1rem' }}>
              The link opens a page where you choose a new password.
            </p>
            <Link href="/login" style={{ color: '#fbbf24', fontSize: '0.85rem' }}>← Back to sign in</Link>
          </div>
        ) : (
          <>
            {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem' }}>{error}</div>}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <input
                type="email"
                autoComplete="email"
                placeholder="Your account email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
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
                {loading ? '…' : 'Send reset link'}
              </button>
            </form>
            <Link href="/login" style={{ display: 'inline-block', marginTop: '1.25rem', color: '#666', fontSize: '0.75rem' }}>← Back to sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
