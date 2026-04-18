import { createSupabaseAdmin } from '@/lib/supabase-server';

export interface ChatMessage {
  role: 'user' | 'karl';
  content: string;
  ts: string;
}

export interface ConceptEntry {
  concept_key: string;
  concept_type: string;
  label: string;
  icon: string | null;
  description: string | null;
  display_order: number;
}

export interface KarlContextBundle {
  situationBrief: string;
  recentMessages: ChatMessage[];
  bucketSnapshot: string;
  recentCompletions: string;
  meetingSnapshot: string;
  fcSnapshot: string;
  observations: string;
  availableTags: string;
  availableContexts: string;
  vocab: string;
  fieldKnowledge: string;
  conceptRegistry: ConceptEntry[];
}

export interface KarlDeepBundle extends KarlContextBundle {
  fullCompletions: string;
  tasksByContext: string;
}

const BUCKET_PREFIX: Record<string, string> = {
  now:      'N',
  soon:     'S',
  realwork: 'RW',
  later:    'L',
  delegate: 'D',
  capture:  'CP',
};

const MAX_OBSERVATIONS = 50;

function trunc(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + ' [...]' : text;
}

// ── Concept Registry ──────────────────────────────────────────────────────────
// System table — no user_id. Filtered by implementation_type from ko_user.
async function buildConceptRegistry(user_id: string): Promise<ConceptEntry[]> {
  const db = createSupabaseAdmin();

  // Get implementation_type from ko_user (PK is `id`)
  const { data: koUser } = await db
    .from('ko_user')
    .select('implementation_type')
    .eq('id', user_id)
    .maybeSingle();

  const implType = koUser?.implementation_type ?? 'personal';

  const { data } = await db
    .from('concept_registry')
    .select('concept_key, concept_type, label, icon, description, display_order')
    .eq('implementation_type', implType)
    .eq('is_active', true)
    .order('concept_type')
    .order('display_order');

  return (data ?? []) as ConceptEntry[];
}

// Export for use in modals and other UI consumers
export async function getConceptRegistry(user_id: string): Promise<ConceptEntry[]> {
  return buildConceptRegistry(user_id);
}

// Format concept registry for Karl's system prompt
function formatConceptRegistry(concepts: ConceptEntry[]): string {
  if (!concepts.length) return '';

  const byType: Record<string, ConceptEntry[]> = {};
  for (const c of concepts) {
    if (!byType[c.concept_type]) byType[c.concept_type] = [];
    byType[c.concept_type].push(c);
  }

  const lines: string[] = [];
  for (const [type, entries] of Object.entries(byType)) {
    lines.push(`${type}:`);
    for (const e of entries) {
      const icon = e.icon ? `${e.icon} ` : '';
      const desc = e.description ? ` — ${e.description}` : '';
      lines.push(`  ${e.concept_key} → ${icon}${e.label}${desc}`);
    }
  }
  return lines.join('\n');
}

// ── Field knowledge ───────────────────────────────────────────────────────────
async function buildFieldKnowledge(user_id: string): Promise<string> {
  const db = createSupabaseAdmin();

  const { data: fields } = await db
    .from('ko_field_metadata')
    .select('object_type, field, label, field_type, insert_behavior, update_behavior, description, llm_notes')
    .eq('user_id', user_id)
    .in('object_type', ['task', 'completion', 'meeting', 'contact', 'external_reference', 'document_template', 'task_status'])
    .lt('display_order', 999)
    .order('object_type')
    .order('display_order');

  if (!fields?.length) return '';

  const byType: Record<string, string[]> = {};
  for (const f of fields) {
    if (!byType[f.object_type]) byType[f.object_type] = [];
    const parts = [`  ${f.field} (${f.label}, ${f.field_type})`];
    if (f.description) parts.push(`    what: ${f.description}`);
    if (f.llm_notes)   parts.push(`    how:  ${f.llm_notes}`);
    byType[f.object_type].push(parts.join('\n'));
  }

  return Object.entries(byType)
    .map(([type, fieldLines]) => `${type}:\n${fieldLines.join('\n')}`)
    .join('\n\n');
}

