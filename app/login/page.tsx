'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0a',
      fontFamily: 'monospace',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '400px',
        padding: '2rem',
        border: '1px solid #222',
        borderRadius: '8px',
        background: '#111',
      }}>
        <h1 style={{ color: '#fff', marginBottom: '0.25rem', fontSize: '1.5rem' }}>KarlOps</h1>
        <p style={{ color: '#666', marginBottom: '2rem', fontSize: '0.85rem' }}>Chaos, polished.</p>

        {sent ? (
          <div style={{ color: '#4ade80', fontSize: '0.9rem', lineHeight: 1.6 }}>
            ✓ Check your email.<br />
            Click the link to sign in.
          </div>
        ) : (
          <>
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '4px',
                color: '#fff',
                fontSize: '0.9rem',
                marginBottom: '1rem',
                boxSizing: 'border-box',
              }}
            />
            {error && (
              <p style={{ color: '#f87171', fontSize: '0.8rem', marginBottom: '1rem' }}>{error}</p>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !email}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: loading || !email ? '#333' : '#fff',
                color: loading || !email ? '#666' : '#000',
                border: 'none',
                borderRadius: '4px',
                fontSize: '0.9rem',
                cursor: loading || !email ? 'not-allowed' : 'pointer',
                fontFamily: 'monospace',
              }}
            >
              {loading ? 'Sending...' : 'Send magic link'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
