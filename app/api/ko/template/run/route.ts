import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { encryptOutput } from '@/lib/ko/outputEncryption';

export const dynamic = 'force-dynamic';

// ─── POST /api/ko/template/run ────────────────────────────────────────────────
//
// Architecture (v0.9.1):
//   selected_elements[] — "object_type.field" strings — drives what data is pulled
//   element_filters{}   — keyed by "object_type.field" — where clause per element
//   karl_prompt         — Karl-generated formatting spec (prompt_template column)
//   user_additions      — user free text appended to karl_prompt at run time
//
// Full prompt sent to Haiku = karl_prompt + "\n\n" + user_additions (if any)
//
// run_mode:
//   preview      — stub data, never saves
//   preview_live — real data pulled via elements+filters, never saves
//   generate     — real data, encrypts output, saves to external_reference
//
// Body: {
//   template_id,
//   run_mode?,
//   karl_prompt?,        // override stored prompt_template
//   user_additions?,     // if key present: use value (may be empty); if omitted: use stored user_prompt_additions
//   selected_elements?,  // override stored selected_elements
//   element_filters?,    // override stored element_filters
//   filename?, suffix?
// }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') ?? '';
    const token      = authHeader.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createSupabaseAdmin();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const {
      template_id,
      run_mode          = 'preview',
      karl_prompt:      bodyKarlPrompt,
      output_format:    bodyOutputFormat,
      selected_elements: bodyElements,
      element_filters:   bodyFilters,
      filename:         clientFilename,
      suffix:           clientSuffix,
    } = body;
    const bodyUserAdditions = Object.prototype.hasOwnProperty.call(body, 'user_additions')
      ? String(body.user_additions ?? '').trim()
      : null;

    if (!template_id) return NextResponse.json({ error: 'template_id required' }, { status: 400 });

    const isPreview = run_mode === 'preview';
    const isSave    = run_mode === 'generate';

    // ── Load template ────────────────────────────────────────────────────────
    const { data: template, error: tErr } = await supabase
      .from('document_template')
      .select('document_template_id, is_system, name, description, prompt_template, user_prompt_additions, template_mode, selected_elements, element_filters, output_format, filename_suffix_format, sections')
      .eq('document_template_id', template_id)
      .or(`user_id.eq.${user.id},is_system.eq.true`)
      .single();

    if (tErr || !template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    // Body overrides take precedence over stored values (for live editing without save)
    const karlPrompt    = (bodyKarlPrompt    ?? template.prompt_template         ?? '').trim();
    const userAdditions = bodyUserAdditions !== null
      ? bodyUserAdditions
      : String(template.user_prompt_additions ?? '').trim();
    const outputFormat  = (bodyOutputFormat  ?? template.output_format            ?? 'md').trim() || 'md';
    const elements: string[] = bodyElements ?? (Array.isArray(template.selected_elements) ? template.selected_elements : []);
    const filters: Record<string, any> = bodyFilters ?? (template.element_filters && typeof template.element_filters === 'object' ? template.element_filters : {});

    // Combined prompt (still used for empty checks); user message splits Karl vs additions for clarity.
    const fullPrompt = [karlPrompt, userAdditions].filter(Boolean).join('\n\n');

    if (!fullPrompt && !isPreview) {
      return NextResponse.json({ error: 'Template has no prompt. Use Karl Assist to generate one first.' }, { status: 400 });
    }

    // ── Load bucket labels ───────────────────────────────────────────────────
    const { data: koUser } = await supabase
      .from('ko_user').select('implementation_type').eq('id', user.id).single();
    const implType = koUser?.implementation_type ?? 'personal';

    const { data: bucketConcepts } = await supabase
      .from('concept_registry')
      .select('concept_key, label')
      .eq('implementation_type', implType)
      .eq('concept_type', 'bucket')
      .eq('is_active', true);

    const bucketLabels: Record<string, string> = {};
    for (const c of bucketConcepts ?? []) {
      bucketLabels[c.concept_key.replace(/^bucket_/, '')] = c.label;
    }

    // ── Build data block from selected_elements + element_filters ────────────
    const today = new Date().toISOString().slice(0, 10);

    // Group elements by object_type to batch queries
    const byType: Record<string, string[]> = {};
    for (const el of elements) {
      const [objType, ...fp] = el.split('.');
      if (!byType[objType]) byType[objType] = [];
      byType[objType].push(fp.join('.'));
    }

    // Extract filter value for a given element key
    const getFilter = (el: string) => filters[el] ?? null;

    const dataBlocks: string[] = [];
    const sections: Array<{ key: string; label: string; source: string; default_scope?: Record<string, any> }> =
      Array.isArray((template as any).sections) ? (template as any).sections : [];

    if (Object.keys(byType).length > 0) {
      if (isPreview) {
        // Stub data — one block per unique object type
        for (const objType of Object.keys(byType)) {
          dataBlocks.push(generateStub(objType, bucketLabels));
        }
      } else {
        // Real data — pull per object type, applying relevant element filters
        const wantsIconsFromPrompt = /\b(icon|icons)\b/i.test(fullPrompt);
        for (const [objType, fields] of Object.entries(byType)) {
          // Build a scope object: optional bulk __scope per object type, then per-element keys overlay.
          const scope: Record<string, any> = {};
          const bulk =
            filters.__scope && typeof filters.__scope === 'object' && !Array.isArray(filters.__scope)
              ? (filters.__scope as Record<string, any>)[objType]
              : null;
          if (bulk && typeof bulk === 'object' && !Array.isArray(bulk)) {
            Object.assign(scope, bulk);
          }
          for (const field of fields) {
            const el  = `${objType}.${field}`;
            const val = getFilter(el);
            if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
              scope[field] = val;
            }
          }
          const options = filters.__options && typeof filters.__options === 'object' && !Array.isArray(filters.__options)
            ? filters.__options as Record<string, any>
            : {};
          if (options.use_context_icons === true || wantsIconsFromPrompt) {
            scope.use_context_icons = true;
          }
          scope.__implementation_type = implType;
          const normalizedScope = normalizeQueryScope(objType, scope);
          const resolvedScope = await resolveObjectScope(supabase, user.id, normalizedScope);
          const block = await pullObjectData(supabase, user.id, objType, resolvedScope, bucketLabels, fields);
          if (block) dataBlocks.push(`${objType}:\n${block}`);
        }
      }
    } else if (sections.length > 0) {
      // Section/default_scope mode — used by chat-saved templates.
      for (const section of sections) {
        const source = String(section.source ?? '').toLowerCase();
        const label = section.label ?? section.key ?? source;
        const baseScope = section.default_scope && typeof section.default_scope === 'object' ? section.default_scope : {};
        const scope = await normalizeSectionScope(supabase, user.id, source, baseScope);
        const objType = mapSectionSourceToObjectType(source);
        const sectionBlock = isPreview
          ? generateStub(objType, bucketLabels)
          : await pullObjectData(supabase, user.id, objType, scope, bucketLabels, []);
        dataBlocks.push(`${label}:\n${sectionBlock || '(no data)'}`);
      }
    }

    const dataSection = dataBlocks.length > 0 ? dataBlocks.join('\n\n') : '(no data)';

    // ── Build Haiku prompt ───────────────────────────────────────────────────
    const systemPrompt = `You are Karl, a precision document generator for a KarlOps user.
Your job: follow the formatting instructions exactly and populate them with the provided data.
Use only the data provided — never invent facts.
${isPreview ? 'This is a STUB PREVIEW — demonstrate layout with sample data only.' : 'The Data section may use ## headings to group rows (e.g. by context). Preserve that structure in your output when it matches the formatting instructions.'}
${userAdditions ? 'User additions (when present) are binding constraints on tone, emphasis, inclusions, or exclusions — apply them together with the formatting instructions.' : ''}
STRICT FIELD GUARD: only render fields that are represented in Selected element keys or explicitly present in Data rows below. If a requested field is absent, omit it (never infer or fabricate).
BULLET MARKER GUARD: when Data rows include explicit list markers (including icon bullets like emoji/symbols), preserve those markers in output rows unless the formatting instructions explicitly require a different marker.
Output format: ${outputFormat}.
Today: ${today}.
Return ONLY the document — no preamble, no explanation, no code fences.`;

    const userMessage = [
      `Template: ${template.name}`,
      template.description ? `Purpose: ${template.description}` : '',
      '',
      '── Formatting instructions (Karl prompt) ──',
      karlPrompt || '(no formatting instructions — format the Data section clearly)',
      userAdditions ? `\n── User additions (apply strictly; together with instructions above) ──\n${userAdditions}` : '',
      '',
      '── Data contract ──',
      'The Data block is workspace-sourced. Each bullet belongs to the group heading above it when headings are present.',
      `Selected element keys: ${elements.length ? elements.join(', ') : '(none — passthrough or sections mode)'}`,
      '',
      '── Data ──',
      dataSection,
    ].filter(s => s !== undefined && s !== '').join('\n').trim();

    // ── Call Haiku ───────────────────────────────────────────────────────────
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':  'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await res.json();
    const usage = data.usage;
    if (usage) console.log('[template/run] tokens:', {
      input: usage.input_tokens, output: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read:  usage.cache_read_input_tokens ?? 0,
    });

    if (data.error) {
      const msg = data.error.message ?? 'Generation failed';
      if (msg.toLowerCase().includes('rate limit'))
        return NextResponse.json({ error: 'Rate limit hit — try narrowing your filters.' }, { status: 429 });
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const output = data.content?.[0]?.text ?? '';
    if (!output) return NextResponse.json({ error: 'Generation produced no output' }, { status: 500 });

    // Preview modes — return immediately, never save
    if (!isSave) {
      return NextResponse.json({ output, format: outputFormat, saved: false });
    }

    // Generate path should persist the latest "recipe" so reruns match this extract.
    // Only update user-owned templates; system templates are read-only.
    if (!template.is_system) {
      const { error: templateUpdateError } = await supabase
        .from('document_template')
        .update({
          prompt_template: karlPrompt,
          user_prompt_additions: userAdditions || null,
          output_format: outputFormat,
          selected_elements: elements,
          element_filters: filters,
          updated_at: new Date().toISOString(),
        })
        .eq('document_template_id', template.document_template_id)
        .eq('user_id', user.id);

      if (templateUpdateError) {
        console.error('[template/run] template update failed:', templateUpdateError);
      }
    }

    // Generate — encrypt and save
    const encryptedOutput = await encryptOutput(output);
    const ext             = formatExtension(outputFormat);
    const fallbackDate    = today.replace(/-/g, '');
    const resolvedFilename = clientFilename?.trim()
      || `${template.name.toLowerCase().replace(/\s+/g, '-')}-${fallbackDate}.${ext}`;
    const resolvedSuffix   = clientSuffix?.trim() || fallbackDate;
    const extractTitle     = `${template.name} · ${resolvedSuffix}`;

    const { error: saveError } = await supabase.from('external_reference').insert({
      user_id:              user.id,
      title:                extractTitle,
      description:          template.description ?? null,
      filename:             resolvedFilename,
      location:             'generated',
      run_data:             userMessage,
      output:               encryptedOutput,
      output_encrypted:     true,
      section_data:         Object.keys(filters).length > 0 ? filters : null,
      document_template_id: template_id,
      ref_type:             'generated',
      tags:                 [],
    });

    if (saveError) {
      console.error('[template/run] save failed:', saveError);
      return NextResponse.json({ output, format: template.output_format ?? 'md', saved: false, save_error: saveError.message });
    }

    return NextResponse.json({
      output, format: outputFormat,
      saved: true, filename: resolvedFilename, title: extractTitle,
    });

  } catch (err: any) {
    console.error('[template/run]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExtension(outputFormat: string): string {
  switch (outputFormat) {
    case 'html': return 'html';
    case 'txt':  return 'txt';
    case 'docx': return 'docx';
    case 'pdf':  return 'pdf';
    default:     return 'md';
  }
}

function mapSectionSourceToObjectType(source: string): string {
  switch (source) {
    case 'tasks': return 'task';
    case 'completions': return 'completion';
    case 'meetings': return 'meeting';
    case 'references': return 'external_reference';
    case 'situation': return 'user_situation';
    case 'contacts': return 'contact';
    default: return source;
  }
}

// Map element_filters (often keyed by object_type.field) into query scope.
// UI quirk: a numeric filter on completion.completed_at usually means "last N days" → window_days.
function normalizeQueryScope(objType: string, scope: Record<string, any>): Record<string, any> {
  const s = { ...scope };
  if (objType === 'completion') {
    const n = typeof s.completed_at === 'number' ? s.completed_at
      : typeof s.completed_at === 'string' && /^\d+$/.test(String(s.completed_at).trim())
        ? Number(String(s.completed_at).trim())
        : null;
    if (n != null && n > 0 && s.window_days == null) {
      s.window_days = n;
      delete s.completed_at;
    }
  }
  if (objType === 'meeting') {
    const n = typeof s.meeting_date === 'number' ? s.meeting_date
      : typeof s.meeting_date === 'string' && /^\d+$/.test(String(s.meeting_date).trim())
        ? Number(String(s.meeting_date).trim())
        : null;
    if (n != null && n > 0 && s.window_days == null) {
      s.window_days = n;
      delete s.meeting_date;
    }
  }
  return s;
}

async function resolveObjectScope(
  supabase: any,
  userId: string,
  scope: Record<string, any>
): Promise<Record<string, any>> {
  const out = { ...scope };
  const rawContext =
    out.context_id
    ?? out.context
    ?? out.context_name
    ?? out.context_names
    ?? null;
  delete out.context;
  delete out.context_name;
  delete out.context_names;
  if (!rawContext) return out;

  const asArr = Array.isArray(rawContext) ? rawContext : [rawContext];
  const uuids: string[] = [];
  const names: string[] = [];

  for (const v of asArr) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
    if (isUuid) uuids.push(t);
    else names.push(t);
  }

  if (names.length > 0) {
    // Resolve each human label with case-insensitive matching.
    for (const nm of names) {
      const { data } = await supabase
        .from('context')
        .select('context_id')
        .eq('user_id', userId)
        .ilike('name', nm)
        .limit(1)
        .maybeSingle();
      if (data?.context_id) uuids.push(data.context_id);
    }
  }

  if (uuids.length === 0) {
    // Caller asked for specific contexts, but none resolved.
    // Mark as no-match so query builders can return empty deterministic output.
    out.__no_context_match = true;
    delete out.context_id;
    return out;
  }
  out.context_id = uuids.length === 1 ? uuids[0] : uuids;
  return out;
}

