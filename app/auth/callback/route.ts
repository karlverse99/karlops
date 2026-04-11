export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get('code');

  console.log('[callback] hit, code present:', !!code);

  if (!code) {
    console.log('[callback] no code found');
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet: { name: string; value: string; options?: any }[]) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  console.log('[callback] calling exchangeCodeForSession');
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  console.log('[callback] exchange result — error:', error?.message ?? 'none', 'user:', data?.user?.email ?? 'none');

  if (!error) {
    const response = NextResponse.redirect(`${origin}/workspace`);
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return response;
  }

  const response = NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}