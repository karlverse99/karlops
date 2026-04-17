// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and enrichment
// v0.7.3 — max_tokens bump for pending, hard JSON rule on confirms

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
  | 'process_document'
  | 'question'
  | 'command'
  | 'unclear';

export interface UpdateOperation {
  field: string;
  value: string | string[];
  tag_op?: 'add' | 'remove';
}

export interface RouterResult {
  intent: IntentType;
  payload?: Record<string, any>;
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
}

export const OBJECT_TABLE: Record<string, string> = {
  task:               'task',
  completion:         'completion',
  meeting:            'meeting',
  external_reference: 'external_reference',
  document_template:  'document_template',
  contact:            'contact',
};

export const OBJECT_PK: Record<string, string> = {
  task:               'task_id',
  completion:         'completion_id',
  meeting:            'meeting_id',
  external_reference: 'external_reference_id',
  document_template:  'document_template_id',
  contact:            'contact_id',
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

function isDocumentInput(input: string): boolean {
  if (input.length < 500) return false;
  const lower = input.toLowerCase();
  const docSignals = [
    'transcript', 'meeting notes', 'email thread', "here's the", 'here is the',
    'paste', 'copied from', 'from the doc', 'from the meeting',
    'attendees', 'agenda', 'action items', 'minutes',
  ];
  return docSignals.some(s => lower.includes(s)) || input.split('\n').length > 15;
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

async function suggestTagsForCapture(user_id: string, context_text: string, already_tagged: string[], rejected_tags: string[] = []): Promise<string[]> {
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

    const rejectedNote = rejected_tags.length ? `\nNEVER suggest these (user rejected): ${rejected_tags.join(', ')}` : '';

    const systemPrompt = `You are Karl, suggesting tags for a KarlOps task being captured via chat.
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Content to tag: ${context_text}` }],
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[suggestTagsForCapture] tokens:', { input: usage.input_tokens, output: usage.output_tokens, cache_write: usage.cache_creation_input_tokens ?? 0, cache_read: usage.cache_read_input_tokens ?? 0 });

    const text = data.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const existingNames = new Set(existingTags.map(t => t.name));
    return (parsed.suggested ?? []).filter((name: string) => existingNames.has(name) && !already_tagged.includes(name) && !rejected_tags.includes(name));
  } catch (err) {
    console.error('[suggestTagsForCapture]', err);
    return [];
  }
}

// ─── FIELD SUMMARY BUILDERS ───────────────────────────────────────────────────

function buildEditableFieldSummary(meta: FieldMeta[]): string {
  const byType: Record<string, string[]> = {};
  for (const f of meta) {
    if (f.update_behavior !== 'editable') continue;
    if (!byType[f.object_type]) byType[f.object_type] = [];
    byType[f.object_type].push(`${f.field} (${f.label})`);
  }
  return Object.entries(byType).map(([type, fields]) => `- ${type}: ${fields.join(', ')}`).join('\n') || 'no editable fields found';
}

function buildObjectSummaries(meta: FieldMeta[]): string {
  const byType: Record<string, FieldMeta[]> = {};
  for (const f of meta) {
    if (!byType[f.object_type]) byType[f.object_type] = [];
    byType[f.object_type].push(f);
  }
  return Object.entries(byType).map(([type, fields]) => {
    const required = fields.filter(f => f.insert_behavior === 'required').map(f => f.label).join(', ');
    return `- ${type}: required fields are ${required}`;
  }).join('\n');
}

// ─── FORMAT PENDING FOR KARL ──────────────────────────────────────────────────