async function normalizeSectionScope(
  supabase: any,
  userId: string,
  source: string,
  scope: Record<string, any>
): Promise<Record<string, any>> {
  const out: Record<string, any> = { ...scope };
  const rawContext = out.context_id ?? out.context ?? null;
  if (rawContext && typeof rawContext === 'string') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawContext);
    if (isUuid) {
      out.context_id = rawContext;
    } else {
      const { data } = await supabase
        .from('context')
        .select('context_id')
        .eq('user_id', userId)
        .ilike('name', rawContext)
        .maybeSingle();
      if (data?.context_id) out.context_id = data.context_id;
    }
  }
  delete out.context;

  if (source === 'tasks' && Array.isArray(out.buckets) && !out.bucket_key) {
    out.bucket_key = out.buckets;
  }
  return out;
}

// ─── Per-object data puller ───────────────────────────────────────────────────
// scope: field → filter value (from element_filters, keyed by field name only)
// fields: which fields were selected for this object type
// RULE: notes and description NEVER included

async function pullObjectData(
  supabase:     any,
  userId:       string,
  objType:      string,
  scope:        Record<string, any>,
  bucketLabels: Record<string, string>,
  fields:       string[],
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  if (objType === 'task') {
    if (scope.__no_context_match) return '(no tasks)';
    const buckets: string[] = Array.isArray(scope.bucket_key) ? scope.bucket_key
      : scope.bucket_key ? [scope.bucket_key] : Object.keys(bucketLabels);
    let q = supabase
      .from('task')
      .select('title, bucket_key, tags, target_date, task_status:task_status_id(label)')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .in('bucket_key', buckets)
      .order('sort_order', { ascending: true, nullsFirst: false });
    if (scope.context_id)  q = Array.isArray(scope.context_id) ? q.in('context_id', scope.context_id) : q.eq('context_id', scope.context_id);
    if (scope.tags?.length) q = q.contains('tags', scope.tags);

    const { data: tasks } = await q;
    if (!tasks?.length) return '(no tasks)';

    const byBucket: Record<string, string[]> = {};
    for (const t of tasks) {
      if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
      const status  = (t.task_status as any)?.label ?? '';
      const due     = t.target_date ? String(t.target_date).slice(0, 10) : null;
      const overdue = due && due < today ? ' [OVERDUE]' : '';
      byBucket[t.bucket_key].push(
        `- ${t.title}${status ? ' · ' + status : ''}${due ? ' · Due: ' + due + overdue : ''}`
      );
    }
    return Object.entries(byBucket)
      .map(([b, items]) => `${bucketLabels[b] ?? b}:\n${items.join('\n')}`)
      .join('\n\n');
  }

  if (objType === 'completion') {
    if (scope.__no_context_match) return '(no completions)';
    const displayFields = fields.length > 0 ? fields : ['title', 'completed_at', 'outcome'];
    const wantContext = displayFields.includes('context_id');
    const includeIcon = scope.use_context_icons === true;
    const selectCols = [
      'title',
      'completed_at',
      'outcome',
      ...(wantContext || scope.context_id ? ['context_id', 'context:context_id(name)'] : []),
      ...(scope.tags?.length ? ['tags'] : []),
    ];
    const selectUnique = Array.from(new Set(selectCols)).join(', ');

    let q = supabase
      .from('completion')
      .select(selectUnique)
      .eq('user_id', userId)
      .order('completed_at', { ascending: false })
      .limit(500);
    if (scope.window_days) {
      const since = new Date();
      since.setDate(since.getDate() - Number(scope.window_days));
      q = q.gte('completed_at', since.toISOString());
    }
    if (scope.context_id)  q = Array.isArray(scope.context_id) ? q.in('context_id', scope.context_id) : q.eq('context_id', scope.context_id);
    if (scope.tags?.length) q = q.contains('tags', scope.tags);

    const { data } = await q;
    if (!data?.length) return '(no completions)';
    let contextIcon = '•';
    if (includeIcon) {
      const implementationType = typeof scope.__implementation_type === 'string' && scope.__implementation_type.trim()
        ? scope.__implementation_type
        : 'personal';
      const { data: iconRow } = await supabase
        .from('concept_registry')
        .select('icon')
        .eq('implementation_type', implementationType)
        .eq('concept_type', 'object')
        .eq('concept_key', 'context')
        .eq('is_active', true)
        .maybeSingle();
      contextIcon = iconRow?.icon?.trim() || '•';
    }

    const formatRow = (c: any, groupedByContext: boolean): string => {
      const bits: string[] = [];
      if (displayFields.includes('title'))         bits.push(String(c.title ?? ''));
      if (displayFields.includes('completed_at')) {
        bits.push(`Completed: ${String(c.completed_at ?? '').slice(0, 10)}`);
      }
      if (displayFields.includes('outcome') && c.outcome) bits.push(String(c.outcome));
      if (displayFields.includes('context_id') && !groupedByContext) {
        const nm = (c.context as any)?.name ?? (c.context_id ? String(c.context_id).slice(0, 8) + '…' : 'No context');
        bits.push(`Context: ${nm}`);
      }
      const core = bits.filter(Boolean).join(' · ');
      const bullet = includeIcon ? contextIcon : '-';
      return `${bullet} ${core || '(row)'}`;
    };

    if (wantContext) {
      const groups = new Map<string, any[]>();
      for (const c of data) {
        const nm = (c.context as any)?.name ?? 'No context';
        if (!groups.has(nm)) groups.set(nm, []);
        groups.get(nm)!.push(c);
      }
      const ordered = Array.from(groups.entries()).sort((a, b) => {
        const maxA = Math.max(...a[1].map((x: any) => new Date(x.completed_at ?? 0).getTime()));
        const maxB = Math.max(...b[1].map((x: any) => new Date(x.completed_at ?? 0).getTime()));
        return maxB - maxA;
      });
      return ordered.map(([ctxName, rows]) => {
        rows.sort((a: any, b: any) =>
          new Date(b.completed_at ?? 0).getTime() - new Date(a.completed_at ?? 0).getTime());
        return `## ${ctxName}\n${rows.map((r: any) => formatRow(r, true)).join('\n')}`;
      }).join('\n\n');
    }

    return data.map((c: any) => formatRow(c, false)).join('\n');
  }

  if (objType === 'meeting') {
    if (scope.__no_context_match) return '(no meetings)';
    let q = supabase
      .from('meeting')
      .select('title, meeting_date, attendees, outcome')
      .eq('user_id', userId)
      .order('meeting_date', { ascending: false })
      .limit(50);
    if (scope.window_days) {
      const since = new Date();
      since.setDate(since.getDate() - Number(scope.window_days));
      q = q.gte('meeting_date', since.toISOString().slice(0, 10));
    }
    if (scope.completed_only) q = q.eq('is_completed', true);
    if (scope.context_id)     q = Array.isArray(scope.context_id) ? q.in('context_id', scope.context_id) : q.eq('context_id', scope.context_id);
    if (scope.attendee)       q = q.contains('attendees', [scope.attendee]);
    if (scope.tags?.length)   q = q.contains('tags', scope.tags);

    const { data } = await q;
    if (!data?.length) return '(no meetings)';
    return data.map((m: any) => {
      const date    = String(m.meeting_date ?? '').slice(0, 10);
      const att     = m.attendees?.length ? ` · ${m.attendees.join(', ')}` : '';
      const outcome = m.outcome ? ` · ${m.outcome}` : '';
      const future  = date > today ? ' [upcoming]' : '';
      return `- ${m.title}${att} · ${date}${future}${outcome}`;
    }).join('\n');
  }

  if (objType === 'contact') {
    const { data } = await supabase
      .from('contact').select('name').eq('user_id', userId).eq('is_archived', false)
      .order('name').limit(Number(scope.limit) || 20);
    if (!data?.length) return '(no contacts)';
    return data.map((c: any) => `- ${c.name}`).join('\n');
  }

  if (objType === 'user_situation') {
    const { data } = await supabase
      .from('user_situation').select('brief').eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data?.brief?.trim() ?? '(no situation brief)';
  }

  if (objType === 'external_reference') {
    const { data } = await supabase
      .from('external_reference').select('title').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(Number(scope.limit) || 10);
    if (!data?.length) return '(no extracts)';
    return data.map((r: any) => `- ${r.title}`).join('\n');
  }

  return `(no handler for ${objType})`;
}

