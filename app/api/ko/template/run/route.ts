import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// ─── POST /api/ko/template/run ────────────────────────────────────────────────
// Runs a saved template against the user's live context data.
// Body: { template_id: string }
// Returns: { output: string, format: string }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') ?? '';
    const token      = authHeader.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createSupabaseAdmin();

    // Verify user
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { template_id, override_instructions, focus_prompt } = await req.json();
    if (!template_id) return NextResponse.json({ error: 'template_id required' }, { status: 400 });

    // Load template
    const { data: template, error: tErr } = await supabase
      .from('document_template')
      .select('*')
      .eq('document_template_id', template_id)
      .or(`user_id.eq.${user.id},is_system.eq.true`)
      .single();

    if (tErr || !template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    // Use override instructions if provided (e.g. from template builder preview)
    const instructions = override_instructions || template.prompt_template;

    // Load ko_user for implementation_type
    const { data: koUser } = await supabase
      .from('ko_user')
      .select('implementation_type, display_name')
      .eq('id', user.id)
      .single();

    // Build context from data_sources
    const ds      = template.data_sources ?? {};
    const context = await buildTemplateContext(supabase, user.id, ds, koUser?.implementation_type ?? 'personal');

    // Load user situation
    const { data: situation } = await supabase
      .from('user_situation')
      .select('brief')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    const systemPrompt = buildSystemPrompt(instructions, situation?.brief ?? '', context, focus_prompt);

    // Call Anthropic via fetch
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
        max_tokens: 4096,
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: 'Generate the document now based on my workspace data.' }],
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[template/run] tokens:', { input: usage.input_tokens, output: usage.output_tokens, cache_write: usage.cache_creation_input_tokens ?? 0, cache_read: usage.cache_read_input_tokens ?? 0 });
    const output = data.content?.[0]?.text ?? '';

    return NextResponse.json({ output, format: template.output_format ?? 'markdown' });

  } catch (err: any) {
    console.error('[template/run]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}

// ─── Context builder ──────────────────────────────────────────────────────────

async function buildTemplateContext(supabase: any, userId: string, ds: any, implementationType: string): Promise<string> {
  const sections: string[] = [];

  // Tasks
  if (ds.tasks) {
    const q = supabase
      .from('task')
      .select('title, bucket_key, tags, target_date, context_id')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false);

    if (ds.tasks.buckets?.length) q.in('bucket_key', ds.tasks.buckets);
    if (ds.tasks.context)         q.eq('context_id', ds.tasks.context);

    const { data: tasks } = await q.order('created_at', { ascending: false });

    if (tasks?.length) {
      const grouped: Record<string, string[]> = {};
      for (const t of tasks) {
        if (!grouped[t.bucket_key]) grouped[t.bucket_key] = [];
        grouped[t.bucket_key].push(t.title);
      }
      let taskBlock = '## Open Tasks\n';
      for (const [bucket, titles] of Object.entries(grouped)) {
        taskBlock += `\n**${bucket.toUpperCase()}**\n`;
        taskBlock += titles.map(t => `- ${t}`).join('\n');
      }
      sections.push(taskBlock);
    }
  }

  // Completions
  if (ds.completions) {
    const windowDays = ds.completions.window_days ?? 30;
    const since      = new Date(Date.now() - windowDays * 86400000).toISOString();

    const q = supabase
      .from('completion')
      .select('title, outcome, description, completed_at, tags, context_id')
      .eq('user_id', userId)
      .gte('completed_at', since)
      .order('completed_at', { ascending: false });

    if (ds.completions.context) q.eq('context_id', ds.completions.context);
    if (ds.completions.tags?.length) q.overlaps('tags', ds.completions.tags);

    const { data: completions } = await q;

    if (completions?.length) {
      let block = `## Completions (last ${windowDays} days)\n`;
      for (const c of completions) {
        block += `\n### ${c.title}`;
        if (c.outcome)     block += `\n**Outcome:** ${c.outcome}`;
        if (c.description) block += `\n${c.description}`;
        if (c.tags?.length) block += `\n**Tags:** ${c.tags.join(', ')}`;
      }
      sections.push(block);
    }
  }

  // Meetings
  if (ds.meetings) {
    const windowDays = ds.meetings.window_days ?? 30;
    const since      = new Date(Date.now() - windowDays * 86400000).toISOString();

    const q = supabase
      .from('meeting')
      .select('title, outcome, notes, meeting_date, attendees, tags')
      .eq('user_id', userId)
      .gte('meeting_date', since)
      .order('meeting_date', { ascending: false });

    if (ds.meetings.completed_only) q.eq('is_completed', true);

    const { data: meetings } = await q;

    if (meetings?.length) {
      let block = `## Meetings (last ${windowDays} days)\n`;
      for (const m of meetings) {
        block += `\n### ${m.title}`;
        if (m.meeting_date) block += ` (${new Date(m.meeting_date).toLocaleDateString()})`;
        if (m.outcome)      block += `\n**Outcome:** ${m.outcome}`;
        if (m.notes)        block += `\n${m.notes}`;
        if (m.attendees?.length) block += `\n**Attendees:** ${m.attendees.join(', ')}`;
      }
      sections.push(block);
    }
  }

  // References
  if (ds.references) {
    const { data: refs } = await supabase
      .from('external_reference')
      .select('title, description, filename, location, tags')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (refs?.length) {
      let block = '## External References\n';
      for (const r of refs) {
        block += `\n- **${r.title}**`;
        if (r.filename)    block += ` (${r.filename})`;
        if (r.description) block += ` — ${r.description}`;
      }
      sections.push(block);
    }
  }

  return sections.join('\n\n');
}

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(instructions: string, situation: string, context: string, focusPrompt?: string): string {
  return `You are Karl, an operational AI assistant. You are generating a document for the user based on their workspace data.

${situation ? `## User Situation\n${situation}\n` : ''}

## Workspace Data
${context}

## Document Instructions
${instructions}

${focusPrompt ? `## Additional Focus\n${focusPrompt}\n` : ''}
Generate the document now. Write in clear, professional prose. Use markdown formatting. Be specific and concrete — use the actual data provided, not placeholders. Do not add preamble or meta-commentary about what you're about to do. Just produce the document.`;
}