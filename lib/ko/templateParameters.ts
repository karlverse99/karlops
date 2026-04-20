// lib/ko/templateParameters.ts
// KarlOps L — Template parameter system v1.0.0
// No hardcoded icons, labels, or bucket names — all driven by caller context

import { createSupabaseAdmin } from '@/lib/supabase-server';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface TemplateParameter {
  key: string;
  label: string;
  source: ParameterSource;
  filters: ParameterFilters;
}

export interface ParameterFilters {
  buckets?: string[];
  context?: string | null;
  tags?: string[];
  window_days?: number | null;
  attendee?: string | null;
  completed_only?: boolean;
  delegated_to?: string | null;
  limit?: number | null;
}

export type ParameterSource =
  | 'tasks'
  | 'completions'
  | 'meetings'
  | 'references'
  | 'situation'
  | 'contacts'
  | 'tags';

// ─── SOURCE CONFIG ────────────────────────────────────────────────────────────
// Single config drives both the UI picker and the data builder.
// To add a new source: add entry here. Nothing else needs to change.

export interface SourceConfig {
  label: string;
  filters: SourceFilterConfig[];
}

export interface SourceFilterConfig {
  key: keyof ParameterFilters;
  label: string;
  type: 'buckets' | 'text' | 'number' | 'boolean' | 'context' | 'tags';
}

export const PARAMETER_SOURCES: Record<ParameterSource, SourceConfig> = {
  tasks: {
    label: 'Tasks',
    filters: [
      { key: 'buckets',      label: 'Buckets',      type: 'buckets' },
      { key: 'context',      label: 'Context',      type: 'context' },
      { key: 'tags',         label: 'Tags',         type: 'tags' },
      { key: 'delegated_to', label: 'Delegated To', type: 'text' },
    ],
  },
  completions: {
    label: 'Completions',
    filters: [
      { key: 'window_days', label: 'Window (days)', type: 'number' },
      { key: 'context',     label: 'Context',       type: 'context' },
      { key: 'tags',        label: 'Tags',          type: 'tags' },
    ],
  },
  meetings: {
    label: 'Meetings',
    filters: [
      { key: 'window_days',    label: 'Window (days)',  type: 'number' },
      { key: 'attendee',       label: 'Attendee',       type: 'text' },
      { key: 'completed_only', label: 'Completed Only', type: 'boolean' },
      { key: 'tags',           label: 'Tags',           type: 'tags' },
      { key: 'context',        label: 'Context',        type: 'context' },
    ],
  },
  references: {
    label: 'References',
    filters: [
      { key: 'tags',  label: 'Tags',  type: 'tags' },
      { key: 'limit', label: 'Limit', type: 'number' },
    ],
  },
  situation: {
    label: 'Situation Brief',
    filters: [],
  },
  contacts: {
    label: 'Contacts',
    filters: [
      { key: 'tags',  label: 'Tags',  type: 'tags' },
      { key: 'limit', label: 'Limit', type: 'number' },
    ],
  },
  tags: {
    label: 'Tags',
    filters: [
      { key: 'limit', label: 'Limit', type: 'number' },
    ],
  },
};

// ─── PARAMETER KEY GENERATOR ──────────────────────────────────────────────────

