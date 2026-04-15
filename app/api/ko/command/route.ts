// app/api/ko/command/route.ts
// KarlOps L — Command execution route

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { routeCommand, OBJECT_TABLE, OBJECT_PK } from '@/lib/ko/commandRouter';
import { captureTask } from '@/lib/ko/commands/captureTask';
import { captureCompletion } from '@/lib/ko/commands/captureCompletion';
import { writeKarlObservation } from '@/lib/ko/buildKarlContext';

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

const BUCKET_LABEL: Record<string, string> = {
  now:      'On Fire (now)',
  soon:     'Up Next (soon)',
  realwork: 'Real Work',
  later:    'Later',
  delegate: 'Delegated',
  capture:  'Capture',
};

// Bucket prefix → DB bucket_key
const BUCKET_PREFIX_MAP: Record<string, string> = {
  N:  'now',
  S:  'soon',
  RW: 'realwork',
  L:  'later',
  D:  'delegate',
  CP: 'capture',
  CM: 'completion',
  MT: 'meeting',
  EX: 'external_reference',
  TM: 'document_template',
  CT: 'contact',
};

// Parse identifier string into { prefix, index }
function parseIdentifier(identifier: string): { prefix: string; index: number } | null {
  const match = identifier.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], index: parseInt(match[2], 10) };
}

// Resolve an identifier like "N3" or "TM1" to a DB record UUID
async function resolveIdentifier(
  user_id: string,
  identifier: string,
  object_type: string
): Promise<string | null> {
  const db = createSupabaseAdmin();
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;

  const { prefix, index } = parsed;
  const bucketKey = BUCKET_PREFIX_MAP[prefix];

  // Tasks — resolve by bucket + sort order
  if (object_type === 'task') {
    if (!bucketKey || !['now', 'soon', 'realwork', 'later', 'delegate', 'capture'].includes(bucketKey)) return null;

    const { data: tasks } = await db
      .from('task')
      .select('task_id')
      .eq('user_id', user_id)
      .eq('bucket_key', bucketKey)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    const task = tasks?.[index - 1];
    return task?.task_id ?? null;
  }

  // All other FC objects — resolve by created_at order
  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  if (!table || !pk) return null;

  const { data: rows } = await db
    .from(table)
    .select(pk)
    .eq('user_id', user_id)
    .order('created_at', { ascending: true });

  const row = rows?.[index - 1];
  return (row as any)?.[pk] ?? null;
}

// Resolve a status label to task_status_id UUID
async function resolveStatusId(user_id: string, label: string): Promise<string | null> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('task_status')
    .select('task_status_id, label')
    .eq('user_id', user_id);

  if (!data) return null;
  const match = data.find(s => s.label.toLowerCase() === label.toLowerCase());
  return match?.task_status_id ?? null;
}

