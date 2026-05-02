'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { buildDocumentTemplateFilenameStub } from '@/lib/ko/documentTemplateFilenameStub';
import KarlSpinner from './KarlSpinner';

interface Context {
  context_id: string;
  name: string;
}

interface TemplateLite {
  document_template_id: string;
  name: string;
}

interface TaskReportBuilderModalProps {
  userId: string;
  accessToken: string;
  contextOptions: Context[];
  scope: {
    search: string;
    bucket: string;
    contextId: string;
    statusId: string;
    showCompleted: boolean;
    showArchived: boolean;
    filteredCount: number;
  };
  onClose: () => void;
}

const ACCENT = '#8b5cf6';
const ACCENT_BG = '#f5f3ff';
const ACCENT_BORDER = '#ddd6fe';

function defaultTaskInstructions() {
  return [
    '# Weekly Task Report',
    '',
    '## Executive Summary',
    '- Total active tasks: include count from data.',
    '- Top priorities: 3 concise bullets.',
    '- Risks/blocks: 2 concise bullets if present.',
    '',
    '## Work By Bucket',
    '| **Bucket** | **Task** | **Status** | **Due** |',
    '|------------|----------|------------|---------|',
    '| ... | ... | ... | ... |',
    '',
    '## Action Notes',
    '- Mention overdue and approaching due dates.',
    '- Keep output concise and manager-readable.',
  ].join('\n');
}

