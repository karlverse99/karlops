// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and enrichment
// v0.8.0 — Generic action map, chained actions, modal-ready pending, learning write-back

import { createSupabaseAdmin } from '@/lib/supabase-server';
import {
  buildKarlContext,
  buildKarlDeepContext,
  formatContextForPrompt,
  appendSessionMessage,
  writeKarlObservation,
  upsertKarlVocab,
  updateFieldLlmNotes,
} from '@/lib/ko/buildKarlContext';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type IntentType =
  | 'execute'
  | 'pending'
  | 'modify_pending'
  | 'confirm_pending'
  | 'cancel_pending'
  | 'preview_pending'
  | 'open_form'
  | 'question'
  | 'command'
  | 'unclear';

// Action types Karl can propose
export type ActionType =
  | 'insert'           // create any FC object
  | 'update'           // update any FC object (generic field ops)
  | 'complete'         // complete a task or meeting (two-step, produces completion record)
  | 'archive'          // set is_archived = true
  | 'delete'           // hard delete
  | 'refine'           // iterate on extract content in chat
  | 'run_template'     // run a template — preview in chat or save as extract
  | 'capture_tasks'    // bulk task insert (kept named — special bulk flow)
  | 'create_tag'       // propose a new tag (always pending, never silent)
  | 'summarize'        // no DB write — Karl summarizes content in chat

export interface KarlAction {
  action: ActionType;
  object_type?: string;           // FC object: task | completion | meeting | external_reference | document_template | contact | tag
  modal?: string;                 // modal to open if user wants UI escape hatch
  fields?: Record<string, any>;  // fields for insert/update
  tasks?: any[];                  // bulk tasks (capture_tasks only)
  operations?: UpdateOperation[]; // field operations for update
  identifier?: string;            // e.g. N3, MT1, EX2
  target_identifier?: string;     // for complete/refine/run — which object
  run_mode?: 'preview' | 'save';  // run_template: preview in chat or save as extract
  learning?: KarlLearning;        // write-back on new patterns
}

export interface UpdateOperation {
  field: string;
  value: string | string[];
  mode?: 'set' | 'append' | 'add' | 'remove'; // default: set
}

export interface KarlLearning {
  vocab?: { term: string; maps_to: string };         // new user term → object_type or action
  field_notes?: { object_type: string; field: string; llm_notes: string };
  observation?: { content: string; observation_type: 'pattern' | 'preference' | 'flag' };
}

export interface RouterResult {
  intent: IntentType;
  actions?: KarlAction[];   // v0.8.0 — array of actions replacing single payload
  payload?: Record<string, any>; // kept for backwards compat on execute
  response?: string;
  error?: string;
}

interface FieldMeta {
  object_type: string;
  field: string;
  label: string;
  field_type: string;
  insert_behavior: string;
  update_behavior: string;
  description?: string;
  llm_notes?: string;
}

export const OBJECT_TABLE: Record<string, string> = {
  task:               'task',
  completion:         'completion',
  meeting:            'meeting',
  external_reference: 'external_reference',
  document_template:  'document_template',
  contact:            'contact',
  tag:                'tag',
};

export const OBJECT_PK: Record<string, string> = {
  task:               'task_id',
  completion:         'completion_id',
  meeting:            'meeting_id',
  external_reference: 'external_reference_id',
  document_template:  'document_template_id',
  contact:            'contact_id',
  tag:                'tag_id',
};

