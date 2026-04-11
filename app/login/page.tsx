'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
       redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', fontFamily: 'monospace' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#fff', fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>KarlOps</div>
        <div style={{ color: '#555', fontSize: '0.75rem', marginBottom: '2rem' }}>Chaos, polished.</div>
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem' }}>{error}</div>}
        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          style={{ background: '#1a1a1a', border: '1px solid #333', color: '#e5e5e5', padding: '0.75rem 1.5rem', borderRadius: '6px', fontSize: '0.85rem', fontFamily: 'monospace', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? '...' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  );
}