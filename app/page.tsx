'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export default function Home() {
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      console.log('[root] getSession:', session?.user?.email ?? 'no session');
    });

    supabase.auth.onAuthStateChange((event, session) => {
      console.log('[root] event:', event, 'user:', session?.user?.email ?? 'none');
      if (session?.user) {
        window.location.href = '/workspace';
      } else if (event === 'INITIAL_SESSION') {
        window.location.href = '/login';
      }
    });
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a', color: '#333', fontFamily: 'monospace', fontSize: '0.8rem' }}>
      ...
    </div>
  );
}