// ─── Stub data for preview ────────────────────────────────────────────────────

function generateStub(objType: string, bucketLabels: Record<string, string>): string {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lastWeek  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const nextWeek  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const overdue   = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const labels    = Object.values(bucketLabels);

  switch (objType) {
    case 'task':
      return [
        `${labels[0] ?? 'Now'}:`,
        `- Sample Task A · Active · Due: ${today}`,
        `- Sample Task B · Waiting · Due: ${overdue} [OVERDUE]`,
        '',
        `${labels[1] ?? 'Soon'}:`,
        `- Sample Task C · Active · Due: ${nextWeek}`,
      ].join('\n');
    case 'completion':
      return [
        `- Completed Item A · Completed: ${today} · Delivered on schedule`,
        `- Completed Item B · Completed: ${yesterday} · Reviewed and approved`,
        `- Completed Item C · Completed: ${lastWeek}`,
      ].join('\n');
    case 'meeting':
      return [
        `- Weekly Sync · Alice, Bob · ${yesterday}`,
        `- Project Kickoff · Alice, Carol · ${lastWeek} · Aligned on scope`,
        `- Planning Session · Bob, Dave · ${nextWeek} [upcoming]`,
      ].join('\n');
    case 'user_situation':
      return 'Currently focused on Q2 delivery with active projects across multiple contexts.';
    case 'external_reference':
      return '- Sample Extract A\n- Sample Extract B';
    case 'contact':
      return '- Alice Smith\n- Bob Jones';
    default:
      return `(stub data for ${objType})`;
  }
}