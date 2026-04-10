import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { routeCommand } from '@/lib/ko/commandRouter';
import { captureTask } from '@/lib/ko/commands/captureTask';

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { input, confirm, pending } = body;

  try {
    // ── Confirm a pending action ───────────────────────────────────────────
    if (confirm && pending) {

      // Single task capture
      if (pending.intent === 'capture_task') {
        const result = await captureTask(user.id, pending.payload);
        if (!result.success) throw new Error(result.error);
        return NextResponse.json({
          success: true,
          intent: 'capture_task',
          task: result.task,
          response: `Captured — **${result.task?.title}** is in your capture bucket.`,
        });
      }

      // Bulk task capture
      if (pending.intent === 'capture_tasks') {
        const titles: string[] = pending.payload.titles ?? [];
        const results = await Promise.all(
          titles.map(title => captureTask(user.id, { title }))
        );
        const failed  = results.filter(r => !r.success);
        const success = results.filter(r => r.success);

        if (success.length === 0) throw new Error('All captures failed');

        return NextResponse.json({
          success: true,
          intent: 'capture_tasks',
          tasks: success.map(r => r.task),
          response: failed.length > 0
            ? `Captured ${success.length} task${success.length > 1 ? 's' : ''}. ${failed.length} failed.`
            : `Captured ${success.length} task${success.length > 1 ? 's' : ''} into your capture bucket.`,
        });
      }
    }

    // ── Classify new input ─────────────────────────────────────────────────
    const result = await routeCommand(user.id, input);
    return NextResponse.json({ success: true, ...result });

  } catch (err: any) {
    console.error('[POST /api/ko/command]', err);
    return NextResponse.json({ error: err.message ?? 'Command failed' }, { status: 500 });
  }
}