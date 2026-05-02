/**
 * Versioned JSON for external_reference.run_data — receipt + reproducibility, no document body.
 */

export const EXTRACT_RUN_DATA_VERSION = 1 as const;

export type ExtractRunDataV1 = {
  v: typeof EXTRACT_RUN_DATA_VERSION;
  /** Link to reusable recipe when present */
  template_id: string | null;
  /** Draft path: full formatting instructions used for this run */
  prompt_snapshot: string | null;
  focus_prompt: string | null;
  selected_elements: string[];
  element_filters: Record<string, unknown>;
  task_list_scope: Record<string, unknown>;
  scope_tags: string[];
  approved_at: string;
  approval_mode: 'manual';
  /** User-facing summary persisted separately in notes; duplicated here for machine reads */
  approved_summary: string;
  external: {
    /** What they plan to name the file on disk / share */
    suggested_filename: string;
    /** Short label: Dropbox, This PC, Google Drive, … */
    storage_label: string | null;
    /** Path or URL — KarlOps does not verify existence or custody */
    locator: string | null;
  };
  policy: {
    non_custody: true;
    notice: string;
  };
};

export function defaultSuggestedFilenameDdMmYyyyColonHhMm(ext = 'md'): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}${mm}${yyyy}:${hh}${min}.${ext}`;
}

const NON_CUSTODY_NOTICE =
  'KarlOps does not verify file paths or URLs or maintain chain of custody for externally stored documents.';

export function buildExtractRunDataV1(input: {
  template_id: string | null;
  prompt_snapshot: string | null;
  focus_prompt: string | null;
  selected_elements: string[];
  element_filters: Record<string, unknown>;
  task_list_scope: Record<string, unknown>;
  scope_tags: string[];
  approved_summary: string;
  approved_at: string;
  suggested_filename: string;
  storage_label: string | null;
  locator: string | null;
}): ExtractRunDataV1 {
  return {
    v: EXTRACT_RUN_DATA_VERSION,
    template_id: input.template_id,
    prompt_snapshot: input.prompt_snapshot,
    focus_prompt: input.focus_prompt,
    selected_elements: input.selected_elements,
    element_filters: input.element_filters,
    task_list_scope: input.task_list_scope,
    scope_tags: input.scope_tags,
    approved_at: input.approved_at,
    approval_mode: 'manual',
    approved_summary: input.approved_summary,
    external: {
      suggested_filename: input.suggested_filename,
      storage_label: input.storage_label,
      locator: input.locator,
    },
    policy: {
      non_custody: true,
      notice: NON_CUSTODY_NOTICE,
    },
  };
}

export function serializeExtractRunData(data: ExtractRunDataV1): string {
  return JSON.stringify(data);
}
