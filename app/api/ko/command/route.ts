// app/api/ko/command/route.ts
// KarlOps L — Command execution route v0.8.0
// Generic executor. Karl decides. Route executes. No hardcoded action maps.

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { routeCommand, OBJECT_TABLE, OBJECT_PK, KarlAction } from '@/lib/ko/commandRouter';
import { captureTask } from '@/lib/ko/commands/captureTask';
import { captureCompletion } from '@/lib/ko/commands/captureCompletion';
import { writeKarlObservation } from '@/lib/ko/buildKarlContext';

// ─── ERROR HANDLING ──────────────────────────────────────────────────────────

// Knowledge failures — DB constraint/validation errors Karl can learn from
const KNOWLEDGE_FAILURE_PATTERNS = [
  'null value in column',
  'violates not-null constraint',
  'violates foreign key constraint',
  'violates unique constraint',
  'violates check constraint',
  'invalid input syntax',
  'not found',
  'does not exist',
];

function isKnowledgeFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return KNOWLEDGE_FAILURE_PATTERNS.some(p => lower.includes(p));
}

// Log to ko_error_log — always async, never blocks response
async function logError(
  user_id: string,
  route: string,
  action: string,
  error_type: 'knowledge' | 'system',
  message: string,
  payload?: Record<string, any>
): Promise<void> {
  try {
    const db = createSupabaseAdmin();
    await db.from('ko_error_log').insert({
      user_id,
      route,
      action,
      error_type,
      message,
      payload: payload ?? null,
      resolved: false,
    });
  } catch {
    // Never let logging break the response
  }
}

