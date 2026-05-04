/** Markdown export for task notes / status (download + email share the same body). */

export function buildTaskStatusMarkdown(
  taskTitle: string,
  notes: string | null | undefined,
  exportedAt: Date = new Date(),
): string {
  const title = taskTitle.trim() || 'Task';
  const body = notes?.trim() || '_(No notes / status log yet.)_';
  const stamp = exportedAt.toISOString().replace('T', ' ').slice(0, 19);
  return [
    `# Status — ${title}`,
    '',
    `_Exported ${stamp} UTC · source: task notes / status in KarlOps_`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n');
}
