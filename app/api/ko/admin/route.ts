// app/api/ko/admin/route.ts
// KarlOps L — Admin API
// User-owned tables: filtered by user_id
// System tables (concept_registry): filtered by implementation_type, read-only

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

// User-owned tables — all operations, filtered by user_id
const USER_TABLES = [
  'tag', 'tag_group', 'task_status', 'ko_default_registry',
  'ko_field_metadata', 'ko_list_view_config', 'context',
  'user_situation',
];

// System tables — read-only, filtered by implementation_type
const SYSTEM_TABLES = [
  'concept_registry',
];

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

async function getUserImplementationType(userId: string): Promise<string> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('ko_user')
    .select('implementation_type')
    .eq('id', userId)
    .single();
  return data?.implementation_type ?? 'personal';
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const table = searchParams.get('table');

  if (!table) return NextResponse.json({ error: 'Invalid table' }, { status: 400 });

  const db = createSupabaseAdmin();

  // ── System table — filter by implementation_type ───────────────────────────
  if (SYSTEM_TABLES.includes(table)) {
    const implType = await getUserImplementationType(user.id);
    const { data, error } = await (db as any)
      .from(table)
      .select('*')
      .eq('implementation_type', implType)
      .order('display_order', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data });
  }

  // ── User-owned table — filter by user_id ──────────────────────────────────
  if (!USER_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const { data, error } = await (db as any)
    .from(table)
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { table, record } = body;

  // System tables are read-only
  if (SYSTEM_TABLES.includes(table)) {
    return NextResponse.json({ error: 'System table is read-only' }, { status: 403 });
  }

  if (!table || !USER_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await (db as any)
    .from(table)
    .insert({ ...record, user_id: user.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { table, id_field, id_value, updates } = body;

  // System tables are read-only
  if (SYSTEM_TABLES.includes(table)) {
    return NextResponse.json({ error: 'System table is read-only' }, { status: 403 });
  }

  if (!table || !USER_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await (db as any)
    .from(table)
    .update(updates)
    .eq(id_field, id_value)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { table, id_field, id_value } = body;

  // System tables are read-only
  if (SYSTEM_TABLES.includes(table)) {
    return NextResponse.json({ error: 'System table is read-only' }, { status: 403 });
  }

  if (!table || !USER_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { error } = await (db as any)
    .from(table)
    .delete()
    .eq(id_field, id_value)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}