// Karl feedback call — called when a knowledge failure occurs
// Karl reasons about what went wrong and returns a learning block
async function karlLearnFromFailure(
  user_id: string,
  action: KarlAction,
  errorMessage: string
): Promise<void> {
  try {
    const systemPrompt = `You are Karl, an AI assistant for KarlOps. An action you proposed just failed with a DB error.
Reason about what went wrong and what you should remember to avoid this next time.
Return ONLY valid JSON — no markdown, no code fences:
{
  "field_notes": { "object_type": "...", "field": "...", "llm_notes": "one sentence about what you learned" },
  "observation": { "content": "...", "observation_type": "flag" }
}
If you cannot determine a specific field lesson, return only the observation block.`;

    const userMessage = `Action attempted: ${JSON.stringify(action, null, 2)}
DB error: ${errorMessage}
What did you learn?`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    const db = createSupabaseAdmin();

    if (parsed.field_notes?.object_type && parsed.field_notes?.field && parsed.field_notes?.llm_notes) {
      await db.from('ko_field_metadata')
        .update({ llm_notes: parsed.field_notes.llm_notes })
        .eq('user_id', user_id)
        .eq('object_type', parsed.field_notes.object_type)
        .eq('field', parsed.field_notes.field);
      console.log('[karlLearnFromFailure] field_notes written:', parsed.field_notes);
    }

    if (parsed.observation?.content) {
      const { writeKarlObservation } = await import('@/lib/ko/buildKarlContext');
      await writeKarlObservation(user_id, parsed.observation.content, 'flag');
      console.log('[karlLearnFromFailure] observation written:', parsed.observation.content);
    }

  } catch (err) {
    console.error('[karlLearnFromFailure] failed:', err);
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BUCKET_LABEL: Record<string, string> = {
  now: 'On Fire', soon: 'Up Next', realwork: 'Real Work',
  later: 'Later', delegate: 'Delegated', capture: 'Capture',
};

const BUCKET_PREFIX_MAP: Record<string, string> = {
  N: 'now', S: 'soon', RW: 'realwork', L: 'later', D: 'delegate',
  CP: 'capture', CM: 'completion', MT: 'meeting',
  EX: 'external_reference', TM: 'document_template', CT: 'contact',
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SUPPORTED_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const EXT_FALLBACK: Record<string, string> = {
  '.pdf':  'application/pdf',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ─── FILE EXTRACTION ──────────────────────────────────────────────────────────

async function extractTextFromFile(base64: string, mimeType: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  if (mimeType === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text?.trim() ?? '';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() ?? '';
  }
  return buffer.toString('utf-8').trim();
}

function resolveFileType(name: string, type: string): string {
  if (SUPPORTED_TYPES[type]) return type;
  const ext = '.' + (name.split('.').pop()?.toLowerCase() ?? '');
  return EXT_FALLBACK[ext] ?? type;
}

// ─── IDENTIFIER RESOLUTION ────────────────────────────────────────────────────

function parseIdentifier(identifier: string): { prefix: string; index: number } | null {
  const match = identifier.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], index: parseInt(match[2], 10) };
}

async function resolveIdentifier(
  user_id: string,
  identifier: string,
  object_type: string,
  context_filter?: string | null
): Promise<string | null> {
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
    if (context_filter) query = query.eq('context_id', context_filter);
    const { data } = await query;
    return data?.[index - 1]?.task_id ?? null;
  }

  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  if (!table || !pk) return null;
  const { data } = await db.from(table).select(pk).eq('user_id', user_id).order('created_at', { ascending: true });
  return (data?.[index - 1] as any)?.[pk] ?? null;
}

async function resolveStatusId(user_id: string, label: string): Promise<string | null> {
  const db = createSupabaseAdmin();
  const { data } = await db.from('task_status').select('task_status_id, label').eq('user_id', user_id);
  // Normalize underscores to spaces — Karl sometimes sends "not_started" instead of "Not Started"
  const normalized = label.replace(/_/g, ' ').toLowerCase();
  return data?.find(s => s.label.toLowerCase() === normalized)?.task_status_id ?? null;
}

async function resolveContextId(user_id: string, contextName: string | null | undefined): Promise<string | null> {
  if (!contextName) return null;
  const db = createSupabaseAdmin();
  const { data } = await db.from('context').select('context_id').eq('user_id', user_id).ilike('name', contextName).single();
  return data?.context_id ?? null;
}

async function resolvePeopleTagId(user_id: string, nameOrId: string): Promise<string | null> {
  if (!nameOrId) return null;
  // Already a UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) return nameOrId;
  // Resolve by name
  const db = createSupabaseAdmin();
  const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
  if (!peopleGroup) return null;
  const hint = nameOrId.toLowerCase().trim();
  const { data: tags } = await db.from('tag').select('tag_id, name').eq('user_id', user_id).eq('tag_group_id', peopleGroup.tag_group_id).eq('is_archived', false);
  const match = (tags ?? []).find(t =>
    t.name === nameOrId ||
    t.name.toLowerCase() === hint ||
    t.name.toLowerCase().includes(hint)
  );
  if (match) return match.tag_id;
  // Create it
  const { data: newTag } = await db.from('tag').insert({ user_id, tag_group_id: peopleGroup.tag_group_id, name: nameOrId.trim(), is_archived: false }).select('tag_id').single();
  return newTag?.tag_id ?? null;
}

// ─── GENERIC FIELD OPERATION ──────────────────────────────────────────────────

async function applyFieldOperation(
  user_id: string,
  object_type: string,
  record_id: string,
  op: { field: string; value: any; mode?: string }
): Promise<string> {
  const db    = createSupabaseAdmin();
  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  if (!table || !pk) throw new Error(`Unknown object type: ${object_type}`);

  // Tags — add/remove
  // Handles: op.mode ('remove'/'add') AND legacy op.tag_op ('remove'/'add')
  // Splits comma-separated values. Validates against tag table before adding.
  if (op.field === 'tags') {
    const isRemove = op.mode === 'remove' || (op as any).tag_op === 'remove';
    const tagNames = String(op.value).split(',').map((t: string) => t.trim()).filter(Boolean);
    const { data: current } = await db.from(table).select('tags').eq(pk, record_id).single();
    let currentTags: string[] = (current as any)?.tags ?? [];
    if (isRemove) {
      currentTags = currentTags.filter(t => !tagNames.includes(t));
    } else {
      // Validate tag names exist in tag table before adding — GIGO
      const { data: validTagRows } = await db.from('tag')
        .select('name')
        .eq('user_id', user_id)
        .in('name', tagNames)
        .eq('is_archived', false);
      const validNames = new Set((validTagRows ?? []).map((t: any) => t.name));
      const invalid = tagNames.filter(t => !validNames.has(t));
      if (invalid.length) {
        console.warn(`[applyFieldOperation] rejected invalid tags: ${invalid.join(', ')}`);
      }
      for (const tagName of tagNames) {
        if (validNames.has(tagName) && !currentTags.includes(tagName)) currentTags.push(tagName);
      }
      currentTags = currentTags.slice(0, 5);
    }
    const { error } = await db.from(table).update({ tags: currentTags }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return isRemove
      ? `removed ${tagNames.map(t => `#${t}`).join(', ')}`
      : `added ${tagNames.filter(t => currentTags.includes(t)).map(t => `#${t}`).join(', ')}`;
  }

  // Status label → id
  if (op.field === 'task_status_id') {
    const statusId = await resolveStatusId(user_id, String(op.value));
    if (!statusId) throw new Error(`Status "${op.value}" not found`);
    const { error } = await db.from(table).update({ task_status_id: statusId }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `status set to ${op.value}`;
  }

  // Delegated_to — resolve name to uuid
  if (op.field === 'delegated_to') {
    const tagId = await resolvePeopleTagId(user_id, String(op.value));
    const { error } = await db.from(table).update({ delegated_to: tagId }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `delegated to ${op.value}`;
  }

  // Notes — append or set
  // Handles op.mode === 'append' AND legacy "append:text" value prefix from old Karl shape
  if (op.field === 'notes') {
    const rawValue = String(op.value);
    const isAppend = op.mode === 'append' || rawValue.toLowerCase().startsWith('append:');
    const noteValue = rawValue.replace(/^append:/i, '').trim();
    if (isAppend) {
      const { data: current } = await db.from(table).select('notes').eq(pk, record_id).single();
      const existing = (current as any)?.notes ?? '';
      const newNotes = existing ? `${existing}\n${noteValue}` : noteValue;
      const { error } = await db.from(table).update({ notes: newNotes }).eq(pk, record_id).eq('user_id', user_id);
      if (error) throw new Error(error.message);
      return `notes updated`;
    }
    const { error } = await db.from(table).update({ notes: noteValue }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `notes updated`;
  }

  // Bucket label → key
  if (op.field === 'bucket_key') {
    const { error } = await db.from(table).update({ bucket_key: op.value }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `moved to ${BUCKET_LABEL[String(op.value)] ?? op.value}`;
  }

  // Generic set
  const { error } = await db.from(table).update({ [op.field]: op.value }).eq(pk, record_id).eq('user_id', user_id);
  if (error) throw new Error(error.message);
  return `${op.field} updated`;
}

// ─── ACTION EXECUTORS ─────────────────────────────────────────────────────────

// insert — generic for any FC object
async function executeInsert(user_id: string, action: KarlAction, context_filter?: string | null): Promise<{ response: string; refresh: boolean; task_id?: string; offer_preview?: boolean }> {
  const db          = createSupabaseAdmin();
  const object_type = action.object_type ?? 'task';
  const fields      = { ...(action.fields ?? {}) };
  const table       = OBJECT_TABLE[object_type];
  const pk          = OBJECT_PK[object_type];

  if (!table) throw new Error(`Unknown object type: ${object_type}`);

  // Resolve context_name → context_id
  if (fields.context_name && !fields.context_id) {
    fields.context_id = await resolveContextId(user_id, fields.context_name);
    delete fields.context_name;
  }

  // Resolve delegated_to name → uuid (defensive — should already be uuid from enrichActions)
  if (fields.delegated_to && typeof fields.delegated_to === 'string') {
    fields.delegated_to = await resolvePeopleTagId(user_id, fields.delegated_to);
  }

  // Task — use captureTask for defaults + observation
  if (object_type === 'task') {
    const result = await captureTask(user_id, fields as any);
    if (!result.success) throw new Error(result.error);
    const bucketLabel = BUCKET_LABEL[result.task?.bucket_key ?? 'capture'] ?? result.task?.bucket_key;
    const tagNote     = result.task?.tags?.length ? ` · ${result.task.tags.map((t: string) => `#${t}`).join(' ')}` : '';
    writeKarlObservation(user_id, `Captured: "${result.task?.title}" → ${bucketLabel}${tagNote}`, 'pattern').catch(() => {});
    return {
      response: `Captured — **${result.task?.title}** → ${bucketLabel}${tagNote}.`,
      refresh: true,
      task_id: result.task_id,
      offer_preview: true,
    };
  }

  // Contact — auto-create People tag
  if (object_type === 'contact') {
    const { data: contact, error: contactError } = await db.from('contact').insert({ user_id, ...fields }).select().single();
    if (contactError) throw new Error(contactError.message);

    // Auto-create People tag
    const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
    if (peopleGroup && fields.name) {
      const { data: newTag } = await db.from('tag').insert({
        user_id, tag_group_id: peopleGroup.tag_group_id, name: fields.name.trim(), is_archived: false,
      }).select('tag_id').single();
      if (newTag) {
        await db.from('contact').update({ tag_id: newTag.tag_id }).eq('contact_id', contact.contact_id);
      }
    }

    writeKarlObservation(user_id, `Created contact: "${fields.name}"`, 'pattern').catch(() => {});
    return { response: `Contact **${fields.name}** added.`, refresh: true };
  }

  // Generic insert for meeting, completion, external_reference, document_template
  const { error } = await db.from(table).insert({ user_id, ...fields });
  if (error) throw new Error(error.message);

  writeKarlObservation(user_id, `Created ${object_type}: "${fields.title ?? fields.name ?? '(untitled)'}"`, 'pattern').catch(() => {});

  const label = fields.title ?? fields.name ?? object_type;
  return { response: `**${label}** saved.`, refresh: true };
}

// capture_tasks — bulk task insert
async function executeCaptureTasksBulk(user_id: string, tasks: any[]): Promise<{ response: string; refresh: boolean }> {
  const results = await Promise.all(tasks.map(t => captureTask(user_id, typeof t === 'string' ? { title: t } : t)));
  const failed  = results.filter(r => !r.success);
  const success = results.filter(r => r.success);
  if (success.length === 0) throw new Error('All task captures failed');
  writeKarlObservation(user_id, `Bulk captured ${success.length} tasks`, 'pattern').catch(() => {});
  return {
    response: failed.length > 0
      ? `Captured ${success.length} tasks. ${failed.length} failed.`
      : `Captured ${success.length} task${success.length > 1 ? 's' : ''}.`,
    refresh: true,
  };
}

// update — generic field operations on any FC object
async function executeUpdate(user_id: string, action: KarlAction, context_filter?: string | null): Promise<{ response: string; refresh: boolean }> {
  const object_type = action.object_type ?? 'task';
  const identifier  = action.identifier;
  if (!identifier) throw new Error('update action missing identifier');

  const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
  if (!record_id) {
    return { response: `Couldn't find ${identifier} — it may have moved. Try refreshing.`, refresh: false };
  }

  const descriptions: string[] = [];
  for (const op of action.operations ?? []) {
    descriptions.push(await applyFieldOperation(user_id, object_type, record_id, op));
  }

  writeKarlObservation(user_id, `Updated ${object_type} ${identifier}: ${descriptions.join(', ')}`, 'pattern').catch(() => {});
  return { response: `Done — ${descriptions.join(', ')}.`, refresh: true };
}

// complete — marks done, creates completion record
async function executeComplete(user_id: string, action: KarlAction, context_filter?: string | null): Promise<{ response: string; refresh: boolean }> {
  const db          = createSupabaseAdmin();
  const object_type = action.object_type ?? 'task';
  const identifier  = action.identifier;
  if (!identifier) throw new Error('complete action missing identifier');

  const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
  if (!record_id) {
    return { response: `Couldn't find ${identifier}.`, refresh: false };
  }

  const outcome = action.fields?.outcome ?? '';

  if (object_type === 'task') {
    const { data: task } = await db.from('task').select('title').eq('task_id', record_id).eq('user_id', user_id).single();
    if (!task) throw new Error(`Task ${identifier} not found`);
    await db.from('task').update({ is_completed: true }).eq('task_id', record_id).eq('user_id', user_id);
    await captureCompletion(user_id, { title: task.title, outcome });
    writeKarlObservation(user_id, `Completed task: "${task.title}" (${identifier})`, 'pattern').catch(() => {});
    return { response: `Marked **${task.title}** complete and logged.`, refresh: true };
  }

  if (object_type === 'meeting') {
    const { data: meeting } = await db.from('meeting').select('title').eq('meeting_id', record_id).eq('user_id', user_id).single();
    if (!meeting) throw new Error(`Meeting ${identifier} not found`);
    await db.from('meeting').update({ is_completed: true, outcome, notes: action.fields?.notes ?? undefined }).eq('meeting_id', record_id).eq('user_id', user_id);
    writeKarlObservation(user_id, `Completed meeting: "${meeting.title}" (${identifier})`, 'pattern').catch(() => {});
    return { response: `Meeting **${meeting.title}** marked complete.`, refresh: true };
  }

  throw new Error(`complete not supported for ${object_type}`);
}

// archive — set is_archived = true
async function executeArchive(user_id: string, action: KarlAction, context_filter?: string | null): Promise<{ response: string; refresh: boolean }> {
  const db          = createSupabaseAdmin();
  const object_type = action.object_type ?? 'task';
  const identifier  = action.identifier;
  if (!identifier) throw new Error('archive action missing identifier');

  const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
  if (!record_id) return { response: `Couldn't find ${identifier}.`, refresh: false };

  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  const { error } = await db.from(table).update({ is_archived: true }).eq(pk, record_id).eq('user_id', user_id);
  if (error) throw new Error(error.message);

  writeKarlObservation(user_id, `Archived ${object_type} ${identifier}`, 'pattern').catch(() => {});
  return { response: `${identifier} archived.`, refresh: true };
}

// delete — hard delete
async function executeDelete(user_id: string, action: KarlAction, context_filter?: string | null): Promise<{ response: string; refresh: boolean }> {
  const db          = createSupabaseAdmin();
  const object_type = action.object_type ?? 'task';
  const identifier  = action.identifier;
  if (!identifier) throw new Error('delete action missing identifier');

  const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
  if (!record_id) return { response: `Couldn't find ${identifier}.`, refresh: false };

  const table = OBJECT_TABLE[object_type];
  const pk    = OBJECT_PK[object_type];
  const { error } = await db.from(table).delete().eq(pk, record_id).eq('user_id', user_id);
  if (error) throw new Error(error.message);

  writeKarlObservation(user_id, `Deleted ${object_type} ${identifier}`, 'pattern').catch(() => {});
  return { response: `${identifier} deleted.`, refresh: true };
}

// create_tag — insert tag, optionally associate
async function executeCreateTag(user_id: string, action: KarlAction): Promise<{ response: string; refresh: boolean }> {
  const db     = createSupabaseAdmin();
  const fields = action.fields ?? {};
  const name   = fields.name;
  if (!name) throw new Error('create_tag missing name');

  // Resolve group
  let tag_group_id: string | null = null;
  if (fields.tag_group) {
    const { data: group } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).ilike('name', fields.tag_group).maybeSingle();
    tag_group_id = group?.tag_group_id ?? null;
  }
  if (!tag_group_id) {
    const { data: general } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).ilike('name', 'General').maybeSingle();
    tag_group_id = general?.tag_group_id ?? null;
  }

  const { error } = await db.from('tag').insert({ user_id, tag_group_id, name: name.trim(), description: fields.description ?? null, is_archived: false });
  if (error) throw new Error(error.message);

  writeKarlObservation(user_id, `Created tag: "${name}" in ${fields.tag_group ?? 'General'}`, 'pattern').catch(() => {});
  return { response: `Tag **${name}** created.`, refresh: true };
}

// ─── DISPATCH SINGLE ACTION ───────────────────────────────────────────────────

async function dispatchAction(
  user_id: string,
  action: KarlAction,
  context_filter?: string | null
): Promise<{ response: string; refresh: boolean; task_id?: string; offer_preview?: boolean }> {
  switch (action.action) {
    case 'insert':
      return executeInsert(user_id, action, context_filter);
    case 'capture_tasks':
      return executeCaptureTasksBulk(user_id, action.tasks ?? []);
    case 'update':
      return executeUpdate(user_id, action, context_filter);
    case 'complete':
      return executeComplete(user_id, action, context_filter);
    case 'archive':
      return executeArchive(user_id, action, context_filter);
    case 'delete':
      return executeDelete(user_id, action, context_filter);
    case 'create_tag':
      return executeCreateTag(user_id, action);
    case 'run_template':
      // Stub — preview in chat for now, save as extract coming next
      return { response: 'Template run coming soon.', refresh: false };
    case 'refine':
      // Iterative chat flow — no DB write at dispatch time
      return { response: 'Refine flow active.', refresh: false };
    case 'summarize':
      // Karl already responded in chat — no DB write
      return { response: '', refresh: false };
    default:
      throw new Error(`Unknown action: ${(action as any).action}`);
  }
}

// ─── EXECUTE ACTIONS ARRAY ────────────────────────────────────────────────────

async function executeActions(
  user_id: string,
  actions: KarlAction[],
  context_filter?: string | null
): Promise<NextResponse> {
  const results: Array<{ response: string; refresh: boolean; task_id?: string; offer_preview?: boolean }> = [];
  const errors: string[] = [];

  for (const action of actions) {
    try {
      const result = await dispatchAction(user_id, action, context_filter);
      results.push(result);
    } catch (err: any) {
      const message = err.message ?? 'Unknown error';
      console.error(`[executeActions] ${action.action} ${action.object_type} failed:`, message);

      if (isKnowledgeFailure(message)) {
        // Knowledge failure — Karl learns from it, write warning observation
        logError(user_id, 'command', `${action.action} ${action.object_type ?? ''}`, 'knowledge', message, action as any).catch(() => {});
        karlLearnFromFailure(user_id, action, message).catch(() => {});
        errors.push(`${action.action} ${action.object_type ?? ''}: ${message}`);
      } else {
        // System failure — log only, don't bother Karl
        logError(user_id, 'command', `${action.action} ${action.object_type ?? ''}`, 'system', message, action as any).catch(() => {});
        errors.push(`${action.action} ${action.object_type ?? ''}: something went wrong`);
      }
    }
  }

  const refresh     = results.some(r => r.refresh);
  const task_id     = results.find(r => r.task_id)?.task_id;
  const offerPreview = results.some(r => r.offer_preview) && actions.length === 1;
  const responses   = results.map(r => r.response).filter(Boolean);
  const responseText = errors.length
    ? [...responses, `Errors: ${errors.join(', ')}`].join('\n')
    : responses.join('\n');

  return NextResponse.json({
    success:       errors.length === 0,
    intent:        'executed',
    response:      responseText,
    refresh,
    task_id,
    offer_preview: offerPreview,
  });
}

// ─── BACKWARDS COMPAT — flatten old pending shape to actions[] ────────────────

function flattenLegacyPending(pending: Record<string, any>): KarlAction[] {
  // Already new shape
  if (pending.actions?.length) return pending.actions;

  const flat    = pending.payload ? { ...pending.payload, ...pending } : pending;
  const action  = flat.action ?? flat.intent;
  const tasks   = flat.tasks ?? flat.payload?.tasks ?? [];

  // Bulk tasks
  if (tasks.length > 0) {
    return [{ action: 'capture_tasks', object_type: 'task', modal: 'TaskAddModal', tasks }];
  }

  if (action === 'capture_task' || action === 'insert') {
    return [{
      action: 'insert', object_type: flat.object_type ?? 'task', modal: 'TaskAddModal',
      fields: {
        title: flat.title, bucket_key: flat.bucket_key ?? 'capture',
        context_id: flat.context_id ?? null, tags: flat.tags ?? [],
        notes: flat.notes ?? null, target_date: flat.target_date ?? null,
        delegated_to: flat.delegated_to ?? null,
      },
    }];
  }

  if (action === 'update_object' || action === 'update') {
    return [{
      action: 'update', object_type: flat.object_type, identifier: flat.identifier,
      operations: flat.operations ?? [],
    }];
  }

  if (action === 'capture_completion') {
    return [{
      action: 'insert', object_type: 'completion', modal: 'CompletionsModal',
      fields: { title: flat.title ?? flat.payload?.title, outcome: flat.outcome ?? flat.payload?.outcome ?? '' },
    }];
  }

  if (action === 'complete') {
    return [{
      action: 'complete', object_type: flat.object_type ?? 'task',
      identifier: flat.identifier, fields: { outcome: flat.outcome ?? '' },
    }];
  }

  // Unknown — pass through as-is
  return [flat];
}

// ─── MAIN POST HANDLER ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { input, pending, context_filter, file, files } = body;

  // ── File drop path ─────────────────────────────────────────────────────────
  const fileList: Array<{ name: string; type: string; data: string; size: number }> =
    files ? files : file ? [file] : [];

  if (fileList.length > 0) {
    const extracted: Array<{ name: string; type: string; text: string }> = [];
    const errors: string[] = [];

    for (const f of fileList) {
      if (f.size > MAX_FILE_BYTES) { errors.push(`${f.name} over 5MB`); continue; }
      const resolvedType = resolveFileType(f.name, f.type);
      if (!SUPPORTED_TYPES[resolvedType]) { errors.push(`${f.name} unsupported type`); continue; }
      try {
        const text = await extractTextFromFile(f.data, resolvedType);
        if (!text) { errors.push(`${f.name} had no readable text`); continue; }
        extracted.push({ name: f.name, type: resolvedType, text });
      } catch (err: any) {
        console.error('[command] extraction failed:', f.name, err);
        errors.push(`${f.name} could not be read`);
      }
    }

    if (extracted.length === 0) {
      return NextResponse.json({
        success: true, intent: 'question',
        response: errors.length
          ? `Couldn't read those files: ${errors.join(', ')}.`
          : `I opened the files but couldn't find any readable text.`,
      });
    }

    // Build file content block — Karl reasons from field knowledge, no hardcoded instructions
    const fileBlocks = extracted.map((f, i) =>
      extracted.length > 1
        ? `--- FILE ${i + 1}: ${f.name} ---\n${f.text.length > 8000 ? f.text.slice(0, 8000) + '\n[truncated]' : f.text}`
        : `--- ${f.name} ---\n${f.text.length > 12000 ? f.text.slice(0, 12000) + '\n[truncated]' : f.text}`
    ).join('\n\n');

    const userHint = input?.trim() ?? '';
    const filePrompt = userHint
      ? `User instruction: "${userHint}"\n\nFile content:\n${fileBlocks}`
      : `File dropped without instruction. Ask what the user wants to do.\n\nFile content:\n${fileBlocks}`;

    const result = await routeCommand(user.id, filePrompt, pending ?? null, context_filter ?? null);

    // Observation — what Karl classified
    const classifiedAction = result.actions?.[0]?.action ?? result.intent;
    writeKarlObservation(
      user.id,
      `File drop: user said "${userHint || 'nothing'}", Karl classified as "${classifiedAction}". Files: ${extracted.map(f => f.name).join(', ')}.`,
      'preference'
    ).catch(() => {});

    if (errors.length && result.response) {
      result.response = result.response + `\n\n(Skipped: ${errors.join(', ')})`;
    }

    // If Karl proposed actions, return as pending — don't auto-execute file drops
    return NextResponse.json({
      success:  true,
      intent:   result.intent,
      response: result.response ?? null,
      actions:  result.actions ?? null,
      payload:  null,
    });
  }

  // ── Normal text path ───────────────────────────────────────────────────────
  if (!input) return NextResponse.json({ error: 'No input provided' }, { status: 400 });

  try {
    const result = await routeCommand(user.id, input, pending ?? null, context_filter ?? null);

    // ── execute — no confirm needed ──────────────────────────────────────────
    if (result.intent === 'execute' && result.actions?.length) {
      return executeActions(user.id, result.actions, context_filter);
    }

    // ── confirm pending — execute the actions array ───────────────────────────
    if (result.intent === 'confirm_pending' && pending) {
      const actions = flattenLegacyPending(pending);
      return executeActions(user.id, actions, context_filter);
    }

    // ── cancel ────────────────────────────────────────────────────────────────
    if (result.intent === 'cancel_pending') {
      return NextResponse.json({ success: true, intent: 'cancel_pending', response: result.response ?? 'Cancelled.' });
    }

    // ── everything else — question, pending, preview, open_form, command ──────
    return NextResponse.json({
      success:  true,
      intent:   result.intent,
      response: result.response ?? null,
      actions:  result.actions ?? null,
      payload:  result.payload ?? null,
    });

  } catch (err: any) {
    console.error('[POST /api/ko/command]', err);
    logError(user?.id ?? 'unknown', 'command', 'POST', 'system', err.message ?? 'Unknown error').catch(() => {});
    return NextResponse.json({ error: err.message ?? 'Command failed' }, { status: 500 });
  }
}