export function generateParameterKey(label: string, source: ParameterSource): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${source}_${slug}`;
}

// ─── BUCKET LABEL RESOLUTION ──────────────────────────────────────────────────
// Always resolved from concept registry at runtime — never hardcoded

async function resolveBucketLabels(user_id: string): Promise<Record<string, string>> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('ko_concept_registry')
    .select('concept_key, label')
    .eq('user_id', user_id)
    .eq('concept_type', 'bucket');

  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    const key = row.concept_key.replace(/^bucket_/, '');
    map[key] = row.label;
  }
  return map;
}

// ─── DATA BUILDERS ────────────────────────────────────────────────────────────

async function buildTasksData(
  user_id: string,
  filters: ParameterFilters,
  context_filter?: string | null
): Promise<string> {
  const db = createSupabaseAdmin();
  const bucketLabels = await resolveBucketLabels(user_id);
  const buckets = filters.buckets?.length ? filters.buckets : Object.keys(bucketLabels);

  let q = db.from('task')
    .select('title, bucket_key, tags, notes, target_date, context:context_id(name), delegatee:delegated_to(name)')
    .eq('user_id', user_id)
    .eq('is_completed', false)
    .eq('is_archived', false)
    .in('bucket_key', buckets)
    .order('sort_order', { ascending: true, nullsFirst: false });

  if (filters.context)      q = (q as any).eq('context_id', filters.context);
  else if (context_filter)  q = (q as any).eq('context_id', context_filter);
  if (filters.tags?.length) q = (q as any).contains('tags', filters.tags);

  const { data: tasks } = await q;
  if (!tasks?.length) return '(no tasks)';

  const filtered = filters.delegated_to
    ? tasks.filter(t =>
        (t.delegatee as any)?.name?.toLowerCase().includes(filters.delegated_to!.toLowerCase())
      )
    : tasks;

  if (!filtered.length) return '(no tasks)';

  const byBucket: Record<string, string[]> = {};
  for (const t of filtered) {
    if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
    const tagStr      = t.tags?.length ? ` [${t.tags.join(', ')}]` : '';
    const dateStr     = t.target_date ? ` · due ${String(t.target_date).slice(0, 10)}` : '';
    const ctxStr      = (t.context as any)?.name ? ` · ${(t.context as any).name}` : '';
    const delegateStr = (t.delegatee as any)?.name ? ` · delegated_to:${(t.delegatee as any).name}` : '';
    byBucket[t.bucket_key].push(`- ${t.title}${tagStr}${dateStr}${ctxStr}${delegateStr}`);
  }

  return Object.entries(byBucket)
    .map(([b, items]) => `${bucketLabels[b] ?? b}:\n${items.join('\n')}`)
    .join('\n\n');
}

async function buildCompletionsData(
  user_id: string,
  filters: ParameterFilters,
  context_filter?: string | null
): Promise<string> {
  const db = createSupabaseAdmin();
  const windowDays = filters.window_days ?? 7;
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - windowDays);

  let q = db.from('completion')
    .select('title, completed_at, outcome, description, tags, context:context_id(name)')
    .eq('user_id', user_id)
    .gte('completed_at', windowStart.toISOString())
    .order('completed_at', { ascending: false });

  if (filters.context)      q = (q as any).eq('context_id', filters.context);
  else if (context_filter)  q = (q as any).eq('context_id', context_filter);
  if (filters.tags?.length) q = (q as any).contains('tags', filters.tags);

  const { data: completions } = await q;
  if (!completions?.length) return '(no completions)';

  return completions.map(c => {
    const date   = String(c.completed_at ?? '').slice(0, 10);
    const ctx    = (c.context as any)?.name;
    const tags   = c.tags?.length ? ` [${c.tags.join(', ')}]` : '';
    const ctxStr = ctx ? ` · ${ctx}` : '';
    let line = `- [${date}] ${c.title}${tags}${ctxStr}`;
    if (c.outcome)     line += `\n  Outcome: ${c.outcome}`;
    if (c.description) line += `\n  Notes: ${c.description}`;
    return line;
  }).join('\n');
}

async function buildMeetingsData(
  user_id: string,
  filters: ParameterFilters,
  context_filter?: string | null
): Promise<string> {
  const db = createSupabaseAdmin();
  const windowDays = filters.window_days ?? 30;
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - windowDays);

  let q = db.from('meeting')
    .select('title, meeting_date, attendees, tags, outcome, notes, context:context_id(name)')
    .eq('user_id', user_id)
    .gte('meeting_date', windowStart.toISOString().slice(0, 10))
    .order('meeting_date', { ascending: false })
    .limit(20);

  if (filters.completed_only) q = (q as any).eq('is_completed', true);
  if (filters.context)        q = (q as any).eq('context_id', filters.context);
  else if (context_filter)    q = (q as any).eq('context_id', context_filter);
  if (filters.tags?.length)   q = (q as any).contains('tags', filters.tags);

  const { data: meetings } = await q;
  if (!meetings?.length) return '(no meetings)';

  const filtered = filters.attendee
    ? meetings.filter(m =>
        (m.attendees ?? []).some((a: string) =>
          a.toLowerCase().includes(filters.attendee!.toLowerCase())
        )
      )
    : meetings;

  if (!filtered.length) return '(no meetings)';

  return filtered.map(m => {
    const date   = String(m.meeting_date ?? '').slice(0, 10);
    const att    = m.attendees?.length ? ` · ${m.attendees.join(', ')}` : '';
    const ctx    = (m.context as any)?.name;
    const ctxStr = ctx ? ` · ${ctx}` : '';
    let line = `- [${date}] ${m.title}${att}${ctxStr}`;
    if (m.outcome) line += `\n  Outcome: ${m.outcome}`;
    if (m.notes)   line += `\n  Notes: ${m.notes.slice(0, 500)}`;
    return line;
  }).join('\n');
}

async function buildReferencesData(
  user_id: string,
  filters: ParameterFilters
): Promise<string> {
  const db = createSupabaseAdmin();
  const limit = filters.limit ?? 10;

  let q = db.from('external_reference')
    .select('title, description, notes')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filters.tags?.length) q = (q as any).contains('tags', filters.tags);

  const { data: refs } = await q;
  if (!refs?.length) return '(no references)';
  return refs.map(r => `- ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
}

