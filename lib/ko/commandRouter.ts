// lib/ko/commandRouter.ts
// KarlOps L — Intent classification, field extraction, and enrichment

import { createSupabaseAdmin } from '@/lib/supabase-server';
import {
  buildKarlContext,
  buildKarlDeepContext,
  formatContextForPrompt,
  appendSessionMessage,
  writeKarlObservation,
  upsertKarlVocab,
} from '@/lib/ko/buildKarlContext';

export type IntentType =
  | 'capture_task'
  | 'capture_tasks'
  | 'capture_completion'
  | 'update_object'
  | 'question'
  | 'command'
  | 'unclear';

export interface UpdateOperation {
  field: string;               // DB field name e.g. 'bucket_key', 'title', 'tags'
  value: string | string[];    // new value. For tags: the tag name string
  tag_op?: 'add' | 'remove';  // required when field === 'tags'
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

// Table name for each FC object type Karl can reference
export const OBJECT_TABLE: Record<string, string> = {
  task:               'task',
  completion:         'completion',
  meeting:            'meeting',
  external_reference: 'external_reference',
  document_template:  'document_template',
  contact:            'contact',
};

// PK column name per table
export const OBJECT_PK: Record<string, string> = {
  task:               'task_id',
  completion:         'completion_id',
  meeting:            'meeting_id',
  external_reference: 'external_reference_id',
  document_template:  'document_template_id',
  contact:            'contact_id',
};

const ANALYSIS_TRIGGERS = [
  'analyze', 'analysis', 'review', 'summarize', 'summary',
  'make the case', 'what have i done', 'show me', 'evidence',
  'how am i doing', 'what does it look like', 'this week', 'this month',
  'against my', 'pip', 'requirement', 'progress',
];

function isAnalysisRequest(input: string): boolean {
  const lower = input.toLowerCase();
  return ANALYSIS_TRIGGERS.some(t => lower.includes(t));
}

// ── Tag suggestion for chat captures ─────────────────────────────────────────

async function suggestTagsForCapture(
  user_id: string,
  context_text: string,
  already_tagged: string[]
): Promise<string[]> {
  const db = createSupabaseAdmin();

  try {
    const [tagGroupRes, tagRes, situationRes] = await Promise.all([
      db.from('tag_group').select('tag_group_id, name').eq('user_id', user_id).eq('is_archived', false).order('display_order'),
      db.from('tag').select('name, description, tag_group_id').eq('user_id', user_id).eq('is_archived', false).order('name'),
      db.from('user_situation').select('brief').eq('user_id', user_id).eq('is_active', true).maybeSingle(),
    ]);

    const tagGroups    = tagGroupRes.data ?? [];
    const existingTags = tagRes.data ?? [];
    const situation    = situationRes.data?.brief?.trim() ?? '';

    if (existingTags.length === 0) return [];

    const groupMap: Record<string, string> = {};
    for (const g of tagGroups) groupMap[g.tag_group_id] = g.name;

    const existingTagList = existingTags
      .map(t => `${t.name} [${groupMap[t.tag_group_id] ?? 'General'}]${t.description ? ` (${t.description})` : ''}`)
      .join(', ');

    const alreadySelected = already_tagged.length ? already_tagged.join(', ') : 'none';

    const systemPrompt = `You are Karl, suggesting tags for a KarlOps task being captured via chat.
Suggest 1-3 existing tags that fit the content. Existing tags only — do not invent new ones.

Existing tags: ${existingTagList}
Already tagged (do not re-suggest): ${alreadySelected}
User situation: ${situation || 'Not provided.'}

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
      existingNames.has(name) && !already_tagged.includes(name)
    );

  } catch (err) {
    console.error('[suggestTagsForCapture]', err);
    return [];
  }
}

// ── Extract tags the user explicitly rejected in the conversation ─────────────

function extractRejectedTags(messages: { role: string; content: string }[]): string[] {
  const rejected = new Set<string>();
  const rejectPatterns = [
    /don'?t (?:like|want|use|include)\s+#?([A-Za-z0-9/_\-]+)/gi,
    /(?:remove|drop|not|skip|no)\s+#([A-Za-z0-9/_\-]+)/gi,
    /(?:remove|drop|skip)\s+([A-Za-z0-9/_\-]+)\s+tag/gi,
  ];

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const pattern of rejectPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(msg.content)) !== null) {
        rejected.add(match[1]);
      }
    }
  }

  return Array.from(rejected);
}

// ── Build editable field summary for Karl's system prompt ─────────────────────

function buildEditableFieldSummary(meta: FieldMeta[]): string {
  const byType: Record<string, string[]> = {};
  for (const f of meta) {
    if (f.update_behavior !== 'editable') continue;
    if (!byType[f.object_type]) byType[f.object_type] = [];
    byType[f.object_type].push(`${f.field} (${f.label})`);
  }
  return Object.entries(byType)
    .map(([type, fields]) => `- ${type}: ${fields.join(', ')}`)
    .join('\n') || 'no editable fields found';
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

// ── Main router ───────────────────────────────────────────────────────────────

export async function routeCommand(
  user_id: string,
  input: string
): Promise<RouterResult> {
  const db = createSupabaseAdmin();

  try {
    // ── Load field metadata ────────────────────────────────────────────────
    const { data: allMeta } = await db
      .from('ko_field_metadata')
      .select('object_type, field, label, field_type, insert_behavior, update_behavior')
      .eq('user_id', user_id)
      .in('object_type', ['task', 'meeting', 'completion', 'external_reference', 'document_template', 'contact']);

    const objectSummaries      = buildObjectSummaries(allMeta ?? []);
    const editableFieldSummary = buildEditableFieldSummary(allMeta ?? []);

    // ── Build context bundle ───────────────────────────────────────────────
    const isDeep = isAnalysisRequest(input);
    const bundle = isDeep
      ? await buildKarlDeepContext(user_id)
      : await buildKarlContext(user_id);

    const contextBlock = formatContextForPrompt(bundle);

    // ── Build Anthropic messages array ────────────────────────────────────
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

    // ── Extract rejected tags from recent conversation ─────────────────────
    const rejectedTags = extractRejectedTags(bundle.recentMessages);
    const rejectedTagsNote = rejectedTags.length > 0
      ? `\n## Rejected Tags — NEVER suggest these\nThe user has explicitly rejected these tags in this conversation: ${rejectedTags.join(', ')}`
      : '';

    // ── Observations as behavior instructions ─────────────────────────────
    const observationInstructions = bundle.observations
      ? `## Your Observations About This User\nYou have noticed these patterns. Use them actively to shape your responses — adjust your tone, suggestions, and defaults accordingly. Do not just acknowledge them; act on them.\n${bundle.observations}`
      : '';

    // ── System prompt ──────────────────────────────────────────────────────
    const systemPrompt = [
      'You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done.',
      '',
      contextBlock,
      '',
      observationInstructions,
      '',
      '## Your Job',
      'Classify user input, extract structured data, and enrich tasks with full metadata when provided.',
      '',
      '## Available Object Types',
      objectSummaries,
      '',
      '## Task Identifiers',
      'Tasks and FC objects are identified as PrefixN (e.g. N1, S2, RW1, L1, D1, CP1, CM1, MT1, EX1, TM1, CT1).',
      'Prefix key: N=now, S=soon, RW=realwork, L=later, D=delegate, CP=capture, CM=completion, MT=meeting, EX=extract, TM=template, CT=contact.',
      'When the user references an object by identifier, use it to act on that specific object.',
      '',
      '## Intent Classification',
      '- capture_task: A single clear action item to add.',
      '- capture_tasks: Multiple action items in one message.',
      '- capture_completion: User is logging something they completed.',
      '- update_object: User wants to change, move, rename, tag, delegate, or update an existing object.',
      '  Use this for: "move N3 to soon", "change the title of RW2", "delegate D1 to Sarah", "add tag X to N2", "update the outcome on CM1", "rename TM1".',
      '  Do NOT use this for task completion — see complete_task rule below.',
      '- question: User is asking for information, analysis, or clarification.',
      '  ALWAYS use question (never unclear) when the user asks anything meta about a pending action:',
      '  "what are you going to change?", "would you have done that?", "what does that do?", "why did you pick that?" — all are question.',
      '- command: Explicit system command.',
      '  Tag manager: "manage tags", "open tags", "tag manager", "add a tag", "create a tag" → command_type: open_tag_manager',
      '- unclear: LAST RESORT ONLY. Use only when you genuinely cannot determine intent and none of the above fit.',
      '  Never use unclear for meta-questions about pending actions. Never use unclear for short affirmations or reactions.',
      '',
      '## complete_task — TWO STEP FLOW (CRITICAL)',
      'When the user wants to mark a task done ("mark N1 done", "complete S2", "finish RW1"):',
      'STEP 1 — You do NOT immediately return update_object.',
      '  Instead return intent: question and ask for the outcome:',
      '  "What was the result? Give me a line on what happened or how it was resolved."',
      '  Include "outcome_pending": true and "identifier": "N1" and "object_type": "task" in your JSON so the workspace knows to keep context.',
      'STEP 2 — When the user provides the outcome, THEN return:',
      '  { "intent": "update_object", "object_type": "task", "identifier": "N1",',
      '    "operations": [{ "field": "is_completed", "value": "true" }, { "field": "outcome", "value": "<their answer>" }],',
      '    "response": "..." }',
      'EXCEPTION: If the user explicitly says "no outcome" or "just mark it done" or "no comment", skip the question and go straight to update_object with outcome="".',
      '',
      '## update_object Rules',
      'When the user wants to update an existing FC object:',
      '- Identify the object type and identifier (e.g. N3 = task, TM1 = document_template)',
      '- Return one or more operations in the `operations` array',
      '- Each operation: { "field": "db_field_name", "value": "new_value" }',
      '- For tag operations: { "field": "tags", "value": "Tag Name", "tag_op": "add" } or "remove"',
      '- For delegate: two operations — bucket_key=delegate AND tags add the person name',
      '',
      '## Editable Fields Per Object Type',
      editableFieldSummary,
      '',
      '## Primary Vocabulary (always recognised)',
      '- "bucket X" or "put it in X" or "move to X" → bucket_key',
      '  Valid bucket keys: now, soon, realwork, later, delegate, capture',
      '  Aliases: "fire"/"on fire" → now, "up next" → soon, "real work" → realwork',
      '- "code it to X" or "context X" → context_id (resolve X against Available Contexts, return the UUID)',
      '- "tag it X" or "tagged X" → tags add operation',
      '- "by DATE" or "due DATE" or "target DATE" → target_date (ISO format YYYY-MM-DD)',
      '- "delegate to X" → bucket_key=delegate + add People tag X',
      '- "mark done" or "complete" or "finished" → complete_task two-step flow (see above)',
      '',
      '## Tag Rules',
      '- Only use tags from the Available Tags list in context.',
      '- If the user names a tag that does not exist, say so clearly and omit it.',
      '- NEVER suggest a tag the user has rejected in this conversation.',
      rejectedTagsNote,
      '',
      '## Enrichment Rules',
      '- Always attempt to extract bucket, context_id, tags, and target_date from captures.',
      '- Only use context_id UUIDs from the Available Contexts list.',
      '- If bucket is not specified for a capture, use "capture".',
      '- For task generation requests, generate the task titles yourself.',
      '',
      '## General Rules',
      '- Be conservative on intent. Commentary = question.',
      '- "I just did X", "I finished X", "I completed X" → capture_completion.',
      '- Never capture philosophical statements as tasks.',
      '- Pattern for analysis: "Based on what I see — [fact]. My read — [inference]."',
      '- Never pretend inference is fact.',
      '- CRITICAL: When you have enough info to capture or update, always return the action intent — never question or unclear.',
      '- CRITICAL: Response field always uses FUTURE tense for captures/updates — "Here\'s what I\'ll do..." NOT "Done..."',
      '- CRITICAL: Long text dumps (especially after being asked) → capture_task. Extract concise title, use text as context.',
      '',
      isDeep ? '## Observation Instruction\nInclude an "observation" field — 1-2 sentences capturing a pattern you noticed.\nobservation_type: pattern | preference | flag\n' : '',
      '## Response Format — ONLY valid JSON, no markdown fences',
      '',
      'Single capture:',
      '{ "intent": "capture_task", "title": "concise title", "bucket_key": "soon", "context_id": "uuid-or-null", "tags": ["Tag1"], "target_date": "2026-04-20 or null", "response": "Karl\'s response", "recognised_phrase": "the key phrase" }',
      '',
      'Multiple captures:',
      '{ "intent": "capture_tasks", "tasks": [{ "title": "task one", "bucket_key": "soon", "context_id": "uuid-or-null", "tags": ["Tag1"], "target_date": null }], "summary": "X tasks found", "response": "Karl\'s response", "recognised_phrase": "the key phrase" }',
      '',
      'Completion capture:',
      '{ "intent": "capture_completion", "title": "what was completed", "outcome": "result", "response": "Karl\'s response" }',
      '',
      'Complete task step 1 (asking for outcome):',
      '{ "intent": "question", "outcome_pending": true, "identifier": "N1", "object_type": "task", "response": "What was the result? Give me a line on what happened." }',
      '',
      'Complete task step 2 (after outcome provided):',
      '{ "intent": "update_object", "object_type": "task", "identifier": "N1", "operations": [{ "field": "is_completed", "value": "true" }, { "field": "outcome", "value": "user\'s outcome text" }], "response": "I\'ll mark that done and log the outcome." }',
      '',
      'Update object:',
      '{ "intent": "update_object", "object_type": "task", "identifier": "N3", "operations": [{ "field": "bucket_key", "value": "soon" }], "response": "Karl\'s summary of what will change" }',
      '',
      'Delegate example:',
      '{ "intent": "update_object", "object_type": "task", "identifier": "D1", "operations": [{ "field": "bucket_key", "value": "delegate" }, { "field": "tags", "value": "Sarah", "tag_op": "add" }], "response": "I\'ll move this to Delegate and tag Sarah." }',
      '',
      isDeep
        ? 'Question/analysis: { "intent": "question", "response": "Karl\'s response", "observation": "pattern note", "observation_type": "pattern" }'
        : 'Question/command/unclear: { "intent": "question", "response": "Karl\'s response" }',
    ].filter(Boolean).join('\n');

    // ── Call Anthropic ────────────────────────────────────────────────────
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
        max_tokens: isDeep ? 1500 : 800,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages,
      }),
    });

    const rawData = await res.json();
    const usage = rawData.usage;
    if (usage) console.log('[commandRouter] tokens:', {
      input:       usage.input_tokens,
      output:      usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read:  usage.cache_read_input_tokens ?? 0,
    });

    const text = rawData.content?.[0]?.text ?? '';

    let parsed: any;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return { intent: 'unclear', response: "I didn't quite get that. Can you rephrase?" };
    }

    const intent       = parsed.intent as IntentType;
    const karlResponse = parsed.response ?? "I'm not sure what to do with that.";

    // ── Persist exchange ───────────────────────────────────────────────────
    await appendSessionMessage(user_id, 'user', input);
    await appendSessionMessage(user_id, 'karl', karlResponse);

    // ── Write vocab (fire and forget) ─────────────────────────────────────
    if (parsed.recognised_phrase && (intent === 'capture_task' || intent === 'capture_tasks')) {
      upsertKarlVocab(user_id, parsed.recognised_phrase, intent, 'task').catch(err =>
        console.error('[commandRouter] vocab write failed:', err)
      );
    }

    // ── Write observation after analysis (fire and forget) ────────────────
    if (isDeep && parsed.observation) {
      const obsType = (['pattern', 'preference', 'flag'] as const).includes(parsed.observation_type)
        ? parsed.observation_type as 'pattern' | 'preference' | 'flag'
        : 'pattern';
      writeKarlObservation(user_id, parsed.observation, obsType).catch(err =>
        console.error('[commandRouter] observation write failed:', err)
      );
    }

    // ── capture_task — enrich with tag suggestions ─────────────────────────
    if (intent === 'capture_task') {
      const karlTags: string[] = (parsed.tags ?? []).filter(
        (t: string) => !rejectedTags.includes(t)
      );

      const suggestedTags     = await suggestTagsForCapture(user_id, parsed.title, karlTags);
      const filteredSuggested = suggestedTags.filter(t => !rejectedTags.includes(t));
      const allTags           = Array.from(new Set([...karlTags, ...filteredSuggested])).slice(0, 5);

      const tagMention = allTags.length > 0
        ? ` Tagged: ${allTags.map(t => `#${t}`).join(' ')}.`
        : ' No tags — will land in capture.';

      const enrichedResponse = karlResponse.replace(/\.$/, '') + tagMention;
      await appendSessionMessage(user_id, 'karl', enrichedResponse);

      return {
        intent: 'capture_task',
        payload: {
          title:       parsed.title,
          bucket_key:  parsed.bucket_key  ?? 'capture',
          context_id:  parsed.context_id  ?? null,
          tags:        allTags,
          target_date: parsed.target_date ?? null,
        },
        response: enrichedResponse,
      };
    }

    // ── capture_tasks — enrich each task ──────────────────────────────────
    if (intent === 'capture_tasks') {
      const tasks             = parsed.tasks ?? parsed.titles?.map((t: string) => ({ title: t })) ?? [];
      const combinedTitles    = tasks.map((t: any) => t.title).join(', ');
      const suggestedTags     = await suggestTagsForCapture(user_id, combinedTitles, []);
      const filteredSuggested = suggestedTags.filter(t => !rejectedTags.includes(t));

      const enrichedTasks = tasks.map((task: any) => {
        const taskTags = (task.tags ?? []).filter((t: string) => !rejectedTags.includes(t));
        const merged   = Array.from(new Set([...taskTags, ...filteredSuggested])).slice(0, 5);
        return { ...task, tags: merged };
      });

      const tagMention = filteredSuggested.length > 0
        ? ` Suggested tags: ${filteredSuggested.map(t => `#${t}`).join(' ')}.`
        : '';

      const enrichedResponse = karlResponse.replace(/\.$/, '') + tagMention;

      return {
        intent: 'capture_tasks',
        payload: { tasks: enrichedTasks, summary: parsed.summary ?? `${enrichedTasks.length} tasks` },
        response: enrichedResponse,
      };
    }

    // ── capture_completion ─────────────────────────────────────────────────
    if (intent === 'capture_completion') {
      return {
        intent: 'capture_completion',
        payload: { title: parsed.title, outcome: parsed.outcome ?? '' },
        response: karlResponse,
      };
    }

    // ── update_object ──────────────────────────────────────────────────────
    if (intent === 'update_object') {
      return {
        intent: 'update_object',
        payload: {
          object_type: parsed.object_type,
          identifier:  parsed.identifier,
          operations:  parsed.operations ?? [],
        },
        response: karlResponse,
      };
    }

    // ── command ────────────────────────────────────────────────────────────
    if (intent === 'command' && parsed.command_type === 'open_tag_manager') {
      return {
        intent: 'command',
        payload: { command_type: 'open_tag_manager' },
        response: parsed.response ?? 'Opening tag manager.',
      };
    }

    // ── question with outcome_pending — pass context through ───────────────
    // Karl is mid-complete_task flow, waiting for the outcome from the user.
    // Return the pending identifiers so workspace can keep context if needed.
    if (intent === 'question' && parsed.outcome_pending) {
      return {
        intent: 'question',
        payload: {
          outcome_pending: true,
          identifier:      parsed.identifier,
          object_type:     parsed.object_type,
        },
        response: karlResponse,
      };
    }

    return { intent, response: karlResponse };

  } catch (err: any) {
    console.error('[commandRouter]', err);
    return { intent: 'unclear', error: err.message, response: 'Something went wrong. Try again.' };
  }
}