/** Slug for document_template.filename_stub — matches save_as_template in command router. */
export function buildDocumentTemplateFilenameStub(
  name: string,
  description: string | null | undefined
): string {
  const seed =
    typeof description === 'string' && description.trim().length > 0
      ? description
      : String(name ?? '');
  const stub = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return stub || `template-${Date.now()}`;
}
