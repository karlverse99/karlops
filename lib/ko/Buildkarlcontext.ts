// lib/ko/buildKarlContext.ts
// KarlOps L — Assembles Karl's context bundle before every Anthropic API call
// Tiered: every call gets the base bundle, analysis calls get deep pull

import { createSupabaseAdmin } from '@/lib/supabase-server';

export interface ChatMessage {
  role: 'user' | 'karl';
  content: string;
  ts: string;
}

export interface KarlContextBundle {
  situationBrief: string;        // who the user is and what they're doing
  recentMessages: ChatMessage[]; // last N messages from ko_session
  bucketSnapshot: string;        // open task counts by bucket
  recentCompletions: string;     // recent completion titles (windowed)
}

export interface KarlDeepBundle extends KarlContextBundle {
  fullCompletions: string;  // all completions in window with outcomes
  tasksByContext: string;   // open tasks grouped by context
}

// ── Base context — every Karl call ────────────────────────────────────────────
export async function buildKarlContext(user_id: string): Promise<KarlContextBundle> {
  const db = createSupabaseAdmin();

  // Load situation (active only)
  const { data: situation } = await db
    .from('user_situation')
    .select('brief, chat_history_depth, completion_window_days')
    .eq('user_id', user_id)
    .eq('is_active', true)
    .maybeSingle();

  const historyDepth     = situation?.chat_history_depth     ?? 15;
  const completionWindow = situation?.completion_window_days ?? 7;
  const situationBrief   = situation?.brief?.trim() || '';

  // Load session message history
  const { data: session } = await db
    .from('ko_session')
    .select('messages')
    .eq('user_id', user_id)
    .maybeSingle();

  const allMessages: ChatMessage[] = session?.messages ?? [];
  const recentMessages = allMessages.slice(-historyDepth);

  // Bucket snapshot — open task counts by bucket (excludes completed/archived)
  const { data: tasks } = await db
    .from('task')
    .select('bucket_key')
    .eq('user_id', user_id)
    .eq('is_completed', false)
    .eq('is_archived', false);

  const bucketCounts: Record<string, number> = {};
  for (const t of tasks ?? []) {
    bucketCounts[t.bucket_key] = (bucketCounts[t.bucket_key] ?? 0) + 1;
  }
  const bucketSnapshot = Object.entries(bucketCounts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'no open tasks';

  // Recent completions — titles only, windowed
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWindow);

  const { data: completions } = await db
    .from('completion')
    .select('title, completed_at')
    .eq('user_id', user_id)
    .gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false })
    .limit(20);

  const recentCompletions = completions?.length
    ? completions.map(c => `- ${c.title} (${c.completed_at?.slice(0, 10)})`).join('\n')
    : 'none in window';

  return {
    situationBrief,
    recentMessages,
    bucketSnapshot,
    recentCompletions,
  };
}

// ── Deep context — analysis calls only ───────────────────────────────────────
export async function buildKarlDeepContext(user_id: string): Promise<KarlDeepBundle> {
  const db = createSupabaseAdmin();
  const base = await buildKarlContext(user_id);

  const { data: situation } = await db
    .from('user_situation')
    .select('completion_window_days')
    .eq('user_id', user_id)
    .eq('is_active', true)
    .maybeSingle();

  const completionWindow = situation?.completion_window_days ?? 7;
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWindow);

  // Full completions with outcomes
  const { data: completions } = await db
    .from('completion')
    .select('title, outcome, completed_at, tags, context_id')
    .eq('user_id', user_id)
    .gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false });

  const fullCompletions = completions?.length
    ? completions.map(c =>
        `[${c.completed_at?.slice(0, 10)}] ${c.title}` +
        (c.outcome ? `\n  Outcome: ${c.outcome}` : '') +
        (c.tags?.length ? `\n  Tags: ${c.tags.join(', ')}` : '')
      ).join('\n\n')
    : 'no completions in window';

  // Open tasks grouped by context (excludes completed/archived)
  const { data: tasks } = await db
    .from('task')
    .select('title, bucket_key, tags, context:context_id(name)')
    .eq('user_id', user_id)
    .eq('is_completed', false)
    .eq('is_archived', false)
    .neq('bucket_key', 'capture');

  const byContext: Record<string, string[]> = {};
  for (const t of tasks ?? []) {
    const ctx = (t.context as any)?.name ?? 'No Context';
    if (!byContext[ctx]) byContext[ctx] = [];
    byContext[ctx].push(`  [${t.bucket_key}] ${t.title}`);
  }
  const tasksByContext = Object.entries(byContext)
    .map(([ctx, items]) => `${ctx}:\n${items.join('\n')}`)
    .join('\n\n') || 'no curated tasks';

  return {
    ...base,
    fullCompletions,
    tasksByContext,
  };
}

// ── Format bundle into system prompt string ───────────────────────────────────
export function formatContextForPrompt(bundle: KarlContextBundle): string {
  const parts: string[] = [];

  if (bundle.situationBrief) {
    parts.push(`## User Situation\n${bundle.situationBrief}`);
  } else {
    parts.push(`## User Situation\nNot yet configured. Encourage the user to write their situation brief.`);
  }

  parts.push(`## Current Task Load\n${bundle.bucketSnapshot}`);
  parts.push(`## Recent Completions\n${bundle.recentCompletions}`);

  if ('fullCompletions' in bundle) {
    const deep = bundle as KarlDeepBundle;
    parts.push(`## Completion Detail (Evidence Record)\n${deep.fullCompletions}`);
    parts.push(`## Open Tasks by Context\n${deep.tasksByContext}`);
  }

  return parts.join('\n\n');
}

// ── Append a message to session history ──────────────────────────────────────
export async function appendSessionMessage(
  user_id: string,
  role: 'user' | 'karl',
  content: string
): Promise<void> {
  const db = createSupabaseAdmin();

  const { data: session } = await db
    .from('ko_session')
    .select('ko_session_id, messages')
    .eq('user_id', user_id)
    .maybeSingle();

  if (!session) return;

  const { data: situation } = await db
    .from('user_situation')
    .select('chat_history_depth')
    .eq('user_id', user_id)
    .eq('is_active', true)
    .maybeSingle();

  const maxDepth = situation?.chat_history_depth ?? 15;
  const messages: ChatMessage[] = session.messages ?? [];

  messages.push({ role, content, ts: new Date().toISOString() });

  // Trim to depth — keep the story but cap the cost
  const trimmed = messages.slice(-maxDepth * 2); // *2 because each exchange is 2 messages

  await db
    .from('ko_session')
    .update({ messages: trimmed })
    .eq('ko_session_id', session.ko_session_id);
}