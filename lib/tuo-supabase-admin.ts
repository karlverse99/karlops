import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Server-only: TUO Supabase project (Capture outbox). Returns null if env missing. */
export function createTuoSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.TUO_SUPABASE_URL?.trim();
  const key =
    process.env.TUO_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.TUO_SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
