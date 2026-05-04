'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
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

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(decodeURIComponent(err));
  }, []);

  async function handleSubmit(e: FormEvent) {
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
    router.replace('/workspace');
    router.refresh();
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace' }}>
      <div style={{ textAlign: 'center', width: '100%', padding: '1rem' }}>
        <div style={{ color: '#fff', fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>KarlOps</div>
        <div style={{ color: '#555', fontSize: '0.75rem', marginBottom: '1.5rem' }}>Chaos, polished.</div>
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem', maxWidth: '320px', marginLeft: 'auto', marginRight: 'auto' }}>{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
              marginTop: '0.25rem',
            }}
          >
            {loading ? '…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
