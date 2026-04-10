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

// POST — classify and route input
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { input, confirm, pending } = body;

  try {
    // ── Confirm a pending action ───────────────────────────────────────────
    if (confirm && pending) {
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
    }

    // ── Classify new input ─────────────────────────────────────────────────
    const result = await routeCommand(user.id, input);
    return NextResponse.json({ success: true, ...result });

  } catch (err: any) {
    console.error('[POST /api/ko/command]', err);
    return NextResponse.json({ error: err.message ?? 'Command failed' }, { status: 500 });
  }
}