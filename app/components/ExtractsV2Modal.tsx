'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Lane = 'run' | 'guide' | 'build' | 'tweak';
type UniverseTab = 'recent_runs' | 'templates';

interface RunRecord {
  external_reference_id: string;
  title: string;
  description: string | null;
  filename: string | null;
  ref_type: string | null;
  created_at: string;
  document_template_id: string | null;
}

interface TemplateRecord {
  document_template_id: string;
  name: string;
  doc_type: string | null;
  output_format: string | null;
}

interface ExtractsV2ModalProps {
  userId: string;
  accessToken: string;
  initialLane?: Lane;
  onCountChange?: (count: number) => void;
  onClose: () => void;
}

const LANE_COPY: Record<Lane, { title: string; subtitle: string }> = {
  run: {
    title: 'Run Documentation',
    subtitle: 'Generate output quickly from a known template or prior run.',
  },
  guide: {
    title: 'Guide Documentation',
    subtitle: 'Use chat guidance to assemble a runnable draft.',
  },
  build: {
    title: 'Build Template',
    subtitle: 'Create reusable documentation structure for repeat runs.',
  },
  tweak: {
    title: 'Tweak and Re-run',
    subtitle: 'Adjust an existing run path, preview, then rerun.',
  },
};

const LANE_DEFAULT_TAB: Record<Lane, UniverseTab> = {
  run: 'recent_runs',
  tweak: 'recent_runs',
  build: 'templates',
  guide: 'templates',
};

const LANE_ACTION_COPY: Record<Lane, { primary: string; helper: string }> = {
  run: {
    primary: 'Preview Documentation Run',
    helper: 'Pick a prior run or template, preview output, then approve the run record.',
  },
  guide: {
    primary: 'Preview Guided Draft',
    helper: 'Start from a template, preview output, then refine with chat guidance.',
  },
  build: {
    primary: 'Preview Template Draft',
    helper: 'Start from template structure, preview quickly, then save for repeatable use.',
  },
  tweak: {
    primary: 'Preview Tweaked Output',
    helper: 'Pick a prior run, preview changes, then approve a new run record.',
  },
};

const LANE_CHAT_HINT: Record<Lane, string> = {
  run: 'Chat hint: "Run last week status extract with current data."',
  guide: 'Chat hint: "Guide me through creating this documentation run."',
  build: 'Chat hint: "Build this into a reusable HR documentation template."',
  tweak: 'Chat hint: "Tweak the filters and rerun this output."',
};

