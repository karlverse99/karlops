  // app/api/ko/command/route.ts
  // KarlOps L — Command execution route v1.5.3
  // flattenLegacyPending now handles run_template action correctly.
  // Generation uses claude-haiku (separate rate limit from routing sonnet call).
  // notes and description NEVER included in generation prompts or API payloads.
  // Output stored compressed (gzip) + encrypted (AES-256-GCM) + base64 encoded.

  import { NextRequest, NextResponse } from 'next/server';
  import { createSupabaseAdmin } from '@/lib/supabase-server';
  import { routeCommand, OBJECT_TABLE, OBJECT_PK, KarlAction } from '@/lib/ko/commandRouter';
  import { captureTask } from '@/lib/ko/commands/captureTask';
  import { captureCompletion } from '@/lib/ko/commands/captureCompletion';
  import { writeKarlObservation, buildKarlContext } from '@/lib/ko/buildKarlContext';
  import { encryptOutput } from '@/lib/ko/outputEncryption';
  import { buildKarlContextSplit, formatStaticContextForPrompt, formatDynamicContextForPrompt } from '@/lib/ko/buildKarlContext';

  // ─── ERROR HANDLING ──────────────────────────────────────────────────────────

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
        user_id, route, action, error_type, message,
        payload: payload ?? null, resolved: false,
      });
    } catch { /* never let logging break response */ }
  }

  async function karlLearnFromFailure(user_id: string, action: KarlAction, errorMessage: string): Promise<void> {
    try {
      const systemPrompt = `You are Karl, an AI assistant for KarlOps. An action you proposed just failed with a DB error.
  Reason about what went wrong and what you should remember to avoid this next time.
  Return ONLY valid JSON — no markdown, no code fences:
  {
    "field_notes": { "object_type": "...", "field": "...", "llm_notes": "one sentence about what you learned" },
    "observation": { "content": "...", "observation_type": "flag" }
  }
  If you cannot determine a specific field lesson, return only the observation block.`;

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
          messages: [{ role: 'user', content: `Action attempted: ${JSON.stringify(action, null, 2)}\nDB error: ${errorMessage}\nWhat did you learn?` }],
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
      }
      if (parsed.observation?.content) {
        const { writeKarlObservation } = await import('@/lib/ko/buildKarlContext');
        await writeKarlObservation(user_id, parsed.observation.content, 'flag');
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

  // ─── BUCKET LABEL RESOLUTION ──────────────────────────────────────────────────

  async function resolveBucketLabels(user_id: string): Promise<Record<string, string>> {
    const db = createSupabaseAdmin();
    const { data } = await db
      .from('ko_concept_registry')
      .select('concept_key, label')
      .eq('user_id', user_id)
      .eq('concept_type', 'bucket');
    const map: Record<string, string> = {};
    for (const row of data ?? []) {
      const key = row.concept_key.replace(/^bucket_/, '');
      map[key] = row.label;
    }
    return map;
  }

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
      let query = db.from('task')
        .select('task_id')
        .eq('user_id', user_id)
        .eq('bucket_key', bucketKey)
        .eq('is_completed', false)
        .eq('is_archived', false)
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
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) return nameOrId;
    const db = createSupabaseAdmin();
    const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
    if (!peopleGroup) return null;
    const hint = nameOrId.toLowerCase().trim();
    const { data: tags } = await db.from('tag').select('tag_id, name').eq('user_id', user_id).eq('tag_group_id', peopleGroup.tag_group_id).eq('is_archived', false);
    const match = (tags ?? []).find(t => t.name === nameOrId || t.name.toLowerCase() === hint || t.name.toLowerCase().includes(hint));
    if (match) return match.tag_id;
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

    if (op.field === 'tags') {
      const isRemove = op.mode === 'remove' || (op as any).tag_op === 'remove';
      const tagNames = String(op.value).split(',').map((t: string) => t.trim()).filter(Boolean);
      const { data: current } = await db.from(table).select('tags').eq(pk, record_id).single();
      let currentTags: string[] = (current as any)?.tags ?? [];
      if (isRemove) {
        currentTags = currentTags.filter(t => !tagNames.includes(t));
      } else {
        const { data: validTagRows } = await db.from('tag').select('name').eq('user_id', user_id).in('name', tagNames).eq('is_archived', false);
        const validNames = new Set((validTagRows ?? []).map((t: any) => t.name));
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

    if (op.field === 'task_status_id') {
      const statusId = await resolveStatusId(user_id, String(op.value));
      if (!statusId) throw new Error(`Status "${op.value}" not found`);
      const { error } = await db.from(table).update({ task_status_id: statusId }).eq(pk, record_id).eq('user_id', user_id);
      if (error) throw new Error(error.message);
      return `status set to ${op.value}`;
    }

    if (op.field === 'delegated_to') {
      const tagId = await resolvePeopleTagId(user_id, String(op.value));
      const { error } = await db.from(table).update({ delegated_to: tagId }).eq(pk, record_id).eq('user_id', user_id);
      if (error) throw new Error(error.message);
      return `delegated to ${op.value}`;
    }

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

    if (op.field === 'bucket_key') {
      const bucketLabels = await resolveBucketLabels(user_id);
      const { error } = await db.from(table).update({ bucket_key: op.value }).eq(pk, record_id).eq('user_id', user_id);
      if (error) throw new Error(error.message);
      return `moved to ${bucketLabels[String(op.value)] ?? op.value}`;
    }

    const { error } = await db.from(table).update({ [op.field]: op.value }).eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    return `${op.field} updated`;
  }

  // ─── SECTION DATA PULLERS ─────────────────────────────────────────────────────
  // RULE: notes and description are NEVER included in generation prompts or API payloads.
  // They are display-only fields, exported via file only.

  async function pullTasksForSection(
    user_id: string,
    scope: Record<string, any>,
    bucketLabels: Record<string, string>,
    context_filter?: string | null
  ): Promise<string> {
    const db = createSupabaseAdmin();
    const buckets: string[] = scope.buckets ?? Object.keys(bucketLabels);

    let q = db.from('task')
      .select('title, bucket_key, tags, target_date, context:context_id(name), delegatee:delegated_to(name), task_status:task_status_id(label)')
      .eq('user_id', user_id)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .in('bucket_key', buckets)
      .order('sort_order', { ascending: true, nullsFirst: false });

    if (scope.context)       q = (q as any).eq('context_id', scope.context);
    else if (context_filter) q = (q as any).eq('context_id', context_filter);
    if (scope.tags?.length)  q = (q as any).contains('tags', scope.tags);
    if (scope.delegated_to)  q = (q as any).eq('delegated_to', scope.delegated_to);

    const { data: tasks } = await q;
    if (!tasks?.length) return '(no tasks)';

    const today = new Date().toISOString().slice(0, 10);
    const byBucket: Record<string, string[]> = {};

    for (const t of tasks) {
      if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
      const ctx       = (t.context as any)?.name;
      const status    = (t.task_status as any)?.label ?? '';
      const due       = t.target_date ? String(t.target_date).slice(0, 10) : null;
      const overdue   = due && due < today ? ' [OVERDUE]' : '';
      const dueStr    = due ? ` · Due: ${due}${overdue}` : '';
      const ctxStr    = ctx ? ` · ${ctx}` : '';
      const statusStr = status ? ` · ${status}` : '';
      byBucket[t.bucket_key].push(`- ${t.title}${ctxStr}${statusStr}${dueStr}`);
    }

    return Object.entries(byBucket)
      .map(([b, items]) => `${bucketLabels[b] ?? b}:\n${items.join('\n')}`)
      .join('\n\n');
  }

  async function pullCompletionsForSection(
    user_id: string,
    scope: Record<string, any>,
    context_filter?: string | null
  ): Promise<string> {
    const db = createSupabaseAdmin();
    const windowDays = scope.window_days ?? null;

    let q = db.from('completion')
      .select('title, completed_at, outcome, context:context_id(name)')
      .eq('user_id', user_id)
      .order('completed_at', { ascending: false });

    if (windowDays !== null) {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - windowDays);
      q = (q as any).gte('completed_at', windowStart.toISOString());
    }

    if (scope.context)       q = (q as any).eq('context_id', scope.context);
    else if (context_filter) q = (q as any).eq('context_id', context_filter);
    if (scope.tags?.length)  q = (q as any).contains('tags', scope.tags);

    const { data: completions } = await q;
    if (!completions?.length) return '(no completions)';

    return completions.map(c => {
      const date       = String(c.completed_at ?? '').slice(0, 10);
      const ctx        = (c.context as any)?.name;
      const ctxStr     = ctx ? ` · ${ctx}` : '';
      const outcomeStr = c.outcome ? ` · ${c.outcome}` : '';
      return `- ${c.title}${ctxStr} · Completed: ${date}${outcomeStr}`;
    }).join('\n');
  }

  async function pullMeetingsForSection(
    user_id: string,
    scope: Record<string, any>,
    context_filter?: string | null
  ): Promise<string> {
    const db = createSupabaseAdmin();
    const windowDays = scope.window_days ?? null;
    const today = new Date().toISOString().slice(0, 10);

    let q = db.from('meeting')
      .select('title, meeting_date, attendees, outcome, context:context_id(name)')
      .eq('user_id', user_id)
      .order('meeting_date', { ascending: false })
      .limit(50);

    if (windowDays !== null) {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - windowDays);
      q = (q as any).gte('meeting_date', windowStart.toISOString().slice(0, 10));
    }

    if (scope.completed_only) q = (q as any).eq('is_completed', true);
    if (scope.context)        q = (q as any).eq('context_id', scope.context);
    else if (context_filter)  q = (q as any).eq('context_id', context_filter);
    if (scope.attendee)       q = (q as any).contains('attendees', [scope.attendee]);
    if (scope.tags?.length)   q = (q as any).contains('tags', scope.tags);

    const { data: meetings } = await q;
    if (!meetings?.length) return '(no meetings)';

    return meetings.map(m => {
      const date       = String(m.meeting_date ?? '').slice(0, 10);
      const att        = m.attendees?.length ? ` · ${m.attendees.join(', ')}` : '';
      const ctx        = (m.context as any)?.name;
      const ctxStr     = ctx ? ` · ${ctx}` : '';
      const outcomeStr = m.outcome ? ` · ${m.outcome}` : '';
      const futureStr  = date > today ? ' [upcoming]' : '';
      return `- ${m.title}${att}${ctxStr} · ${date}${futureStr}${outcomeStr}`;
    }).join('\n');
  }

  async function pullReferencesForSection(user_id: string, scope: Record<string, any>): Promise<string> {
    const db = createSupabaseAdmin();
    const limit = scope.limit ?? 10;
    let q = db.from('external_reference')
      .select('title')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (scope.tags?.length) q = (q as any).contains('tags', scope.tags);
    const { data: refs } = await q;
    if (!refs?.length) return '(no references)';
    return refs.map(r => `- ${r.title}`).join('\n');
  }

  async function pullSituationForSection(user_id: string): Promise<string> {
    const db = createSupabaseAdmin();
    const { data } = await db.from('user_situation').select('brief').eq('user_id', user_id).eq('is_active', true).maybeSingle();
    return data?.brief?.trim() ?? '(no situation brief)';
  }

  async function pullContactsForSection(user_id: string, scope: Record<string, any>): Promise<string> {
    const db = createSupabaseAdmin();
    const limit = scope.limit ?? 20;
    const { data: contacts } = await db.from('contact')
      .select('name')
      .eq('user_id', user_id)
      .eq('is_archived', false)
      .order('name')
      .limit(limit);
    if (!contacts?.length) return '(no contacts)';
    return contacts.map(c => `- ${c.name}`).join('\n');
  }

  // ─── STUB DATA GENERATOR ──────────────────────────────────────────────────────

  function generateStubForSection(source: string, bucketLabels: Record<string, string>): string {
    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lastWeek  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const nextWeek  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const overdue   = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const labels    = Object.keys(bucketLabels).map(k => bucketLabels[k]);

    switch (source) {
      case 'tasks':
        return [
          labels[0] ? `${labels[0]}:` : 'On Fire:',
          `- Sample Task A · Project Alpha · Active · Due: ${today}`,
          `- Sample Task B · Project Beta · Waiting · Due: ${overdue} [OVERDUE]`,
          '',
          labels[1] ? `${labels[1]}:` : 'Up Next:',
          `- Sample Task C · Project Alpha · Active · Due: ${nextWeek}`,
          `- Sample Task D · No context · Active`,
          '',
          labels[2] ? `${labels[2]}:` : 'Real Work:',
          `- Sample Task E · Project Beta · In Progress`,
          '',
          labels[3] ? `${labels[3]}:` : 'Later:',
          `- Sample Task F · Project Alpha · Active · Due: ${nextWeek}`,
          '',
          labels[4] ? `${labels[4]}:` : 'Delegated:',
          `- Sample Task G · Project Beta · Waiting · Due: ${overdue} [OVERDUE]`,
        ].join('\n');
      case 'completions':
        return [
          `- Completed Item A · Project Alpha · Completed: ${today} · Delivered on schedule`,
          `- Completed Item B · Project Beta · Completed: ${yesterday} · Reviewed and approved`,
          `- Completed Item C · No context · Completed: ${lastWeek}`,
        ].join('\n');
      case 'meetings':
        return [
          `- Weekly Sync · Alice, Bob · Project Alpha · ${yesterday}`,
          `- Project Kickoff · Alice, Carol · Project Beta · ${lastWeek} · Aligned on scope`,
          `- Planning Session · Bob, Dave · Project Alpha · ${nextWeek} [upcoming]`,
        ].join('\n');
      case 'references':
        return [`- Sample Reference Document`, `- Another Reference`].join('\n');
      case 'situation':
        return `Currently focused on Q2 delivery with active projects across multiple contexts.`;
      case 'contacts':
        return [`- Alice Smith`, `- Bob Jones`].join('\n');
      default:
        return `(stub data for ${source})`;
    }
  }

  // ─── ACTION EXECUTORS ─────────────────────────────────────────────────────────

  async function executeInsert(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean; task_id?: string; offer_preview?: boolean }> {
    const db          = createSupabaseAdmin();
    const object_type = action.object_type ?? 'task';
    const fields      = { ...(action.fields ?? {}) };
    const table       = OBJECT_TABLE[object_type];
    if (!table) throw new Error(`Unknown object type: ${object_type}`);

    if (fields.context_name && !fields.context_id) {
      fields.context_id = await resolveContextId(user_id, fields.context_name);
      delete fields.context_name;
    }
    if (fields.delegated_to && typeof fields.delegated_to === 'string') {
      fields.delegated_to = await resolvePeopleTagId(user_id, fields.delegated_to);
    }
    if (fields.task_status_id && typeof fields.task_status_id === 'string') {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.task_status_id);
      if (!isUuid) {
        const resolved = await resolveStatusId(user_id, fields.task_status_id);
        if (resolved) fields.task_status_id = resolved;
        else delete fields.task_status_id;
      }
    }

    if (object_type === 'task') {
      const result = await captureTask(user_id, fields as any);
      if (!result.success) throw new Error(result.error);
      const bucketLabels = await resolveBucketLabels(user_id);
      const bucketLabel  = bucketLabels[result.task?.bucket_key ?? 'capture'] ?? result.task?.bucket_key;
      const tagNote      = result.task?.tags?.length ? ` · ${result.task.tags.map((t: string) => `#${t}`).join(' ')}` : '';
      writeKarlObservation(user_id, `Captured: "${result.task?.title}" → ${bucketLabel}${tagNote}`, 'pattern').catch(() => {});
      return { response: `Captured — **${result.task?.title}** → ${bucketLabel}${tagNote}.`, refresh: true, task_id: result.task_id, offer_preview: true };
    }

    if (object_type === 'contact') {
      const { data: contact, error: contactError } = await db.from('contact').insert({ user_id, ...fields }).select().single();
      if (contactError) throw new Error(contactError.message);
      const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
      if (peopleGroup && fields.name) {
        const { data: newTag } = await db.from('tag').insert({ user_id, tag_group_id: peopleGroup.tag_group_id, name: fields.name.trim(), is_archived: false }).select('tag_id').single();
        if (newTag) await db.from('contact').update({ tag_id: newTag.tag_id }).eq('contact_id', contact.contact_id);
      }
      writeKarlObservation(user_id, `Created contact: "${fields.name}"`, 'pattern').catch(() => {});
      return { response: `Contact **${fields.name}** added.`, refresh: true };
    }

    const { error } = await db.from(table).insert({ user_id, ...fields });
    if (error) throw new Error(error.message);
    writeKarlObservation(user_id, `Created ${object_type}: "${fields.title ?? fields.name ?? '(untitled)'}"`, 'pattern').catch(() => {});
    return { response: `**${fields.title ?? fields.name ?? object_type}** saved.`, refresh: true };
  }

  async function executeCaptureTasksBulk(
    user_id: string,
    tasks: any[]
  ): Promise<{ response: string; refresh: boolean }> {
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

  async function executeUpdate(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean }> {
    const object_type = action.object_type ?? 'task';
    const identifier  = action.identifier;
    if (!identifier) throw new Error('update action missing identifier');
    const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
    if (!record_id) return { response: `Couldn't find ${identifier} — it may have moved. Try refreshing.`, refresh: false };
    const descriptions: string[] = [];
    for (const op of action.operations ?? []) {
      descriptions.push(await applyFieldOperation(user_id, object_type, record_id, op));
    }
    writeKarlObservation(user_id, `Updated ${object_type} ${identifier}: ${descriptions.join(', ')}`, 'pattern').catch(() => {});
    return { response: `Done — ${descriptions.join(', ')}.`, refresh: true };
  }

  async function executeComplete(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean }> {
    const db          = createSupabaseAdmin();
    const object_type = action.object_type ?? 'task';
    const identifier  = action.identifier;
    if (!identifier) throw new Error('complete action missing identifier');
    const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
    if (!record_id) return { response: `Couldn't find ${identifier}.`, refresh: false };
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

  async function executeArchive(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean }> {
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

  async function executeDelete(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean }> {
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

  async function executeDeleteObject(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean }> {
    const db           = createSupabaseAdmin();
    const object_type  = action.object_type ?? '';
    const identifier   = action.identifier;
    const display_name = action.fields?.display_name ?? identifier;

    if (!object_type || !identifier) throw new Error('delete_object missing object_type or identifier');

    const { data: cfg } = await db
      .from('ko_list_view_config')
      .select('allow_delete')
      .eq('user_id', user_id)
      .eq('object_type', object_type)
      .maybeSingle();

    if (!cfg?.allow_delete) {
      return { response: `Delete on ${object_type} disabled by administrator.`, refresh: false };
    }

    const table = OBJECT_TABLE[object_type];
    const pk    = OBJECT_PK[object_type];
    if (!table || !pk) throw new Error(`Unknown object type: ${object_type}`);

    const record_id = await resolveIdentifier(user_id, identifier, object_type, context_filter);
    if (!record_id) return { response: `Couldn't find ${identifier}.`, refresh: false };

    const { error } = await db.from(table).delete().eq(pk, record_id).eq('user_id', user_id);
    if (error) throw new Error(error.message);

    writeKarlObservation(user_id, `Deleted ${object_type} ${identifier} ("${display_name}") via chat`, 'pattern').catch(() => {});
    return { response: `🗑️ **${display_name}** deleted.`, refresh: true };
  }

  async function executeCreateTag(user_id: string, action: KarlAction): Promise<{ response: string; refresh: boolean }> {
    const db     = createSupabaseAdmin();
    const fields = action.fields ?? {};
    const name   = fields.name;
    if (!name) throw new Error('create_tag missing name');
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

  async function executeSaveAsTemplate(
    user_id: string,
    action: KarlAction
  ): Promise<{ response: string; refresh: boolean; offer_open_templates: boolean }> {
    const db     = createSupabaseAdmin();
    const fields = action.fields ?? {};
    const name   = fields.name;
    if (!name) throw new Error('save_as_template missing name');

    const { error } = await db.from('document_template').insert({
      user_id,
      name:            fields.name.trim(),
      description:     fields.description?.trim() ?? null,
      doc_type:        fields.doc_type?.trim() ?? '',
      prompt_template: fields.prompt_template?.trim() ?? '',
      sections:        fields.sections ?? [],
      output_format:   fields.output_format ?? 'md',
      tags:            fields.tags ?? [],
      is_system:       false,
      is_active:       true,
    });
    if (error) throw new Error(error.message);

    writeKarlObservation(user_id, `Saved template: "${name}"`, 'pattern').catch(() => {});
    return {
      response: `📄 Template **${name}** saved. Run it anytime — say "run TM" followed by its number, or open Templates to configure it first.`,
      refresh: true,
      offer_open_templates: true,
    };
  }

  // ─── EXECUTE RUN TEMPLATE ─────────────────────────────────────────────────────
  // v1.5.3 — Uses claude-haiku for generation (separate rate limit from routing).
  // Preview = stub data, validates formatting, never saves.
  // Save = real data (no notes/description), encrypts and stores output.

  async function executeRunTemplate(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean; template_output?: string }> {
    const db = createSupabaseAdmin();

    // ── Resolve template ──────────────────────────────────────────────────────
    let templateId = action.fields?.template_id ?? null;

    if (!templateId && action.target_identifier) {
      const parsed = action.target_identifier.toUpperCase().match(/^TM(\d+)$/);
      if (parsed) {
        const index = parseInt(parsed[1], 10);
        const { data: templates } = await db
          .from('document_template')
          .select('document_template_id')
          .eq('user_id', user_id)
          .eq('is_active', true)
          .order('created_at', { ascending: true });
        templateId = templates?.[index - 1]?.document_template_id ?? null;
      }
    }

    if (!templateId) throw new Error('run_template: could not resolve template');

    const { data: template } = await db
      .from('document_template')
      .select('name, description, prompt_template, sections, output_format')
      .eq('document_template_id', templateId)
      .single();

    if (!template) throw new Error('Template not found');
    if (!template.prompt_template) throw new Error('Template has no formatting instructions. Open Templates to add them.');

    const sections: Array<{ key: string; label: string; source: string; format: string }> =
      Array.isArray(template.sections) ? template.sections : [];

    const isPreview    = action.run_mode === 'preview';
    const sectionData  = action.section_data ?? {};
    const bucketLabels = await resolveBucketLabels(user_id);

    // ── Build section data blocks ─────────────────────────────────────────────
    const sectionBlocks: string[] = [];

    if (sections.length > 0) {
      for (const section of sections) {
        const scope = sectionData[section.key] ?? {};
        let sectionContent: string;

        if (isPreview) {
          sectionContent = generateStubForSection(section.source, bucketLabels);
        } else {
          switch (section.source) {
            case 'tasks':
              sectionContent = await pullTasksForSection(user_id, scope, bucketLabels, context_filter);
              break;
            case 'completions':
              sectionContent = await pullCompletionsForSection(user_id, scope, context_filter);
              break;
            case 'meetings':
              sectionContent = await pullMeetingsForSection(user_id, scope, context_filter);
              break;
            case 'references':
              sectionContent = await pullReferencesForSection(user_id, scope);
              break;
            case 'situation':
              sectionContent = await pullSituationForSection(user_id);
              break;
            case 'contacts':
              sectionContent = await pullContactsForSection(user_id, scope);
              break;
            default:
              sectionContent = `(unknown source: ${section.source})`;
          }
        }

        sectionBlocks.push(
          `[${section.key}] ${section.label}\nFormat: ${section.format}\nData:\n${sectionContent}`
        );
      }
    } else {
      // Legacy path — no sections defined
      console.log('[executeRunTemplate] no sections defined — using legacy full pull');
      if (isPreview) {
        sectionBlocks.push([
          generateStubForSection('tasks', bucketLabels),
          generateStubForSection('meetings', bucketLabels),
          generateStubForSection('completions', bucketLabels),
        ].join('\n\n'));
      } else {
        const [tasksData, completionsData, meetingsData] = await Promise.all([
          pullTasksForSection(user_id, { buckets: Object.keys(bucketLabels) }, bucketLabels, context_filter),
          pullCompletionsForSection(user_id, {}, context_filter),
          pullMeetingsForSection(user_id, {}, context_filter),
        ]);
        if (tasksData !== '(no tasks)')             sectionBlocks.push(`Tasks:\n${tasksData}`);
        if (meetingsData !== '(no meetings)')        sectionBlocks.push(`Meetings:\n${meetingsData}`);
        if (completionsData !== '(no completions)') sectionBlocks.push(`Completions:\n${completionsData}`);
      }
    }

    const dataBlock = sectionBlocks.join('\n\n') || 'No data available.';

    // ── Concept registry hints ────────────────────────────────────────────────
    const bundle = await buildKarlContext(user_id, context_filter);
    const conceptHints = bundle.conceptRegistry.length
      ? 'Concept registry (use these labels and icons only):\n' +
        bundle.conceptRegistry
          .filter(c => c.concept_type !== 'action')
          .map(c => `  ${c.icon ?? ''} = ${c.label} (key: ${c.concept_key})`)
          .join('\n')
      : '';

    // ── Assemble full prompt ───────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const fullPrompt = [
      `Template: ${template.name}`,
      template.description ? `Purpose: ${template.description}` : '',
      `Date: ${today}`,
      '',
      'Formatting Instructions:',
      template.prompt_template,
      '',
      conceptHints,
      '',
      isPreview ? 'NOTE: This is a FORMATTING PREVIEW using stub data. Show the layout only.' : '',
      '',
      'Section Data:',
      dataBlock,
    ].filter(Boolean).join('\n').trim();

    // ── Generate using Haiku — separate rate limit from routing Sonnet call ───
    const systemPrompt = `You are Karl, generating a document for a KarlOps user.
  Follow the formatting instructions exactly. Use only the section data provided — do not invent data.
  ${isPreview ? 'This is a formatting preview — use the stub data as-is to demonstrate the layout.' : ''}
  Format the output in ${template.output_format ?? 'md'}.
  Use concept registry labels and icons for section headers. Never use hardcoded labels or icons.
  Replace {date} in the template with today's date: ${today}.
  Return ONLY the document content — no preamble, no explanation, no code fences.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: fullPrompt }],
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[executeRunTemplate] tokens:', {
      input: usage.input_tokens, output: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
    });

    if (data.error) {
      console.error('[executeRunTemplate] Anthropic error:', JSON.stringify(data.error));
      throw new Error(`Generation failed: ${data.error.message ?? 'unknown error'}`);
    }

    const output = data.content?.[0]?.text ?? '';
    if (!output) throw new Error('Template run produced no output');

    // Preview — show in chat, never save
    if (isPreview) {
      writeKarlObservation(user_id, `Previewed template "${template.name}" (formatting check, stub data)`, 'pattern').catch(() => {});
      return {
        response: `Here is a formatting preview of **${template.name}** using sample data:`,
        refresh: false,
        template_output: output,
      };
    }

    // Save — encrypt output, store run_data and encrypted output on extract
    const encryptedOutput = await encryptOutput(output);
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const { error: saveError } = await db.from('external_reference').insert({
      user_id,
      title:                `${template.name} — ${dateStr}`,
      description:          template.description ?? null,
      filename:             `${template.name.toLowerCase().replace(/\s+/g, '-')}-${today}.md`,
      location:             'generated',
      run_data:             fullPrompt,
      output:               encryptedOutput,
      output_encrypted:     true,
      section_data:         Object.keys(sectionData).length > 0 ? sectionData : null,
      document_template_id: templateId,
      ref_type:             'generated',
      tags:                 [],
    });
    if (saveError) throw new Error(saveError.message);

    writeKarlObservation(user_id, `Ran template "${template.name}" → saved extract (output encrypted)`, 'pattern').catch(() => {});
    return {
      response: `📄 **${template.name}** generated and saved to Extracts. Output shown below — encrypted at rest, regenerate anytime.`,
      refresh: true,
      template_output: output,
    };
  }

  // ─── DISPATCH SINGLE ACTION ───────────────────────────────────────────────────

  async function dispatchAction(
    user_id: string,
    action: KarlAction,
    context_filter?: string | null
  ): Promise<{ response: string; refresh: boolean; task_id?: string; offer_preview?: boolean; template_output?: string; offer_open_templates?: boolean }> {
    switch (action.action) {
      case 'insert':           return executeInsert(user_id, action, context_filter);
      case 'capture_tasks':    return executeCaptureTasksBulk(user_id, action.tasks ?? []);
      case 'update':           return executeUpdate(user_id, action, context_filter);
      case 'complete':         return executeComplete(user_id, action, context_filter);
      case 'archive':          return executeArchive(user_id, action, context_filter);
      case 'delete':           return executeDelete(user_id, action, context_filter);
      case 'delete_object':    return executeDeleteObject(user_id, action, context_filter);
      case 'create_tag':       return executeCreateTag(user_id, action);
      case 'save_as_template': return executeSaveAsTemplate(user_id, action);
      case 'run_template':     return executeRunTemplate(user_id, action, context_filter);
      case 'refine':           return { response: 'Refine flow active.', refresh: false };
      case 'summarize':        return { response: '', refresh: false };
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
    const results: Array<{
      response: string; refresh: boolean; task_id?: string;
      offer_preview?: boolean; template_output?: string; offer_open_templates?: boolean;
    }> = [];
    const errors: string[] = [];

    for (const action of actions) {
      try {
        const result = await dispatchAction(user_id, action, context_filter);
        results.push(result);
      } catch (err: any) {
        const message = err.message ?? 'Unknown error';
        console.error(`[executeActions] ${action.action} ${action.object_type ?? ''} failed:`, message);
        if (isKnowledgeFailure(message)) {
          logError(user_id, 'command', `${action.action} ${action.object_type ?? ''}`, 'knowledge', message, action as any).catch(() => {});
          karlLearnFromFailure(user_id, action, message).catch(() => {});
          errors.push(`${action.action} ${action.object_type ?? ''}: ${message}`);
        } else {
          logError(user_id, 'command', `${action.action} ${action.object_type ?? ''}`, 'system', message, action as any).catch(() => {});
          if (message.toLowerCase().includes('rate limit')) {
            errors.push(`Rate limit hit — the data selected for this template is too large to process in one request. Try reducing the date window or filtering by context.`);
          } else {
            errors.push(`${action.action} ${action.object_type ?? ''}: something went wrong`);
          }
        }
      }
    }

    const refresh            = results.some(r => r.refresh);
    const task_id            = results.find(r => r.task_id)?.task_id;
    const offerPreview       = results.some(r => r.offer_preview) && actions.length === 1;
    const templateOutput     = results.find(r => r.template_output)?.template_output;
    const offerOpenTemplates = results.some(r => r.offer_open_templates);
    const responses          = results.map(r => r.response).filter(Boolean);
    const responseText       = errors.length
      ? [...responses, `Errors: ${errors.join(', ')}`].join('\n')
      : responses.join('\n');

    return NextResponse.json({
      success:              errors.length === 0,
      intent:               'executed',
      response:             responseText,
      refresh,
      task_id,
      offer_preview:        offerPreview,
      template_output:      templateOutput ?? null,
      offer_open_templates: offerOpenTemplates,
    });
  }

  // ─── BACKWARDS COMPAT ─────────────────────────────────────────────────────────
  // flattenLegacyPending: converts old flat pending payload to actions array.
  // CRITICAL: run_template must be handled explicitly or it falls through to
  // insert task, causing captureTask to receive garbage fields.

  function flattenLegacyPending(pending: Record<string, any>): KarlAction[] {
    if (pending.actions?.length) return pending.actions;

    const flat   = pending.payload ? { ...pending.payload, ...pending } : pending;
    const action = flat.action ?? flat.intent;
    const tasks  = flat.tasks ?? flat.payload?.tasks ?? [];

    // run_template — must be explicit, never fall through to insert
    if (action === 'run_template') {
      return [{
        action:           'run_template',
        target_identifier: flat.target_identifier ?? flat.actions?.[0]?.target_identifier,
        run_mode:         flat.run_mode === 'preview' ? 'save' : (flat.run_mode ?? 'save'), // if confirming a preview, run as save
        section_data:     flat.section_data ?? flat.actions?.[0]?.section_data ?? {},
      }];
    }

    if (tasks.length > 0) return [{ action: 'capture_tasks', object_type: 'task', modal: 'TaskAddModal', tasks }];

    if (action === 'capture_task' || action === 'insert') {
      return [{ action: 'insert', object_type: flat.object_type ?? 'task', modal: 'TaskAddModal', fields: { title: flat.title, bucket_key: flat.bucket_key ?? 'capture', context_id: flat.context_id ?? null, tags: flat.tags ?? [], notes: flat.notes ?? null, target_date: flat.target_date ?? null, delegated_to: flat.delegated_to ?? null } }];
    }
    if (action === 'update_object' || action === 'update') {
      return [{ action: 'update', object_type: flat.object_type, identifier: flat.identifier, operations: flat.operations ?? [] }];
    }
    if (action === 'capture_completion') {
      return [{ action: 'insert', object_type: 'completion', modal: 'CompletionsModal', fields: { title: flat.title ?? flat.payload?.title, outcome: flat.outcome ?? flat.payload?.outcome ?? '' } }];
    }
    if (action === 'complete') {
      return [{ action: 'complete', object_type: flat.object_type ?? 'task', identifier: flat.identifier, fields: { outcome: flat.outcome ?? '' } }];
    }
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

      const fileBlocks = extracted.map((f, i) =>
        extracted.length > 1
          ? `--- FILE ${i + 1}: ${f.name} ---\n${f.text.length > 8000 ? f.text.slice(0, 8000) + '\n[truncated]' : f.text}`
          : `--- ${f.name} ---\n${f.text.length > 12000 ? f.text.slice(0, 12000) + '\n[truncated]' : f.text}`
      ).join('\n\n');

      const userHint   = input?.trim() ?? '';
      const filePrompt = userHint
        ? `User instruction: "${userHint}"\n\nFile content:\n${fileBlocks}`
        : `File dropped without instruction. Ask what the user wants to do.\n\nFile content:\n${fileBlocks}`;

      
const contextSplit = await buildKarlContextSplit(user.id, context_filter ?? null);
const result = await routeCommand(
  user.id,
  filePrompt,
  pending ?? null,
  context_filter ?? null,
  [],
  {
    staticContext: formatStaticContextForPrompt(contextSplit.static),
    dynamicContext: formatDynamicContextForPrompt(contextSplit.dynamic),
  }
);



      const classifiedAction = result.actions?.[0]?.action ?? result.intent;
      writeKarlObservation(user.id, `File drop: user said "${userHint || 'nothing'}", Karl classified as "${classifiedAction}". Files: ${extracted.map(f => f.name).join(', ')}.`, 'preference').catch(() => {});
      if (errors.length && result.response) result.response = result.response + `\n\n(Skipped: ${errors.join(', ')})`;

      const safeIntent = result.intent === 'execute' ? 'pending' : result.intent;
      return NextResponse.json({
        success: true, intent: safeIntent,
        response: result.response ?? null,
        actions: result.actions ?? null,
        payload: null,
      });
    }

    // ── Normal text path ───────────────────────────────────────────────────────
    if (!input) return NextResponse.json({ error: 'No input provided' }, { status: 400 });

    try {
      

const contextSplit = await buildKarlContextSplit(user.id, context_filter ?? null);
const result = await routeCommand(
  user.id,
  input,
  pending ?? null,
  context_filter ?? null,
  [],
  {
    staticContext: formatStaticContextForPrompt(contextSplit.static),
    dynamicContext: formatDynamicContextForPrompt(contextSplit.dynamic),
  }
);



      if (result.intent === 'execute' && result.actions?.length) {
        return executeActions(user.id, result.actions, context_filter);
      }
  if (result.intent === 'confirm_pending' && pending) {
    const actions = flattenLegacyPending(pending);
    // If confirming a run_template, always force run_mode to save
    // A preview action should never be executed directly
    const safeActions = actions.map(a => {
      if (a.action === 'run_template') {
        return { ...a, run_mode: 'save' as const };
      }
      return a;
    });
    return executeActions(user.id, safeActions, context_filter);
  }

      if (result.intent === 'cancel_pending') {
        return NextResponse.json({ success: true, intent: 'cancel_pending', response: result.response ?? 'Cancelled.' });
      }

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