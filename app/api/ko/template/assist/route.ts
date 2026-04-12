import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─── POST /api/ko/template/assist ─────────────────────────────────────────────
// Karl-assist chat for building template instructions.
// Body: { message, history, current_instructions, current_data_sources }
// Returns: { response, suggested_instructions, suggested_data_sources }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') ?? '';
    const token      = authHeader.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createSupabaseAdmin();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { message, history = [], current_instructions = '', current_data_sources = {} } = await req.json();
    if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

    const systemPrompt = `You are Karl, an operational AI assistant helping a user build a document template for KarlOps.

A KarlOps template has two core parts:
1. **prompt_template** — instructions that tell an LLM how to transform workspace data into a document
2. **data_sources** — a JSON object declaring which workspace data to pull

Available data sources:
\`\`\`json
{
  "situation": true,                          // user's situation brief
  "tasks": {
    "buckets": ["now","soon","realwork"],      // which buckets (now/soon/realwork/later/delegate/capture)
    "context": null,                          // optional context_id filter
    "tags": []                                // optional tag filter
  },
  "completions": {
    "window_days": 30,                        // how far back
    "context": null,
    "tags": []
  },
  "meetings": {
    "window_days": 30,
    "completed_only": true
  },
  "references": true                          // all references
}
\`\`\`

Your job:
- Understand what document the user wants to produce
- Draft clear, specific prompt_template instructions that will make Karl generate exactly that document
- Suggest the right data_sources for the document type
- Refine based on feedback
- Be concise in conversation — you're a builder tool, not a chatbot

When you have enough info to suggest instructions, respond in this JSON format:
\`\`\`json
{
  "response": "your conversational reply here",
  "suggested_instructions": "the full prompt_template text to use",
  "suggested_data_sources": { the data_sources json object }
}
\`\`\`

If you don't have enough info yet, respond with just:
\`\`\`json
{
  "response": "your question or reply"
}
\`\`\`

Current template state:
instructions: ${current_instructions || '(none yet)'}
data_sources: ${JSON.stringify(current_data_sources)}`;

    // Build message history (max 6 messages = 3 turns)
    const trimmedHistory = history.slice(-6);
    const messages = [
      ...trimmedHistory,
      { role: 'user' as const, content: message },
    ];

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      system:     systemPrompt,
      messages,
    });

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('');

    // Parse JSON response
    try {
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1].trim());
        return NextResponse.json({
          response:              parsed.response ?? '',
          suggested_instructions: parsed.suggested_instructions ?? null,
          suggested_data_sources: parsed.suggested_data_sources ?? null,
        });
      }
    } catch (_) {}

    // Fallback — plain text response
    return NextResponse.json({ response: raw, suggested_instructions: null, suggested_data_sources: null });

  } catch (err: any) {
    console.error('[template/assist]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}