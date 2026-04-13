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
  bucketSnapshot: string;        // open tasks with identifiers by bucket
  recentCompletions: string;     // recent completion titles (windowed)
  observations: string;          // Karl's running notes on user patterns
  availableTags: string;         // all tags Karl can assign
  availableContexts: string;     // all contexts Karl can assign (name|id pairs)
  vocab: string;                 // learned phrase→intent mappings
}

export interface KarlDeepBundle extends KarlContextBundle {
  fullCompletions: string;  // all completions in window with outcomes
  tasksByContext: string;   // open tasks grouped by context
}

const BUCKET_PREFIX: Record<string, string> = {
  now:      'N',
  soon:     'S',
  realwork: 'RW',
  later:    'L',
  delegate: 'D',
  capture:  'CP',
};

const MAX_OBSERVATIONS = 50;

// ── Base context — every Karl call ────────────────────────────────────────────
export async function buildKarlContext(user_id: string): Promise<KarlContextBundle> {
  const db = createSupabaseAdmin();

  // Load everything in parallel
  const [
    situationRes,
    sessionRes,
    taskRes,
    obsRes,
    tagRes,
    contextRes,
    vocabRes,
  ] = await Promise.all([
    db.from('user_situation')
      .select('brief, chat_history_depth, completion_window_days')
      .eq('user_id', user_id).eq('is_active', true).maybeSingle(),
    db.from('ko_session')
      .select('messages')
      .eq('user_id', user_id).maybeSingle(),
    db.from('task')
      .select('task_id, title, bucket_key')
      .eq('user_id', user_id).eq('is_completed', false).eq('is_archived', false)
      .order('created_at', { ascending: true }),
    db.from('karl_observation')
      .select('content, observation_type')
      .eq('user_id', user_id).eq('is_active', true)
      .order('created_at', { ascending: false }).limit(MAX_OBSERVATIONS),
    db.from('tag')
      .select('name')
      .eq('user_id', user_id).order('name'),
    db.from('context')
      .select('context_id, name')
      .eq('user_id', user_id).eq('is_archived', false).eq('is_visible', true)
      .order('name'),
    db.from('karl_vocab')
      .select('phrase, intent, object_type, use_count')
      .eq('user_id', user_id).eq('is_active', true)
      .order('use_count', { ascending: false }).limit(100),
  ]);

  const situation      = situationRes.data;
  const historyDepth   = situation?.chat_history_depth     ?? 15;
  const completionWin  = situation?.completion_window_days ?? 7;
  const situationBrief = situation?.brief?.trim() || '';

  // Session history
  const allMessages: ChatMessage[] = sessionRes.data?.messages ?? [];
  const recentMessages = allMessages.slice(-historyDepth);

  // Bucket snapshot
  const byBucket: Record<string, { task_id: string; title: string }[]> = {};
  for (const t of taskRes.data ?? []) {
    if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
    byBucket[t.bucket_key].push({ task_id: t.task_id, title: t.title });
  }
  const bucketOrder = ['now', 'soon', 'realwork', 'later', 'delegate', 'capture'];
  const snapshotLines: string[] = [];
  for (const bucket of bucketOrder) {
    const items = byBucket[bucket] ?? [];
    if (items.length === 0) continue;
    const prefix = BUCKET_PREFIX[bucket] ?? bucket;
    if (bucket === 'capture') {
      snapshotLines.push(`capture: ${items.length} uncurated tasks`);
    } else {
      snapshotLines.push(`${bucket}:`);
      items.forEach((t, i) => snapshotLines.push(`  ${prefix}${i + 1} ${t.title}`));
    }
  }
  const bucketSnapshot = snapshotLines.join('\n') || 'no open tasks';

  // Recent completions
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWin);
  const { data: completions } = await db
    .from('completion').select('title, completed_at')
    .eq('user_id', user_id).gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false }).limit(20);

  const recentCompletions = completions?.length
    ? completions.map(c => `- ${c.title} (${c.completed_at?.slice(0, 10)})`).join('\n')
    : 'none in window';

  // Observations
  const observations = obsRes.data?.length
    ? obsRes.data.map(o => `[${o.observation_type}] ${o.content}`).join('\n')
    : '';

  // Available tags — names only
  const availableTags = tagRes.data?.length
    ? tagRes.data.map(t => t.name).join(', ')
    : 'none';

  // Available contexts — name|id so Karl can return the UUID
  const availableContexts = contextRes.data?.length
    ? contextRes.data.map(c => `${c.name}|${c.context_id}`).join(', ')
    : 'none';

  // Learned vocab
  const vocab = vocabRes.data?.length
    ? vocabRes.data.map(v => `"${v.phrase}" → ${v.intent} (${v.object_type})`).join('\n')
    : '';

  return {
    situationBrief,
    recentMessages,
    bucketSnapshot,
    recentCompletions,
    observations,
    availableTags,
    availableContexts,
    vocab,
  };
}

