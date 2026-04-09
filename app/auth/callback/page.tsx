'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export default function AuthCallbackPage() {
  useEffect(() => {
    supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        window.location.href = '/';
      }
    });

    // Also check immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        window.location.href = '/';
      } else {
        // Give it a moment for hash to be processed
        setTimeout(async () => {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            window.location.href = '/';
          } else {
            window.location.href = '/login';
          }
        }, 1000);
      }
    });
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0a',
      color: '#666',
      fontFamily: 'monospace',
    }}>
      Signing you in...
    </div>
  );
}
