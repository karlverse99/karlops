import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// ─── POST /api/ko/extract/refine ─────────────────────────────────────────────
// Refines an extract's content based on the current draft + a user instruction.
// Karl rewrites FROM the current content — hand edits are preserved as input.
// Body: { current_content, refinement_instruction, template_instructions }
// Returns: { output }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') ?? '';
    const token      = authHeader.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createSupabaseAdmin();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { current_content, refinement_instruction, template_instructions } = await req.json();
    if (!current_content)          return NextResponse.json({ error: 'current_content required' }, { status: 400 });
    if (!refinement_instruction)   return NextResponse.json({ error: 'refinement_instruction required' }, { status: 400 });

    const systemPrompt = [
      'You are Karl, an operational AI assistant. You are refining a document draft.',
      '',
      template_instructions
        ? `## Original document instructions\n${template_instructions}`
        : '',
      '',
      '## Your task',
      'The user has provided their current draft (which may include hand edits) and a refinement instruction.',
      'Rewrite the document incorporating the refinement instruction.',
      'Preserve the overall structure and any specific details the user has added.',
      'Work FROM the current draft — it is your input, not a starting point to discard.',
      '',
      '## Rules',
      '- Do not add preamble or meta-commentary',
      '- Do not say what you changed — just produce the refined document',
      '- Preserve markdown formatting',
      '- Be specific and concrete — use real data and names from the draft',
      '- If the instruction is unclear, make your best judgment and proceed',
    ].filter(Boolean).join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system:     systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Here is my current draft:\n\n${current_content}\n\n---\n\nRefinement instruction: ${refinement_instruction}`,
          },
        ],
      }),
    });

    const data   = await res.json();
    const output = data.content?.[0]?.text ?? '';

    return NextResponse.json({ output });

  } catch (err: any) {
    console.error('[extract/refine]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}