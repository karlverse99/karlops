import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { buildKarlContext } from '@/lib/ko/buildKarlContext';
import { encryptOutput } from '@/lib/ko/outputEncryption';

export const dynamic = 'force-dynamic';

// ─── POST /api/ko/template/run ────────────────────────────────────────────────
// Unified template execution endpoint — used by both modal and chat.
//
// run_mode: 'preview'      = stub data, never saves
// run_mode: 'preview_live' = real data, never saves
// run_mode: 'generate'     = real data, encrypts and saves to external_reference
//
// Pass-through mode: if template has NO sections[] and NO selected_elements,
// the prompt_template content is encrypted directly and saved. No Haiku call.
//
// resolved_values: Record<"object_type.field", value> — from ValueResolverModal.
//   Merged into section scope before data pull. Values override section default_scope.
//   Keyed by "object_type.field" e.g. "task.tags", "meeting.attendee".
//
// Body: {
//   template_id, override_instructions?, run_mode?,
//   section_data?, resolved_values?, filename?, suffix?
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
      override_instructions,
      run_mode = 'preview',
      section_data      = {},
      resolved_values   = {},   // from ValueResolverModal — "object_type.field" → value
      filename: clientFilename,
      suffix:   clientSuffix,
    } = body;

    if (!template_id) return NextResponse.json({ error: 'template_id required' }, { status: 400 });

    const isPreview = run_mode === 'preview';
    const isSave    = run_mode === 'generate';

    // ── Load template ────────────────────────────────────────────────────────
    const { data: template, error: tErr } = await supabase
      .from('document_template')
      .select('name, description, prompt_template, sections, selected_elements, output_format, context_id, filename_suffix_format')
      .eq('document_template_id', template_id)
      .or(`user_id.eq.${user.id},is_system.eq.true`)
      .single();

    if (tErr || !template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    const instructions = override_instructions?.trim() || template.prompt_template;

    const sections: Array<{ key: string; label: string; source: string; format: string; default_scope?: Record<string, any> }> =
      Array.isArray(template.sections) ? template.sections : [];
    const selectedElements: string[] =
      Array.isArray(template.selected_elements) ? template.selected_elements : [];

    // ── PASS-THROUGH MODE ────────────────────────────────────────────────────
    // No sections AND no selected_elements → this template is a plain document.
    // For generate: encrypt prompt_template (or override_instructions) directly.
    // For preview/preview_live: return the instructions as-is (nothing to generate).
    if (sections.length === 0 && selectedElements.length === 0 && !isPreview) {
      const content = instructions ?? '';
      if (!content) return NextResponse.json({ error: 'Template has no content.' }, { status: 400 });

      if (!isSave) {
        // preview_live with no sections — just return the raw instructions
        return NextResponse.json({ output: content, format: template.output_format ?? 'md', saved: false });
      }

      // Generate — encrypt and save directly, no Haiku call
      const encryptedOutput = await encryptOutput(content);
      const ext             = formatExtension(template.output_format ?? 'md');
      const today           = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const resolvedFilename = clientFilename?.trim() || `${template.name.toLowerCase().replace(/\s+/g, '-')}-${today}.${ext}`;
      const resolvedSuffix   = clientSuffix?.trim() || today;
      const extractTitle     = `${template.name} · ${resolvedSuffix}`;

      const { error: saveError } = await supabase.from('external_reference').insert({
        user_id:              user.id,
        title:                extractTitle,
        description:          template.description ?? null,
        filename:             resolvedFilename,
        location:             'generated',
        run_data:             content,
        output:               encryptedOutput,
        output_encrypted:     true,
        section_data:         null,
        document_template_id: template_id,
        ref_type:             'generated',
        tags:                 [],
      });

      if (saveError) {
        console.error('[template/run] pass-through save failed:', saveError);
        return NextResponse.json({ output: content, format: template.output_format ?? 'md', saved: false, save_error: saveError.message });
      }

      console.log('[template/run] pass-through save — no Haiku call used');
      return NextResponse.json({ output: content, format: template.output_format ?? 'md', saved: true, filename: resolvedFilename, title: extractTitle });
    }

    // Instructions required for non-pass-through paths
    if (!instructions) return NextResponse.json({ error: 'Template has no formatting instructions. Add them before running.' }, { status: 400 });

    // ── Load bucket labels ───────────────────────────────────────────────────
    const { data: koUser } = await supabase.from('ko_user').select('implementation_type').eq('id', user.id).single();
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

    // ── Merge resolved_values into section_data ───────────────────────────
    // resolved_values are keyed "object_type.field" — we need to map them into
    // section scopes. Strategy: for each section, find resolved_values whose
    // object_type matches the section source, and merge the field value in.
    //
    // e.g. "task.tags" = ["Jen Schroeder"] applies to sections with source = "tasks"
    //      "meeting.attendee" = "Jen Schroeder" applies to sections with source = "meetings"
    //      "completion.window_days" = 14 applies to sections with source = "completions"
    //
    // source-to-object_type map:
    const SOURCE_OBJECT_MAP: Record<string, string> = {
      tasks:        'task',
      completions:  'completion',
      meetings:     'meeting',
      contacts:     'contact',
      situation:    'user_situation',
      extracts:     'external_reference',
    };

    const mergedSectionData: Record<string, Record<string, any>> = {};

    for (const section of sections) {
      const baseScope      = section_data[section.key] ?? section.default_scope ?? {};
      const expectedObjType = SOURCE_OBJECT_MAP[section.source] ?? section.source;

      // Collect resolved_values whose object_type matches this section's source
      const patch: Record<string, any> = {};
      for (const [elKey, val] of Object.entries(resolved_values)) {
        const [objType, ...fieldParts] = elKey.split('.');
        const field = fieldParts.join('.');
        if (objType === expectedObjType && val !== '' && val !== null && val !== undefined) {
          // Array values only override if non-empty
          if (!Array.isArray(val) || val.length > 0) patch[field] = val;
        }
      }

      mergedSectionData[section.key] = { ...baseScope, ...patch };
    }

    // ── Build section data blocks ────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const sectionBlocks: string[] = [];

    if (sections.length > 0) {
      for (const section of sections) {
        const scope = mergedSectionData[section.key] ?? {};
        const content = isPreview
          ? generateStub(section.source, bucketLabels)
          : await pullSectionData(supabase, user.id, section.source, scope, bucketLabels);
        sectionBlocks.push(`[${section.key}] ${section.label}\nFormat: ${section.format}\nData:\n${content}`);
      }
    } else {
      // selected_elements with no sections — describe what we pulled
      if (isPreview) {
        sectionBlocks.push(generateStub('tasks', bucketLabels));
        sectionBlocks.push(generateStub('meetings', bucketLabels));
        sectionBlocks.push(generateStub('completions', bucketLabels));
      } else {
        // Build a combined scope from all resolved_values
        const combinedTaskScope       = buildCombinedScope(resolved_values, 'task');
        const combinedCompletionScope = buildCombinedScope(resolved_values, 'completion');
        const combinedMeetingScope    = buildCombinedScope(resolved_values, 'meeting');

        const [tasks, meetings, completions] = await Promise.all([
          pullSectionData(supabase, user.id, 'tasks',       { buckets: Object.keys(bucketLabels), ...combinedTaskScope }, bucketLabels),
          pullSectionData(supabase, user.id, 'meetings',    combinedMeetingScope, bucketLabels),
          pullSectionData(supabase, user.id, 'completions', combinedCompletionScope, bucketLabels),
        ]);
        if (tasks !== '(no data)')       sectionBlocks.push(`Tasks:\n${tasks}`);
        if (meetings !== '(no data)')    sectionBlocks.push(`Meetings:\n${meetings}`);
        if (completions !== '(no data)') sectionBlocks.push(`Completions:\n${completions}`);
      }
    }

    // ── Concept registry hints ───────────────────────────────────────────────
    const bundle = await buildKarlContext(user.id, null);
    const conceptHints = bundle.conceptRegistry.length
      ? 'Concept registry (use these icons and labels only):\n' +
        bundle.conceptRegistry
          .filter(c => c.concept_type !== 'action')
          .map(c => `  ${c.icon ?? ''} = ${c.label} (key: ${c.concept_key})`)
          .join('\n')
      : '';

    const dataBlock = sectionBlocks.join('\n\n') || 'No data available.';

    const fullPrompt = [
      `Template: ${template.name}`,
      template.description ? `Purpose: ${template.description}` : '',
      `Date: ${today}`,
      '',
      'Formatting Instructions:',
      instructions,
      '',
      conceptHints,
      '',
      isPreview ? 'NOTE: FORMATTING PREVIEW — use stub data as-is to demonstrate layout.' : '',
      '',
      'Section Data:',
      dataBlock,
    ].filter(Boolean).join('\n').trim();

    // ── Generate via Haiku ───────────────────────────────────────────────────
    const systemPrompt = `You are Karl, generating a document for a KarlOps user.
Follow the formatting instructions exactly. Use only the section data provided — do not invent data.
${isPreview ? 'This is a formatting preview — demonstrate the layout using stub data.' : ''}
Format output in ${template.output_format ?? 'md'}.
Use concept registry icons/labels for section headers. Never hardcode labels.
Replace {date} with today's date: ${today}.
Return ONLY the document content — no preamble, no explanation, no code fences.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: fullPrompt }],
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
      if (msg.toLowerCase().includes('rate limit')) {
        return NextResponse.json({ error: 'Rate limit hit — try reducing the date window or filtering by context.' }, { status: 429 });
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const output = data.content?.[0]?.text ?? '';
    if (!output) return NextResponse.json({ error: 'Generation produced no output' }, { status: 500 });

    // Preview (stub or live) — return immediately, never save
    if (!isSave) {
      return NextResponse.json({ output, format: template.output_format ?? 'md', saved: false });
    }

    // Generate — encrypt and save to external_reference
    const encryptedOutput = await encryptOutput(output);

    const ext          = formatExtension(template.output_format ?? 'md');
    const fallbackDate = today.replace(/-/g, '');
    const resolvedFilename = clientFilename?.trim()
      || `${template.name.toLowerCase().replace(/\s+/g, '-')}-${fallbackDate}.${ext}`;
    const resolvedSuffix = clientSuffix?.trim() || fallbackDate;
    const extractTitle   = `${template.name} · ${resolvedSuffix}`;

    // Persist the merged scope (what actually ran) so extract is reproducible
    const persistedSectionData = sections.length > 0 ? mergedSectionData : (Object.keys(resolved_values).length > 0 ? resolved_values : null);

    const { error: saveError } = await supabase.from('external_reference').insert({
      user_id:              user.id,
      title:                extractTitle,
      description:          template.description ?? null,
      filename:             resolvedFilename,
      location:             'generated',
      run_data:             fullPrompt,
      output:               encryptedOutput,
      output_encrypted:     true,
      section_data:         persistedSectionData,
      document_template_id: template_id,
      ref_type:             'generated',
      tags:                 [],
    });

    if (saveError) {
      console.error('[template/run] save failed:', saveError);
      return NextResponse.json({ output, format: template.output_format ?? 'md', saved: false, save_error: saveError.message });
    }

    return NextResponse.json({ output, format: template.output_format ?? 'md', saved: true, filename: resolvedFilename, title: extractTitle });

  } catch (err: any) {
    console.error('[template/run]', err);
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExtension(outputFormat: string): string {
  switch (outputFormat) {
    case 'html':  return 'html';
    case 'txt':   return 'txt';
    case 'docx':  return 'docx';
    case 'pdf':   return 'pdf';
    default:      return 'md';
  }
}

/** Build a flat scope object from resolved_values for a given object type */
function buildCombinedScope(resolvedValues: Record<string, any>, objectType: string): Record<string, any> {
  const scope: Record<string, any> = {};
  for (const [key, val] of Object.entries(resolvedValues)) {
    const [objType, ...fieldParts] = key.split('.');
    if (objType === objectType && val !== '' && val !== null && val !== undefined) {
      if (!Array.isArray(val) || val.length > 0) scope[fieldParts.join('.')] = val;
    }
  }
  return scope;
}

// ─── Section data puller ──────────────────────────────────────────────────────
// RULE: notes and description NEVER included — display-only fields

async function pullSectionData(
  supabase: any,
  userId: string,
  source: string,
  scope: Record<string, any>,
  bucketLabels: Record<string, string>
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  if (source === 'tasks') {
    const buckets: string[] = scope.buckets ?? Object.keys(bucketLabels);
    let q = supabase
      .from('task')
      .select('title, bucket_key, tags, target_date, context:context_id(name), task_status:task_status_id(label)')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .in('bucket_key', buckets)
      .order('sort_order', { ascending: true, nullsFirst: false });
    if (scope.context) q = q.eq('context_id', scope.context);
    if (scope.tags?.length) q = q.contains('tags', scope.tags);
    if (scope.delegated_to) q = q.eq('delegated_to', scope.delegated_to);

    const { data: tasks } = await q;
    if (!tasks?.length) return '(no tasks)';

    const byBucket: Record<string, string[]> = {};
    for (const t of tasks) {
      if (!byBucket[t.bucket_key]) byBucket[t.bucket_key] = [];
      const status  = (t.task_status as any)?.label ?? '';
      const due     = t.target_date ? String(t.target_date).slice(0, 10) : null;
      const overdue = due && due < today ? ' [OVERDUE]' : '';
      byBucket[t.bucket_key].push(`- ${t.title}${status ? ' · ' + status : ''}${due ? ' · Due: ' + due + overdue : ''}`);
    }
    return Object.entries(byBucket)
      .map(([b, items]) => `${bucketLabels[b] ?? b}:\n${items.join('\n')}`)
      .join('\n\n');
  }

  if (source === 'completions') {
    const windowDays = scope.window_days ?? null;
    let q = supabase
      .from('completion')
      .select('title, completed_at, outcome, context:context_id(name)')
      .eq('user_id', userId)
      .order('completed_at', { ascending: false });
    if (windowDays) {
      const since = new Date();
      since.setDate(since.getDate() - windowDays);
      q = q.gte('completed_at', since.toISOString());
    }
    if (scope.context) q = q.eq('context_id', scope.context);
    if (scope.tags?.length) q = q.contains('tags', scope.tags);

    const { data: completions } = await q;
    if (!completions?.length) return '(no completions)';
    return completions.map((c: any) => {
      const date    = String(c.completed_at ?? '').slice(0, 10);
      const outcome = c.outcome ? ` · ${c.outcome}` : '';
      return `- ${c.title} · Completed: ${date}${outcome}`;
    }).join('\n');
  }

  if (source === 'meetings') {
    const windowDays = scope.window_days ?? null;
    let q = supabase
      .from('meeting')
      .select('title, meeting_date, attendees, outcome, context:context_id(name)')
      .eq('user_id', userId)
      .order('meeting_date', { ascending: false })
      .limit(50);
    if (windowDays) {
      const since = new Date();
      since.setDate(since.getDate() - windowDays);
      q = q.gte('meeting_date', since.toISOString().slice(0, 10));
    }
    if (scope.completed_only) q = q.eq('is_completed', true);
    if (scope.context) q = q.eq('context_id', scope.context);
    if (scope.attendee) q = q.contains('attendees', [scope.attendee]);
    if (scope.tags?.length) q = q.contains('tags', scope.tags);

    const { data: meetings } = await q;
    if (!meetings?.length) return '(no meetings)';
    return meetings.map((m: any) => {
      const date    = String(m.meeting_date ?? '').slice(0, 10);
      const att     = m.attendees?.length ? ` · ${m.attendees.join(', ')}` : '';
      const outcome = m.outcome ? ` · ${m.outcome}` : '';
      const future  = date > today ? ' [upcoming]' : '';
      return `- ${m.title}${att} · ${date}${future}${outcome}`;
    }).join('\n');
  }

  if (source === 'situation') {
    const { data } = await supabase
      .from('user_situation').select('brief').eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data?.brief?.trim() ?? '(no situation brief)';
  }

  if (source === 'extracts') {
    const { data: extracts } = await supabase
      .from('external_reference').select('title').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(scope.limit ?? 10);
    if (!extracts?.length) return '(no extracts)';
    return extracts.map((r: any) => `- ${r.title}`).join('\n');
  }

  if (source === 'contacts') {
    const { data: contacts } = await supabase
      .from('contact').select('name').eq('user_id', userId).eq('is_archived', false)
      .order('name').limit(scope.limit ?? 20);
    if (!contacts?.length) return '(no contacts)';
    return contacts.map((c: any) => `- ${c.name}`).join('\n');
  }

  return `(unknown source: ${source})`;
}

// ─── Stub data for preview ────────────────────────────────────────────────────

function generateStub(source: string, bucketLabels: Record<string, string>): string {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lastWeek  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const nextWeek  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const overdue   = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const labels    = Object.values(bucketLabels);

  switch (source) {
    case 'tasks':
      return [
        `${labels[0] ?? 'Now'}:`,
        `- Sample Task A · Active · Due: ${today}`,
        `- Sample Task B · Waiting · Due: ${overdue} [OVERDUE]`,
        ``,
        `${labels[1] ?? 'Soon'}:`,
        `- Sample Task C · Active · Due: ${nextWeek}`,
        ``,
        `${labels[4] ?? 'Delegate'}:`,
        `- Sample Task D · Waiting · Due: ${overdue} [OVERDUE]`,
      ].join('\n');
    case 'completions':
      return [
        `- Completed Item A · Completed: ${today} · Delivered on schedule`,
        `- Completed Item B · Completed: ${yesterday} · Reviewed and approved`,
        `- Completed Item C · Completed: ${lastWeek}`,
      ].join('\n');
    case 'meetings':
      return [
        `- Weekly Sync · Alice, Bob · ${yesterday}`,
        `- Project Kickoff · Alice, Carol · ${lastWeek} · Aligned on scope`,
        `- Planning Session · Bob, Dave · ${nextWeek} [upcoming]`,
      ].join('\n');
    case 'situation':
      return `Currently focused on Q2 delivery with active projects across multiple contexts.`;
    case 'extracts':
      return `- Sample Extract Document\n- Another Extract`;
    case 'contacts':
      return `- Alice Smith\n- Bob Jones`;
    default:
      return `(stub data for ${source})`;
  }
}