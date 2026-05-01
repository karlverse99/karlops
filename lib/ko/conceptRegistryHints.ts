/**
 * concept_registry rows for template generation — same source of truth as chat context / admin.
 * - Buckets → task bucket_key labels (queries) + suggested ## headings
 * - Objects → suggested ## headings for task / completion / meeting / … sections
 */

export type ConceptRegistryForTemplate = {
  bucketLabels: Record<string, string>;
  /** Injected into Haiku / assist prompts — registry-backed markdown ## headings */
  hintsBlock: string;
};

function iconPrefix(icon: unknown): string {
  return icon && String(icon).trim() ? `${String(icon).trim()} ` : '';
}

export async function loadConceptRegistryForTemplate(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<ConceptRegistryForTemplate> {
  const { data: koUser } = await supabase.from('ko_user').select('implementation_type').eq('id', userId).maybeSingle();
  const implType = koUser?.implementation_type ?? 'personal';

  const { data: rows } = await supabase
    .from('concept_registry')
    .select('concept_key, concept_type, label, icon, display_order')
    .eq('implementation_type', implType)
    .eq('is_active', true)
    .in('concept_type', ['bucket', 'object'])
    .order('concept_type')
    .order('display_order');

  const bucketLabels: Record<string, string> = {};
  const bucketLines: string[] = [];
  const objectLines: string[] = [];
  let taskIcon = '';

  for (const r of rows ?? []) {
    const label = String(r.label ?? '').trim() || String(r.concept_key ?? '');
    if (r.concept_type === 'bucket') {
      const shortKey = String(r.concept_key ?? '').replace(/^bucket_/, '');
      bucketLabels[shortKey] = label;
      bucketLines.push(`- bucket_key \`${shortKey}\` → ## ${iconPrefix(r.icon)}${label}`);
    } else if (r.concept_type === 'object') {
      const key = String(r.concept_key ?? '');
      objectLines.push(`- object \`${key}\` → ## ${iconPrefix(r.icon)}${label} (section about this entity type)`);
      if (key === 'task') taskIcon = iconPrefix(r.icon);
    }
  }

  const parts: string[] = [
    'KO concept registry — use these icon + label pairs for ## section headings (aligned with workspace UI). Prefer Markdown only (no HTML).',
  ];

  if (bucketLines.length) {
    parts.push('', '**Buckets** (maps to `task.bucket_key`):', ...bucketLines);
  }
  if (objectLines.length) {
    parts.push('', '**Objects** (maps to entity types in data / sections):', ...objectLines);
  }

  if (taskIcon) {
    parts.push(
      '',
      `**Tagged task lists:** companion to delegated work — ## ${taskIcon}Tagged tasks with pipe tables and **bold** header row when the doc splits delegated vs tag-filtered tasks.`,
    );
  }

  const hintsBlock = bucketLines.length || objectLines.length || taskIcon ? parts.join('\n').trim() : '';

  return { bucketLabels, hintsBlock };
}
