  import { NextRequest, NextResponse } from 'next/server';
  import { createServerClient } from '@supabase/ssr';
  import { cookies } from 'next/headers';

  export async function GET(req: NextRequest) {
    const { searchParams, origin } = new URL(req.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/workspace';

    if (code) {
      const cookieStore = cookies();
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

      const { error } = await supabase.auth.exchangeCodeForSession(code);
if (!error) {
  return NextResponse.redirect(`${origin}/`);
}
      console.error('[auth/callback] exchangeCodeForSession error:', error);
    }

    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }