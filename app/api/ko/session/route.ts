import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { initializeUserWorkspace } from '@/lib/ko/initializeUserWorkspace';

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const db = createSupabaseAdmin();

    const { data: { user }, error: authError } = await db.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const result = await initializeUserWorkspace(
      user.id,
      user.email ?? '',
      user.user_metadata?.full_name ?? user.user_metadata?.name ?? undefined
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Weighted random greeting from karl_greeting
    let greeting: string | null = null;
    try {
      const { data: greetings } = await db
        .from('karl_greeting')
        .select('content, weight')
        .eq('is_active', true);

      if (greetings && greetings.length > 0) {
        // Build weighted pool
        const pool: string[] = [];
        for (const g of greetings) {
          const w = g.weight ?? 1;
          for (let i = 0; i < w; i++) pool.push(g.content);
        }
        greeting = pool[Math.floor(Math.random() * pool.length)];
      }
    } catch (greetErr) {
      console.error('[session] greeting fetch failed (non-fatal):', greetErr);
    }

    return NextResponse.json({
      success: true,
      ko_user_id: result.ko_user_id,
      session_id: result.session_id,
      is_new_user: result.is_new_user,
      greeting,
    });
  } catch (err: any) {
    console.error('[POST /api/ko/session]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}