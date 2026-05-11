import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { createTuoSupabaseAdmin } from '@/lib/tuo-supabase-admin';

export const runtime = 'nodejs';

const ROW_FIELDS = 'id,created_at,submitted_by,input_mode,raw_text,status,notes';

const STATUSES = ['new', 'seen', 'processed'] as const;

async function requireKoUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const token = authHeader.replace('Bearer ', '');
  const db = createSupabaseAdmin();
  const {
    data: { user },
    error,
  } = await db.auth.getUser(token);
  if (error || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { user };
}

/** GET — work-queue rows (new + seen) for KarlOps operator */
export async function GET(req: NextRequest) {
  const auth = await requireKoUser(req);
  if ('error' in auth) return auth.error;

  const tuo = createTuoSupabaseAdmin();
  if (!tuo) {
    return NextResponse.json({ rows: [], configured: false });
  }

  const lim = Math.min(50, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') ?? '40', 10) || 40));

  const { data, error } = await tuo
    .from('tuo_capture_outbox')
    .select(ROW_FIELDS)
    .in('status', ['new', 'seen'])
    .order('created_at', { ascending: false })
    .limit(lim);

  if (error) {
    console.error('[tuo-capture-queue GET]', error.message);
    return NextResponse.json({ error: error.message, rows: [] }, { status: 500 });
  }

  return NextResponse.json({ rows: data ?? [], configured: true });
}

/** PATCH — update status / notes (e.g. mark processed after filing in KO) */
export async function PATCH(req: NextRequest) {
  const auth = await requireKoUser(req);
  if ('error' in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.status === 'string') {
    const s = body.status.trim().toLowerCase();
    if (!STATUSES.includes(s as (typeof STATUSES)[number])) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    patch.status = s;
  }

  if (typeof body.notes === 'string') {
    patch.notes = body.notes.trim() ? body.notes.trim() : null;
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: 'Provide status and/or notes' }, { status: 400 });
  }

  const tuo = createTuoSupabaseAdmin();
  if (!tuo) {
    return NextResponse.json({ error: 'TUO Supabase not configured' }, { status: 503 });
  }

  const { error } = await tuo.from('tuo_capture_outbox').update(patch).eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