// ── Base context — every Karl call ────────────────────────────────────────────
export async function buildKarlContext(user_id: string, context_filter: string | null = null): Promise<KarlContextBundle> {
  const db = createSupabaseAdmin();

  const [
    situationRes,
    sessionRes,
    taskRes,
    obsRes,
    tagRes,
    contextRes,
    vocabRes,
    meetingRes,
    completionRes,
    extractRes,
    templateRes,
    contactRes,
    conceptRegistry,
  ] = await Promise.all([
    db.from('user_situation')
      .select('brief, chat_history_depth, completion_window_days')
      .eq('user_id', user_id).eq('is_active', true).maybeSingle(),
    db.from('ko_session')
      .select('messages')
      .eq('user_id', user_id).maybeSingle(),
    (() => {
      let q = db.from('task')
        .select('task_id, title, bucket_key, tags, notes, sort_order, target_date, context_id, delegated_to')
        .eq('user_id', user_id).eq('is_completed', false).eq('is_archived', false)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (context_filter) q = q.eq('context_id', context_filter);
      return q;
    })(),
    db.from('karl_observation')
      .select('content, observation_type')
      .eq('user_id', user_id).eq('is_active', true)
      .order('created_at', { ascending: false }).limit(MAX_OBSERVATIONS),
    db.from('tag')
      .select('name')
      .eq('user_id', user_id).order('name'),
    db.from('context')
      .select('context_id, name')
      .eq('user_id', user_id).eq('is_archived', false).eq('is_visible', true)
      .order('name'),
    db.from('karl_vocab')
      .select('vocab_id, phrase, intent, object_type, use_count, rule_data, match, confirm, last_used')
      .eq('user_id', user_id).eq('is_active', true)
      .order('use_count', { ascending: false }).limit(100),
    db.from('meeting')
      .select('meeting_id, title, meeting_date, attendees, tags, notes, outcome')
      .eq('user_id', user_id).eq('is_completed', false)
      .order('meeting_date', { ascending: false }).limit(15),
    db.from('completion')
      .select('completion_id, title, completed_at, outcome, description, tags, context_id')
      .eq('user_id', user_id)
      .order('completed_at', { ascending: false }).limit(15),
    db.from('external_reference')
      .select('external_reference_id, title, notes, description, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false }).limit(15),
    db.from('document_template')
      .select('document_template_id, name, doc_type, description, prompt_template, is_active')
      .eq('user_id', user_id).eq('is_active', true)
      .order('created_at', { ascending: false }).limit(15),
    db.from('contact')
      .select('contact_id, name, email, primary_contact_method, contact_method_detail, notes')
      .eq('user_id', user_id).eq('is_archived', false)
      .order('name', { ascending: true }).limit(20),
    buildConceptRegistry(user_id),
  ]);

  const situation      = situationRes.data;
  const historyDepth   = situation?.chat_history_depth     ?? 15;
  const completionWin  = situation?.completion_window_days ?? 7;
  const situationBrief = situation?.brief?.trim() || '';

  const allMessages: ChatMessage[] = sessionRes.data?.messages ?? [];
  const recentMessages = allMessages.slice(-historyDepth);

  // Helper — look up icon from registry
  const getObjectIcon = (key: string): string => {
    const found = conceptRegistry.find(c => c.concept_key === key && c.concept_type === 'object');
    return found?.icon ?? '';
  };
  const getBucketDisplay = (bucketKey: string): string => {
    const found = conceptRegistry.find(c => c.concept_key === `bucket_${bucketKey}` && c.concept_type === 'bucket');
    return found ? `${found.icon ?? ''} ${found.label}`.trim() : bucketKey;
  };

  // ── Bucket snapshot ────────────────────────────────────────────────────────
  const byBucket: Record<string, {
    task_id: string; title: string; tags: string[];
    notes: string | null; target_date: string | null;
    context_id: string | null; delegated_to: string | null;
  }[]> = {};

  for (const t of taskRes.data ?? []) {
    if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
    byBucket[t.bucket_key].push({
      task_id: t.task_id, title: t.title, tags: t.tags ?? [],
      notes: t.notes ?? null, target_date: t.target_date ?? null,
      context_id: t.context_id ?? null, delegated_to: t.delegated_to ?? null,
    });
  }

  const bucketOrder = ['now', 'soon', 'realwork', 'later', 'delegate', 'capture'];
  const snapshotLines: string[] = [];
  for (const bucket of bucketOrder) {
    const items = byBucket[bucket] ?? [];
    if (items.length === 0) continue;
    const prefix = BUCKET_PREFIX[bucket] ?? bucket;
    if (bucket === 'capture') {
      const icon = conceptRegistry.find(c => c.concept_key === 'bucket_capture')?.icon ?? '📥';
      snapshotLines.push(`${icon} Capture: ${items.length} uncurated tasks`);
    } else {
      snapshotLines.push(`${getBucketDisplay(bucket)}:`);
      items.forEach((t, i) => {
        const tagStr  = t.tags.length ? ` [${t.tags.join(', ')}]` : '';
        const dateStr = t.target_date ? ` · due ${t.target_date.slice(0, 10)}` : '';
        const delStr  = t.delegated_to ? ` · delegated` : '';
        snapshotLines.push(`  ${prefix}${i + 1} ${t.title}${tagStr}${dateStr}${delStr}`);
        if (t.notes) snapshotLines.push(`    notes: ${trunc(t.notes, 300)}`);
      });
    }
  }
  const bucketSnapshot = snapshotLines.join('\n') || 'no open tasks';

  // ── Recent completions ─────────────────────────────────────────────────────
  const allCompletions = completionRes.data ?? [];
  const cmIndexMap = new Map<string, number>();
  allCompletions.forEach((c, i) => cmIndexMap.set(c.completion_id, i + 1));

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWin);
  const { data: recentCompletionData } = await db
    .from('completion').select('completion_id, title, completed_at')
    .eq('user_id', user_id).gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false }).limit(20);

  const completionIcon = getObjectIcon('completion');
  const recentCompletions = recentCompletionData?.length
    ? recentCompletionData.map(c => {
        const cmNum = cmIndexMap.get(c.completion_id);
        const prefix = cmNum ? `CM${cmNum}` : 'CM?';
        return `${completionIcon} ${prefix} ${c.title} (${c.completed_at?.slice(0, 10)})`;
      }).join('\n')
    : 'none in window';

  // ── Meeting snapshot ───────────────────────────────────────────────────────
  const meetings = meetingRes.data ?? [];
  const meetingIcon = getObjectIcon('meeting');
  const meetingLines: string[] = [];
  meetings.forEach((m, i) => {
    const date        = m.meeting_date ? m.meeting_date.slice(0, 10) : 'no date';
    const attendeeStr = m.attendees?.length ? ` · attendees: ${m.attendees.join(', ')}` : '';
    const tagStr      = m.tags?.length ? ` · tags: ${m.tags.join(', ')}` : '';
    meetingLines.push(`${meetingIcon} MT${i + 1} ${m.title} · ${date}${attendeeStr}${tagStr}`);
    if (m.outcome) meetingLines.push(`  outcome: ${trunc(m.outcome, 500)}`);
    if (m.notes)   meetingLines.push(`  notes: ${trunc(m.notes, 2000)}`);
  });
  const meetingSnapshot = meetingLines.length ? meetingLines.join('\n') : 'no open meetings';

  // ── FC snapshots ───────────────────────────────────────────────────────────
  const fcLines: string[] = [];

  if (allCompletions.length) {
    fcLines.push(`${getObjectIcon('completion')} completions:`);
    allCompletions.forEach((c, i) => {
      const date    = c.completed_at?.slice(0, 10) ?? '';
      const tagStr  = c.tags?.length ? ` [${c.tags.join(', ')}]` : '';
      const ctxName = contextRes.data?.find((ctx: any) => ctx.context_id === c.context_id)?.name ?? null;
      const ctxStr  = ctxName ? ` · context:${ctxName}` : '';
      fcLines.push(`  CM${i + 1} ${c.title} · ${date}${tagStr}${ctxStr}`);
      if (c.outcome)     fcLines.push(`    outcome: ${trunc(c.outcome, 500)}`);
      if (c.description) fcLines.push(`    description: ${trunc(c.description, 300)}`);
    });
  }

  const extracts = extractRes.data ?? [];
  if (extracts.length) {
    fcLines.push(`${getObjectIcon('external_reference')} extracts:`);
    extracts.forEach((e, i) => {
      fcLines.push(`  EX${i + 1} ${e.title}`);
      if (e.description) fcLines.push(`    description: ${trunc(e.description, 300)}`);
      if (e.notes)       fcLines.push(`    content: ${trunc(e.notes, 2000)}`);
    });
  }

  const templates = templateRes.data ?? [];
  if (templates.length) {
    fcLines.push(`${getObjectIcon('document_template')} templates:`);
    templates.forEach((t, i) => {
      fcLines.push(`  TM${i + 1} ${t.name}${t.doc_type ? ` (${t.doc_type})` : ''}`);
      if (t.description)     fcLines.push(`    description: ${trunc(t.description, 200)}`);
      if (t.prompt_template) fcLines.push(`    template: ${trunc(t.prompt_template, 2000)}`);
    });
  }

  const contacts = contactRes.data ?? [];
  if (contacts.length) {
    fcLines.push(`contacts:`);
    contacts.forEach((c, i) => {
      fcLines.push(`  CT${i + 1} ${c.name}`);
      if (c.email) fcLines.push(`    email: ${c.email}`);
      if (c.primary_contact_method) {
        fcLines.push(`    contact via: ${c.primary_contact_method}${c.contact_method_detail ? ` (${c.contact_method_detail})` : ''}`);
      }
      if (c.notes) fcLines.push(`    notes: ${trunc(c.notes, 300)}`);
    });
  }

  const fcSnapshot = fcLines.join('\n') || 'no FC objects';

  const observations = obsRes.data?.length
    ? obsRes.data.map(o => `[${o.observation_type}] ${o.content}`).join('\n')
    : '';

  const availableTags = tagRes.data?.length
    ? tagRes.data.map(t => t.name).join(', ')
    : 'none';

  const availableContexts = contextRes.data?.length
    ? contextRes.data.map(c => `${c.name}|${c.context_id}`).join(', ')
    : 'none';

  const vocab = vocabRes.data?.length
    ? vocabRes.data.map(v => {
        const base = `"${v.phrase}" → ${v.intent} (${v.object_type}) · used ${v.use_count}x`;
        if (v.rule_data) {
          const rule = v.rule_data as any;
          const match = v.match ?? 'contains';
          const confirm = v.confirm ? 'confirm' : 'silent';
          const actions = (rule.actions ?? []).map((a: any) =>
            `${a.field} ${a.mode} ${Array.isArray(a.value) ? a.value.join(', ') : a.value}`
          ).join(' | ');
          return `${base} · [RULE match:${match} ${confirm}] ${actions}`;
        }
        return base;
      }).join('\n')
    : '';

  const fieldKnowledge = await buildFieldKnowledge(user_id);

  return {
    situationBrief,
    recentMessages,
    bucketSnapshot,
    recentCompletions,
    meetingSnapshot,
    fcSnapshot,
    observations,
    availableTags,
    availableContexts,
    vocab,
    fieldKnowledge,
    conceptRegistry,
  };
}

