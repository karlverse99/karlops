import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// ─── POST /api/ko/template/assist ─────────────────────────────────────────────
// Karl Assist — helps user build formatting instructions for a template.
// Body: { message, history, current_instructions }
// Returns: { response, suggested_instructions }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') ?? '';
    const token      = authHeader.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createSupabaseAdmin();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { message, history = [], current_instructions = '' } = await req.json();
    if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

    const systemPrompt = `You are Karl, an operational AI assistant helping a user build formatting instructions for a KarlOps document template.

## How KarlOps templates work

A template has one thing the user controls: **Formatting Instructions** (stored as prompt_template).

These instructions tell the generation model:
- What sections to include
- What fields to show per section
- How to format each section (bullets, table, prose, etc.)
- Any ordering, grouping, or conditional display rules

The data itself is pulled automatically based on sections[] defined on the template — the user does NOT write data queries. They just describe what they want to see.

## Available data sources (for your reference when suggesting instructions)

- **tasks** — open tasks, filterable by bucket (now/soon/realwork/later/delegate/capture), tags, context
- **completions** — completed work, filterable by date window, tags, context
- **meetings** — meetings, filterable by date window, attendees, completed status
- **situation** — user's current situation brief
- **references** — saved external references
- **contacts** — people directory

## Your job

1. Understand what document the user wants to produce
2. Draft clear, specific formatting instructions that describe exactly what the output should look like
3. Refine based on feedback
4. Be concise — you're a builder tool, not a chatbot

## What good formatting instructions look like

Good instructions describe output structure, not data queries. Example:

---
# Status Update for [Person Name]
Generated: {date}

## Delegated Tasks
Bullet per task. Show: title · status · due date. Flag overdue tasks.

## Recent Meetings
Bullet per meeting. Show: title · date · attendees · outcome if available.

## Open Tasks Tagged: [Person Name]
Bullet per task. Show: title · bucket · due date.

## Recent Completions
Bullet per completion. Show: title · completed date · outcome.
---

## Response format

When you have enough info to suggest instructions, respond ONLY with valid JSON (no markdown fences, no preamble):
{
  "response": "your conversational reply",
  "suggested_instructions": "the full formatting instructions text"
}

If you need more info first:
{
  "response": "your question or reply"
}

NEVER include data_sources, JSON queries, or technical config in suggested_instructions.
The instructions should read like a document spec — sections, fields, format. That's it.

Current instructions: ${current_instructions || '(none yet)'}`;

    const trimmedHistory = history.slice(-6);
    const messages = [
      ...trimmedHistory,
      { role: 'user' as const, content: message },
    ];

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[template/assist] tokens:', {
      input: usage.input_tokens, output: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read:  usage.cache_read_input_tokens ?? 0,
    });

    const raw = data.content?.[0]?.text ?? '';

    // Parse JSON — Karl returns raw JSON, no fences
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return NextResponse.json({
        response:               parsed.response ?? '',
        suggested_instructions: parsed.suggested_instructions ?? null,
      });
    } catch (_) {
      // Fallback — plain text response, no instructions suggested
      return NextResponse.json({ response: raw, suggested_instructions: null });
    }

  } catch (err: any) {
    console.error('[template/assist]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}