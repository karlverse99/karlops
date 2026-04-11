// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and field extraction

import { createSupabaseAdmin } from '@/lib/supabase-server';
import {
  buildKarlContext,
  buildKarlDeepContext,
  formatContextForPrompt,
  appendSessionMessage,
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

// Analysis keywords — trigger deep context pull
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
    // ── Load capturable object types from field metadata ───────────────────
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

    // ── Build conversation history for Anthropic messages array ───────────
    const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [
      ...bundle.recentMessages.map(m => ({
        role: (m.role === 'karl' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input },
    ];

    // Anthropic requires the first message to be role: 'user'
    while (anthropicMessages.length > 1 && anthropicMessages[0].role === 'assistant') {
      anthropicMessages.shift();
    }

    // ── Call Anthropic ─────────────────────────────────────────────────────
    const systemPrompt = [
      'You are Karl, an operational assistant inside KarlOps — a personal pressure system for getting things done.',
      '',
      contextBlock,
      '',
      '## Your Job',
      'Classify user input and extract structured data, informed by the user\'s situation and history above.',
      '',
      '## Available Object Types',
      objectSummaries,
      '',
      '## Task Identifiers',
      'Tasks in the current load are identified as [Bucket-N] (e.g. [Now-1], [RW-2], [Del-1]).',
      'When the user references a task by identifier or title, use it to act on that specific task.',
      '',
      '## Intent Classification',
      'Classify into one of these intents:',
      '- capture_task: A single clear action item. Extract a concise title.',
      '- capture_tasks: Multiple action items in one message. Extract all titles.',
      '- capture_completion: User is logging something they completed or accomplished. Extract title and outcome.',
      '- question: User is asking for information or analysis. Answer using their situation and history.',
      '- command: Explicit system command (show, list, update, delete, move, etc.)',
      '- unclear: Ambiguous — needs more info.',
      '',
      '## Rules',
      '- Be conservative. Commentary, opinions, or meta-statements = question or unclear.',
      '- Only capture_* if there are clear actionable items or completions.',
      '- "I just did X", "I finished X", "I completed X", "log that I did X" → capture_completion.',
      '- Extract the most concise title possible.',
      '- For capture_tasks, extract ALL distinct tasks from the input.',
      '- Never capture philosophical statements or system commentary as tasks.',
      '- For questions and analysis, use the user\'s situation brief and history to give situated, specific answers.',
      '- Pattern for analysis: "Based on what I see — [fact from data]. My read — [inference]."',
      '- Never pretend inference is fact.',
      '- If the user has no situation brief, gently prompt them to write one.',
      '',
      '## Response Format',
      'Respond ONLY with valid JSON.',
      '',
      'For single task:',
      '{ "intent": "capture_task", "title": "concise task title", "response": "Karl\'s response" }',
      '',
      'For multiple tasks:',
      '{ "intent": "capture_tasks", "titles": ["task one", "task two"], "summary": "X tasks found", "response": "Karl\'s response listing what was found" }',
      '',
      'For completion:',
      '{ "intent": "capture_completion", "title": "what was completed", "outcome": "what happened / result", "response": "Karl\'s response" }',
      '',
      'For question/command/unclear:',
      '{ "intent": "question", "response": "Karl\'s conversational response" }',
    ].join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: isDeep ? 1500 : 500,
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

    // ── Persist exchange to session history ────────────────────────────────
    await appendSessionMessage(user_id, 'user', input);
    await appendSessionMessage(user_id, 'karl', karlResponse);

    // ── Return result ──────────────────────────────────────────────────────
    if (intent === 'capture_task') {
      return {
        intent: 'capture_task',
        payload: { title: parsed.title },
        response: karlResponse,
      };
    }

    if (intent === 'capture_tasks') {
      return {
        intent: 'capture_tasks',
        payload: { titles: parsed.titles, summary: parsed.summary ?? `${parsed.titles?.length} tasks` },
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

    return {
      intent,
      response: karlResponse,
    };

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
    const required = fields
      .filter(f => f.insert_behavior === 'required')
      .map(f => f.label)
      .join(', ');
    return `- ${type}: required fields are ${required}`;
  }).join('\n');
}