// ── Deep context — analysis calls only ───────────────────────────────────────
export async function buildKarlDeepContext(user_id: string, context_filter: string | null = null): Promise<KarlDeepBundle> {
  const db = createSupabaseAdmin();
  const base = await buildKarlContext(user_id, context_filter);

  const { data: situation } = await db
    .from('user_situation').select('completion_window_days')
    .eq('user_id', user_id).eq('is_active', true).maybeSingle();

  const completionWindow = situation?.completion_window_days ?? 7;
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWindow);

  const { data: completions } = await db
    .from('completion').select('title, outcome, completed_at, tags, context_id')
    .eq('user_id', user_id).gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false });

  const completionIcon = base.conceptRegistry.find(c => c.concept_key === 'completion' && c.concept_type === 'object')?.icon ?? '🏆';

  const fullCompletions = completions?.length
    ? completions.map(c =>
        `${completionIcon} [${c.completed_at?.slice(0, 10)}] ${c.title}` +
        (c.outcome ? `\n  Outcome: ${c.outcome}` : '') +
        (c.tags?.length ? `\n  Tags: ${c.tags.join(', ')}` : '')
      ).join('\n\n')
    : 'no completions in window';

  const { data: tasks } = await db
    .from('task').select('title, bucket_key, tags, context:context_id(name)')
    .eq('user_id', user_id).eq('is_completed', false).eq('is_archived', false)
    .neq('bucket_key', 'capture');

  const byContext: Record<string, string[]> = {};
  for (const t of tasks ?? []) {
    const ctx = (t.context as any)?.name ?? 'No Context';
    if (!byContext[ctx]) byContext[ctx] = [];
    const tagStr = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
    const bucketConcept = base.conceptRegistry.find(c => c.concept_key === `bucket_${t.bucket_key}` && c.concept_type === 'bucket');
    const bucketLabel = bucketConcept ? `${bucketConcept.icon ?? ''} ${bucketConcept.label}`.trim() : t.bucket_key;
    byContext[ctx].push(`  ${bucketLabel} ${t.title}${tagStr}`);
  }
  const tasksByContext = Object.entries(byContext)
    .map(([ctx, items]) => `${ctx}:\n${items.join('\n')}`)
    .join('\n\n') || 'no curated tasks';

  return { ...base, fullCompletions, tasksByContext };
}

