// app/api/ko/command/route.ts
// KarlOps L — Command execution route v0.7.1
// Karl decides everything. Route just executes.

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { routeCommand, OBJECT_TABLE, OBJECT_PK } from '@/lib/ko/commandRouter';
import { captureTask } from '@/lib/ko/commands/captureTask';
import { captureCompletion } from '@/lib/ko/commands/captureCompletion';
import { writeKarlObservation, updateFieldLlmNotes } from '@/lib/ko/buildKarlContext';

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

const BUCKET_LABEL: Record<string, string> = {
  now:      'On Fire',
  soon:     'Up Next',
  realwork: 'Real Work',
  later:    'Later',
  delegate: 'Delegated',
  capture:  'Capture',
};

const BUCKET_PREFIX_MAP: Record<string, string> = {
  N: 'now', S: 'soon', RW: 'realwork', L: 'later', D: 'delegate',
  CP: 'capture', CM: 'completion', MT: 'meeting',
  EX: 'external_reference', TM: 'document_template', CT: 'contact',
};

function parseIdentifier(identifier: string): { prefix: string; index: number } | null {
  const match = identifier.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], index: parseInt(match[2], 10) };
}

async function resolveIdentifier(user_id: string, identifier: string, object_type: string, context_filter?: string | null): Promise<string | null> {
  const db = createSupabaseAdmin();
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;

  const { prefix, index } = parsed;
  const bucketKey = BUCKET_PREFIX_MAP[prefix];

  if (object_type === 'task') {
    if (!bucketKey || !['now', 'soon', 'realwork', 'later', 'delegate', 'capture'].includes(bucketKey)) return null;
    let query = db.from('task').select('task_id')
      .eq('user_id', user_id).eq('bucket_key', bucketKey)
      .eq('is_completed', false).eq('is_archived', false)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    // Match the UI's context filter so identifier positions align with what user sees
    if (context_filter) query = query.eq('context_id', context_filter);
    const { data: tasks } = await query;
    return tasks?.[index - 1]?.task_id ?? null;
  }

  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  if (!table || !pk) return null;
  const { data: rows } = await db.from(table).select(pk).eq('user_id', user_id).order('created_at', { ascending: true });
  return (rows?.[index - 1] as any)?.[pk] ?? null;
}

async function resolveStatusId(user_id: string, label: string): Promise<string | null> {
  const db = createSupabaseAdmin();
  const { data } = await db.from('task_status').select('task_status_id, label').eq('user_id', user_id);
  return data?.find(s => s.label.toLowerCase() === label.toLowerCase())?.task_status_id ?? null;
}

