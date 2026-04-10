import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

const ALLOWED_TABLES = [
  'tag', 'tag_group', 'task_status', 'ko_default_registry',
  'ko_field_metadata', 'ko_list_view_config', 'concept_registry',
];

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const table = searchParams.get('table');
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
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
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
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
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
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
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { error } = await db
    .from(table)
    .delete()
    .eq(id_field, id_value)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}