import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { buildTaskStatusMarkdown } from '@/lib/ko/taskStatusMarkdown';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.replace('Bearer ', '');
    const db = createSupabaseAdmin();
    const { data: { user }, error: authErr } = await db.auth.getUser(token);
    if (authErr || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    let to = typeof body.to === 'string' ? body.to.trim() : '';
    const titleFromClient = typeof body.title === 'string' ? body.title : undefined;
    const notesFromClient = typeof body.notes === 'string' ? body.notes : undefined;
    if (!taskId) {
      return NextResponse.json({ error: 'taskId required' }, { status: 400 });
    }
    if (!to) to = user.email ?? '';
    if (!to || !EMAIL_RE.test(to)) {
      return NextResponse.json({ error: 'Valid recipient email required' }, { status: 400 });
    }

    const { data: task, error: taskErr } = await db
      .from('task')
      .select('title, notes, user_id')
      .eq('task_id', taskId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (taskErr || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const resendKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.RESEND_FROM?.trim() || 'KarlOps <auth@karlops.com>';
    if (!resendKey) {
      return NextResponse.json(
        { error: 'Email is not configured (RESEND_API_KEY missing on server).' },
        { status: 503 },
      );
    }

    const title =
      titleFromClient !== undefined
        ? titleFromClient.trim() || 'Task'
        : String(task.title ?? '').trim() || 'Task';
    const notes = notesFromClient !== undefined ? notesFromClient : task.notes;
    const md = buildTaskStatusMarkdown(title, notes);
    const subject = `KarlOps status — ${title.slice(0, 120)}`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: md,
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[task-email] Resend error', res.status, payload);
      return NextResponse.json(
        { error: typeof payload.message === 'string' ? payload.message : 'Send failed' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, id: payload.id });
  } catch (e: unknown) {
    console.error('[POST /api/ko/task-email]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
