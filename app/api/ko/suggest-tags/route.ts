// app/api/ko/suggest-tags/route.ts
// KarlOps L — Tag suggestion engine
// Modes:
//   admin  — seed tags for the whole workspace (onboarding)
//   inline — suggest tags for any FC object based on its content

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const db = createSupabaseAdmin();
  const { data: { user } } = await db.auth.getUser(token);
  return user;
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createSupabaseAdmin();
  const body = await req.json();

  // mode: 'admin'  = seed tags for the whole workspace
  //       'inline' = suggest tags for a specific FC object
  const {
    mode = 'inline',
    object_type = '',       // inline: which FC object (task, meeting, completion, etc.)
    context_text = '',      // inline: title + description + any other text from the object
    selected_tags = [],     // inline: already selected tags — don't re-suggest these
  } = body;

  try {
    // Load user context
    const [situationRes, tagGroupRes, tagRes, contextRes, taskRes] = await Promise.all([
      db.from('user_situation')
        .select('brief')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle(),
      db.from('tag_group')
        .select('tag_group_id, name')
        .eq('user_id', user.id)
        .eq('is_archived', false)
        .order('display_order'),
      db.from('tag')
        .select('name, description, tag_group_id')
        .eq('user_id', user.id)
        .eq('is_archived', false)
        .order('name'),
      db.from('context')
        .select('name')
        .eq('user_id', user.id)
        .eq('is_archived', false)
        .eq('is_visible', true)
        .order('name'),
      db.from('task')
        .select('title, tags')
        .eq('user_id', user.id)
        .eq('is_completed', false)
        .eq('is_archived', false)
        .limit(50),
    ]);

    const situation    = situationRes.data?.brief?.trim() || '';
    const tagGroups    = tagGroupRes.data ?? [];
    const existingTags = tagRes.data ?? [];
    const contexts     = contextRes.data ?? [];
    const tasks        = taskRes.data ?? [];

    const groupMap: Record<string, string> = {};
    for (const g of tagGroups) groupMap[g.tag_group_id] = g.name;

    const groupList = tagGroups.map(g => g.name).join(', ');
    const existingTagList = existingTags.length
      ? existingTags.map(t => {
          const groupName = groupMap[t.tag_group_id] ?? 'General';
          return `${t.name} [${groupName}]${t.description ? ` (${t.description})` : ''}`;
        }).join(', ')
      : 'none yet';
    const contextList  = contexts.map(c => c.name).join(', ');
    const taskSample   = tasks.slice(0, 20).map(t => t.title).join(', ');
    const alreadySelected = selected_tags.length ? selected_tags.join(', ') : 'none';

    // ── ADMIN mode ────────────────────────────────────────────────────────────
    if (mode === 'admin') {
      const systemPrompt = `You are Karl, helping a KarlOps user build their initial tag set.
You have full context about who they are and what they're working on.
Your job is to suggest a comprehensive starting set of tags that will be useful across all their work.

Available tag groups: ${groupList}
Existing tags: ${existingTagList}
Contexts: ${contextList}
Sample tasks: ${taskSample || 'none yet'}

Rules:
- Suggest 15-25 tags total — enough to be useful, not overwhelming
- Assign each tag to the most logical group from the available groups
- Include a short description for each tag (1 sentence, helps Karl infer usage later)
- Do NOT suggest tags that already exist (check existing tags list)
- Mix people, tools, domains, activities — cover the full surface of their life
- For People tags: use first names of people mentioned in situation or tasks
- For Systems tags: tools and platforms they use
- For Activities tags: domains of work and life they operate in
- For Projects tags: discrete bounded efforts visible in their situation or tasks
- For Organizations tags: companies, institutions they interact with
- For Personal tags: health, learning, self-development areas
- For Places tags: locations that matter (home, office, etc.)
- For Roles tags: relationship roles (Manager, Colleague, Client, etc.)
- General: anything that doesn't fit above

Respond ONLY with valid JSON, no markdown:
{
  "suggested": [
    { "name": "TagName", "group": "GroupName", "description": "one sentence description" }
  ],
  "reasoning": "one sentence explaining your overall approach"
}`;

      const userMessage = `My situation: ${situation || 'Not yet written.'}\n\nPlease suggest a strong starting tag set for my KarlOps workspace.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      const data = await res.json();
      const text = data.content?.[0]?.text ?? '';
      let parsed: any;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        return NextResponse.json({ error: 'Failed to parse Karl response' }, { status: 500 });
      }

      const groupNameMap: Record<string, string> = {};
      for (const g of tagGroups) groupNameMap[g.name.toLowerCase()] = g.tag_group_id;
      const resolveGroup = (name: string) => groupNameMap[name.toLowerCase()] ?? null;

      return NextResponse.json({
        success: true,
        mode: 'admin',
        suggestions: (parsed.suggested ?? []).map((s: any) => ({
          name: s.name,
          group: s.group,
          group_id: resolveGroup(s.group),
          description: s.description,
        })),
        reasoning: parsed.reasoning ?? '',
      });
    }

    // ── INLINE mode ───────────────────────────────────────────────────────────
    const systemPrompt = `You are Karl, helping a KarlOps user tag a ${object_type || 'item'}.
Suggest tags from the existing tag list that fit the content provided.
If you think a genuinely useful new tag is missing, include up to 2 new tag ideas.

Available tag groups: ${groupList}
Existing tags (name [group] description): ${existingTagList}
Already selected tags (do not re-suggest): ${alreadySelected}
User situation: ${situation || 'Not provided.'}

Rules:
- Suggest 1-3 existing tags maximum — quality over quantity
- Only suggest existing tags you are confident fit the content
- New tag ideas: maximum 2, only if genuinely useful and not covered by existing tags
- Never suggest tags already in the selected list
- Prefer specific tags over generic ones
- Do NOT suggest People/Roles/Organizations tags unless a person or org is explicitly mentioned in the content

Respond ONLY with valid JSON, no markdown:
{
  "suggested": ["ExistingTag1", "ExistingTag2"],
  "new_tag_ideas": [
    { "name": "NewTag", "group": "GroupName", "description": "one sentence" }
  ],
  "reasoning": "one sentence"
}`;

    const userMessage = `${object_type ? `Object type: ${object_type}\n` : ''}Content to tag: ${context_text || '(no content yet)'}`;

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
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    let parsed: any;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return NextResponse.json({ error: 'Failed to parse Karl response' }, { status: 500 });
    }

    const groupNameMap: Record<string, string> = {};
    for (const g of tagGroups) groupNameMap[g.name.toLowerCase()] = g.tag_group_id;
    const resolveGroup = (name: string) => groupNameMap[name.toLowerCase()] ?? null;

    return NextResponse.json({
      success: true,
      mode: 'inline',
      suggested: parsed.suggested ?? [],
      new_tag_ideas: (parsed.new_tag_ideas ?? []).map((s: any) => ({
        name: s.name,
        group: s.group,
        group_id: resolveGroup(s.group),
        description: s.description,
      })),
      reasoning: parsed.reasoning ?? '',
    });

  } catch (err: any) {
    console.error('[suggest-tags]', err);
    return NextResponse.json({ error: err.message ?? 'Suggestion failed' }, { status: 500 });
  }
}