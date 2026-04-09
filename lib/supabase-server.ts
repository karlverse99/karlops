import { createClient } from '@supabase/supabase-js';

// Server-side only — uses secret key, never expose to client
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;

  if (!url || !key) {
    throw new Error('Missing Supabase server environment variables');
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