// ── Deep context — analysis calls only ───────────────────────────────────────
export async function buildKarlDeepContext(user_id: string): Promise<KarlDeepBundle> {
  const db = createSupabaseAdmin();
  const base = await buildKarlContext(user_id);

  const { data: situation } = await db
    .from('user_situation').select('completion_window_days')
    .eq('user_id', user_id).eq('is_active', true).maybeSingle();

  const completionWindow = situation?.completion_window_days ?? 7;
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - completionWindow);

  const { data: completions } = await db
    .from('completion').select('title, outcome, completed_at, tags, context_id')
    .eq('user_id', user_id).gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false });

  const fullCompletions = completions?.length
    ? completions.map(c =>
        `[${c.completed_at?.slice(0, 10)}] ${c.title}` +
        (c.outcome ? `\n  Outcome: ${c.outcome}` : '') +
        (c.tags?.length ? `\n  Tags: ${c.tags.join(', ')}` : '')
      ).join('\n\n')
    : 'no completions in window';

  const { data: tasks } = await db
    .from('task').select('title, bucket_key, tags, context:context_id(name)')
    .eq('user_id', user_id).eq('is_completed', false).eq('is_archived', false)
    .neq('bucket_key', 'capture');

  const byContext: Record<string, string[]> = {};
  for (const t of tasks ?? []) {
    const ctx = (t.context as any)?.name ?? 'No Context';
    if (!byContext[ctx]) byContext[ctx] = [];
    byContext[ctx].push(`  ${t.bucket_key} ${t.title}`);
  }
  const tasksByContext = Object.entries(byContext)
    .map(([ctx, items]) => `${ctx}:\n${items.join('\n')}`)
    .join('\n\n') || 'no curated tasks';

  return { ...base, fullCompletions, tasksByContext };
}

// ── Format bundle into system prompt string ───────────────────────────────────
export function formatContextForPrompt(bundle: KarlContextBundle): string {
  const parts: string[] = [];

  if (bundle.situationBrief) {
    parts.push(`## User Situation\n${bundle.situationBrief}`);
  } else {
    parts.push(`## User Situation\nNot yet configured. Encourage the user to write their situation brief.`);
  }

  parts.push(`## Current Task Load\nTasks are identified as BucketN (e.g. N1, S2, RW1, L1, D1) for reference in commands.\n${bundle.bucketSnapshot}`);
  parts.push(`## Recent Completions\n${bundle.recentCompletions}`);

  if (bundle.observations) {
    parts.push(`## Karl's Observations\n${bundle.observations}`);
  }

  parts.push(`## Available Tags\nExact tag names this user has created. Only use tags from this list.\n${bundle.availableTags}`);

  parts.push(`## Available Contexts\nFormat: Name|context_id. Use the context_id UUID when returning context_id in your JSON response.\n${bundle.availableContexts}`);

  if (bundle.vocab) {
    parts.push(`## Learned Vocabulary\nPhrases this user has used before and what they map to. Use these to improve classification.\n${bundle.vocab}`);
  }

  if ('fullCompletions' in bundle) {
    const deep = bundle as KarlDeepBundle;
    parts.push(`## Completion Detail (Evidence Record)\n${deep.fullCompletions}`);
    parts.push(`## Open Tasks by Context\n${deep.tasksByContext}`);
  }

  return parts.join('\n\n');
}

// ── Write a Karl observation ──────────────────────────────────────────────────
export async function writeKarlObservation(
  user_id: string,
  content: string,
  observation_type: 'pattern' | 'preference' | 'flag' = 'pattern',
  tags: string[] = []
): Promise<void> {
  const db = createSupabaseAdmin();

  const { count } = await db
    .from('karl_observation')
    .select('observation_id', { count: 'exact', head: true })
    .eq('user_id', user_id).eq('is_active', true);

  if ((count ?? 0) >= MAX_OBSERVATIONS) {
    const { data: oldest } = await db
      .from('karl_observation').select('observation_id')
      .eq('user_id', user_id).eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (oldest) {
      await db.from('karl_observation')
        .update({ is_active: false })
        .eq('observation_id', oldest.observation_id);
    }
  }

  await db.from('karl_observation').insert({ user_id, content, observation_type, tags });
}

// ── Upsert karl_vocab — increment use_count if phrase exists ─────────────────
export async function upsertKarlVocab(
  user_id: string,
  phrase: string,
  intent: string,
  object_type: string
): Promise<void> {
  const db = createSupabaseAdmin();
  const normalised = phrase.toLowerCase().trim();

  const { data: existing } = await db
    .from('karl_vocab').select('vocab_id, use_count')
    .eq('user_id', user_id).eq('phrase', normalised).maybeSingle();

  if (existing) {
    await db.from('karl_vocab')
      .update({ use_count: existing.use_count + 1, updated_at: new Date().toISOString() })
      .eq('vocab_id', existing.vocab_id);
  } else {
    await db.from('karl_vocab').insert({
      user_id,
      phrase: normalised,
      intent,
      object_type,
      use_count: 1,
    });
  }
}

// ── Append a message to session history ──────────────────────────────────────
export async function appendSessionMessage(
  user_id: string,
  role: 'user' | 'karl',
  content: string
): Promise<void> {
  const db = createSupabaseAdmin();

  const { data: session } = await db
    .from('ko_session').select('ko_session_id, messages')
    .eq('user_id', user_id).maybeSingle();

  if (!session) return;

  const { data: situation } = await db
    .from('user_situation').select('chat_history_depth')
    .eq('user_id', user_id).eq('is_active', true).maybeSingle();

  const maxDepth = situation?.chat_history_depth ?? 15;
  const messages: ChatMessage[] = session.messages ?? [];
  messages.push({ role, content, ts: new Date().toISOString() });
  const trimmed = messages.slice(-maxDepth * 2);

  await db.from('ko_session')
    .update({ messages: trimmed })
    .eq('ko_session_id', session.ko_session_id);
}