export default function ExtractsV2Modal({ userId, accessToken, initialLane = 'run', onCountChange, onClose }: ExtractsV2ModalProps) {
  const [loading, setLoading] = useState(true);
  const [lane, setLane] = useState<Lane>(initialLane);
  const [tab, setTab] = useState<UniverseTab>('recent_runs');
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateRecord | null>(null);
  const [previewOutput, setPreviewOutput] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionInfo, setActionInfo] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [approving, setApproving] = useState(false);
  const [copiedHint, setCopiedHint] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [runsRes, templatesRes] = await Promise.all([
        supabase
          .from('external_reference')
          .select('external_reference_id, title, description, filename, ref_type, created_at, document_template_id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('document_template')
          .select('document_template_id, name, doc_type, output_format')
          .or(`user_id.eq.${userId},is_system.eq.true`)
          .eq('is_active', true)
          .order('name')
          .limit(100),
      ]);

      if (runsRes.data) {
        setRuns(runsRes.data as RunRecord[]);
        onCountChange?.(runsRes.data.length);
      }
      if (templatesRes.data) setTemplates(templatesRes.data as TemplateRecord[]);
      setLoading(false);
    };

    load();
  }, [userId, onCountChange]);

  useEffect(() => {
    setLane(initialLane);
  }, [initialLane]);

  useEffect(() => {
    setTab(LANE_DEFAULT_TAB[lane]);
    setActionError('');
    setActionInfo('');
    setCopiedHint(false);
  }, [lane]);

  const handleCopyHint = async () => {
    const text = LANE_CHAT_HINT[lane];
    try {
      await navigator.clipboard.writeText(text.replace(/^Chat hint:\s*/i, ''));
      setCopiedHint(true);
      setTimeout(() => setCopiedHint(false), 1200);
    } catch {
      setActionError('Could not copy hint text.');
    }
  };

  const resolveTemplateId = () => {
    if (selectedTemplate?.document_template_id) return selectedTemplate.document_template_id;
    if (selectedRun?.document_template_id) return selectedRun.document_template_id;
    return null;
  };

  const resolveSourceTitle = () => selectedTemplate?.name ?? selectedRun?.title ?? 'Extract Run';

  const buildSummary = (output: string) => {
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const snippet = lines.slice(0, 3).join(' | ').slice(0, 420);
    const modeLabel = lane.toUpperCase();
    return `Approved ${modeLabel} run from "${resolveSourceTitle()}" on ${new Date().toLocaleString()}. Preview snippet: ${snippet || '(empty output)'}`;
  };

  const handleRunWithPreview = async () => {
    const templateId = resolveTemplateId();
    if (!templateId) {
      setActionError('Select a template or a prior run linked to a template.');
      return;
    }
    setActionError('');
    setActionInfo('');
    setRunLoading(true);
    try {
      const res = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          template_id: templateId,
          run_mode: 'preview_live',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Preview run failed');
      const output = String(data.output ?? '');
      setPreviewOutput(output);
      setSummaryDraft(buildSummary(output));
      setActionInfo('Preview generated. Review summary then approve to save run record.');
    } catch (err: any) {
      setActionError(err.message ?? 'Preview run failed');
    } finally {
      setRunLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!summaryDraft.trim()) {
      setActionError('Summary is required before approval.');
      return;
    }
    setApproving(true);
    setActionError('');
    setActionInfo('');
    const now = new Date();
    const dateSlug = now.toISOString().slice(0, 10);
    const sourceTitle = resolveSourceTitle();
    const sourceTemplateId = resolveTemplateId();
    try {
      const { error } = await supabase.from('external_reference').insert({
        user_id: userId,
        title: `${sourceTitle} · approved ${dateSlug}`,
        filename: `${sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${dateSlug}.md`,
        location: 'v2_approved',
        description: `v2 approved ${lane} run`,
        notes: summaryDraft.trim(),
        ref_type: 'generated',
        document_template_id: sourceTemplateId,
        run_data: JSON.stringify({
          approval_mode: 'manual',
          approved_at: now.toISOString(),
          lane,
          source_run_id: selectedRun?.external_reference_id ?? null,
          source_template_id: sourceTemplateId,
          preview_chars: previewOutput.length,
        }),
        output: null,
        output_encrypted: false,
        tags: [],
      });
      if (error) throw error;
      setActionInfo('Approved and saved run record.');
      setSummaryDraft('');
      await (async () => {
        const { data } = await supabase
          .from('external_reference')
          .select('external_reference_id, title, description, filename, ref_type, created_at, document_template_id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(100);
        if (data) {
          setRuns(data as RunRecord[]);
          onCountChange?.(data.length);
        }
      })();
    } catch (err: any) {
      setActionError(err.message ?? 'Approve failed');
    } finally {
      setApproving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((run) =>
      [run.title, run.filename ?? '', run.description ?? '', run.ref_type ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [runs, query]);

  const filteredTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((template) =>
      [template.name, template.doc_type ?? '', template.output_format ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [templates, query]);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        zIndex: 3000,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: '2rem',
          right: '2rem',
          top: '3.5rem',
          bottom: '2rem',
          background: '#0f0f0f',
          border: '1px solid #2a2a2a',
          borderRadius: '10px',
          color: '#e5e5e5',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.8rem 1rem', borderBottom: '1px solid #252525' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ color: '#8b5cf6', fontWeight: 700 }}>Extracts v2</span>
            <span style={{ color: '#666' }}>|</span>
            <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>parallel workflow track</span>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer', padding: '0.25rem 0.55rem' }}>
            close
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 2fr', height: '100%' }}>
          <div style={{ borderRight: '1px solid #252525', padding: '0.8rem', overflowY: 'auto' }}>
            <div style={{ color: '#888', fontSize: '0.7rem', marginBottom: '0.55rem' }}>What do you need to get done?</div>
            <div style={{ display: 'grid', gap: '0.45rem' }}>
              {(['run', 'guide', 'build', 'tweak'] as Lane[]).map((candidateLane) => (
                <button
                  key={candidateLane}
                  onClick={() => setLane(candidateLane)}
                  style={{
                    textAlign: 'left',
                    border: `1px solid ${lane === candidateLane ? '#6d28d9' : '#2f2f2f'}`,
                    background: lane === candidateLane ? '#1a1030' : '#131313',
                    color: lane === candidateLane ? '#c4b5fd' : '#d4d4d4',
                    borderRadius: '7px',
                    padding: '0.6rem',
                    fontFamily: 'monospace',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'capitalize' }}>{candidateLane}</div>
                  <div style={{ fontSize: '0.68rem', color: '#888', marginTop: '0.2rem' }}>{LANE_COPY[candidateLane].subtitle}</div>
                </button>
              ))}
            </div>

            <div style={{ marginTop: '1rem', borderTop: '1px solid #252525', paddingTop: '0.7rem' }}>
              <div style={{ color: '#888', fontSize: '0.7rem', marginBottom: '0.5rem' }}>My Universe</div>
              <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '0.5rem' }}>
                <button
                  onClick={() => setTab('recent_runs')}
                  style={{
                    border: '1px solid #2f2f2f',
                    background: tab === 'recent_runs' ? '#191919' : '#101010',
                    color: tab === 'recent_runs' ? '#fff' : '#aaa',
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    fontSize: '0.68rem',
                    padding: '0.2rem 0.45rem',
                    cursor: 'pointer',
                  }}
                >
                  run history ({runs.length})
                </button>
                <button
                  onClick={() => setTab('templates')}
                  style={{
                    border: '1px solid #2f2f2f',
                    background: tab === 'templates' ? '#191919' : '#101010',
                    color: tab === 'templates' ? '#fff' : '#aaa',
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    fontSize: '0.68rem',
                    padding: '0.2rem 0.45rem',
                    cursor: 'pointer',
                  }}
                >
                  templates ({templates.length})
                </button>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search runs or templates"
                style={{
                  width: '100%',
                  background: '#111',
                  color: '#ddd',
                  border: '1px solid #2a2a2a',
                  borderRadius: '5px',
                  padding: '0.35rem 0.45rem',
                  fontSize: '0.72rem',
                  fontFamily: 'monospace',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', overflow: 'hidden' }}>
            <div style={{ padding: '0.8rem 1rem', borderBottom: '1px solid #252525' }}>
              <div style={{ color: '#ddd', fontSize: '0.85rem', fontWeight: 700 }}>{LANE_COPY[lane].title}</div>
              <div style={{ color: '#888', fontSize: '0.72rem', marginTop: '0.2rem' }}>{LANE_COPY[lane].subtitle}</div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                <button style={primaryBtn} onClick={handleRunWithPreview} disabled={runLoading}>
                  {runLoading ? 'Running...' : LANE_ACTION_COPY[lane].primary}
                </button>
                <button style={ghostBtn} onClick={handleApprove} disabled={approving || !previewOutput}>
                  {approving ? 'Approving...' : 'Approve'}
                </button>
              </div>
              <div style={{ color: '#8f8f8f', fontSize: '0.68rem', marginTop: '0.45rem' }}>
                {LANE_ACTION_COPY[lane].helper}
              </div>
              {actionInfo && <div style={{ color: '#86efac', fontSize: '0.68rem', marginTop: '0.5rem' }}>{actionInfo}</div>}
              {actionError && <div style={{ color: '#fca5a5', fontSize: '0.68rem', marginTop: '0.5rem' }}>{actionError}</div>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', minHeight: 0 }}>
              <div style={{ borderRight: '1px solid #252525', overflowY: 'auto', padding: '0.75rem' }}>
                {loading && <div style={{ color: '#888', fontSize: '0.72rem' }}>Loading records...</div>}
                {!loading && tab === 'recent_runs' && (
                  <>
                    {filteredRuns.length === 0 && (
                      <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>No run history found.</div>
                    )}
                    {filteredRuns.map((run) => (
                      <button
                        key={run.external_reference_id}
                        onClick={() => setSelectedRun(run)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          background: selectedRun?.external_reference_id === run.external_reference_id ? '#171121' : '#111',
                          border: `1px solid ${selectedRun?.external_reference_id === run.external_reference_id ? '#4c1d95' : '#272727'}`,
                          color: '#ddd',
                          borderRadius: '6px',
                          fontFamily: 'monospace',
                          cursor: 'pointer',
                          padding: '0.55rem',
                          marginBottom: '0.4rem',
                        }}
                      >
                        <div style={{ fontSize: '0.74rem', fontWeight: 700 }}>{run.title}</div>
                        <div style={{ fontSize: '0.65rem', color: '#8f8f8f', marginTop: '0.2rem' }}>
                          {new Date(run.created_at).toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </>
                )}

                {!loading && tab === 'templates' && (
                  <>
                    {filteredTemplates.length === 0 && (
                      <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>No templates found.</div>
                    )}
                    {filteredTemplates.map((template) => (
                      <button
                        key={template.document_template_id}
                        onClick={() => setSelectedTemplate(template)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          background: selectedTemplate?.document_template_id === template.document_template_id ? '#102227' : '#111',
                          border: `1px solid ${selectedTemplate?.document_template_id === template.document_template_id ? '#0f766e' : '#272727'}`,
                          color: '#ddd',
                          borderRadius: '6px',
                          fontFamily: 'monospace',
                          cursor: 'pointer',
                          padding: '0.55rem',
                          marginBottom: '0.4rem',
                        }}
                      >
                        <div style={{ fontSize: '0.74rem', fontWeight: 700 }}>{template.name}</div>
                        <div style={{ fontSize: '0.65rem', color: '#8f8f8f', marginTop: '0.2rem' }}>
                          {template.doc_type ?? 'template'} • {template.output_format ?? 'md'}
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>

              <div style={{ overflowY: 'auto', padding: '0.8rem' }}>
                <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginBottom: '0.45rem' }}>Detail</div>
                {!selectedRun && !selectedTemplate && (
                  <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>
                    Select a run or template, then preview.
                  </div>
                )}
                {selectedRun && (
                  <div style={{ fontSize: '0.72rem', lineHeight: 1.55 }}>
                    <div><strong style={{ color: '#ddd' }}>Run:</strong> {selectedRun.title}</div>
                    <div><strong style={{ color: '#ddd' }}>Created:</strong> {new Date(selectedRun.created_at).toLocaleString()}</div>
                    <div><strong style={{ color: '#ddd' }}>Filename:</strong> {selectedRun.filename ?? '-'}</div>
                    <div><strong style={{ color: '#ddd' }}>Type:</strong> {selectedRun.ref_type ?? '-'}</div>
                    <div style={{ marginTop: '0.45rem', color: '#aaa' }}>{selectedRun.description ?? 'No description.'}</div>
                  </div>
                )}
                {selectedTemplate && (
                  <div style={{ fontSize: '0.72rem', lineHeight: 1.55 }}>
                    <div><strong style={{ color: '#ddd' }}>Template:</strong> {selectedTemplate.name}</div>
                    <div><strong style={{ color: '#ddd' }}>Doc Type:</strong> {selectedTemplate.doc_type ?? '-'}</div>
                    <div><strong style={{ color: '#ddd' }}>Output:</strong> {selectedTemplate.output_format ?? 'md'}</div>
                    <div style={{ marginTop: '0.45rem', color: '#aaa' }}>
                      v2 flow runs in parallel with legacy extracts while we tighten UX.
                    </div>
                  </div>
                )}
                {!!previewOutput && (
                  <>
                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginTop: '0.85rem', marginBottom: '0.45rem' }}>Preview</div>
                    <pre style={{ whiteSpace: 'pre-wrap', background: '#111', border: '1px solid #2a2a2a', borderRadius: '6px', padding: '0.55rem', color: '#ddd', fontSize: '0.68rem', maxHeight: '220px', overflowY: 'auto' }}>
                      {previewOutput}
                    </pre>
                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginTop: '0.75rem', marginBottom: '0.45rem' }}>Approval Summary</div>
                    <textarea
                      value={summaryDraft}
                      onChange={(e) => setSummaryDraft(e.target.value)}
                      rows={6}
                      style={{ width: '100%', background: '#111', border: '1px solid #2a2a2a', borderRadius: '6px', color: '#ddd', fontFamily: 'monospace', fontSize: '0.68rem', padding: '0.55rem', resize: 'vertical' }}
                    />
                  </>
                )}
                <div
                  style={{
                    marginTop: '0.8rem',
                    paddingTop: '0.65rem',
                    borderTop: '1px solid #252525',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.65rem',
                  }}
                >
                  <div style={{ color: '#7c7c7c', fontSize: '0.68rem' }}>{LANE_CHAT_HINT[lane]}</div>
                  <button
                    type="button"
                    onClick={handleCopyHint}
                    style={{
                      border: '1px solid #303030',
                      background: copiedHint ? '#16241a' : '#121212',
                      color: copiedHint ? '#86efac' : '#c9c9c9',
                      borderRadius: '5px',
                      fontFamily: 'monospace',
                      fontSize: '0.66rem',
                      padding: '0.2rem 0.42rem',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    title="Copy chat hint"
                  >
                    {copiedHint ? 'copied' : 'copy hint'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  border: '1px solid #6d28d9',
  background: '#2e1065',
  color: '#ddd6fe',
  borderRadius: '5px',
  fontFamily: 'monospace',
  fontSize: '0.72rem',
  padding: '0.28rem 0.55rem',
  cursor: 'pointer',
};

const ghostBtn: React.CSSProperties = {
  border: '1px solid #303030',
  background: '#121212',
  color: '#d4d4d4',
  borderRadius: '5px',
  fontFamily: 'monospace',
  fontSize: '0.72rem',
  padding: '0.28rem 0.55rem',
  cursor: 'pointer',
};