async function executeOperation(user_id: string, object_type: string, record_id: string, op: { field: string; value: string | string[]; tag_op?: 'add' | 'remove' }): Promise<string> {
  const db    = createSupabaseAdmin();
  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  if (!table || !pk) throw new Error(`Unknown object type: ${object_type}`);

  if (op.field === 'tags') {
    const tagName = String(op.value);
    const { data: current } = await db.from(table).select('tags').eq(pk, record_id).single();
    const currentTags: string[] = (current as any)?.tags ?? [];
    const newTags = op.tag_op === 'remove'
      ? currentTags.filter(t => t !== tagName)
      : currentTags.includes(tagName) ? currentTags : [...currentTags, tagName].slice(0, 5);
    const { error } = await db.from(table).update({ tags: newTags }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    // Plain English — no field syntax
    return op.tag_op === 'remove' ? `removed #${tagName}` : `added #${tagName}`;
  }

  if (op.field === 'task_status_id') {
    const statusId = await resolveStatusId(user_id, String(op.value));
    if (!statusId) throw new Error(`Status "${op.value}" not found`);
    const { error } = await db.from(table).update({ task_status_id: statusId }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `status set to ${op.value}`;
  }

  if (op.field === 'bucket_key') {
    const { error } = await db.from(table).update({ [op.field]: op.value }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `moved to ${BUCKET_LABEL[String(op.value)] ?? op.value}`;
  }

  if (op.field === 'notes' && (op as any).mode === 'append') {
    const { data: current } = await db.from(table).select('notes').eq(pk, record_id).single();
    const existing = (current as any)?.notes ?? '';
    const newNotes = existing ? `${existing}\n${op.value}` : String(op.value);
    const { error } = await db.from(table).update({ notes: newNotes }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `notes updated`;
  }

  const { error } = await db.from(table).update({ [op.field]: op.value }).eq(pk, record_id).eq('user_id', user_id);
  if (error) throw new Error(error.message);
  // Generic plain English fallback
  return `${op.field} updated`;
}

// ── Execute a capture_task payload ────────────────────────────────────────────
async function executeCaptureTask(user_id: string, payload: any): Promise<NextResponse> {
  const result = await captureTask(user_id, payload);
  if (!result.success) throw new Error(result.error);

  const bucketLabel = BUCKET_LABEL[result.task?.bucket_key ?? 'capture'] ?? result.task?.bucket_key;
  const tagNote     = result.task?.tags?.length ? ` · ${result.task.tags.map((t: string) => `#${t}`).join(' ')}` : '';

  writeKarlObservation(user_id, `Captured: "${result.task?.title}" → ${bucketLabel}${tagNote}`, 'pattern').catch(() => {});

  return NextResponse.json({
    success: true,
    intent:  'capture_task',
    task:    result.task,
    task_id: result.task_id,
    refresh: true, // FIX: always refresh after capture so bucket view and counts update
    response: `Captured — **${result.task?.title}** → ${bucketLabel}${tagNote}.`,
    offer_preview: true,
  });
}

// ── Execute capture_tasks payload ─────────────────────────────────────────────
async function executeCaptureTasksBulk(user_id: string, tasks: any[]): Promise<NextResponse> {
  const results = await Promise.all(tasks.map(t => captureTask(user_id, typeof t === 'string' ? { title: t } : t)));
  const failed  = results.filter(r => !r.success);
  const success = results.filter(r => r.success);
  if (success.length === 0) throw new Error('All captures failed');

  writeKarlObservation(user_id, `Bulk captured ${success.length} tasks`, 'pattern').catch(() => {});

  return NextResponse.json({
    success:  true,
    intent:   'capture_tasks',
    tasks:    success.map(r => r.task),
    task_ids: success.map(r => r.task_id),
    refresh:  true,
    response: failed.length > 0
      ? `Captured ${success.length} tasks. ${failed.length} failed.`
      : `Captured ${success.length} task${success.length > 1 ? 's' : ''}.`,
  });
}

// ── Execute update_object payload ─────────────────────────────────────────────
async function executeUpdateObject(user_id: string, payload: any, context_filter?: string | null): Promise<NextResponse> {
  const { object_type, identifier, operations } = payload;
  const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
  if (!record_id) {
    return NextResponse.json({ success: false, response: `Couldn't find ${identifier} — it may have moved. Try refreshing.` });
  }

  // complete_task special case
  const isComplete = operations.some((op: any) => op.field === 'is_completed' && op.value === 'true');
  if (isComplete && object_type === 'task') {
    const db = createSupabaseAdmin();
    const { data: task } = await db.from('task').select('title').eq('task_id', record_id).eq('user_id', user_id).single();
    if (!task) throw new Error(`Task ${identifier} not found`);

    await db.from('task').update({ is_completed: true }).eq('task_id', record_id).eq('user_id', user_id);
    const outcomeOp = operations.find((op: any) => op.field === 'outcome');
    await captureCompletion(user_id, { title: task.title, outcome: outcomeOp?.value ?? '' });
    writeKarlObservation(user_id, `Completed task via chat: "${task.title}" (${identifier})`, 'pattern').catch(() => {});

    return NextResponse.json({
      success: true,
      intent: 'update_object',
      refresh: true,
      response: `Marked **${task.title}** complete and logged.`,
    });
  }

  const descriptions: string[] = [];
  for (const op of operations) {
    const desc = await executeOperation(user_id, object_type, record_id, op);
    descriptions.push(desc);
  }

  writeKarlObservation(user_id, `Updated ${object_type} ${identifier}: ${descriptions.join(', ')}`, 'pattern').catch(() => {});

  return NextResponse.json({
    success: true,
    intent: 'update_object',
    refresh: true,
    response: `Done — ${descriptions.join(', ')}.`,
  });
}

// ── Execute process_document payload ──────────────────────────────────────────
async function executeProcessDocument(user_id: string, payload: any, context_filter?: string | null): Promise<NextResponse> {
  const db = createSupabaseAdmin();
  const results: string[] = [];
  const capturedTasks: any[] = [];

  if (payload.doc_action === 'complete_meeting' && payload.target_identifier) {
    const meeting_id = await resolveIdentifier(user_id, payload.target_identifier, 'meeting', context_filter);
    if (meeting_id && payload.summary) {
      await db.from('meeting').update({ notes: payload.summary, is_completed: true }).eq('meeting_id', meeting_id).eq('user_id', user_id);
      results.push(`Meeting ${payload.target_identifier} completed`);
    }
  }

  if (payload.extracted_tasks?.length) {
    for (const t of payload.extracted_tasks) {
      const result = await captureTask(user_id, { title: t.title, bucket_key: t.bucket_key ?? 'capture', tags: t.tags ?? [], notes: t.notes ?? null });
      if (result.success) capturedTasks.push(result.task);
    }
    if (capturedTasks.length) results.push(`${capturedTasks.length} task${capturedTasks.length > 1 ? 's' : ''} captured`);
  }

  if (payload.field_learning?.object_type && payload.field_learning?.field && payload.field_learning?.llm_notes) {
    updateFieldLlmNotes(user_id, payload.field_learning.object_type, payload.field_learning.field, payload.field_learning.llm_notes).catch(() => {});
  }

  writeKarlObservation(user_id, `Processed document: action=${payload.doc_action}, tasks=${capturedTasks.length}`, 'pattern').catch(() => {});

  return NextResponse.json({
    success: true,
    intent:  'process_document',
    tasks:   capturedTasks,
    response: results.length ? results.join('. ') + '.' : 'Document processed.',
    refresh:  capturedTasks.length > 0 || payload.doc_action === 'complete_meeting',
  });
}

// ── Main POST handler ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { input, pending, context_filter } = body;

  if (!input) return NextResponse.json({ error: 'No input provided' }, { status: 400 });

  try {
    const result = await routeCommand(user.id, input, pending ?? null);

    // ── Karl says execute immediately (quick capture) ──────────────────────
    if (result.intent === 'execute') {
      const p = result.payload!;
      if (p.action === 'capture_task') {
        return await executeCaptureTask(user.id, p);
      }
    }

    // ── Karl says confirm the pending action ───────────────────────────────
    if (result.intent === 'confirm_pending' && pending) {
      const action = pending.action ?? pending.intent;

      if (action === 'capture_task') return await executeCaptureTask(user.id, pending);

      if (action === 'capture_tasks') {
        const tasks = pending.tasks ?? pending.payload?.tasks ?? [];
        return await executeCaptureTasksBulk(user.id, tasks);
      }

      if (action === 'capture_completion') {
        const compResult = await captureCompletion(user.id, { title: pending.title ?? pending.payload?.title, outcome: pending.outcome ?? pending.payload?.outcome ?? '' });
        if (!compResult.success) throw new Error(compResult.error);
        writeKarlObservation(user.id, `Logged completion: "${compResult.completion?.title}"`, 'pattern').catch(() => {});
        return NextResponse.json({
          success: true,
          intent: 'capture_completion',
          completion: compResult.completion,
          refresh: true,
          response: `Logged — **${compResult.completion?.title}**.`,
        });
      }

      if (action === 'update_object') return await executeUpdateObject(user.id, pending, context_filter);

      if (action === 'process_document') return await executeProcessDocument(user.id, pending, context_filter);
    }

    // ── Karl says cancel ───────────────────────────────────────────────────
    if (result.intent === 'cancel_pending') {
      return NextResponse.json({ success: true, intent: 'cancel_pending', response: result.response ?? 'Cancelled.' });
    }

    // ── All other intents — return Karl's response, workspace handles state ─
    return NextResponse.json({ success: true, ...result });

  } catch (err: any) {
    console.error('[POST /api/ko/command]', err);
    return NextResponse.json({ error: err.message ?? 'Command failed' }, { status: 500 });
  }
}