export const OBJECT_MODAL: Record<string, string> = {
  task:               'TaskDetailModal', // existing task — use TaskDetailModal. New task insert uses TaskAddModal explicitly.
  completion:         'CompletionsModal',
  meeting:            'MeetingsModal',
  external_reference: 'ExtractsModal',
  document_template:  'TemplatesModal',
  contact:            'ContactsModal',
  tag:                'TagManagerModal',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const ANALYSIS_TRIGGERS = [
  'analyze', 'analysis', 'review', 'summarize', 'summary',
  'make the case', 'what have i done', 'show me', 'evidence',
  'how am i doing', 'this week', 'this month',
  'against my', 'pip', 'requirement', 'progress',
];

function isAnalysisRequest(input: string): boolean {
  const lower = input.toLowerCase();
  return ANALYSIS_TRIGGERS.some(t => lower.includes(t));
}

function isLongInput(input: string): boolean {
  return input.length > 500 || input.split('\n').length > 15;
}

// ─── PEOPLE TAG RESOLUTION ────────────────────────────────────────────────────

interface PeopleTag {
  tag_id: string;
  name: string;
  description: string | null;
}

async function resolveDelegatee(user_id: string, nameHint: string): Promise<{ tag_id: string; name: string } | null> {
  if (!nameHint || nameHint.toLowerCase() === 'skip' || nameHint.toLowerCase() === 'other') {
    return resolveOtherTag(user_id);
  }

  const db = createSupabaseAdmin();
  const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
  if (!peopleGroup) return null;

  const { data: peopleTags } = await db.from('tag').select('tag_id, name, description').eq('user_id', user_id).eq('tag_group_id', peopleGroup.tag_group_id).eq('is_archived', false);
  const tags: PeopleTag[] = peopleTags ?? [];
  const hint = nameHint.toLowerCase().trim();

  let match = tags.find(t => t.name === nameHint);
  if (match) return { tag_id: match.tag_id, name: match.name };
  match = tags.find(t => t.name.toLowerCase() === hint);
  if (match) return { tag_id: match.tag_id, name: match.name };
  match = tags.find(t => t.name.toLowerCase().includes(hint) || hint.includes(t.name.toLowerCase()));
  if (match) return { tag_id: match.tag_id, name: match.name };
  match = tags.find(t => t.description && t.description.toLowerCase().includes(hint));
  if (match) return { tag_id: match.tag_id, name: match.name };

  const { data: contacts } = await db.from('contact').select('name, notes, tag_id').eq('user_id', user_id).eq('is_archived', false);
  for (const contact of contacts ?? []) {
    const nameMatch  = contact.name?.toLowerCase().includes(hint) || hint.includes(contact.name?.toLowerCase() ?? '');
    const notesMatch = contact.notes?.toLowerCase().includes(hint);
    if ((nameMatch || notesMatch) && contact.tag_id) {
      const contactTag = tags.find(t => t.tag_id === contact.tag_id);
      if (contactTag) return { tag_id: contactTag.tag_id, name: contactTag.name };
    }
  }
  return null;
}

async function resolveOtherTag(user_id: string): Promise<{ tag_id: string; name: string } | null> {
  const db = createSupabaseAdmin();
  const { data } = await db.from('tag').select('tag_id, name').eq('user_id', user_id).eq('name', 'Other').eq('is_archived', false).maybeSingle();
  if (data) return { tag_id: data.tag_id, name: data.name };

  const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
  if (!peopleGroup) return null;
  const { data: otherTag } = await db.from('tag').select('tag_id, name').eq('user_id', user_id).eq('tag_group_id', peopleGroup.tag_group_id).eq('name', 'Other').maybeSingle();
  return otherTag ? { tag_id: otherTag.tag_id, name: otherTag.name } : null;
}

async function createPeopleTag(user_id: string, name: string): Promise<{ tag_id: string; name: string } | null> {
  const db = createSupabaseAdmin();
  const { data: peopleGroup } = await db.from('tag_group').select('tag_group_id').eq('user_id', user_id).eq('name', 'People').maybeSingle();
  if (!peopleGroup) return null;
  const { data } = await db.from('tag').insert({ user_id, tag_group_id: peopleGroup.tag_group_id, name: name.trim(), is_archived: false }).select('tag_id, name').single();
  return data ?? null;
}

// ─── TAG SUGGESTION ───────────────────────────────────────────────────────────

async function suggestTagsForCapture(
  user_id: string,
  context_text: string,
  already_tagged: string[],
  rejected_tags: string[] = []
): Promise<string[]> {
  const db = createSupabaseAdmin();
  try {
    const [tagGroupRes, tagRes, situationRes, obsRes] = await Promise.all([
      db.from('tag_group').select('tag_group_id, name').eq('user_id', user_id).eq('is_archived', false).order('display_order'),
      db.from('tag').select('name, description, tag_group_id').eq('user_id', user_id).eq('is_archived', false).order('name'),
      db.from('user_situation').select('brief').eq('user_id', user_id).eq('is_active', true).maybeSingle(),
      db.from('karl_observation').select('content, observation_type').eq('user_id', user_id).eq('is_active', true).order('created_at', { ascending: false }).limit(10),
    ]);

    const tagGroups    = tagGroupRes.data ?? [];
    const existingTags = tagRes.data ?? [];
    const situation    = situationRes.data?.brief?.trim() ?? '';
    const observations = (obsRes.data ?? []).map(o => `[${o.observation_type}] ${o.content}`).join('\n');

    if (existingTags.length === 0) return [];

    const groupMap: Record<string, string> = {};
    for (const g of tagGroups) groupMap[g.tag_group_id] = g.name;

    const existingTagList = existingTags
      .map(t => `${t.name} [${groupMap[t.tag_group_id] ?? 'General'}]${t.description ? ` (${t.description})` : ''}`)
      .join(', ');

    const rejectedNote = rejected_tags.length
      ? `\nNEVER suggest these (user rejected): ${rejected_tags.join(', ')}`
      : '';

    const systemPrompt = `You are Karl, suggesting tags for a KarlOps object being captured via chat.
Suggest 1-3 existing tags that fit the content. Existing tags only — do not invent new ones.

Existing tags: ${existingTagList}
Already tagged (do not re-suggest): ${already_tagged.join(', ') || 'none'}
User situation: ${situation || 'Not provided.'}
${observations ? `Karl observations:\n${observations}` : ''}${rejectedNote}

Rules:
- Suggest 1-3 tags maximum from the existing list only
- Only suggest tags you are confident fit
- Do NOT suggest People/Roles/Organizations tags unless explicitly mentioned
- Return ONLY valid JSON, no markdown: { "suggested": ["Tag1", "Tag2"] }`;

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
        max_tokens: 200,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Content to tag: ${context_text}` }],
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[suggestTagsForCapture] tokens:', {
      input: usage.input_tokens, output: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
    });

    const text = data.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const existingNames = new Set(existingTags.map(t => t.name));
    return (parsed.suggested ?? []).filter((name: string) =>
      existingNames.has(name) && !already_tagged.includes(name) && !rejected_tags.includes(name)
    );
  } catch (err) {
    console.error('[suggestTagsForCapture]', err);
    return [];
  }
}

// ─── FIELD SUMMARY BUILDERS ───────────────────────────────────────────────────

function buildFieldKnowledge(meta: FieldMeta[]): string {
  const byType: Record<string, FieldMeta[]> = {};
  for (const f of meta) {
    if (!byType[f.object_type]) byType[f.object_type] = [];
    byType[f.object_type].push(f);
  }
  return Object.entries(byType).map(([type, fields]) => {
    const lines = [`${type}:`];
    for (const f of fields) {
      const behavior = `insert:${f.insert_behavior} update:${f.update_behavior}`;
      const notes = f.llm_notes ? ` — ${f.llm_notes}` : '';
      const desc = f.description ? ` (${f.description})` : '';
      lines.push(`  ${f.field} [${f.field_type}] ${behavior}${desc}${notes}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

function buildObjectSummaries(meta: FieldMeta[]): string {
  const byType: Record<string, FieldMeta[]> = {};
  for (const f of meta) {
    if (!byType[f.object_type]) byType[f.object_type] = [];
    byType[f.object_type].push(f);
  }
  return Object.entries(byType).map(([type, fields]) => {
    const required = fields.filter(f => f.insert_behavior === 'required').map(f => f.label).join(', ');
    return `- ${type}: required fields are ${required || 'none'}`;
  }).join('\n');
}

// ─── FORMAT PENDING FOR KARL ──────────────────────────────────────────────────

const BUCKET_LABEL: Record<string, string> = {
  now: 'On Fire', soon: 'Up Next', realwork: 'Real Work',
  later: 'Later', delegate: 'Delegated', capture: 'Capture',
};

function formatPendingForPrompt(pending: Record<string, any> | null): string {
  if (!pending) return '';

  const lines = ['## Current Pending Actions'];

  // v0.8.0 — actions array
  const actions: any[] = pending.actions ?? [];

  if (actions.length > 0) {
    actions.forEach((a: any, i: number) => {
      lines.push(`\nAction ${i + 1}: ${a.action} ${a.object_type ?? ''}`);
      if (a.fields) {
        for (const [k, v] of Object.entries(a.fields)) {
          if (v === null || v === undefined) continue;
          const display = Array.isArray(v) ? v.join(', ') : String(v);
          lines.push(`  ${k}: ${display}`);
        }
      }
      if (a.tasks?.length) {
        lines.push(`  tasks (${a.tasks.length}):`);
        a.tasks.forEach((t: any, j: number) => lines.push(`    ${j + 1}. ${t.title} → ${BUCKET_LABEL[t.bucket_key] ?? t.bucket_key ?? 'Capture'}`));
      }
      if (a.operations?.length) {
        const ops = a.operations.map((op: any) => `${op.field} → ${op.value}`).join(', ');
        lines.push(`  operations: ${ops}`);
      }
    });
  } else {
    // Legacy single-action pending — backwards compat
    lines.push(`Intent: ${pending.intent ?? pending.action}`);
    if (pending.title) lines.push(`Title: ${pending.title}`);
    if (pending.bucket_key) lines.push(`Bucket: ${BUCKET_LABEL[pending.bucket_key] ?? pending.bucket_key}`);
    if (pending.tags?.length) lines.push(`Tags: ${pending.tags.join(', ')}`);
    if (pending.tasks?.length) {
      lines.push(`Tasks (${pending.tasks.length}):`);
      pending.tasks.forEach((t: any, i: number) => lines.push(`  ${i + 1}. ${t.title} → ${BUCKET_LABEL[t.bucket_key] ?? t.bucket_key ?? 'Capture'}`));
    }
  }

  lines.push('');
  lines.push('## ABSOLUTE RULE — RETURN VALID JSON ONLY');
  lines.push('There is a pending action. The user is responding to it.');
  lines.push('You MUST return a JSON object. NO prose. NO code fences. NO markdown.');
  lines.push('User confirms → { "intent": "confirm_pending", "response": "plain English" }');
  lines.push('User cancels → { "intent": "cancel_pending", "response": "Cancelled." }');
  lines.push('User modifies → { "intent": "modify_pending", "actions": [...updated actions...], "response": "Updated. Confirm?" }');
  lines.push('User asks to preview → { "intent": "preview_pending", "response": "exact field-by-field description of what will be written" }');
  lines.push('User asks to open modal → { "intent": "question", "open_modal": true, "response": "Open what, dimrod? [list the objects]" }');
  lines.push('DO NOT re-emit full payloads on confirm. Just confirm.');

  return lines.join('\n');
}

// ─── LEARNING WRITE-BACK ──────────────────────────────────────────────────────

async function persistLearning(user_id: string, learning: KarlLearning): Promise<void> {
  if (learning.vocab?.term && learning.vocab?.maps_to) {
    upsertKarlVocab(user_id, learning.vocab.term, 'pending', learning.vocab.maps_to).catch(() => {});
  }
  if (learning.field_notes?.object_type && learning.field_notes?.field && learning.field_notes?.llm_notes) {
    updateFieldLlmNotes(
      user_id,
      learning.field_notes.object_type,
      learning.field_notes.field,
      learning.field_notes.llm_notes
    ).catch(() => {});
  }
  if (learning.observation?.content) {
    const obsType = (['pattern', 'preference', 'flag'] as const).includes(learning.observation.observation_type)
      ? learning.observation.observation_type
      : 'pattern';
    writeKarlObservation(user_id, learning.observation.content, obsType).catch(() => {});
  }
}

// ─── ENRICH ACTIONS ──────────────────────────────────────────────────────────
// Post-process Karl's proposed actions:
// - resolve delegated_to to tag_id
// - run tag suggestion on inserts
// - attach modal name if missing

async function enrichActions(
  user_id: string,
  actions: KarlAction[],
  rejectedTags: string[],
  isModify: boolean
): Promise<KarlAction[]> {
  return Promise.all(actions.map(async (a) => {
    // Attach modal
    if (!a.modal && a.object_type) {
      a.modal = OBJECT_MODAL[a.object_type] ?? undefined;
    }

    // Tag suggestion on insert/capture
    if (!isModify && (a.action === 'insert' || a.action === 'capture_tasks')) {
      if (a.fields?.tags !== undefined) {
        const existing = (a.fields.tags as string[]).filter(t => !rejectedTags.includes(t));
        const contextText = [a.fields.title, a.fields.description, a.fields.notes].filter(Boolean).join(' ');
        const suggested = await suggestTagsForCapture(user_id, contextText, existing, rejectedTags);
        a.fields.tags = Array.from(new Set([...existing, ...suggested])).slice(0, 5);
      }
      if (a.tasks?.length) {
        const combinedTitles = a.tasks.map((t: any) => t.title).join(', ');
        const suggested = await suggestTagsForCapture(user_id, combinedTitles, [], rejectedTags);
        a.tasks = a.tasks.map((t: any) => {
          const taskTags = (t.tags ?? []).filter((tag: string) => !rejectedTags.includes(tag));
          return { ...t, tags: Array.from(new Set([...taskTags, ...suggested])).slice(0, 5) };
        });
      }
    }

    // Resolve delegated_to on task inserts
    if (a.action === 'insert' && a.object_type === 'task' && a.fields?.delegated_to && typeof a.fields.delegated_to === 'string') {
      const resolved = await resolveDelegatee(user_id, a.fields.delegated_to)
        ?? await createPeopleTag(user_id, a.fields.delegated_to)
        ?? await resolveOtherTag(user_id);
      if (resolved) a.fields.delegated_to = resolved.tag_id;
    }

    // Resolve delegated_to on update operations
    if (a.action === 'update' && a.operations) {
      a.operations = await Promise.all(a.operations.map(async (op) => {
        if (op.field === 'delegated_to' && typeof op.value === 'string') {
          const resolved = await resolveDelegatee(user_id, op.value)
            ?? await createPeopleTag(user_id, op.value)
            ?? await resolveOtherTag(user_id);
          return resolved ? { ...op, value: resolved.tag_id } : op;
        }
        return op;
      }));
    }

    return a;
  }));
}

// ─── MAIN ROUTER ──────────────────────────────────────────────────────────────

export async function routeCommand(
  user_id: string,
  input: string,
  pending: Record<string, any> | null = null,
  context_filter: string | null = null
): Promise<RouterResult> {
  const db = createSupabaseAdmin();

  try {
    const { data: allMeta } = await db
      .from('ko_field_metadata')
      .select('object_type, field, label, field_type, insert_behavior, update_behavior, description, llm_notes')
      .eq('user_id', user_id)
      .in('object_type', ['task', 'meeting', 'completion', 'external_reference', 'document_template', 'contact']);

    const meta = allMeta ?? [];
    const objectSummaries = buildObjectSummaries(meta);
    const fieldKnowledge  = buildFieldKnowledge(meta);

    const isDeep     = isAnalysisRequest(input);
    const hasPending = !!pending;
    const isLong     = isLongInput(input);

    const bundle = isDeep
      ? await buildKarlDeepContext(user_id, context_filter)
      : await buildKarlContext(user_id, context_filter);

    const contextBlock = formatContextForPrompt(bundle);
    const pendingBlock = formatPendingForPrompt(pending);

    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [
      ...bundle.recentMessages.map(m => ({
        role: (m.role === 'karl' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input },
    ];
    while (anthropicMessages.length > 1 && anthropicMessages[0].role === 'assistant') {
      anthropicMessages.shift();
    }

    // Rejected tags from recent chat
    const rejectedTags: string[] = [];
    const rejectPattern = /don'?t (?:use|want|include)\s+#?([A-Za-z0-9/_\-]+)/gi;
    for (const msg of bundle.recentMessages) {
      if (msg.role !== 'user') continue;
      let match;
      rejectPattern.lastIndex = 0;
      while ((match = rejectPattern.exec(msg.content)) !== null) {
        rejectedTags.push(match[1]);
      }
    }
    const rejectedTagsNote = rejectedTags.length > 0
      ? `\n## Rejected Tags — NEVER suggest these\n${rejectedTags.join(', ')}`
      : '';

    const observationInstructions = bundle.observations
      ? `## Your Observations About This User\nYou have noticed these patterns. Use them actively.\n${bundle.observations}`
      : '';

    const systemPrompt = [
      `You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done. [v0.8.0]`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}. When a user gives a date without a year, infer the year from today. Use current year unless the date has already passed this year, in which case use next year.`,
      '',
      contextBlock,
      '',
      pendingBlock,
      '',
      observationInstructions,
      '',
      '## Your Job',
      'Every user message comes to you. You decide what to do. No hardcoded action maps. No state machine. Just reason.',
      'You know the full schema via Field Knowledge below. Use it. If something is new, reason from what you know and ask.',
      '',
      '## FC Objects — What Karl Can Work With',
      'task, completion, meeting, external_reference (extract), document_template (template), contact, tag',
      '',
      '## Actions Karl Can Propose',
      '- insert        — create any FC object. Use field knowledge to know what fields are required.',
      '- update        — update any FC object. Use identifier (e.g. N3, MT1) + operations array.',
      '- complete      — complete a task or meeting. Two-step: ask for outcome first, then pending.',
      '- archive       — set is_archived = true on any FC object.',
      '- delete        — hard delete. Karl must always warn this is permanent.',
      '- refine        — iterate on extract content in chat. No immediate DB write.',
      '- run_template  — run a template. run_mode: preview (show in chat) or save (creates extract).',
      '- capture_tasks — bulk task insert. Special flow — keeps tasks array.',
      '- create_tag    — propose a new tag. ALWAYS pending. Never silent.',
      '- summarize     — no DB write. Karl summarizes content in chat response.',
      '',
      '## Decision Flow — Follow This Every Time',
      '1. Is this a question/conversation, or a KarlOps operation?',
      '   QUESTION → intent: question. Answer directly. No pending.',
      '   OPERATION → proceed.',
      '',
      '2. What FC object(s) are involved? What action(s) are needed?',
      '   Can be multiple — a document might produce a meeting + tasks. Build actions array.',
      '',
      '3. Do I have enough data?',
      '   - Quick capture signal ("quick add", "just add it", "fast add") → intent: execute.',
      '   - Have enough → intent: pending. Show proposed actions clearly.',
      '   - Missing something critical → intent: question. Ask for that one thing only.',
      '',
      '4. Pending action exists?',
      '   - Confirm ("yes", "go", "do it", "yep", "correct", "save it", "add these") → confirm_pending',
      '   - Cancel ("no", "cancel", "nevermind") → cancel_pending',
      '   - Modify ("change X", "remove that", "actually...") → modify_pending with updated actions array',
      '   - Preview ("show me", "what will you create", "let me see") → preview_pending with EXACT field-by-field description',
      '   - Open modal ("open it", "show me the form") → ask which object if multiple actions',
      '   - New unrelated input → replace pending with new intent',
      '',
      '## RULE — Proposals always use intent: pending',
      'Any time Karl proposes an action and asks the user to confirm — insert, update, complete, delete, anything — return intent: pending.',
      'intent: question is ONLY for answers that require no DB write and no user confirmation.',
      'NEVER ask "want me to capture these?" as a question. If Karl is proposing captures, return intent: pending with capture_tasks.',
      '',
      '## RULE — GIGO. Karl never writes without user approval.',
      'Every DB write requires explicit user confirmation. No silent writes. Ever.',
      'create_tag is ALWAYS pending. Tags are never created silently.',
      'Karl can suggest anything. Karl never does anything without a confirm.',
      '',
      '## RULE — Preview means exact.',
      'When user asks to preview, Karl shows exactly what will hit the DB — every field, every value.',
      'Not a summary. Not an approximation. Exactly what will be written.',
      '',
      '## RULE — Chained actions.',
      'A single user input can produce multiple actions. A document might produce a meeting + tasks.',
      'Build the full actions array. User confirms or modifies the whole chain.',
      'If user says "skip the meeting, just the tasks" — drop that action from the array, re-present.',
      '',
      '## RULE — complete is two-step.',
      'STEP 1: Ask for outcome. STEP 2: pending with complete action.',
      'EXCEPTION: "no outcome" / "just mark it done" → skip to pending immediately.',
      '',
      '## RULE — delete always warns.',
      'Karl must always say "this is permanent" before proposing a delete.',
      '',
      '## RULE — run_template.',
      'Ask user: preview in chat, or save as extract? Set run_mode accordingly.',
      '',
      '## RULE — Karl can update any field shown in Field Knowledge.',
      'Do not tell the user you cannot access a field. If it is in Field Knowledge with update:editable, you can update it.',
      'target_date, notes, bucket_key, tags, status — all editable. Just propose the update and confirm.',
      '',
      '## RULE — New patterns → write back.',
      'If Karl figures out something new (a user term maps to an object, a field behaves differently than expected),',
      'include a "learning" block in the response. Route will persist it.',
      '',
      '## Vocabulary',
      '- bucket aliases: "fire"/"on fire" → now, "up next" → soon, "real work" → realwork',
      '- "code it to X" / "context X" → context_id (resolve from context list)',
      '- "by DATE" / "due DATE" → target_date (ISO YYYY-MM-DD)',
      '- "delegate to X" → bucket=delegate + delegated_to=X (name, Karl resolves to tag_id)',
      '- Bucket human labels: On Fire, Up Next, Real Work, Later, Delegated, Capture',
      '',
      '## Task Identifiers',
      'N=now, S=soon, RW=realwork, L=later, D=delegate, CP=capture',
      'CM=completion, MT=meeting, EX=extract, TM=template, CT=contact',
      'Format: prefix+number e.g. N1, S2, MT3, EX1',
      '',
      '## Available Object Types + Required Fields',
      objectSummaries,
      '',
      '## Field Knowledge — Reason From This',
      'This is your schema. Use it to know what fields to populate for any insert or update.',
      fieldKnowledge,
      '',
      rejectedTagsNote,
      '',
      isDeep ? '## Analysis Mode\nInclude "learning.observation" with pattern noticed.\n' : '',
      '',
      '## Response Format — ONLY valid JSON, no markdown, no code fences',
      '',
      '// Quick capture (no confirm):',
      '{ "intent": "execute", "actions": [{ "action": "insert", "object_type": "task", "modal": "TaskAddModal", "fields": { "title": "...", "bucket_key": "capture", "tags": [], "notes": null, "target_date": null, "context_id": null } }], "response": "Got it." }',
      '',
      '// Single insert pending:',
      '{ "intent": "pending", "actions": [{ "action": "insert", "object_type": "meeting", "modal": "MeetingsModal", "fields": { "title": "...", "meeting_date": "2026-04-17T00:00:00", "attendees": ["Name"], "tags": ["Tag1"], "notes": "...", "context_name": "Context or null" } }], "response": "Here is what I have:\\nMeeting — [title]\\nDate — [date]\\n\\nConfirm or tell me what to change." }',
      '',
      '// Chained actions (document → meeting + tasks):',
      '{ "intent": "pending", "actions": [{ "action": "insert", "object_type": "meeting", "modal": "MeetingsModal", "fields": { "title": "...", "meeting_date": "...", "attendees": [], "tags": [], "notes": "..." } }, { "action": "capture_tasks", "object_type": "task", "modal": "TaskAddModal", "tasks": [{ "title": "task 1", "bucket_key": "capture", "tags": [] }] }], "response": "Found a meeting and N tasks:\\n\\nMeeting — [title]\\nTasks:\\n1. [title]\\n...\\n\\nWant to see exactly what I\'ll create, or confirm?" }',
      '',
      '// Update existing — single field:',
      '{ "intent": "pending", "actions": [{ "action": "update", "object_type": "task", "identifier": "N3", "modal": "TaskDetailModal", "operations": [{ "field": "bucket_key", "value": "soon", "mode": "set" }] }], "response": "Moving N3 to Up Next. Confirm?" }',
      '',
      '// Update tags — one operation per tag, never comma-separated values:',
      '{ "intent": "pending", "actions": [{ "action": "update", "object_type": "task", "identifier": "S3", "modal": "TaskDetailModal", "operations": [{ "field": "tags", "value": "Vendor", "mode": "remove" }, { "field": "tags", "value": "Technology", "mode": "remove" }] }], "response": "Removing Vendor and Technology from S3. Confirm?" }',
      '',
      '// Complete (step 2 — after outcome collected):',
      '{ "intent": "pending", "actions": [{ "action": "complete", "object_type": "task", "identifier": "N1", "fields": { "outcome": "..." } }], "response": "Marking N1 complete. Confirm?" }',
      '',
      '// Archive:',
      '{ "intent": "pending", "actions": [{ "action": "archive", "object_type": "task", "identifier": "S2" }], "response": "Archiving S2. Confirm?" }',
      '',
      '// Delete (always warn):',
      '{ "intent": "pending", "actions": [{ "action": "delete", "object_type": "task", "identifier": "CP4" }], "response": "This is permanent. Delete CP4? Confirm?" }',
      '',
      '// Create tag (always pending):',
      '{ "intent": "pending", "actions": [{ "action": "create_tag", "object_type": "tag", "fields": { "name": "TagName", "tag_group": "Activities", "description": "..." } }], "response": "New tag: TagName (Activities). Confirm?" }',
      '',
      '// Run template:',
      '{ "intent": "pending", "actions": [{ "action": "run_template", "target_identifier": "TM2", "run_mode": "preview" }], "response": "Running TM2 against current data. Preview in chat or save as extract?" }',
      '',
      '// Confirm:',
      '{ "intent": "confirm_pending", "response": "Done." }',
      '',
      '// Cancel:',
      '{ "intent": "cancel_pending", "response": "Cancelled." }',
      '',
      '// Preview — EXACT field-by-field:',
      '{ "intent": "preview_pending", "response": "Here is exactly what I will create:\\n\\nMeeting\\n  Title: ...\\n  Date: ...\\n  Attendees: ...\\n  Tags: ...\\n\\nTasks (N):\\n  1. title → bucket · tags\\n  ..." }',
      '',
      '// Modify pending:',
      '{ "intent": "modify_pending", "actions": [...complete updated actions array...], "response": "Updated. Confirm?" }',
      '',
      '// Open form — multiple objects:',
      '{ "intent": "question", "open_modal": true, "response": "Open what, dimrod? I have a meeting and 8 tasks pending." }',
      '',
      '// Open existing task by identifier:',
      '{ "intent": "open_form", "modal": "TaskDetailModal", "identifier": "N1", "response": "Opening N1." }',
      '',
      '// Open non-task FC object:',
      '{ "intent": "open_form", "modal": "MeetingsModal", "identifier": "MT2", "response": "Opening MT2." }',
      '',
      '// Open add form (no existing object):',
      '{ "intent": "open_form", "modal": "TaskAddModal", "response": "Opening a new task form." }',
      '',
      '// Question / analysis:',
      '{ "intent": "question", "response": "Karl answer in plain English" }',
      '',
      '// With learning write-back:',
      '{ "intent": "pending", "actions": [...], "response": "...", "learning": { "vocab": { "term": "report", "maps_to": "document_template" }, "observation": { "content": "User calls output documents reports", "observation_type": "preference" } } }',
      '',
      isDeep ? '{ "intent": "question", "response": "...", "learning": { "observation": { "content": "pattern", "observation_type": "pattern" } } }' : '',
    ].filter(Boolean).join('\n');

    // Token budget
    const maxTokens = isDeep ? 1500
      : hasPending ? 3000
      : isLong ? 2000
      : 1000;

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
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages,
      }),
    });

    const rawData = await res.json();
    const usage = rawData.usage;
    if (usage) console.log('[commandRouter] tokens:', {
      input: usage.input_tokens, output: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
    });

    const text = rawData.content?.[0]?.text ?? '';
    let parsed: any;

    // Three-layer JSON parse
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
      }
    }

    if (!parsed) {
      console.error('[commandRouter] JSON parse failed. Raw:', text);
      if (text?.length > 10) {
        await appendSessionMessage(user_id, 'user', input);
        await appendSessionMessage(user_id, 'karl', text);
        return { intent: 'question', response: text };
      }
      return { intent: 'unclear', response: 'Something went wrong parsing that. Try again.' };
    }

    const intent       = parsed.intent as IntentType;
    const karlResponse = parsed.response ?? "I'm not sure what to do with that.";

    await appendSessionMessage(user_id, 'user', input);
    await appendSessionMessage(user_id, 'karl', karlResponse);

    // Learning write-back — any intent can include learning
    if (parsed.learning) {
      persistLearning(user_id, parsed.learning).catch(() => {});
    }

    // Vocab on recognised captures (backwards compat)
    if (parsed.recognised_phrase && (intent === 'pending' || intent === 'execute')) {
      upsertKarlVocab(user_id, parsed.recognised_phrase, intent, 'task').catch(() => {});
    }

    // ── execute ────────────────────────────────────────────────────────────
    if (intent === 'execute') {
      const actions: KarlAction[] = parsed.actions ?? [];
      // Backwards compat: if Karl returned old single-action shape
      if (actions.length === 0 && parsed.title) {
        actions.push({
          action: 'insert',
          object_type: 'task',
          modal: 'TaskAddModal',
          fields: {
            title: parsed.title,
            bucket_key: parsed.bucket_key ?? 'capture',
            context_id: parsed.context_id ?? null,
            tags: parsed.tags ?? [],
            notes: parsed.notes ?? null,
            target_date: parsed.target_date ?? null,
            delegated_to: parsed.delegated_to ?? null,
          },
        });
      }
      return { intent: 'execute', actions, response: karlResponse };
    }

    // ── pending / modify_pending ───────────────────────────────────────────
    if (intent === 'pending' || intent === 'modify_pending') {
      const isModify = intent === 'modify_pending';
      let actions: KarlAction[] = parsed.actions ?? [];

      // Backwards compat: old single-action shape
      if (actions.length === 0) {
        const action = parsed.action ?? 'insert';
        if (action === 'capture_tasks' && parsed.tasks?.length) {
          actions = [{ action: 'capture_tasks', object_type: 'task', modal: 'TaskAddModal', tasks: parsed.tasks }];
        } else if (action === 'capture_task' || action === 'insert') {
          actions = [{
            action: 'insert', object_type: parsed.object_type ?? 'task', modal: OBJECT_MODAL[parsed.object_type ?? 'task'],
            fields: {
              title: parsed.title, bucket_key: parsed.bucket_key ?? 'capture',
              context_id: parsed.context_id ?? null, tags: parsed.tags ?? [],
              notes: parsed.notes ?? null, target_date: parsed.target_date ?? null,
              delegated_to: parsed.delegated_to ?? null,
            },
          }];
        } else if (action === 'update_object') {
          actions = [{ action: 'update', object_type: parsed.object_type, identifier: parsed.identifier, modal: OBJECT_MODAL[parsed.object_type], operations: parsed.operations ?? [] }];
        } else {
          actions = [{ ...parsed, action }];
        }
      }

      // Enrich actions — tag suggestion, delegatee resolution, modal names
      actions = await enrichActions(user_id, actions, rejectedTags, isModify);

      // Update response with enriched tags if single insert
      let enrichedResponse = karlResponse;
      if (actions.length === 1 && actions[0].fields?.tags?.length) {
        const tags = actions[0].fields.tags as string[];
        const tagMention = `\nTags — ${tags.map(t => `#${t}`).join(' ')}`;
        if (!karlResponse.includes('Tags —')) {
          enrichedResponse = karlResponse.replace(/\nConfirm/, tagMention + '\n\nConfirm') || karlResponse + tagMention;
          await appendSessionMessage(user_id, 'karl', enrichedResponse);
        }
      }

      return { intent, actions, response: enrichedResponse };
    }

    // ── confirm / cancel / preview ─────────────────────────────────────────
    if (intent === 'confirm_pending') return { intent: 'confirm_pending', response: karlResponse };
    if (intent === 'cancel_pending')  return { intent: 'cancel_pending',  response: karlResponse };
    if (intent === 'preview_pending') return { intent: 'preview_pending', response: karlResponse };

    // ── open_form ──────────────────────────────────────────────────────────
    if (intent === 'open_form') {
      return { intent: 'open_form', payload: { modal: parsed.modal, identifier: parsed.identifier ?? null, prefill: parsed.prefill ?? {} }, response: karlResponse };
    }

    // ── command ────────────────────────────────────────────────────────────
    if (intent === 'command' && parsed.command_type === 'open_tag_manager') {
      return { intent: 'command', payload: { command_type: 'open_tag_manager' }, response: parsed.response ?? 'Opening tag manager.' };
    }

    // ── question variants ──────────────────────────────────────────────────
    if (intent === 'question') {
      const qPayload: Record<string, any> = {};
      if (parsed.outcome_pending)    { qPayload.outcome_pending = true; qPayload.identifier = parsed.identifier; qPayload.object_type = parsed.object_type; }
      if (parsed.delegation_pending) { qPayload.delegation_pending = true; qPayload.identifier = parsed.identifier; qPayload.object_type = parsed.object_type; }
      if (parsed.open_modal)         { qPayload.open_modal = true; }
      return { intent: 'question', payload: Object.keys(qPayload).length ? qPayload : undefined, response: karlResponse };
    }

    return { intent, response: karlResponse };

  } catch (err: any) {
    console.error('[commandRouter]', err);
    return { intent: 'unclear', error: err.message, response: 'Something went wrong. Try again.' };
  }
}