function renderScopeSummary(
  scope: TaskReportBuilderModalProps['scope'],
  contexts: Context[]
) {
  const parts: string[] = [];
  if (scope.bucket) parts.push(`bucket=${scope.bucket}`);
  if (scope.contextId) {
    const ctx = contexts.find((c) => c.context_id === scope.contextId);
    parts.push(`context=${ctx?.name ?? scope.contextId}`);
  }
  if (scope.search.trim()) parts.push(`search="${scope.search.trim()}"`);
  if (scope.statusId) parts.push('status filter active');
  if (scope.showCompleted) parts.push('include completed');
  if (scope.showArchived) parts.push('include archived');
  return parts.length ? parts.join(' | ') : 'all open task defaults';
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push(
        <h3 key={`h3-${i}`} style={{ fontSize: '0.95rem', margin: '0.85rem 0 0.4rem', color: '#1f2937' }}>
          {line.slice(4)}
        </h3>
      );
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push(
        <h2 key={`h2-${i}`} style={{ fontSize: '1.02rem', margin: '0.95rem 0 0.45rem', color: '#111827' }}>
          {line.slice(3)}
        </h2>
      );
      i += 1;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(
        <h1 key={`h1-${i}`} style={{ fontSize: '1.14rem', margin: '0.95rem 0 0.55rem', color: '#111827' }}>
          {line.slice(2)}
        </h1>
      );
      i += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i].trim();
        if (!/^\|\s*-+/.test(row)) {
          const cols = row.split('|').slice(1, -1).map((c) => c.trim());
          tableRows.push(cols);
        }
        i += 1;
      }
      if (tableRows.length > 0) {
        const [head, ...rows] = tableRows;
        blocks.push(
          <div key={`table-${i}`} style={{ overflowX: 'auto', margin: '0.5rem 0 0.75rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.74rem' }}>
              <thead>
                <tr>
                  {head.map((c, idx) => (
                    <th key={idx} style={{ textAlign: 'left', border: '1px solid #e5e7eb', padding: '0.35rem 0.45rem', background: '#fafafa' }}>
                      {c.replace(/\*\*/g, '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ridx) => (
                  <tr key={ridx}>
                    {r.map((c, cidx) => (
                      <td key={cidx} style={{ border: '1px solid #f0f0f0', padding: '0.32rem 0.45rem', color: '#374151' }}>
                        {c.replace(/\*\*/g, '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${i}`} style={{ margin: '0.25rem 0 0.6rem 1rem', padding: 0 }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ fontSize: '0.77rem', color: '#374151', marginBottom: '0.25rem' }}>
              {item}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${i}`} style={{ fontSize: '0.77rem', color: '#374151', margin: '0.3rem 0', lineHeight: 1.55 }}>
        {line}
      </p>
    );
    i += 1;
  }

  return <div>{blocks}</div>;
}

export default function TaskReportBuilderModal({
  userId,
  accessToken,
  contextOptions,
  scope,
  onClose,
}: TaskReportBuilderModalProps) {
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('Task Report Template');
  const [templateDesc, setTemplateDesc] = useState('Reusable task report recipe.');
  const [instructions, setInstructions] = useState(defaultTaskInstructions());
  const [focusPrompt, setFocusPrompt] = useState('');
  const [previewOutput, setPreviewOutput] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [approvingExtract, setApprovingExtract] = useState(false);
  const [error, setError] = useState('');
  const [saveMsg, setSaveMsg] = useState('');

  const initX = Math.max(30, Math.round(window.innerWidth / 2 - 620));
  const initY = Math.max(30, Math.round(window.innerHeight / 2 - 350));
  const [pos, setPos] = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 1240, h: 700 });
  const dragging = useRef(false);
  const resizing = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0 });

  useEffect(() => {
    const loadTemplates = async () => {
      const { data } = await supabase
        .from('document_template')
        .select('document_template_id, name')
        .or(`user_id.eq.${userId},is_system.eq.true`)
        .eq('is_active', true)
        .order('name');
      if (data) setTemplates(data as TemplateLite[]);
    };
    loadTemplates();
  }, [userId]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({
          x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.mx),
          y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.my),
        });
      }
      if (resizing.current) {
        setSize({
          w: Math.max(980, resizeStart.current.w + e.clientX - resizeStart.current.mx),
          h: Math.max(560, resizeStart.current.h + e.clientY - resizeStart.current.my),
        });
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const taskScope = useMemo(() => {
    const base: Record<string, unknown> = {};
    if (scope.bucket) base.bucket_key = [scope.bucket];
    if (scope.contextId) base.context_id = scope.contextId;
    return { __scope: { task: base } };
  }, [scope.bucket, scope.contextId]);

  const scopeSummary = useMemo(
    () => renderScopeSummary(scope, contextOptions),
    [scope, contextOptions]
  );

  const runPreview = async () => {
    setRunning(true);
    setError('');
    setSaveMsg('');
    setPreviewOutput('');
    try {
      const body: Record<string, unknown> = {
        run_mode: 'preview_live',
        user_additions: focusPrompt.trim(),
      };
      if (templateId) {
        body.template_id = templateId;
      } else {
        body.inline_template = {
          name: templateName.trim() || 'Task Report Template',
          description: templateDesc.trim() || null,
          prompt_template: instructions.trim(),
          template_mode: 'karl',
          output_format: 'md',
          filename_suffix_format: 'date',
          selected_elements: ['task.title', 'task.bucket_key', 'task.target_date', 'task.tags'],
          element_filters: taskScope,
        };
      }
      const res = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Preview failed');
      const output = String(data.output ?? '');
      setPreviewOutput(output);
      const firstLines = output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' | ')
        .slice(0, 380);
      setSummaryDraft(
        `Approved task extract preview on ${new Date().toLocaleString()}. Scope: ${scopeSummary}. Snippet: ${firstLines || '(empty output)'}`.slice(
          0,
          900
        )
      );
    } catch (e: any) {
      setError(e.message ?? 'Preview failed');
    } finally {
      setRunning(false);
    }
  };

  const saveAsTemplate = async () => {
    if (!templateName.trim()) {
      setError('Template name is required');
      return;
    }
    setSavingTemplate(true);
    setError('');
    setSaveMsg('');
    try {
      const payload = {
        user_id: userId,
        name: templateName.trim(),
        filename_stub: buildDocumentTemplateFilenameStub(templateName.trim(), templateDesc.trim() || null),
        description: templateDesc.trim() || null,
        output_format: 'md',
        prompt_template: instructions.trim(),
        template_mode: 'karl',
        filename_suffix_format: 'date',
        selected_elements: ['task.title', 'task.bucket_key', 'task.target_date', 'task.tags'],
        element_filters: taskScope,
        sections: [] as unknown[],
        tags: [] as string[],
        is_system: false,
        is_active: true,
      };
      const { data, error: saveErr } = await supabase
        .from('document_template')
        .insert(payload)
        .select('document_template_id, name')
        .single();
      if (saveErr) throw saveErr;
      if (data?.document_template_id) {
        setTemplates((prev) => [...prev, data as TemplateLite].sort((a, b) => a.name.localeCompare(b.name)));
        setTemplateId(data.document_template_id);
      }
      setSaveMsg('Template saved. Re-run preview anytime with fresh data.');
    } catch (e: any) {
      setError(e.message ?? 'Template save failed');
    } finally {
      setSavingTemplate(false);
    }
  };

  const approveExtract = async () => {
    if (!previewOutput.trim()) {
      setError('Run preview before approving extract.');
      return;
    }
    if (!summaryDraft.trim()) {
      setError('Summary is required to approve extract.');
      return;
    }
    setApprovingExtract(true);
    setError('');
    setSaveMsg('');
    try {
      const now = new Date();
      const dateSlug = now.toISOString().slice(0, 10);
      const titleBase = (templateName.trim() || 'Task Report').slice(0, 90);
      const runSnapshot = {
        template_id: templateId || null,
        instructions,
        focus_prompt: focusPrompt.trim() || null,
        selected_elements: ['task.title', 'task.bucket_key', 'task.target_date', 'task.tags'],
        element_filters: taskScope,
        scope,
        approved_at: now.toISOString(),
        approval_mode: 'manual',
      };
      const { error: saveErr } = await supabase.from('external_reference').insert({
        user_id: userId,
        title: `${titleBase} · approved ${dateSlug}`,
        filename: `${titleBase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${dateSlug}.md`,
        location: 'task_report_approved',
        description: templateDesc.trim() || 'Approved task extract run',
        notes: summaryDraft.trim(),
        run_data: JSON.stringify(runSnapshot),
        output: null,
        output_encrypted: false,
        section_data: taskScope,
        document_template_id: templateId || null,
        ref_type: 'generated',
        tags: [],
      });
      if (saveErr) throw saveErr;
      setSaveMsg('Extract approved and run record saved.');
    } catch (e: any) {
      setError(e.message ?? 'Approve extract failed');
    } finally {
      setApprovingExtract(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          width: size.w,
          height: size.h,
          background: '#fff',
          border: `2px solid ${ACCENT}`,
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'monospace',
          boxShadow: '0 25px 70px rgba(0,0,0,0.35)',
          pointerEvents: 'all',
        }}
      >
        <div
          onMouseDown={(e) => {
            dragging.current = true;
            dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
          }}
          style={{
            padding: '0.75rem 1rem',
            background: ACCENT,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            cursor: 'grab',
            userSelect: 'none',
          }}
        >
          <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.84rem' }}>Task Report Builder</span>
          <span style={{ color: '#ede9fe', fontSize: '0.66rem' }}>
            {scope.filteredCount} tasks in current view
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1rem', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '0.45rem 0.9rem', borderBottom: `1px solid ${ACCENT_BORDER}`, background: ACCENT_BG, color: '#6d28d9', fontSize: '0.65rem' }}>
          Current task scope: {scopeSummary}
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.1fr 1.4fr', overflow: 'hidden' }}>
          <div style={{ borderRight: `1px solid ${ACCENT_BORDER}`, overflowY: 'auto', padding: '0.8rem' }}>
            <div style={{ marginBottom: '0.7rem' }}>
              <div style={labelSt}>Use Existing Template (optional)</div>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                style={{ ...inputSt, cursor: 'pointer' } as any}
              >
                <option value="">Draft from this task view</option>
                {templates.map((t) => (
                  <option key={t.document_template_id} value={t.document_template_id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: '0.7rem' }}>
              <div style={labelSt}>Template Name</div>
              <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputSt} />
            </div>
            <div style={{ marginBottom: '0.7rem' }}>
              <div style={labelSt}>Template Description</div>
              <input value={templateDesc} onChange={(e) => setTemplateDesc(e.target.value)} style={inputSt} />
            </div>
            <div style={{ marginBottom: '0.7rem' }}>
              <div style={labelSt}>Run Focus (data tweak per run)</div>
              <textarea
                value={focusPrompt}
                onChange={(e) => setFocusPrompt(e.target.value)}
                rows={3}
                style={{ ...inputSt, resize: 'vertical' } as any}
                placeholder="Example: Emphasize overdue and delegated tasks this week."
              />
            </div>
            <div style={{ marginBottom: '0.7rem' }}>
              <div style={labelSt}>Formatting Instructions (recipe)</div>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={13}
                style={{ ...inputSt, resize: 'vertical', minHeight: 220 } as any}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={runPreview} disabled={running} style={primaryBtn}>
                {running ? 'running...' : 'Run Preview'}
              </button>
              <button onClick={saveAsTemplate} disabled={savingTemplate} style={ghostBtn}>
                {savingTemplate ? 'saving...' : 'Save as Template'}
              </button>
              <button
                onClick={approveExtract}
                disabled={approvingExtract || !previewOutput.trim()}
                style={{
                  ...ghostBtn,
                  borderColor: previewOutput.trim() ? '#a7f3d0' : '#ddd',
                  color: previewOutput.trim() ? '#065f46' : '#aaa',
                  cursor: previewOutput.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                {approvingExtract ? 'approving...' : 'Approve Extract'}
              </button>
              {saveMsg && <span style={{ color: '#047857', fontSize: '0.66rem' }}>{saveMsg}</span>}
              {error && <span style={{ color: '#ef4444', fontSize: '0.66rem' }}>{error}</span>}
            </div>
          </div>

          <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '0.6rem 0.8rem', borderBottom: `1px solid ${ACCENT_BORDER}`, fontSize: '0.68rem', color: '#6b7280', background: '#fafafa' }}>
              Rich Preview (recipe-based, rerunnable with new data)
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.9rem 1rem', background: '#fcfcfd' }}>
              {running ? (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.7rem', color: '#6b7280', fontSize: '0.76rem' }}>
                  <KarlSpinner size="sm" color={ACCENT} />
                  Rendering preview from current task data...
                </div>
              ) : previewOutput ? (
                <MarkdownPreview content={previewOutput} />
              ) : (
                <div style={{ color: '#9ca3af', fontSize: '0.76rem' }}>
                  Run preview to render output here.
                </div>
              )}
            </div>
            {previewOutput && (
              <div style={{ borderTop: `1px solid ${ACCENT_BORDER}`, padding: '0.45rem 0.8rem', background: '#fff', display: 'grid', gap: '0.45rem' }}>
                <div>
                  <div style={labelSt}>Approval Summary (persisted on Approve Extract)</div>
                  <textarea
                    value={summaryDraft}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    rows={4}
                    style={{ ...inputSt, resize: 'vertical', fontSize: '0.7rem' } as any}
                  />
                </div>
                <details>
                  <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: '0.66rem' }}>Raw output</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.7rem', color: '#374151', marginTop: '0.45rem' }}>{previewOutput}</pre>
                </details>
              </div>
            )}
          </div>
        </div>

        <div
          onMouseDown={(e) => {
            resizing.current = true;
            resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h };
          }}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: 'se-resize',
          }}
        />
      </div>
    </div>
  );
}

const labelSt: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '0.62rem',
  marginBottom: '0.24rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontWeight: 600,
};

const inputSt: React.CSSProperties = {
  width: '100%',
  background: '#fff',
  border: '1px solid #ddd',
  color: '#222',
  padding: '0.42rem 0.55rem',
  borderRadius: 4,
  fontFamily: 'monospace',
  fontSize: '0.76rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  background: ACCENT,
  border: 'none',
  color: '#fff',
  padding: '0.35rem 0.85rem',
  borderRadius: 4,
  fontSize: '0.7rem',
  fontFamily: 'monospace',
  cursor: 'pointer',
  fontWeight: 700,
};

const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${ACCENT_BORDER}`,
  color: '#6d28d9',
  padding: '0.35rem 0.85rem',
  borderRadius: 4,
  fontSize: '0.7rem',
  fontFamily: 'monospace',
  cursor: 'pointer',
};
