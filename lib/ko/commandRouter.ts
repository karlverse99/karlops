// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and enrichment
// v1.5.0 — Split context for caching (static vs dynamic)

import { createSupabaseAdmin } from '@/lib/supabase-server';
import {
  buildKarlDeepContext,
  appendSessionMessage,
  writeKarlObservation,
  upsertKarlVocab,
  updateFieldLlmNotes,
  loadActiveVocabRules,
  writeKarlVocabRule,
  deleteKarlVocabRule,
  touchKarlVocabRule,
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

export type ActionType =
  | 'insert'
  | 'update'
  | 'complete'
  | 'archive'
  | 'delete'
  | 'delete_object'
  | 'refine'
  | 'run_template'
  | 'save_as_template'
  | 'capture_tasks'
  | 'create_tag'
  | 'summarize'
  | 'propose_rule'
  | 'update_rule'
  | 'delete_rule'

export interface KarlAction {
  action: ActionType;
  object_type?: string;
  modal?: string;
  fields?: Record<string, any>;
  tasks?: any[];
  operations?: UpdateOperation[];
  identifier?: string;
  target_identifier?: string;
  run_mode?: 'preview' | 'save';
  section_data?: Record<string, any>;
  learning?: KarlLearning;
}

export interface UpdateOperation {
  field: string;
  value: string | string[];
  mode?: 'set' | 'append' | 'add' | 'remove';
}

export interface KarlLearning {
  vocab?: { term: string; maps_to: string };
  field_notes?: { object_type: string; field: string; llm_notes: string };
  observation?: { content: string; observation_type: 'pattern' | 'preference' | 'flag' };
}

export interface RouterResult {
  intent: IntentType;
  actions?: KarlAction[];
  payload?: Record<string, any>;
  response?: string;
  error?: string;
  usage?: any;
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
  task_status:        'task_status',
};

export const OBJECT_PK: Record<string, string> = {
  task:               'task_id',
  completion:         'completion_id',
  meeting:            'meeting_id',
  external_reference: 'external_reference_id',
  document_template:  'document_template_id',
  contact:            'contact_id',
  tag:                'tag_id',
  task_status:        'task_status_id',
};

export const OBJECT_MODAL: Record<string, string> = {
  task:               'TaskDetailModal',
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

// ─── ALLOW_DELETE GATE ────────────────────────────────────────────────────────

async function checkAllowDelete(user_id: string, object_type: string): Promise<boolean> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('ko_list_view_config')
    .select('allow_delete')
    .eq('user_id', user_id)
    .eq('object_type', object_type)
    .maybeSingle();
  return data?.allow_delete ?? false;
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
    const rejectedNote = rejected_tags.length ? `\nNEVER suggest these (user rejected): ${rejected_tags.join(', ')}` : '';

    const systemPrompt = `You are Karl, suggesting tags for a KarlOps object being captured via chat.
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

function formatPendingForPrompt(pending: Record<string, any> | null): string {
  if (!pending) return '';
  const lines = ['## Current Pending Actions'];
  const actions: any[] = pending.actions ?? [];

  if (actions.length > 0) {
    actions.forEach((a: any, i: number) => {
      lines.push(`\nAction ${i + 1}: ${a.action} ${a.object_type ?? ''}`);
      if (a.run_mode) lines.push(`  run_mode: ${a.run_mode}`);
      if (a.target_identifier) lines.push(`  template: ${a.target_identifier}`);
      if (a.fields) {
        for (const [k, v] of Object.entries(a.fields)) {
          if (v === null || v === undefined) continue;
          const display = Array.isArray(v) ? v.join(', ') : String(v);
          lines.push(`  ${k}: ${display}`);
        }
      }
      if (a.tasks?.length) {
        lines.push(`  tasks (${a.tasks.length}):`);
        a.tasks.forEach((t: any, j: number) => lines.push(`    ${j + 1}. ${t.title} → ${t.bucket_key ?? 'capture'}`));
      }
      if (a.operations?.length) {
        const ops = a.operations.map((op: any) => `${op.field} → ${op.value}`).join(', ');
        lines.push(`  operations: ${ops}`);
      }
      if (a.section_data) {
        lines.push(`  section_data: ${JSON.stringify(a.section_data)}`);
      }
    });
  } else {
    lines.push(`Intent: ${pending.intent ?? pending.action}`);
    if (pending.title) lines.push(`Title: ${pending.title}`);
    if (pending.bucket_key) lines.push(`Bucket: ${pending.bucket_key}`);
    if (pending.tags?.length) lines.push(`Tags: ${pending.tags.join(', ')}`);
  }

  lines.push('');
  lines.push('## ABSOLUTE RULE — RETURN VALID JSON ONLY');
  lines.push('There is a pending action. The user is responding to it.');
  lines.push('You MUST return a JSON object. NO prose. NO code fences. NO markdown.');
  lines.push('');
  lines.push('CRITICAL FOR run_template PENDING:');
  lines.push('If pending action is run_template with run_mode: preview AND user says "save", "yes", "generate", "do it", or confirms:');
  lines.push('→ Return modify_pending with run_mode changed to "save". DO NOT return confirm_pending.');
  lines.push('Example: { "intent": "modify_pending", "actions": [{ "action": "run_template", "target_identifier": "TM3", "run_mode": "save", "section_data": {...} }], "response": "Generating with real data now." }');
  lines.push('');
  lines.push('User confirms (non-template) → { "intent": "confirm_pending", "response": "plain English" }');
  lines.push('User cancels → { "intent": "cancel_pending", "response": "Cancelled." }');
  lines.push('User modifies → { "intent": "modify_pending", "actions": [...updated actions...], "response": "Updated. Confirm?" }');
  lines.push('User asks to preview → { "intent": "preview_pending", "response": "exact field-by-field description" }');
  lines.push('DO NOT re-emit full payloads on confirm. Just confirm.');
  return lines.join('\n');
}

// ─── LEARNING WRITE-BACK ──────────────────────────────────────────────────────

async function persistLearning(user_id: string, learning: KarlLearning & {
  rule?: { phrase: string; description: string; rule_data: Record<string,any>; match?: 'contains'|'exact'|'starts_with'; confirm?: boolean };
  delete_rule?: { vocab_id: string };
}): Promise<void> {
  if (learning.vocab?.term && learning.vocab?.maps_to) {
    upsertKarlVocab(user_id, learning.vocab.term, 'pending', learning.vocab.maps_to).catch(() => {});
  }
  if (learning.rule?.phrase && learning.rule?.rule_data) {
    writeKarlVocabRule(user_id, learning.rule.phrase, learning.rule.description ?? '', learning.rule.rule_data, learning.rule.match ?? 'contains', learning.rule.confirm ?? true).catch(() => {});
  }
  if (learning.delete_rule?.vocab_id) {
    deleteKarlVocabRule(user_id, learning.delete_rule.vocab_id).catch(() => {});
  }
  if (learning.field_notes?.object_type && learning.field_notes?.field && learning.field_notes?.llm_notes) {
    updateFieldLlmNotes(user_id, learning.field_notes.object_type, learning.field_notes.field, learning.field_notes.llm_notes).catch(() => {});
  }
  if (learning.observation?.content) {
    const obsType = (['pattern', 'preference', 'flag'] as const).includes(learning.observation.observation_type)
      ? learning.observation.observation_type : 'pattern';
    writeKarlObservation(user_id, learning.observation.content, obsType).catch(() => {});
  }
}

// ─── ENRICH ACTIONS ──────────────────────────────────────────────────────────

async function enrichActions(user_id: string, actions: KarlAction[], rejectedTags: string[], isModify: boolean): Promise<KarlAction[]> {
  return Promise.all(actions.map(async (a) => {
    if (!a.modal && a.object_type) {
      a.modal = OBJECT_MODAL[a.object_type] ?? undefined;
    }

    const noSuggest = (a as any)._no_suggest === true;
    if (!isModify && !noSuggest && (a.action === 'insert' || a.action === 'capture_tasks')) {
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

    if (a.action === 'insert' && a.object_type === 'task' && a.fields?.delegated_to && typeof a.fields.delegated_to === 'string') {
      const resolved = await resolveDelegatee(user_id, a.fields.delegated_to)
        ?? await createPeopleTag(user_id, a.fields.delegated_to)
        ?? await resolveOtherTag(user_id);
      if (resolved) a.fields.delegated_to = resolved.tag_id;
    }

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

// ─── RULE MATCHING ───────────────────────────────────────────────────────────

interface MatchedRule {
  vocab_id: string;
  phrase: string;
  confirm: boolean;
  rule_data: Record<string, any>;
}

async function matchVocabRules(user_id: string, input: string): Promise<MatchedRule[]> {
  const rules = await loadActiveVocabRules(user_id);
  const lower = input.toLowerCase();
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    const phrases = rule.phrase.toLowerCase().split('|').map((p: string) => p.trim()).filter(Boolean);
    const match   = rule.match ?? 'contains';
    let hit = false;
    for (const phrase of phrases) {
      if (match === 'exact')            hit = lower === phrase;
      else if (match === 'starts_with') hit = lower.startsWith(phrase);
      else                              hit = lower.includes(phrase);
      if (hit) break;
    }
    if (hit) matched.push(rule as MatchedRule);
  }
  return matched;
}

function applyRuleToActions(actions: KarlAction[], rule: MatchedRule): KarlAction[] {
  const ruleData = rule.rule_data as any;
  const ruleActions: Array<{ field: string; mode: string; value: any }> = ruleData.actions ?? [];
  const appliesTo = ruleData.applies_to ?? 'task';

  return actions.map(a => {
    if (a.object_type !== appliesTo) return a;
    if (a.action !== 'insert' && a.action !== 'capture_tasks') return a;
    if (ruleData.no_suggest) (a as any)._no_suggest = true;

    if (a.action === 'insert' && a.fields) {
      for (const ra of ruleActions) {
        if (ra.field === 'tags' && ra.mode === 'add') {
          const existing = (a.fields.tags ?? []) as string[];
          const toAdd = Array.isArray(ra.value) ? ra.value : [ra.value];
          a.fields.tags = Array.from(new Set([...existing, ...toAdd])).slice(0, 5);
        } else if ((ra.field === 'context_id' || ra.field === 'context_name') && ra.mode === 'set') {
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(ra.value));
          if (!a.fields.context_id && !a.fields.context_name) {
            if (isUuid) a.fields.context_id = ra.value;
            else a.fields.context_name = ra.value;
          }
        } else if (ra.field === 'bucket_key' && ra.mode === 'set') {
          if (!a.fields.bucket_key || a.fields.bucket_key === 'capture') a.fields.bucket_key = ra.value;
        } else if (ra.field === 'task_status_id' && ra.mode === 'set') {
          if (!a.fields.task_status_id) a.fields.task_status_id = ra.value;
        }
      }
    }

    if (a.action === 'capture_tasks' && a.tasks?.length) {
      a.tasks = a.tasks.map((t: any) => {
        for (const ra of ruleActions) {
          if (ra.field === 'tags' && ra.mode === 'add') {
            const existing = (t.tags ?? []) as string[];
            const toAdd = Array.isArray(ra.value) ? ra.value : [ra.value];
            t.tags = Array.from(new Set([...existing, ...toAdd])).slice(0, 5);
          } else if ((ra.field === 'context_id' || ra.field === 'context_name') && ra.mode === 'set') {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(ra.value));
            if (!t.context_id && !t.context_name) {
              if (isUuid) t.context_id = ra.value;
              else t.context_name = ra.value;
            }
          } else if (ra.field === 'task_status_id' && ra.mode === 'set') {
            if (!t.task_status_id) t.task_status_id = ra.value;
          }
        }
        return t;
      });
    }

    return a;
  });
}

// ─── MAIN ROUTER ──────────────────────────────────────────────────────────────

export async function routeCommand(
  user_id: string,
  input: string,
  pending: Record<string, any> | null = null,
  context_filter: string | null = null,
  files: any[] = [],
  contexts: { staticContext: string; dynamicContext: string }
): Promise<RouterResult> {
  const db = createSupabaseAdmin();

try {
    const { staticContext, dynamicContext } = contexts;
const { data: allMeta } = await db

  .from('ko_field_metadata')
  .select('object_type, field, label, field_type, insert_behavior, update_behavior, description, llm_notes')
  .eq('user_id', user_id)
  .in('object_type', ['task', 'meeting', 'completion', 'external_reference', 'document_template', 'contact', 'task_status']);

const meta = allMeta ?? [];
const objectSummaries = buildObjectSummaries(meta);
const fieldKnowledge  = buildFieldKnowledge(meta);

    const isDeep     = isAnalysisRequest(input);
    const hasPending = !!pending;
    const isLong     = isLongInput(input);

    const pendingBlock = formatPendingForPrompt(pending);

const { staticContext, dynamicContext } = contexts;

    const db = createSupabaseAdmin();

    const { data: allMeta } = await db
      .from('ko_field_metadata')
      .select('object_type, field, label, field_type, insert_behavior, update_behavior, description, llm_notes')
      .eq('user_id', user_id)
      .in('object_type', ['task', 'meeting', 'completion', 'external_reference', 'document_template', 'contact', 'task_status']);

    const meta = allMeta ?? [];
    const objectSummaries = buildObjectSummaries(meta);
    const fieldKnowledge  = buildFieldKnowledge(meta);

    const isDeep     = isAnalysisRequest(input);
    const hasPending = !!pending;
    const isLong     = isLongInput(input);

    const pendingBlock = formatPendingForPrompt(pending);

    // Chat history already in dynamicContext via buildKarlDynamicContext.
    // We still need recentMessages for rejectedTags extraction and anthropicMessages assembly.
    const { data: sessionData } = await db.from('ko_session').select('messages').eq('user_id', user_id).maybeSingle();
    const sessionMessages: any[] = sessionData?.messages ?? [];
    const { data: situationData } = await db.from('user_situation').select('chat_history_depth').eq('user_id', user_id).eq('is_active', true).maybeSingle();
    const historyDepth = situationData?.chat_history_depth ?? 15;
    const recentMessages = sessionMessages.slice(-historyDepth);

    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [
      ...recentMessages.map(m => ({
        role: (m.role === 'karl' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input },
    ];
    while (anthropicMessages.length > 1 && anthropicMessages[0].role === 'assistant') {
      anthropicMessages.shift();
    }

    const rejectedTags: string[] = [];
    const rejectPattern = /don'?t (?:use|want|include)\s+#?([A-Za-z0-9/_\-]+)/gi;
    for (const msg of recentMessages) {
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
    // ── Static system prompt — NEVER changes between calls, cache hits every time ──
    // Contains: Karl persona, instructions, action list, JSON format rules.
    // staticContext (tags, field knowledge, concept registry) prepended via system block.
    const staticSystemPrompt = [
      `You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done. [v1.5.0]`,
      `When a user gives a date without a year, infer from today's date (provided in each message).`,
      '',
      '## Your Job',
      'Every user message comes to you. You decide what to do. No hardcoded action maps. No state machine. Just reason.',
      'You know the full schema via Field Knowledge. Use it.',
      '',
      '## FC Objects — What Karl Can Work With',
      'task, completion, meeting, external_reference (extract), document_template (template), contact, tag',
      '',
      '## Actions Karl Can Propose',
      '- insert           — create any FC object',
      '- update           — update any FC object via identifier + operations array',
      '- complete         — complete a task or meeting (two-step: outcome first)',
      '- archive          — set is_archived = true',
      '- delete_object    — hard delete any FC object. ALWAYS check allow_delete first. Always warn: permanent.',
      '- refine           — iterate on extract content in chat, no DB write',
      '- run_template     — run a template against selected data',
      '- save_as_template — save a chat-designed document shell as a reusable document_template',
      '- capture_tasks    — bulk task insert',
      '- create_tag       — propose new tag (ALWAYS pending, never silent)',
      '- summarize        — no DB write, Karl summarizes in chat',
      '',
      '## Delete Rules — CRITICAL',
      'Before proposing delete_object for any object type, you MUST reason about allow_delete.',
      'If deletion is NOT allowed, respond: "Delete on [object type] disabled by administrator." — never propose the action.',
      'delete_object is ALWAYS pending. Never silent. Always include display_name in fields.',
      '',
      '## Template System — CRITICAL',
      '',
      '### What a template IS:',
      'A template is a FORMATTING SHELL only. It defines:',
      '  - Title, subtitle, visual structure',
      '  - Section headers and ordering',
      '  - How each data type should be formatted (fields shown, bullet style, grouping)',
      '  - Output format (md only for now)',
      'A template does NOT contain data, data references, or {{placeholders}}.',
      '',
      '### Template sections:',
      'Templates have a sections[] array. Each section defines:',
      '  - key: unique identifier (e.g. "TASKS", "MEETINGS", "COMPLETIONS")',
      '  - label: human-readable name',
      '  - source: what type of data fills this section (tasks/completions/meetings/references/situation/contacts)',
      '  - format: how to display items in this section',
      '',
      '### run_template flow — ENFORCED TWO-STEP. NO EXCEPTIONS:',
      '',
      'STEP 1 — When user says "run TM1" or any variation without an explicit mode:',
      'Karl ALWAYS asks first:',
      '{ "intent": "question", "response": "TM1 — preview the formatting with sample data, or generate with your real data?", "payload": { "template_choice_pending": true, "identifier": "TM1" } }',
      'Karl NEVER skips this step. NEVER goes straight to proposing a run.',
      '',
      'STEP 2a — User says "preview" or "preview TM1":',
      'Karl proposes run_template with run_mode: preview.',
      '{ "intent": "pending", "actions": [{ "action": "run_template", "target_identifier": "TM1", "run_mode": "preview" }], "response": "Previewing TM1 with sample data. Confirm?" }',
      '',
      'STEP 2b — User says "generate", "run it", "real data", or "generate TM1":',
      'Karl proposes run_template with run_mode: save and section_data.',
      '',
      '### CRITICAL — "save" after preview:',
      'When there is a PENDING run_template with run_mode: preview and the user says "save", "yes", "generate", "do it", or any confirmation:',
      'Karl MUST return modify_pending with run_mode changed to "save".',
      'Karl MUST NOT return confirm_pending — that would execute the preview action.',
      'Example:',
      '{ "intent": "modify_pending", "actions": [{ "action": "run_template", "target_identifier": "TM3", "run_mode": "save", "section_data": { ... } }], "response": "Generating with your real data now." }',
      '',
      '### section_data — run-time data scope:',
      'Default scope:',
      '  tasks → all buckets, all contexts, no tag filter',
      '  completions → window_days: 7',
      '  meetings → window_days: 7',
      '',
      '### Overrides:',
      '"run TM1 but completions last 14 days" → Karl applies override to that section only.',
      'Override applies to this run only. Template never modified.',
      '',
      '### save_as_template:',
      'ALWAYS pending. Never silent.',
      'Must include: name, description, output_format (md), prompt_template (formatting only, NO placeholders), sections[].',
      '',
      '## Document queries — "show me docs about X"',
      'Return intent: question with a formatted list inline.',
      '',
      '## Decision Flow',
      '1. Question/conversation → intent: question. No pending.',
      '2. Operation → what objects, what actions? Build actions array.',
      '3. Quick capture → intent: execute. Have enough → intent: pending. Missing critical → intent: question.',
      '4. Pending exists? confirm/cancel/modify/preview/open_modal/replace.',
      '',
      '## Rules',
      '- Proposals always use intent: pending',
      '- GIGO: no silent writes. Every DB write needs explicit confirm.',
      '- run_template with run_mode preview pending + user confirms → ALWAYS modify_pending with run_mode: save',
      '- create_tag ALWAYS pending. save_as_template ALWAYS pending. delete_object ALWAYS pending.',
      '- complete is two-step unless user says "no outcome" or "just mark it done".',
      '- Karl can update any field in Field Knowledge with update:editable. Never say you can\'t.',
      '- NEVER hardcode icons, bucket labels, or object labels. Always use concept registry.',
      '- NEVER write {{placeholders}} in prompt_template.',
      '',
      '## Vocabulary',
      '- "fire"/"on fire" → now · "up next" → soon · "real work" → realwork',
      '- "code it to X" / "context X" → context_id · "by DATE" → target_date',
      '',
      '## Identifiers',
      'N=now S=soon RW=realwork L=later D=delegate CP=capture CM=completion MT=meeting EX=extract TM=template CT=contact',
      '',

'## Available Object Types + Required Fields',
objectSummaries,
'',
'## Field Knowledge',
fieldKnowledge,
'',




      '## Response Format — ONLY valid JSON, no markdown, no code fences',
      '',
      '// question — STEP 1 of run_template:',
      '{ "intent": "question", "response": "TM1 — preview the formatting with sample data, or generate with your real data?", "payload": { "template_choice_pending": true, "identifier": "TM1" } }',
      '',
      '// pending — preview:',
      '{ "intent": "pending", "actions": [{ "action": "run_template", "target_identifier": "TM1", "run_mode": "preview" }], "response": "Previewing TM1 with sample data. Confirm?" }',
      '',
      '// modify_pending — user said save after preview (CRITICAL):',
      '{ "intent": "modify_pending", "actions": [{ "action": "run_template", "target_identifier": "TM3", "run_mode": "save", "section_data": { "DELEGATED": { "buckets": ["delegate"] }, "MEETINGS": { "window_days": 7 }, "JEN_TASKS": { "tags": ["Jen Schroeder"], "buckets": ["now","soon","realwork","later","delegate","capture"] }, "COMPLETIONS": { "window_days": 7 } } }], "response": "Generating with your real data now." }',
      '',
      '// pending — generate with real data:',
      '{ "intent": "pending", "actions": [{ "action": "run_template", "target_identifier": "TM1", "run_mode": "save", "section_data": { "TASKS": { "buckets": ["now","soon","realwork","later","delegate","capture"], "context": null, "tags": [] }, "MEETINGS": { "window_days": 7 }, "COMPLETIONS": { "window_days": 7 } } }], "response": "Generating TM1 with your real data. Defaults applied. Confirm?" }',
      '',
      '// execute (quick capture):',
      '{ "intent": "execute", "actions": [{ "action": "insert", "object_type": "task", "modal": "TaskAddModal", "fields": { "title": "...", "bucket_key": "capture", "tags": [], "notes": null, "target_date": null, "context_id": null } }], "response": "Got it." }',
      '',
      '// pending — insert:',
      '{ "intent": "pending", "actions": [{ "action": "insert", "object_type": "meeting", "modal": "MeetingsModal", "fields": { "title": "...", "meeting_date": "...", "attendees": [], "tags": [], "notes": "..." } }], "response": "Here is what I have. Confirm?" }',
      '',
      '// pending — update:',
      '{ "intent": "pending", "actions": [{ "action": "update", "object_type": "task", "identifier": "N3", "modal": "TaskDetailModal", "operations": [{ "field": "bucket_key", "value": "soon", "mode": "set" }] }], "response": "Moving N3 to Up Next. Confirm?" }',
      '',
      '// confirm / cancel / preview / modify:',
      '{ "intent": "confirm_pending", "response": "Done." }',
      '{ "intent": "cancel_pending", "response": "Cancelled." }',
      '{ "intent": "preview_pending", "response": "Exactly what I will create:\\n\\n..." }',
      '{ "intent": "modify_pending", "actions": [...complete updated actions...], "response": "Updated. Confirm?" }',
      '',
      '// open_form:',
      '{ "intent": "open_form", "modal": "TaskDetailModal", "identifier": "N1", "response": "Opening N1." }',
      '',
      '// question:',
      '{ "intent": "question", "response": "Karl answer in plain English" }',
    ].filter(Boolean).join('\n');

    // ── Dynamic context — prepended to first user message, never in system ──
    // Contains: today's date, task snapshot, completions, meetings, pending, observations.
    // Changes every call — keeping it out of system preserves the cache key on staticSystemPrompt.
    const dynamicPrefix = [
      `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
      '',
      dynamicContext,
      '',
      pendingBlock,
      '',
      isDeep ? '## Analysis Mode\nInclude learning.observation with pattern noticed.' : '',
      rejectedTagsNote,
    ].filter(Boolean).join('\n');

    // Prepend dynamic context to first user message


    const lastIndex = anthropicMessages.length - 1;
const messagesWithContext = anthropicMessages.map((m, i) => {
  if (i === lastIndex) return { ...m, content: dynamicPrefix + '\n\n---\n\n' + m.content };
  return m;
});

    const maxTokens = isDeep ? 1500 : hasPending ? 3000 : isLong ? 2000 : 1200;

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
        system: [
          { type: 'text', text: staticContext, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: staticSystemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        messages: messagesWithContext,
      }),
    });





    const rawData = await res.json();
    console.log('[commandRouter] anthropic status:', res.status);
    if (res.status !== 200) console.error('[commandRouter] anthropic error body:', JSON.stringify(rawData));

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
      console.error('[commandRouter] JSON parse failed. Raw:', text);
      if (text?.length > 10) {
        await appendSessionMessage(user_id, 'user', input);
        await appendSessionMessage(user_id, 'karl', text);
        return { intent: 'question', response: text, usage };
      }
      return { intent: 'unclear', response: 'Something went wrong parsing that. Try again.', usage };
    }

    const intent       = parsed.intent as IntentType;
    const karlResponse = parsed.response ?? "I'm not sure what to do with that.";

    await appendSessionMessage(user_id, 'user', input);
    await appendSessionMessage(user_id, 'karl', karlResponse);

    if (parsed.learning) {
      persistLearning(user_id, parsed.learning).catch(() => {});
    }

    if (intent === 'execute') {
      const actions: KarlAction[] = parsed.actions ?? [];
      if (actions.length === 0 && parsed.title) {
        actions.push({
          action: 'insert', object_type: 'task', modal: 'TaskAddModal',
          fields: { title: parsed.title, bucket_key: parsed.bucket_key ?? 'capture', context_id: parsed.context_id ?? null, tags: parsed.tags ?? [], notes: parsed.notes ?? null, target_date: parsed.target_date ?? null, delegated_to: parsed.delegated_to ?? null },
        });
      }
      return { intent: 'execute', actions, response: karlResponse, usage };
    }

    if (intent === 'pending' || intent === 'modify_pending') {
      const isModify = intent === 'modify_pending';
      let actions: KarlAction[] = parsed.actions ?? [];

      if (actions.length === 0) {
        const action = parsed.action ?? 'insert';
        if (action === 'capture_tasks' && parsed.tasks?.length) {
          actions = [{ action: 'capture_tasks', object_type: 'task', modal: 'TaskAddModal', tasks: parsed.tasks }];
        } else if (action === 'run_template') {
          actions = [{ action: 'run_template', target_identifier: parsed.target_identifier, run_mode: parsed.run_mode ?? 'save', section_data: parsed.section_data ?? {} }];
        } else if (action === 'capture_task' || action === 'insert') {
          actions = [{ action: 'insert', object_type: parsed.object_type ?? 'task', modal: OBJECT_MODAL[parsed.object_type ?? 'task'], fields: { title: parsed.title, bucket_key: parsed.bucket_key ?? 'capture', context_id: parsed.context_id ?? null, tags: parsed.tags ?? [], notes: parsed.notes ?? null, target_date: parsed.target_date ?? null, delegated_to: parsed.delegated_to ?? null } }];
        } else if (action === 'update_object') {
          actions = [{ action: 'update', object_type: parsed.object_type, identifier: parsed.identifier, modal: OBJECT_MODAL[parsed.object_type], operations: parsed.operations ?? [] }];
        } else {
          actions = [{ ...parsed, action }];
        }
      }

      for (const a of actions) {
        if ((a.action === 'delete_object' || a.action === 'delete') && a.object_type) {
          const allowed = await checkAllowDelete(user_id, a.object_type);
          if (!allowed) {
            return { intent: 'question', response: `Delete on ${a.object_type} disabled by administrator.`, usage };
          }
        }
      }

      const nonTemplateActions = actions.filter(a => a.action !== 'run_template');
      const templateActions    = actions.filter(a => a.action === 'run_template');
      const enriched = nonTemplateActions.length > 0
        ? await enrichActions(user_id, nonTemplateActions, rejectedTags, isModify)
        : [];
      actions = [...enriched, ...templateActions];

      const matchedRules = await matchVocabRules(user_id, input);
      const silentRules: MatchedRule[] = [];
      for (const rule of matchedRules) {
        if (!rule.confirm) silentRules.push(rule);
      }
      for (const rule of silentRules) {
        actions = applyRuleToActions(actions, rule);
        touchKarlVocabRule(user_id, rule.vocab_id).catch(() => {});
      }

      return { intent, actions, response: karlResponse, usage };
    }

    if (intent === 'confirm_pending') return { intent: 'confirm_pending', response: karlResponse, usage };
    if (intent === 'cancel_pending')  return { intent: 'cancel_pending',  response: karlResponse, usage };
    if (intent === 'preview_pending') return { intent: 'preview_pending', response: karlResponse, usage };

    if (intent === 'open_form') {
      return { intent: 'open_form', payload: { modal: parsed.modal, identifier: parsed.identifier ?? null, prefill: parsed.prefill ?? {} }, response: karlResponse, usage };
    }

    if (intent === 'command' && parsed.command_type === 'open_tag_manager') {
      return { intent: 'command', payload: { command_type: 'open_tag_manager' }, response: parsed.response ?? 'Opening tag manager.', usage };
    }

    if (intent === 'question') {
      const qPayload: Record<string, any> = {};
      if (parsed.outcome_pending)    { qPayload.outcome_pending = true; qPayload.identifier = parsed.identifier; qPayload.object_type = parsed.object_type; }
      if (parsed.delegation_pending) { qPayload.delegation_pending = true; qPayload.identifier = parsed.identifier; qPayload.object_type = parsed.object_type; }
      if (parsed.open_modal)         { qPayload.open_modal = true; }
      if (parsed.payload?.template_choice_pending) {
        qPayload.template_choice_pending = true;
        qPayload.identifier = parsed.payload.identifier;
      }
      return { intent: 'question', payload: Object.keys(qPayload).length ? qPayload : undefined, response: karlResponse, usage };
    }

    return { intent, response: karlResponse, usage };

  } catch (err: any) {
    console.error('[commandRouter]', err);
    return { intent: 'unclear', error: err.message, response: 'Something went wrong. Try again.' };
  }
}