// ── Format bundle into system prompt string ───────────────────────────────────
export function formatContextForPrompt(bundle: KarlContextBundle): string {
  const parts: string[] = [];

  if (bundle.situationBrief) {
    parts.push(`## User Situation\n${bundle.situationBrief}`);
  } else {
    parts.push(`## User Situation\nNot yet configured. Encourage the user to write their situation brief.`);
  }

  parts.push(`## Current Task Load\nTasks identified as BucketN (e.g. N1, S2, RW1). Tags in brackets. Target date shown as "due YYYY-MM-DD". Notes indented below.\n${bundle.bucketSnapshot}`);
  parts.push(`## Recent Completions\nCompletions identified as CM1, CM2, etc.\n${bundle.recentCompletions}`);
  parts.push(`## Open Meetings\nMeetings identified as MT1, MT2, etc. Full notes included.\n${bundle.meetingSnapshot}`);
  parts.push(`## Other FC Objects\nCompletions (CM), Extracts (EX), Templates (TM), Contacts (CT) with full content.\n${bundle.fcSnapshot}`);

  if (bundle.observations) {
    parts.push(`## Karl's Observations\n${bundle.observations}`);
  }

  parts.push(`## Available Tags\nOnly use tags from this list.\n${bundle.availableTags}`);
  parts.push(`## Available Contexts\nFormat: Name|context_id. Use the UUID when returning context_id in JSON.\n${bundle.availableContexts}`);

  if (bundle.vocab) {
    parts.push(`## Learned Vocabulary & Rules
Phrases and rules this user has defined. Rules marked [RULE] have structured actions that fire automatically.
When input matches a rule trigger, apply the rule actions to the pending payload.
Rules with confirm:true → show in pending for user approval.
Rules with confirm:false (silent) → apply automatically, mention briefly in response.
\n${bundle.vocab}`);
  }

  if (bundle.fieldKnowledge) {
    parts.push(`## Field Knowledge\nFor every FC object field: what it is (what:) and how this user tends to use it (how:).\n${bundle.fieldKnowledge}`);
  }

  // Concept registry — Karl uses these icons/labels in all responses and document output
  if (bundle.conceptRegistry.length) {
    parts.push(`## Concept Registry
Use these icons and labels when referencing buckets, objects, and actions in chat responses and document output.
Labels reflect this user's implementation vocabulary (e.g. "Evidence" not "Completion" for pip users).
Always use the icon + label from this registry when displaying bucket names or object types.
\n${formatConceptRegistry(bundle.conceptRegistry)}`);
  }

  if ('fullCompletions' in bundle) {
    const deep = bundle as KarlDeepBundle;
    parts.push(`## Completion Detail (Evidence Record)\n${deep.fullCompletions}`);
    parts.push(`## Open Tasks by Context\n${deep.tasksByContext}`);
  }

  return parts.join('\n\n');
}

