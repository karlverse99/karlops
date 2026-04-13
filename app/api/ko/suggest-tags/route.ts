// app/api/ko/suggest-tags/route.ts
// KarlOps L — Tag suggestion engine
// Called from Tags admin tab and TaskAddModal
// Returns suggested existing tags + new tag ideas with group assignments

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

  // mode: 'admin' = seed tags for the whole workspace
  //       'task'  = suggest tags for specific task titles
  const { mode = 'admin', titles = [] } = body;

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
        .select('name, description')
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

    const situation   = situationRes.data?.brief?.trim() || '';
    const tagGroups   = tagGroupRes.data ?? [];
    const existingTags = tagRes.data ?? [];
    const contexts    = contextRes.data ?? [];
    const tasks       = taskRes.data ?? [];

    const groupList = tagGroups.map(g => g.name).join(', ');
    const existingTagList = existingTags.length
      ? existingTags.map(t => `${t.name}${t.description ? ` (${t.description})` : ''}`).join(', ')
      : 'none yet';
    const contextList = contexts.map(c => c.name).join(', ');
    const taskSample = tasks.slice(0, 20).map(t => t.title).join(', ');

    const systemPrompt = mode === 'admin'
      ? `You are Karl, helping a KarlOps user build their initial tag set.
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
- General: anything that doesn't fit above

Respond ONLY with valid JSON, no markdown:
{
  "suggested": [
    { "name": "TagName", "group": "GroupName", "description": "one sentence description" }
  ],
  "reasoning": "one sentence explaining your overall approach"
}`
      : `You are Karl, helping a KarlOps user tag specific tasks.
Suggest tags from the existing list that fit the task titles provided.
If you think a new tag would be useful, include it in new_tag_ideas with a suggested group.

Available tag groups: ${groupList}
Existing tags: ${existingTagList}
Task titles to tag: ${titles.join(', ')}

Rules:
- Only suggest existing tags when confident they fit
- Keep new_tag_ideas to 1-3 maximum — don't overwhelm
- Assign new tags to the most logical group
- Include a short description for new tags

Respond ONLY with valid JSON, no markdown:
{
  "suggested": ["ExistingTag1", "ExistingTag2"],
  "new_tag_ideas": [
    { "name": "NewTag", "group": "GroupName", "description": "one sentence" }
  ],
  "reasoning": "one sentence explaining your suggestions"
}`;

    const userMessage = mode === 'admin'
      ? `My situation: ${situation || 'Not yet written.'}\n\nPlease suggest a strong starting tag set for my KarlOps workspace.`
      : `Please suggest tags for these tasks: ${titles.join(', ')}`;

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
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return NextResponse.json({ error: 'Failed to parse Karl response' }, { status: 500 });
    }

    // Resolve group names to tag_group_ids
    const groupMap: Record<string, string> = {};
    for (const g of tagGroups) groupMap[g.name.toLowerCase()] = g.tag_group_id;

    const resolveGroup = (groupName: string): string | null =>
      groupMap[groupName.toLowerCase()] ?? null;

    if (mode === 'admin') {
      const suggestions = (parsed.suggested ?? []).map((s: any) => ({
        name: s.name,
        group: s.group,
        group_id: resolveGroup(s.group),
        description: s.description,
      }));
      return NextResponse.json({
        success: true,
        mode: 'admin',
        suggestions,
        reasoning: parsed.reasoning ?? '',
      });
    } else {
      const newIdeas = (parsed.new_tag_ideas ?? []).map((s: any) => ({
        name: s.name,
        group: s.group,
        group_id: resolveGroup(s.group),
        description: s.description,
      }));
      return NextResponse.json({
        success: true,
        mode: 'task',
        suggested: parsed.suggested ?? [],
        new_tag_ideas: newIdeas,
        reasoning: parsed.reasoning ?? '',
      });
    }

  } catch (err: any) {
    console.error('[suggest-tags]', err);
    return NextResponse.json({ error: err.message ?? 'Suggestion failed' }, { status: 500 });
  }
}