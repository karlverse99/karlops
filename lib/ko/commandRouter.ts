// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and field extraction

import { createSupabaseAdmin } from '@/lib/supabase-server';

export type IntentType = 'capture_task' | 'capture_tasks' | 'question' | 'command' | 'unclear';

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

    // ── Call Anthropic ─────────────────────────────────────────────────────
    const systemPrompt = `You are Karl, an operational assistant. Classify user input and extract structured data.

Available object types:
${objectSummaries}

Classify into one of these intents:
- capture_task: A single clear action item. Extract a concise title.
- capture_tasks: Multiple action items in one message (comma-separated list, numbered list, or block of tasks). Extract all titles.
- question: User is asking for information or analysis.
- command: Explicit system command (show, list, update, delete, move, etc.)
- unclear: Ambiguous — needs more info.

Rules:
- Be conservative. Commentary, opinions, or meta-statements = question or unclear.
- Only capture_* if there are clear actionable items.
- Extract the most concise title possible.
- For capture_tasks, extract ALL distinct tasks from the input.
- Never capture philosophical statements or system commentary as tasks.

Respond ONLY with valid JSON:

For single task:
{ "intent": "capture_task", "title": "concise task title", "response": "Karl's response" }

For multiple tasks:
{ "intent": "capture_tasks", "titles": ["task one", "task two"], "summary": "X tasks found", "response": "Karl's response listing what was found" }

For question/command/unclear:
{ "intent": "question", "response": "Karl's conversational response" }`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: input }],
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

    if (intent === 'capture_task') {
      return {
        intent: 'capture_task',
        payload: { title: parsed.title },
        response: parsed.response ?? `Got it — **${parsed.title}**. Capture it?`,
      };
    }

    if (intent === 'capture_tasks') {
      return {
        intent: 'capture_tasks',
        payload: { titles: parsed.titles, summary: parsed.summary ?? `${parsed.titles?.length} tasks` },
        response: parsed.response ?? `Found ${parsed.titles?.length} tasks. Capture all of them?`,
      };
    }

    return {
      intent,
      response: parsed.response ?? "I'm not sure what to do with that.",
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