// ── Write a Karl observation ──────────────────────────────────────────────────
export async function writeKarlObservation(
  user_id: string,
  content: string,
  observation_type: 'pattern' | 'preference' | 'flag' = 'pattern',
  tags: string[] = []
): Promise<void> {
  const db = createSupabaseAdmin();

  const { count } = await db
    .from('karl_observation')
    .select('observation_id', { count: 'exact', head: true })
    .eq('user_id', user_id).eq('is_active', true);

  if ((count ?? 0) >= MAX_OBSERVATIONS) {
    const { data: oldest } = await db
      .from('karl_observation').select('observation_id')
      .eq('user_id', user_id).eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (oldest) {
      await db.from('karl_observation')
        .update({ is_active: false })
        .eq('observation_id', oldest.observation_id);
    }
  }

  await db.from('karl_observation').insert({ user_id, content, observation_type, tags });
}

// ── Update llm_notes on a field metadata row ──────────────────────────────────
export async function updateFieldLlmNotes(
  user_id: string,
  object_type: string,
  field: string,
  llm_notes: string
): Promise<void> {
  const db = createSupabaseAdmin();
  const { error } = await db
    .from('ko_field_metadata')
    .update({ llm_notes })
    .eq('user_id', user_id)
    .eq('object_type', object_type)
    .eq('field', field);
  if (error) console.error('[updateFieldLlmNotes]', error);
  else console.log(`[updateFieldLlmNotes] updated ${object_type}.${field}`);
}