function formatPendingForPrompt(pending: Record<string, any> | null): string {
  if (!pending) return '';

  const BUCKET_LABEL: Record<string, string> = {
    now: 'On Fire', soon: 'Up Next', realwork: 'Real Work',
    later: 'Later', delegate: 'Delegated', capture: 'Capture',
  };

  const lines = ['## Current Pending Action', `Intent: ${pending.intent}`];

  if (pending.intent === 'capture_task' || pending.intent === 'execute') {
    const p = pending.payload ?? pending;
    lines.push(`Title: ${p.title ?? '—'}`);
    lines.push(`Bucket: ${BUCKET_LABEL[p.bucket_key] ?? p.bucket_key ?? 'Capture'}`);
    lines.push(`Tags: ${(p.tags ?? []).join(', ') || 'none'}`);
    lines.push(`Context: ${p.context_id ?? 'none'}`);
    lines.push(`Target date: ${p.target_date ?? 'none'}`);
    // Notes intentionally omitted — keeps pending context lean for confirms
    if (p.delegated_to) lines.push(`Delegated to: ${p.delegated_to}`);
  } else if (pending.intent === 'capture_tasks') {
    // Show titles only — no notes. Notes are stripped client-side too.
    // This prevents Karl from re-emitting a massive payload on confirm.
    const tasks = pending.payload?.tasks ?? pending.tasks ?? [];
    lines.push(`Tasks (${tasks.length}):`);
    tasks.forEach((t: any, i: number) => lines.push(`  ${i + 1}. ${t.title} → ${BUCKET_LABEL[t.bucket_key] ?? t.bucket_key ?? 'Capture'}`));
  } else if (pending.intent === 'update_object') {
    const p = pending.payload ?? {};
    lines.push(`Object: ${p.object_type} ${p.identifier}`);
    const ops = (p.operations ?? []).map((op: any) => op.tag_op ? `${op.tag_op} tag ${op.value}` : `${op.field} → ${op.value}`).join(', ');
    lines.push(`Operations: ${ops}`);
  } else if (pending.intent === 'process_document') {
    const p = pending.payload ?? pending;
    lines.push(`Action: ${p.action ?? p.doc_action}`);
    lines.push(`Doc action: ${p.doc_action}`);
    if (p.title) lines.push(`Title: ${p.title}`);
    if (p.doc_type) lines.push(`Type: ${p.doc_type}`);
    if (p.description) lines.push(`Description: ${p.description}`);
    if (p.meeting_date) lines.push(`Date: ${p.meeting_date}`);
    if (p.attendees?.length) lines.push(`Attendees: ${p.attendees.join(', ')}`);
    if (p.tags?.length) lines.push(`Tags: ${p.tags.join(', ')}`);
    if (p.context_name) lines.push(`Context: ${p.context_name}`);
  }

  lines.push('');
  lines.push('## CRITICAL — RESPOND WITH JSON ONLY');
  lines.push('The user is responding to this pending action. Your response MUST be valid JSON.');
  lines.push('If user confirms → { "intent": "confirm_pending", "response": "plain English" }');
  lines.push('If user cancels → { "intent": "cancel_pending", "response": "Cancelled." }');
  lines.push('If user modifies → { "intent": "modify_pending", ... updated payload ... }');
  lines.push('DO NOT re-emit the full task list. DO NOT wrap in code fences. Return ONLY the JSON object.');

  return lines.join('\n');
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
      .select('object_type, field, label, field_type, insert_behavior, update_behavior')
      .eq('user_id', user_id)
      .in('object_type', ['task', 'meeting', 'completion', 'external_reference', 'document_template', 'contact']);

    const objectSummaries      = buildObjectSummaries(allMeta ?? []);
    const editableFieldSummary = buildEditableFieldSummary(allMeta ?? []);

    const isDeep    = isAnalysisRequest(input);
    const hasPending = !!pending;
    const bundle    = isDeep ? await buildKarlDeepContext(user_id, context_filter) : await buildKarlContext(user_id, context_filter);
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

    const observationInstructions = bundle.observations
      ? `## Your Observations About This User\nYou have noticed these patterns. Use them actively.\n${bundle.observations}`
      : '';

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

    const systemPrompt = [
      `You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done. [v0.7.3]`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}. When a user gives a date without a year, infer the year from today. Use current year unless the date has already passed this year, in which case use next year.`,
      '',
      // Hard JSON rule injected at the top when pending exists
      hasPending ? '## ABSOLUTE RULE — RETURN VALID JSON ONLY' : '',
      hasPending ? 'There is a pending action. The user is responding to it.' : '',
      hasPending ? 'You MUST return a JSON object. NO prose. NO code fences. NO markdown.' : '',
      hasPending ? 'A simple "yes" or "confirm" from the user → { "intent": "confirm_pending", "response": "On it." }' : '',
      hasPending ? 'DO NOT re-emit the task list or payload. Just confirm.' : '',
      '',
      contextBlock,
      '',
      pendingBlock,
      '',
      observationInstructions,
      '',
      '## Your Job',
      'Every user message comes to you. You decide what to do. No word lists. No state machine. Just reason.',
      '',
      '## Decision Flow — Follow This Every Time',
      '1. Is this a question or conversation, or a KarlOps operation (write to DB, change state, capture something)?',
      '',
      '   QUESTION patterns — return intent: question, answer directly, DO NOT return pending:',
      '   - "what is X", "what is in X", "tell me about X", "describe X"',
      '   - "what should I work on", "what is my priority", "what is next"',
      '   - "how do I...", "what does X mean", "explain X"',
      '   - "what have I completed", "how am I doing", "summarize X" (analysis)',
      '   - Any question about a task by identifier: "what is N4?", "tell me about S3"',
      '   - Anything phrased as a question that does not require writing to the DB',
      '',
      '   OPERATION patterns — proceed to step 2:',
      '   - "add a task", "capture", "log", "complete X", "move X to Y", "delegate X to Y"',
      '   - "append to X notes", "add tag X to Y", "mark X done"',
      '',
      '2. If KarlOps operation — what is it? Capture, update, complete, delegate, process document?',
      '3. Do I have all required data to execute?',
      '   - Quick capture signal ("quick add", "quick task", "quick capture", "just add it", "fast add") → intent: execute. Use defaults for everything missing. Do not ask.',
      '   - Have enough data → intent: pending. Show enriched payload clearly. Let user confirm or adjust.',
      '   - Missing one critical thing (e.g. delegating without a person) → intent: question. Ask for that one thing only.',
      '4. If pending action exists and user input relates to it:',
      '   - User confirms ("yes", "do it", "go", "yep", "ok", "sure", "correct", "looks good", "confirm", "create it", "save it", "add these", "add them") → intent: confirm_pending',
      '   - User cancels ("no", "cancel", "stop", "nevermind", "nah") → intent: cancel_pending',
      '   - User modifies ("change the bucket", "remove that tag", "different context", "actually...") → intent: modify_pending with updated payload',
      '   - User asks what it looks like ("show me", "preview", "what does that look like") → intent: preview_pending',
      '   - User says "open it", "show me the form" → intent: open_form',
      '   - User types something new and unrelated → replace pending with new intent',
      '',
      '## CRITICAL — Question vs Pending',
       'NEVER return intent: pending for a question. A question never requires confirmation. Just answer it.',
      'EXCEPTION: When you suggest a list of tasks and ask if the user wants to capture them, ALWAYS return intent: pending with action: capture_tasks — never intent: question. The user cannot confirm a question.',
      '',
      '## CRITICAL — Modifying Pending',
      'Return intent: modify_pending with COMPLETE updated payload. Do NOT cancel. Do NOT restart.',
      '',
      '## CRITICAL — Pending Payload Presentation',
      'When returning intent: pending, response MUST use labeled format:',
      '"Here is what I have:\\nTitle — [title]\\nBucket — [label]\\nTags — [tags]\\n\\nConfirm or tell me what to change."',
      'Use human bucket labels (On Fire, Up Next, Real Work, Later, Delegated, Capture) — never raw keys.',
      '',
      '## CRITICAL — Confirm Response',
      'When user confirms, return ONLY: { "intent": "confirm_pending", "response": "plain English confirmation" }',
      'DO NOT include the task list. DO NOT re-emit the payload. Just confirm.',
      '',
      '## CRITICAL — Execution Confirmations (Plain English Only)',
      'After action executes: plain English only. No field names, no technical syntax.',
      '',
      '## Enrichment — Always Do This for Captures',
      'Infer bucket, tags, context, target date, notes, delegated_to from input + context.',
      '',
      '## Available Object Types',
      objectSummaries,
      '',
      '## Task Identifiers',
      'N=now, S=soon, RW=realwork, L=later, D=delegate, CP=capture, CM=completion, MT=meeting, EX=extract, TM=template, CT=contact.',
      'Format: prefix+number e.g. N1, S2, RW1.',
      '',
      '## complete_task — TWO STEP FLOW',
      'STEP 1 — ask for outcome. STEP 2 — pending with update_object.',
      'EXCEPTION: "no outcome" / "just mark it done" → skip to pending with outcome="".',
      '',
      '## Delegation Rules',
      'delegated_to required when bucket = delegate. Ask if person not provided.',
      '',
      '## Editable Fields Per Object Type',
      editableFieldSummary,
      '',
      '## Field Knowledge — Reason From This',
      'The Field Knowledge section tells you what every field is and how this user uses it.',
      '',
      '## process_document',
      'When input is 500+ chars or document-like: identify content type, identify what user wants, return pending.',
      '',
      '## Vocabulary',
      '- bucket aliases: "fire"/"on fire" → now, "up next" → soon, "real work" → realwork',
      '- "code it to X" / "context X" → context_id',
      '- "by DATE" / "due DATE" → target_date (ISO YYYY-MM-DD)',
      '- "delegate to X" → bucket=delegate + delegated_to=X',
      '',
      '## Tag Rules — Only use tags from Available Tags list',
      rejectedTagsNote,
      '',
      isDeep ? '## Observation Instruction\nInclude "observation" field — 1-2 sentences on pattern noticed.\nobservation_type: pattern | preference | flag\n' : '',
      '',
      '## Response Format — ONLY valid JSON, no markdown, no code fences',
      '',
      '// Immediate execute (quick capture):',
      '{ "intent": "execute", "action": "capture_task", "title": "title", "bucket_key": "capture", "context_id": null, "tags": [], "notes": null, "target_date": null, "delegated_to": null, "response": "Got it." }',
      '',
      '// Propose capture:',
      '{ "intent": "pending", "action": "capture_task", "title": "title", "bucket_key": "realwork", "context_id": "uuid-or-null", "tags": ["Tag1"], "notes": "detail", "target_date": null, "delegated_to": null, "response": "Here is what I have:\\nTitle — [title]\\nBucket — [label]\\nTags — [tags]\\nNotes — [notes]\\n\\nConfirm or tell me what to change.", "recognised_phrase": "phrase" }',
      '',
      '// Propose multiple captures:',
      '{ "intent": "pending", "action": "capture_tasks", "tasks": [{ "title": "task", "bucket_key": "capture", "tags": [], "notes": null }], "response": "Found N tasks:\\n1. [title] — [bucket]\\n\\nConfirm to capture all, or tell me what to adjust." }',
      '',
      '// Modify pending:',
      '{ "intent": "modify_pending", "action": "capture_task", "title": "title", "bucket_key": "realwork", "context_id": null, "tags": ["Tag1"], "notes": "detail", "target_date": null, "response": "Updated. Confirm?" }',
      '',
      '// Confirm pending — SHORT, no payload re-emission:',
      '{ "intent": "confirm_pending", "response": "On it." }',
      '',
      '// Cancel pending:',
      '{ "intent": "cancel_pending", "response": "Cancelled." }',
      '',
      '// Preview pending:',
      '{ "intent": "preview_pending", "response": "Here is what I have:\\nTitle — [title]\\nBucket — [label]\\nTags — [tags]\\n\\nConfirm or tell me what to change." }',
      '',
      '// Open form:',
      '{ "intent": "open_form", "response": "Opening it up for you." }',
      '',
      '// Update existing object:',
      '{ "intent": "pending", "action": "update_object", "object_type": "task", "identifier": "N3", "operations": [{ "field": "bucket_key", "value": "soon" }], "response": "I will move N3 to Up Next. Confirm?" }',
      '',
      '// Complete task step 1:',
      '{ "intent": "question", "outcome_pending": true, "identifier": "N1", "object_type": "task", "response": "What was the result?" }',
      '',
      '// Delegation — missing person:',
      '{ "intent": "question", "delegation_pending": true, "identifier": "N1", "object_type": "task", "response": "Who is handling this?" }',
      '',
      '// Process document:',
      '{ "intent": "pending", "action": "process_document", "content_type": "transcript", "doc_action": "complete_meeting", "target_identifier": "MT1", "summary": "summary text", "extracted_tasks": [], "response": "Here is what I found:\\n[description]\\n\\nPlan:\\n[what I will do]\\n\\nConfirm?" }',
      '',
      '// Process document — create template:',
      '{ "intent": "pending", "action": "process_document", "doc_action": "create_template", "title": "Template Name", "doc_type": "Script", "description": "One sentence", "generation_instructions": "fill-in-the-blank template with ___", "data_sources": { "tasks": false, "meetings": false, "situation": false, "references": false, "completions": false }, "tags": ["Tag1"], "context_name": "Context or null", "response": "Here is what I have:\\nTitle — [title]\\n\\nConfirm to save." }',
      '',
      '// Conversational:',
      '{ "intent": "question", "response": "Karl response in plain English" }',
      '',
      isDeep ? '// Analysis: { "intent": "question", "response": "Karl response", "observation": "pattern note", "observation_type": "pattern" }' : '',
    ].filter(Boolean).join('\n');

    // ── Token budget ───────────────────────────────────────────────────────────
    // Bump to 3000 when pending exists — confirms with large payloads (e.g. 11 tasks
    // with notes) were hitting 1000 token ceiling and truncating mid-JSON, causing
    // Karl to return prose instead of a valid confirm_pending response.
    const maxTokens = isDeep ? 1500
      : hasPending ? 3000
      : isDocumentInput(input) ? 2000
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

    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
      }
    }

    if (!parsed) {
      console.error('[commandRouter] JSON parse failed. Raw response:', text);
      if (text && text.length > 10) {
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

    if (parsed.recognised_phrase && (intent === 'pending' || intent === 'execute') && (parsed.action === 'capture_task' || parsed.action === 'capture_tasks')) {
      upsertKarlVocab(user_id, parsed.recognised_phrase, intent, 'task').catch(() => {});
    }

    if (isDeep && parsed.observation) {
      const obsType = (['pattern', 'preference', 'flag'] as const).includes(parsed.observation_type)
        ? parsed.observation_type as 'pattern' | 'preference' | 'flag'
        : 'pattern';
      writeKarlObservation(user_id, parsed.observation, obsType).catch(() => {});
    }

    if (parsed.field_learning?.object_type && parsed.field_learning?.field && parsed.field_learning?.llm_notes) {
      updateFieldLlmNotes(user_id, parsed.field_learning.object_type, parsed.field_learning.field, parsed.field_learning.llm_notes).catch(() => {});
    }

    // ── execute ────────────────────────────────────────────────────────────
    if (intent === 'execute') {
      return {
        intent: 'execute',
        payload: {
          action: parsed.action ?? 'capture_task',
          title: parsed.title, bucket_key: parsed.bucket_key ?? 'capture',
          context_id: parsed.context_id ?? null, tags: parsed.tags ?? [],
          notes: parsed.notes ?? null, target_date: parsed.target_date ?? null,
          delegated_to: parsed.delegated_to ?? null,
        },
        response: karlResponse,
      };
    }

    // ── pending / modify_pending ───────────────────────────────────────────
    if (intent === 'pending' || intent === 'modify_pending') {
      const action = parsed.action ?? 'capture_task';

      if (action === 'capture_task') {
        const karlTags = (parsed.tags ?? []).filter((t: string) => !rejectedTags.includes(t));
        const suggested = intent === 'modify_pending'
          ? []
          : await suggestTagsForCapture(user_id, parsed.title ?? '', karlTags, rejectedTags);
        const allTags = Array.from(new Set([...karlTags, ...suggested])).slice(0, 5);

        let delegatedToId: string | null = null;
        if (parsed.bucket_key === 'delegate' && parsed.delegated_to) {
          const resolved = await resolveDelegatee(user_id, parsed.delegated_to);
          delegatedToId = resolved?.tag_id ?? (await createPeopleTag(user_id, parsed.delegated_to))?.tag_id ?? (await resolveOtherTag(user_id))?.tag_id ?? null;
        }

        const tagMention = allTags.length > 0 ? `\nTags — ${allTags.map((t: string) => `#${t}`).join(' ')}` : '\nTags — none';
        const enrichedResponse = karlResponse.includes('Tags —')
          ? karlResponse
          : karlResponse.replace(/\nConfirm/, tagMention + '\n\nConfirm') || karlResponse + tagMention;

        await appendSessionMessage(user_id, 'karl', enrichedResponse);

        return {
          intent,
          payload: {
            action, title: parsed.title, bucket_key: parsed.bucket_key ?? 'capture',
            context_id: parsed.context_id ?? null, tags: allTags,
            notes: parsed.notes ?? null, target_date: parsed.target_date ?? null,
            delegated_to: delegatedToId,
          },
          response: enrichedResponse,
        };
      }

      if (action === 'capture_tasks') {
        const tasks = parsed.tasks ?? [];
        const combinedTitles = tasks.map((t: any) => t.title).join(', ');
        const suggested = intent === 'modify_pending'
          ? []
          : await suggestTagsForCapture(user_id, combinedTitles, [], rejectedTags);
        const enrichedTasks = await Promise.all(tasks.map(async (task: any) => {
          const taskTags = (task.tags ?? []).filter((t: string) => !rejectedTags.includes(t));
          const merged = Array.from(new Set([...taskTags, ...suggested])).slice(0, 5);
          return { ...task, tags: merged };
        }));
        return {
          intent,
          payload: { action, tasks: enrichedTasks },
          response: karlResponse,
        };
      }

      if (action === 'update_object') {
        const operations = await Promise.all((parsed.operations ?? []).map(async (op: any) => {
          if (op.field === 'delegated_to' && typeof op.value === 'string') {
            const resolved = await resolveDelegatee(user_id, op.value)
              ?? await createPeopleTag(user_id, op.value)
              ?? await resolveOtherTag(user_id);
            return resolved ? { ...op, value: resolved.tag_id, _resolved_name: resolved.name } : op;
          }
          return op;
        }));
        return {
          intent,
          payload: { action, object_type: parsed.object_type, identifier: parsed.identifier, operations },
          response: karlResponse,
        };
      }

      // ── process_document — pass ALL fields through ─────────────────────
      if (action === 'process_document') {
        return {
          intent,
          payload: {
            action,
            content_type:            parsed.content_type ?? null,
            doc_action:              parsed.doc_action ?? null,
            target_identifier:       parsed.target_identifier ?? null,
            summary:                 parsed.summary ?? null,
            extracted_tasks:         parsed.extracted_tasks ?? [],
            title:                   parsed.title ?? null,
            meeting_date:            parsed.meeting_date ?? null,
            attendees:               parsed.attendees ?? [],
            notes:                   parsed.notes ?? null,
            context_name:            parsed.context_name ?? null,
            tags:                    parsed.tags ?? [],
            doc_type:                parsed.doc_type ?? null,
            description:             parsed.description ?? null,
            generation_instructions: parsed.generation_instructions ?? null,
            data_sources:            parsed.data_sources ?? {},
          },
          response: karlResponse,
        };
      }

      return { intent, payload: parsed, response: karlResponse };
    }

    // ── confirm / cancel / preview / open_form ─────────────────────────────
    if (intent === 'confirm_pending') return { intent: 'confirm_pending', response: karlResponse };
    if (intent === 'cancel_pending')  return { intent: 'cancel_pending',  response: karlResponse };
    if (intent === 'preview_pending') return { intent: 'preview_pending', response: karlResponse };
    if (intent === 'open_form')       return { intent: 'open_form',       response: karlResponse };

    // ── command ────────────────────────────────────────────────────────────
    if (intent === 'command' && parsed.command_type === 'open_tag_manager') {
      return { intent: 'command', payload: { command_type: 'open_tag_manager' }, response: parsed.response ?? 'Opening tag manager.' };
    }

    // ── question variants ──────────────────────────────────────────────────
    if (intent === 'question' && parsed.outcome_pending) {
      return { intent: 'question', payload: { outcome_pending: true, identifier: parsed.identifier, object_type: parsed.object_type }, response: karlResponse };
    }
    if (intent === 'question' && parsed.delegation_pending) {
      return { intent: 'question', payload: { delegation_pending: true, identifier: parsed.identifier, object_type: parsed.object_type }, response: karlResponse };
    }

    return { intent, response: karlResponse };

  } catch (err: any) {
    console.error('[commandRouter]', err);
    return { intent: 'unclear', error: err.message, response: 'Something went wrong. Try again.' };
  }
}