// Execute a single update operation against a record
// Returns a human-readable description of what changed, or throws
async function executeOperation(
  user_id: string,
  object_type: string,
  record_id: string,
  op: { field: string; value: string | string[]; tag_op?: 'add' | 'remove' }
): Promise<string> {
  const db    = createSupabaseAdmin();
  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];

  if (!table || !pk) throw new Error(`Unknown object type: ${object_type}`);

  // ── Tag add/remove ─────────────────────────────────────────────────────
  if (op.field === 'tags') {
    const tagName = String(op.value);

    const { data: current } = await db
      .from(table).select('tags').eq(pk, record_id).single();
    const currentTags: string[] = (current as any)?.tags ?? [];

    let newTags: string[];
    if (op.tag_op === 'remove') {
      newTags = currentTags.filter(t => t !== tagName);
    } else {
      newTags = currentTags.includes(tagName)
        ? currentTags
        : [...currentTags, tagName].slice(0, 5);
    }

    const { error } = await db
      .from(table).update({ tags: newTags }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);

    return op.tag_op === 'remove' ? `removed tag #${tagName}` : `added tag #${tagName}`;
  }

  // ── Status by label ────────────────────────────────────────────────────
  if (op.field === 'task_status_id') {
    const statusId = await resolveStatusId(user_id, String(op.value));
    if (!statusId) throw new Error(`Status "${op.value}" not found`);

    const { error } = await db
      .from(table).update({ task_status_id: statusId }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);

    return `status → ${op.value}`;
  }

  // ── Generic scalar field ───────────────────────────────────────────────
  const { error } = await db
    .from(table).update({ [op.field]: op.value }).eq(pk, record_id).eq('user_id', user_id);
  if (error) throw new Error(error.message);

  return `${op.field} → ${op.value}`;
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { input, confirm, pending } = body;

  try {
    // ── Confirm a pending action ───────────────────────────────────────────
    if (confirm && pending) {

      // ── Single task capture ──────────────────────────────────────────────
      if (pending.intent === 'capture_task') {
        const result = await captureTask(user.id, pending.payload);
        if (!result.success) throw new Error(result.error);

        const bucketLabel = BUCKET_LABEL[result.task?.bucket_key ?? 'capture'] ?? result.task?.bucket_key;
        const tagNote = result.task?.tags?.length ? ` · tags: ${result.task.tags.join(', ')}` : '';

        writeKarlObservation(
          user.id,
          `User captured task: "${result.task?.title}" → ${bucketLabel}${tagNote}`,
          'pattern'
        ).catch(err => console.error('[command/route] observation write failed:', err));

        return NextResponse.json({
          success: true,
          intent: 'capture_task',
          task: result.task,
          response: `Captured — **${result.task?.title}** → ${bucketLabel}${tagNote}.`,
        });
      }

      // ── Bulk task capture ────────────────────────────────────────────────
      if (pending.intent === 'capture_tasks') {
        const taskPayloads = pending.payload.tasks
          ?? (pending.payload.titles ?? []).map((title: string) => ({ title }));

        const results = await Promise.all(
          taskPayloads.map((t: any) => captureTask(user.id, typeof t === 'string' ? { title: t } : t))
        );

        const failed  = results.filter(r => !r.success);
        const success = results.filter(r => r.success);
        if (success.length === 0) throw new Error('All captures failed');

        const capturedTitles = success.map(r => `"${r.task?.title}"`).join(', ');
        writeKarlObservation(
          user.id,
          `User bulk-captured ${success.length} task${success.length > 1 ? 's' : ''}: ${capturedTitles}`,
          'pattern'
        ).catch(err => console.error('[command/route] observation write failed:', err));

        return NextResponse.json({
          success: true,
          intent: 'capture_tasks',
          tasks: success.map(r => r.task),
          response: failed.length > 0
            ? `Captured ${success.length} task${success.length > 1 ? 's' : ''}. ${failed.length} failed.`
            : `Captured ${success.length} task${success.length > 1 ? 's' : ''}.`,
        });
      }

      // ── Standalone completion capture ────────────────────────────────────
      if (pending.intent === 'capture_completion') {
        const result = await captureCompletion(user.id, {
          title:   pending.payload.title,
          outcome: pending.payload.outcome ?? '',
        });
        if (!result.success) throw new Error(result.error);

        writeKarlObservation(
          user.id,
          `User logged completion: "${result.completion?.title}"${pending.payload.outcome ? ` — outcome: "${pending.payload.outcome}"` : ''}`,
          'pattern'
        ).catch(err => console.error('[command/route] observation write failed:', err));

        return NextResponse.json({
          success: true,
          intent: 'capture_completion',
          completion: result.completion,
          response: `Logged — **${result.completion?.title}** is in your evidence record.`,
        });
      }

      // ── update_object ────────────────────────────────────────────────────
      if (pending.intent === 'update_object') {
        const { object_type, identifier, operations } = pending.payload;

        const record_id = await resolveIdentifier(user.id, identifier, object_type);
        if (!record_id) {
          return NextResponse.json({
            success: false,
            response: `Couldn't resolve ${identifier} — it may have moved or been completed. Try refreshing.`,
          });
        }

        // ── complete_task special case ─────────────────────────────────────
        const isComplete = operations.some(
          (op: any) => op.field === 'is_completed' && op.value === 'true'
        );

        if (isComplete && object_type === 'task') {
          const db = createSupabaseAdmin();

          const { data: task } = await db
            .from('task')
            .select('title')
            .eq('task_id', record_id)
            .eq('user_id', user.id)
            .single();

          if (!task) throw new Error(`Task ${identifier} not found`);

          await db.from('task')
            .update({ is_completed: true })
            .eq('task_id', record_id)
            .eq('user_id', user.id);

      const outcomeOp = operations.find((op: any) => op.field === 'outcome');
await captureCompletion(user.id, {
  title:   task.title,
  outcome: outcomeOp?.value ?? '',
});

          writeKarlObservation(
            user.id,
            `User completed task via chat: "${task.title}" (${identifier})`,
            'pattern'
          ).catch(err => console.error('[command/route] observation write failed:', err));

          return NextResponse.json({
            success: true,
            intent: 'update_object',
            response: `Done — **${task.title}** marked complete and logged.`,
            refresh: true,
          });
        }

        // ── Generic field/tag updates ──────────────────────────────────────
        const descriptions: string[] = [];
        for (const op of operations) {
          const desc = await executeOperation(user.id, object_type, record_id, op);
          descriptions.push(desc);
        }

        writeKarlObservation(
          user.id,
          `User updated ${object_type} ${identifier}: ${descriptions.join(', ')}`,
          'pattern'
        ).catch(err => console.error('[command/route] observation write failed:', err));

        return NextResponse.json({
          success: true,
          intent: 'update_object',
          response: `Updated **${identifier}** — ${descriptions.join(', ')}.`,
          refresh: true,
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