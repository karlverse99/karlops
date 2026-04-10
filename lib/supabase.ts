// lib/supabase-server.ts
// Server-side Supabase client — uses service role key.
// NEVER import this in client components.
// Only use in API routes and server-side functions.

import { createClient } from '@supabase/supabase-js';

export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}