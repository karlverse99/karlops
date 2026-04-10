// lib/ko/commandRouter.ts
// KarlOps L — Intent classification and field extraction
// Reads field metadata to build a dynamic prompt for the LLM.

import { createSupabaseAdmin } from '@/lib/supabase-server';

export type IntentType = 'capture_task' | 'question' | 'command' | 'unclear';

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

    // Build object type summaries for the prompt
    const objectSummaries = buildObjectSummaries(allMeta ?? []);

    // ── Call Anthropic ─────────────────────────────────────────────────────
    const systemPrompt = `You are Karl, an operational assistant. Your job is to classify user input and extract structured data.

Available object types you can capture:
${objectSummaries}

Classify the input into one of these intents:
- capture_task: A clear action item or thing to do. Extract a concise title.
- capture_meeting: References a meeting, call, or scheduled event with someone.
- capture_completion: Something that was already done or accomplished.
- capture_reference: A URL, document, or external resource.
- question: The user is asking for information or analysis.
- command: An explicit system command (show, list, update, delete, move, etc.)
- unclear: Ambiguous — could be multiple things or needs more info.

Rules:
- Be conservative. If it could be a question or commentary, classify as question.
- Only classify as capture_* if there is a clear actionable item or event.
- Extract the most concise title possible — strip filler words.
- Never capture philosophical statements, opinions, or meta-commentary about the system.

Respond ONLY with valid JSON in this exact format:
{
  "intent": "capture_task",
  "title": "extracted title if capture_task",
  "response": "Karl's conversational response to show in chat"
}`;

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

    // ── Parse response ─────────────────────────────────────────────────────
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

    // For questions and commands — return the response directly
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