// ── Upsert karl_vocab — simple phrase/intent tracking ────────────────────────
export async function upsertKarlVocab(
  user_id: string,
  phrase: string,
  intent: string,
  object_type: string
): Promise<void> {
  const db = createSupabaseAdmin();
  const normalised = phrase.toLowerCase().trim();
  const { data: existing } = await db
    .from('karl_vocab').select('vocab_id, use_count')
    .eq('user_id', user_id).eq('phrase', normalised).maybeSingle();
  if (existing) {
    await db.from('karl_vocab')
      .update({ use_count: existing.use_count + 1, last_used: new Date().toISOString() })
      .eq('vocab_id', existing.vocab_id);
  } else {
    await db.from('karl_vocab').insert({ user_id, phrase: normalised, intent, object_type, use_count: 1 });
  }
}

// ── Write a full vocab rule ───────────────────────────────────────────────────
export async function writeKarlVocabRule(
  user_id: string,
  phrase: string,
  description: string,
  rule_data: Record<string, any>,
  match: 'contains' | 'exact' | 'starts_with' = 'contains',
  confirm: boolean = true
): Promise<{ vocab_id: string } | null> {
  const db = createSupabaseAdmin();
  const normalised = phrase.toLowerCase().trim();

  const { data: existing } = await db
    .from('karl_vocab').select('vocab_id')
    .eq('user_id', user_id).eq('phrase', normalised).maybeSingle();

  if (existing) {
    await db.from('karl_vocab')
      .update({ rule_data, match, confirm, description, last_used: new Date().toISOString() })
      .eq('vocab_id', existing.vocab_id);
    return { vocab_id: existing.vocab_id };
  }

  const { data } = await db.from('karl_vocab').insert({
    user_id, phrase: normalised, intent: 'rule',
    object_type: rule_data.applies_to ?? 'task',
    rule_data, match, confirm, use_count: 0,
  }).select('vocab_id').single();

  return data ? { vocab_id: data.vocab_id } : null;
}

// ── Delete/deactivate a vocab rule ────────────────────────────────────────────
export async function deleteKarlVocabRule(user_id: string, vocab_id: string): Promise<void> {
  const db = createSupabaseAdmin();
  await db.from('karl_vocab').update({ is_active: false }).eq('vocab_id', vocab_id).eq('user_id', user_id);
}

// ── Touch last_used on rule fire ──────────────────────────────────────────────
export async function touchKarlVocabRule(user_id: string, vocab_id: string): Promise<void> {
  const db = createSupabaseAdmin();
  const { data: existing } = await db.from('karl_vocab').select('use_count').eq('vocab_id', vocab_id).maybeSingle();
  await db.from('karl_vocab')
    .update({ use_count: (existing?.use_count ?? 0) + 1, last_used: new Date().toISOString() })
    .eq('vocab_id', vocab_id).eq('user_id', user_id);
}

// ── Load active rules for matching ───────────────────────────────────────────
export async function loadActiveVocabRules(user_id: string): Promise<Array<{
  vocab_id: string; phrase: string; match: string; confirm: boolean; rule_data: Record<string, any>;
}>> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('karl_vocab').select('vocab_id, phrase, match, confirm, rule_data')
    .eq('user_id', user_id).eq('is_active', true).not('rule_data', 'is', null)
    .order('use_count', { ascending: false });
  return (data ?? []).filter(r => r.rule_data) as any;
}

// ── Append a message to session history ──────────────────────────────────────
export async function appendSessionMessage(
  user_id: string,
  role: 'user' | 'karl',
  content: string
): Promise<void> {
  const db = createSupabaseAdmin();
  const { data: session } = await db
    .from('ko_session').select('ko_session_id, messages')
    .eq('user_id', user_id).maybeSingle();
  if (!session) return;
  const { data: situation } = await db
    .from('user_situation').select('chat_history_depth')
    .eq('user_id', user_id).eq('is_active', true).maybeSingle();
  const maxDepth = situation?.chat_history_depth ?? 15;
  const messages: ChatMessage[] = session.messages ?? [];
  messages.push({ role, content, ts: new Date().toISOString() });
  const trimmed = messages.slice(-maxDepth * 2);
  await db.from('ko_session').update({ messages: trimmed }).eq('ko_session_id', session.ko_session_id);
}