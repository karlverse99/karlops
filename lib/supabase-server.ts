import { createClient } from '@supabase/supabase-js';

/** Service role key — server only. Accepts either name (Vercel often uses SUPABASE_SERVICE_ROLE_KEY). */
function getServiceRoleKey(): string | undefined {
  return (
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    undefined
  );
}

// Server-side only — uses secret key, never expose to client
export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = getServiceRoleKey();

  if (!url || !key) {
    throw new Error(
      'Missing server Supabase env: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
        '(service_role from Supabase → Settings → API) or SUPABASE_SECRET_KEY with the same value.',
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}