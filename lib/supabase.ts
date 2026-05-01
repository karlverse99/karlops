// lib/supabase.ts
// Client-side Supabase client — uses anon key.
// Safe to import in client components.

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Non-empty placeholders so `next build` can prerender when env files are absent locally.
// Set NEXT_PUBLIC_SUPABASE_* in .env / Vercel for real usage.
export const supabase = createClient(
  url?.trim() || 'https://build-placeholder.supabase.co',
  anon?.trim() || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.build-placeholder',
);