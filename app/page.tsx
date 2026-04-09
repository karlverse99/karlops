'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function Home() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#666', fontFamily: 'monospace' }}>
        Loading...
      </div>
    );
  }

  if (!user) {
    window.location.href = '/login';
    return null;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', fontFamily: 'monospace', padding: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ color: '#fff', margin: 0, fontSize: '1.5rem' }}>KarlOps</h1>
          <p style={{ color: '#666', margin: '0.25rem 0 0', fontSize: '0.8rem' }}>Chaos, polished.</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ color: '#666', margin: '0 0 0.5rem', fontSize: '0.8rem' }}>{user.email}</p>
          <button
            onClick={handleLogout}
            style={{ background: 'transparent', border: '1px solid #333', color: '#666', padding: '0.4rem 0.75rem', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.8rem' }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div style={{ color: '#4ade80', fontSize: '0.9rem' }}>
        ✓ Authenticated — workspace coming soon.
      </div>
    </div>
  );
}
