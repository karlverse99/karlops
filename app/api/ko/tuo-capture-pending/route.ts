import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from '@/lib/supabase-server';

export const runtime = 'nodejs';

/**
 * How many TUO Capture outbox rows still need attention (new + seen).
 * Requires KarlOps user session. Uses TUO Supabase service role (server env).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.replace('Bearer ', '');
  const db = createSupabaseAdmin();
  const {
    data: { user },
    error: authErr,
  } = await db.auth.getUser(token);
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tuoUrl = process.env.TUO_SUPABASE_URL?.trim();
  const tuoKey =
    process.env.TUO_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.TUO_SUPABASE_SECRET_KEY?.trim();

  const tuoEnvHint = {
    hasUrl: Boolean(process.env.TUO_SUPABASE_URL?.trim()),
    hasKey: Boolean(
      process.env.TUO_SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.TUO_SUPABASE_SECRET_KEY?.trim(),
    ),
  };

  if (!tuoUrl || !tuoKey) {
    return NextResponse.json({
      count: 0,
      totalInTable: null,
      configured: false,
      tuoEnvHint,
    });
  }

  const tuo = createClient(tuoUrl, tuoKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const [pendingRes, allRes] = await Promise.all([
    tuo.from('tuo_capture_outbox').select('*', { count: 'exact', head: true }).in('status', ['new', 'seen']),
    tuo.from('tuo_capture_outbox').select('*', { count: 'exact', head: true }),
  ]);

  if (pendingRes.error) {
    console.error('[tuo-capture-pending]', pendingRes.error.message);
    return NextResponse.json({ count: 0, totalInTable: 0, configured: true, error: 'tuo_query_failed' });
  }

  return NextResponse.json({
    count: pendingRes.count ?? 0,
    totalInTable: allRes.error ? null : (allRes.count ?? 0),
    configured: true,
  });
}
