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
  | 'question'
  | 'command'
  | 'unclear';

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
}

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

export async function routeCommand(
  user_id: string,
  input: string
): Promise<RouterResult> {
  const db = createSupabaseAdmin();

  try {
    // ── Load field metadata ────────────────────────────────────────────────
    const { data: allMeta } = await db
      .from('ko_field_metadata')
      .select('object_type, field, label, field_type, insert_behavior')
      .eq('user_id', user_id)
      .in('object_type', ['task', 'meeting', 'completion', 'external_reference']);

    const objectSummaries = buildObjectSummaries(allMeta ?? []);

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

    // ── System prompt ──────────────────────────────────────────────────────
    const systemPrompt = [
      'You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done.',
      '',
      contextBlock,
      '',
      '## Your Job',
      'Classify user input, extract structured data, and enrich tasks with full metadata when provided.',
      '',
      '## Available Object Types',
      objectSummaries,
      '',
      '## Task Identifiers',
      'Tasks in the current load are identified as BucketN (e.g. N1, S2, RW1, L1, D1).',
      'When the user references a task by identifier or title, use it to act on that specific task.',
      '',
      '## Intent Classification',
      '- capture_task: A single clear action item.',
      '- capture_tasks: Multiple action items in one message.',
      '- capture_completion: User is logging something they completed.',
      '- question: User is asking for information or analysis.',
      '- command: Explicit system command (move, delegate, delete, update, etc.)',
      '- unclear: Ambiguous — ask for clarification.',
      '',
      '## Primary Vocabulary (always recognised)',
      'These phrases map to fields. Resolve them against Available Tags and Available Contexts above.',
      '- "bucket X" or "put it in X" or "X bucket" → bucket_key',
      '  Valid bucket keys: now, soon, realwork, later, delegate, capture',
      '  Common aliases: "fire" or "on fire" → now, "up next" → soon, "real work" → realwork',
      '- "code it to X" or "context X" → context_id (resolve X against Available Contexts, return the UUID)',
      '- "tag it X" or "tagged X" or "tag X" → tags array (resolve X against Available Tags, use exact name)',
      '- "by DATE" or "due DATE" or "target DATE" → target_date (ISO format YYYY-MM-DD)',
      '- "delegate to X" or "delegated to X" → delegated_to (person name)',
      '',
      '## Enrichment Rules',
      '- Always attempt to extract bucket, context_id, tags, and target_date from the input.',
      '- Only use tags from the Available Tags list. If the user names a tag that does not exist, note it in your response and omit it from the payload — do not invent tags.',
      '- Only use context_id UUIDs from the Available Contexts list. Match by name (case-insensitive). Return the UUID, not the name.',
      '- If bucket is not specified, use "capture".',
      '- If multiple tasks are described, extract ALL of them — apply the same metadata to each.',
      '- For task generation requests ("give me steps to X", "list tasks for Y"), generate the task titles yourself and apply the provided metadata to all of them.',
      '',
      '## Rules',
      '- Be conservative on intent. Commentary = question or unclear.',
      '- "I just did X", "I finished X", "I completed X" → capture_completion.',
      '- Extract the most concise title possible.',
      '- Never capture philosophical statements as tasks.',
      '- For questions and analysis, use the situation brief and history for situated answers.',
      '- Pattern for analysis: "Based on what I see — [fact]. My read — [inference]."',
      '- Never pretend inference is fact.',
      '- If no situation brief, gently prompt the user to write one.',
      '',
      isDeep ? [
        '## Observation Instruction',
        'Include an "observation" field — 1-2 sentences capturing a pattern you noticed.',
        'observation_type: pattern | preference | flag',
        '',
      ].join('\n') : '',
      '## Response Format — ONLY valid JSON, no markdown fences',
      '',
      'Single task:',
      '{ "intent": "capture_task", "title": "concise title", "bucket_key": "soon", "context_id": "uuid-or-null", "tags": ["Tag1"], "target_date": "2026-04-20 or null", "delegated_to": "name or null", "response": "Karl\'s response", "recognised_phrase": "the key phrase that triggered this" }',
      '',
      'Multiple tasks:',
      '{ "intent": "capture_tasks", "tasks": [{ "title": "task one", "bucket_key": "soon", "context_id": "uuid-or-null", "tags": ["Tag1"], "target_date": null, "delegated_to": null }], "summary": "X tasks found", "response": "Karl\'s response listing what was captured", "recognised_phrase": "the key phrase" }',
      '',
      'Completion:',
      '{ "intent": "capture_completion", "title": "what was completed", "outcome": "result", "response": "Karl\'s response" }',
      '',
      isDeep
        ? 'Question/command/unclear (analysis): { "intent": "question", "response": "Karl\'s response", "observation": "pattern note", "observation_type": "pattern" }'
        : 'Question/command/unclear: { "intent": "question", "response": "Karl\'s response" }',
    ].join('\n');

    // ── Call Anthropic ─────────────────────────────────────────────────────
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: isDeep ? 1500 : 800,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';

    let parsed: any;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return { intent: 'unclear', response: "I didn't quite get that. Can you rephrase?" };
    }

    const intent = parsed.intent as IntentType;
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

    // ── Return result ──────────────────────────────────────────────────────
    if (intent === 'capture_task') {
      return {
        intent: 'capture_task',
        payload: {
          title:        parsed.title,
          bucket_key:   parsed.bucket_key   ?? 'capture',
          context_id:   parsed.context_id   ?? null,
          tags:         parsed.tags         ?? [],
          target_date:  parsed.target_date  ?? null,
          delegated_to: parsed.delegated_to ?? null,
        },
        response: karlResponse,
      };
    }

    if (intent === 'capture_tasks') {
      // Support both old `titles` array and new `tasks` array with full enrichment
      const tasks = parsed.tasks ?? parsed.titles?.map((t: string) => ({ title: t })) ?? [];
      return {
        intent: 'capture_tasks',
        payload: {
          tasks,
          summary: parsed.summary ?? `${tasks.length} tasks`,
        },
        response: karlResponse,
      };
    }

    if (intent === 'capture_completion') {
      return {
        intent: 'capture_completion',
        payload: {
          title:   parsed.title,
          outcome: parsed.outcome ?? '',
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