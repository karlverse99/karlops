// lib/supabase.ts
// Client-side Supabase client — uses anon key.
// Safe to import in client components.

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);