async function buildSituationData(user_id: string): Promise<string> {
  const db = createSupabaseAdmin();
  const { data } = await db
    .from('user_situation')
    .select('brief')
    .eq('user_id', user_id)
    .eq('is_active', true)
    .maybeSingle();
  return data?.brief?.trim() ?? '(no situation brief)';
}

async function buildContactsData(
  user_id: string,
  filters: ParameterFilters
): Promise<string> {
  const db = createSupabaseAdmin();
  const limit = filters.limit ?? 20;

  const { data: contacts } = await db.from('contact')
    .select('name, notes')
    .eq('user_id', user_id)
    .eq('is_archived', false)
    .order('name')
    .limit(limit);

  if (!contacts?.length) return '(no contacts)';
  return contacts
    .map(c => `- ${c.name}${c.notes ? ` — ${c.notes.slice(0, 100)}` : ''}`)
    .join('\n');
}

async function buildTagsData(
  user_id: string,
  filters: ParameterFilters
): Promise<string> {
  const db = createSupabaseAdmin();
  const limit = filters.limit ?? 50;

  const { data: tags } = await db.from('tag')
    .select('name, description')
    .eq('user_id', user_id)
    .eq('is_archived', false)
    .order('name')
    .limit(limit);

  if (!tags?.length) return '(no tags)';
  return tags
    .map(t => `- ${t.name}${t.description ? ` — ${t.description}` : ''}`)
    .join('\n');
}

// ─── MAIN EXPORTS ─────────────────────────────────────────────────────────────

// Build data for a single parameter
export async function buildDataForParameter(
  user_id: string,
  param: TemplateParameter,
  context_filter?: string | null
): Promise<string> {
  try {
    switch (param.source) {
      case 'tasks':       return await buildTasksData(user_id, param.filters, context_filter);
      case 'completions': return await buildCompletionsData(user_id, param.filters, context_filter);
      case 'meetings':    return await buildMeetingsData(user_id, param.filters, context_filter);
      case 'references':  return await buildReferencesData(user_id, param.filters);
      case 'situation':   return await buildSituationData(user_id);
      case 'contacts':    return await buildContactsData(user_id, param.filters);
      case 'tags':        return await buildTagsData(user_id, param.filters);
      default:            return '(unknown source)';
    }
  } catch (err) {
    console.error(`[buildDataForParameter] failed for ${param.key}:`, err);
    return `(error loading ${param.label})`;
  }
}

// Build all parameters in parallel → keyed data object + formatted block for prompt
export async function buildDataBundle(
  user_id: string,
  parameters: TemplateParameter[],
  context_filter?: string | null
): Promise<{ keyed: Record<string, string>; block: string }> {
  const keyed: Record<string, string> = {};

  await Promise.all(parameters.map(async (param) => {
    keyed[param.key] = await buildDataForParameter(user_id, param, context_filter);
  }));

  const block = parameters
    .map(p => `## ${p.label}\n${keyed[p.key]}`)
    .join('\n\n');

  return { keyed, block };
}

// Replace {{key}} placeholders in prompt template with actual data
export function injectParameters(
  promptTemplate: string,
  keyed: Record<string, string>
): string {
  let result = promptTemplate;
  for (const [key, value] of Object.entries(keyed)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// Format parameter list for Karl's system prompt — so he knows what slots exist
export function formatParametersForPrompt(parameters: TemplateParameter[]): string {
  if (!parameters.length) return '';
  return [
    '## Template Parameters (named data slots)',
    'These parameters are defined for this template. Reference them as {{key}} placeholders in prompt_template.',
    parameters.map(p => {
      const filterStr = Object.entries(p.filters)
        .filter(([, v]) =>
          v !== null &&
          v !== undefined &&
          v !== false &&
          !(Array.isArray(v) && v.length === 0)
        )
        .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(',') : v}`)
        .join(' ');
      return `- {{${p.key}}} — ${p.label} (${p.source}${filterStr ? ' · ' + filterStr : ''})`;
    }).join('\n'),
  ].join('\n');
}