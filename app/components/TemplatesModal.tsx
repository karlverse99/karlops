'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import KarlSpinner from './KarlSpinner';

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Template {
  document_template_id: string;
  name: string;
  description: string | null;
  doc_type: string | null;
  prompt_template: string;
  data_sources: DataSources;
  output_format: string;
  tags: string[];
  is_system: boolean;
  is_active: boolean;
  implementation_type: string | null;
  context_id: string | null;
  created_at: string;
}

interface DataSources {
  situation?: boolean;
  tasks?: { buckets: string[]; context: string | null; tags: string[] } | false;
  completions?: { window_days: number; context: string | null; tags: string[] } | false;
  meetings?: { window_days: number; completed_only: boolean } | false;
  references?: boolean;
}

interface AssistMessage { role: 'user' | 'assistant'; content: string; }

interface ConceptEntry {
  concept_key: string;
  concept_type: string;
  label: string;
  icon: string | null;
  description: string | null;
  display_order: number;
}

interface TemplatesModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange?: (count: number) => void;
  onOpenExtracts?: (templateId: string) => void; // ← NEW: opens ExtractsModal filtered to this template
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

const BUCKET_KEYS_FALLBACK = ['now', 'soon', 'realwork', 'later', 'delegate', 'capture'];

const DEFAULT_DS: DataSources = {
  situation:   true,
  tasks:       { buckets: ['now', 'soon', 'realwork'], context: null, tags: [] },
  completions: { window_days: 30, context: null, tags: [] },
  meetings:    { window_days: 30, completed_only: true },
  references:  false,
};

// ─── CONCEPT REGISTRY HELPERS ─────────────────────────────────────────────────

function getBucketIcon(concepts: ConceptEntry[], bucketKey: string): string {
  const found = concepts.find(c => c.concept_type === 'bucket' && c.concept_key === `bucket_${bucketKey}`);
  return found?.icon ?? '';
}

function getBucketLabel(concepts: ConceptEntry[], bucketKey: string): string {
  const found = concepts.find(c => c.concept_type === 'bucket' && c.concept_key === `bucket_${bucketKey}`);
  return found?.label ?? bucketKey;
}

function getObjectIcon(concepts: ConceptEntry[], key: string): string {
  const found = concepts.find(c => c.concept_type === 'object' && c.concept_key === key);
  return found?.icon ?? '';
}

function getObjectLabel(concepts: ConceptEntry[], key: string): string {
  const found = concepts.find(c => c.concept_type === 'object' && c.concept_key === key);
  return found?.label ?? key;
}

// ─── DATA SOURCES EDITOR ──────────────────────────────────────────────────────

function DataSourcesEditor({
  ds,
  onChange,
  concepts,
}: {
  ds: DataSources;
  onChange: (ds: DataSources) => void;
  concepts: ConceptEntry[];
}) {
  const hasTasks       = !!ds.tasks;
  const hasCompletions = !!ds.completions;
  const hasMeetings    = !!ds.meetings;

  const bucketOpts = concepts.filter(c => c.concept_type === 'bucket').map(c => ({
    key:   c.concept_key.replace('bucket_', ''),
    label: c.label,
    icon:  c.icon ?? '',
  }));
  if (!bucketOpts.length) {
    BUCKET_KEYS_FALLBACK.forEach(k => bucketOpts.push({ key: k, label: k, icon: '' }));
  }

  const toggle = (key: keyof DataSources, defaultVal: any) => {
    const next = { ...ds };
    if (next[key]) { (next as any)[key] = false; }
    else           { (next as any)[key] = defaultVal; }
    onChange(next);
  };

  const row = (label: string, active: boolean, onToggle: () => void, children?: React.ReactNode) => (
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: active && children ? '0.35rem' : 0 }}>
        <div onClick={onToggle} style={{ width: 14, height: 14, border: `1px solid ${active ? ACCENT : '#444'}`, borderRadius: 3, background: active ? ACCENT : 'transparent', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {active && <span style={{ color: '#000', fontSize: 9, fontWeight: 700 }}>✓</span>}
        </div>
        <span style={{ color: active ? '#111' : '#888', fontSize: '0.75rem' }}>{label}</span>
      </div>
      {active && children && (
        <div style={{ marginLeft: '1.5rem', padding: '0.4rem 0.6rem', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 4 }}>
          {children}
        </div>
      )}
    </div>
  );

  const completionLabel = getObjectLabel(concepts, 'completion') || 'Completions';
  const meetingLabel    = getObjectLabel(concepts, 'meeting')    || 'Meetings';
  const completionIcon  = getObjectIcon(concepts, 'completion');
  const meetingIcon     = getObjectIcon(concepts, 'meeting');
  const situationIcon   = '📋';

  return (
    <div>
      {row(`${situationIcon} Situation brief`, !!ds.situation, () => toggle('situation', true))}

      {row('✅ Tasks', hasTasks, () => toggle('tasks', { buckets: ['now', 'soon', 'realwork'], context: null, tags: [] }),
        hasTasks && typeof ds.tasks === 'object' ? (
          <div>
            <div style={{ color: '#666', fontSize: '0.62rem', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Buckets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {bucketOpts.map(b => {
                const active = (ds.tasks as any).buckets?.includes(b.key);
                return (
                  <button key={b.key} onClick={() => {
                    const cur  = (ds.tasks as any).buckets ?? [];
                    const next = active ? cur.filter((x: string) => x !== b.key) : [...cur, b.key];
                    onChange({ ...ds, tasks: { ...(ds.tasks as any), buckets: next } });
                  }} style={{ background: active ? ACCENT_BG : 'transparent', border: `1px solid ${active ? ACCENT : '#333'}`, color: active ? ACCENT : '#555', padding: '0.12rem 0.4rem', borderRadius: 3, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                    {b.icon} {b.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null
      )}

      {row(`${completionIcon} ${completionLabel}`, hasCompletions, () => toggle('completions', { window_days: 30, context: null, tags: [] }),
        hasCompletions && typeof ds.completions === 'object' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#666', fontSize: '0.65rem' }}>Last</span>
            <input type="number" min={1} max={365} value={(ds.completions as any).window_days}
              onChange={e => onChange({ ...ds, completions: { ...(ds.completions as any), window_days: parseInt(e.target.value) || 30 } })}
              style={{ width: 50, background: '#f5f5f5', border: '1px solid #ddd', color: '#222', padding: '0.2rem 0.4rem', borderRadius: 3, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none' }} />
            <span style={{ color: '#666', fontSize: '0.65rem' }}>days</span>
          </div>
        ) : null
      )}

      {row(`${meetingIcon} ${meetingLabel}`, hasMeetings, () => toggle('meetings', { window_days: 30, completed_only: true }),
        hasMeetings && typeof ds.meetings === 'object' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#666', fontSize: '0.65rem' }}>Last</span>
            <input type="number" min={1} max={365} value={(ds.meetings as any).window_days}
              onChange={e => onChange({ ...ds, meetings: { ...(ds.meetings as any), window_days: parseInt(e.target.value) || 30 } })}
              style={{ width: 50, background: '#f5f5f5', border: '1px solid #ddd', color: '#222', padding: '0.2rem 0.4rem', borderRadius: 3, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none' }} />
            <span style={{ color: '#666', fontSize: '0.65rem' }}>days</span>
          </div>
        ) : null
      )}

      {row('🔗 References', !!ds.references, () => toggle('references', true))}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function TemplatesModal({ userId, accessToken, onClose, onCountChange, onOpenExtracts }: TemplatesModalProps) {

  // ── State ──────────────────────────────────────────────────────────────────
  const [templates, setTemplates]   = useState<Template[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState<Template | null>(null);
  const [isNew, setIsNew]           = useState(false);
  const [search, setSearch]         = useState('');
  const [filterType, setFilterType] = useState<'all' | 'system' | 'mine'>('all');

  const [concepts, setConcepts] = useState<ConceptEntry[]>([]);

  // ← NEW: extract counts per template
  const [extractCounts, setExtractCounts] = useState<Record<string, number>>({});

  // Edit state
  const [editName, setEditName]           = useState('');
  const [editDesc, setEditDesc]           = useState('');
  const [editDocType, setEditDocType]     = useState('');
  const [editFormat, setEditFormat]       = useState('markdown');
  const [editDs, setEditDs]               = useState<DataSources>(DEFAULT_DS);
  const [editInstructions, setEditInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [saving, setSaving]               = useState(false);
  const [saveErr, setSaveErr]             = useState('');

  // Run/preview state
  const [running, setRunning]           = useState(false);
  const [runOutput, setRunOutput]       = useState<string | null>(null);
  const [runErr, setRunErr]             = useState('');
  const [copied, setCopied]             = useState(false);
  const [savePrompt, setSavePrompt]     = useState(false);
  const [savingToRefs, setSavingToRefs] = useState(false);
  const [savedToRefs, setSavedToRefs]   = useState(false);

  // Assist state
  const [assistInput, setAssistInput]     = useState('');
  const [assistHistory, setAssistHistory] = useState<AssistMessage[]>([]);
  const [assistLoading, setAssistLoading] = useState(false);

  // Modal drag/resize
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 550));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 390));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 1100, h: 780 });

  const [leftW, setLeftW]     = useState(300);
  const leftDragging          = useRef(false);
  const leftDragStart         = useRef({ mx: 0, w: 0 });
  const dragging              = useRef(false);
  const resizing              = useRef(false);
  const dragStart             = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const resizeStart           = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const assistBottomRef       = useRef<HTMLDivElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadTemplates();
    loadConceptRegistry();
    loadExtractCounts(); // ← NEW
  }, []);

  useEffect(() => {
    assistBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [assistHistory, assistLoading]);

  const loadTemplates = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('document_template')
      .select('*')
      .or(`user_id.eq.${userId},is_system.eq.true`)
      .eq('is_active', true)
      .order('is_system', { ascending: false })
      .order('name');
    if (data) { setTemplates(data as Template[]); onCountChange?.(data.length); }
    setLoading(false);
  };

  const loadConceptRegistry = async () => {
    try {
      const { data: koUser } = await supabase
        .from('ko_user')
        .select('implementation_type')
        .eq('id', userId)
        .maybeSingle();
      const implType = koUser?.implementation_type ?? 'personal';
      const { data } = await supabase
        .from('concept_registry')
        .select('concept_key, concept_type, label, icon, description, display_order')
        .eq('implementation_type', implType)
        .eq('is_active', true)
        .order('concept_type')
        .order('display_order');
      if (data) setConcepts(data as ConceptEntry[]);
    } catch (err) {
      console.error('[TemplatesModal] concept registry load failed:', err);
    }
  };

  // ← NEW: load how many extracts each template has generated
  const loadExtractCounts = async () => {
    try {
      const { data } = await supabase
        .from('external_reference')
        .select('document_template_id')
        .eq('user_id', userId)
        .not('document_template_id', 'is', null);
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        if (row.document_template_id) {
          counts[row.document_template_id] = (counts[row.document_template_id] ?? 0) + 1;
        }
      }
      setExtractCounts(counts);
    } catch (err) {
      console.error('[TemplatesModal] extract counts load failed:', err);
    }
  };

  // ── Drag / Resize ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.x), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.y) });
      }
      if (resizing.current) {
        setSize({ w: Math.max(800, resizeStart.current.w + e.clientX - resizeStart.current.x), h: Math.max(500, resizeStart.current.h + e.clientY - resizeStart.current.y) });
      }
      if (leftDragging.current) {
        const newW = Math.max(200, Math.min(500, leftDragStart.current.w + e.clientX - leftDragStart.current.mx));
        setLeftW(newW);
      }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; leftDragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const selectTemplate = (t: Template) => {
    setSelected(t); setIsNew(false);
    setEditName(t.name); setEditDesc(t.description ?? ''); setEditDocType(t.doc_type ?? '');
    setEditFormat(t.output_format ?? 'markdown'); setEditDs(t.data_sources ?? DEFAULT_DS);
    setEditInstructions(t.prompt_template ?? '');
    setShowInstructions(!!t.prompt_template);
    setRunOutput(null); setRunErr(''); setSaveErr(''); setAssistHistory([]);
    setSavePrompt(false); setSavedToRefs(false);
  };

  const startNew = () => {
    setSelected(null); setIsNew(true);
    setEditName(''); setEditDesc(''); setEditDocType(''); setEditFormat('markdown');
    setEditDs(DEFAULT_DS); setEditInstructions(''); setShowInstructions(false);
    setRunOutput(null); setRunErr(''); setSaveErr(''); setAssistHistory([]);
    setSavePrompt(false); setSavedToRefs(false);
  };

  const handleSave = async () => {
    if (!editName.trim()) { setSaveErr('Name is required'); return; }
    setSaving(true); setSaveErr('');
    try {
      if (isNew) {
        const { error } = await supabase.from('document_template').insert({
          user_id:         userId,
          name:            editName.trim(),
          description:     editDesc.trim() || null,
          doc_type:        editDocType.trim() || null,
          output_format:   editFormat,
          data_sources:    editDs,
          prompt_template: editInstructions.trim() || '',
          is_system:       false,
          is_active:       true,
        });
        if (error) throw error;
      } else if (selected && !selected.is_system) {
        const { error } = await supabase.from('document_template').update({
          name:            editName.trim(),
          description:     editDesc.trim() || null,
          doc_type:        editDocType.trim() || null,
          output_format:   editFormat,
          data_sources:    editDs,
          prompt_template: editInstructions.trim() || '',
          updated_at:      new Date().toISOString(),
        }).eq('document_template_id', selected.document_template_id);
        if (error) throw error;
      }
      await loadTemplates(); setIsNew(false);
    } catch (err: any) { setSaveErr(err.message ?? 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || selected.is_system) return;
    if (!confirm(`Delete "${selected.name}"? This cannot be undone.`)) return;
    await supabase.from('document_template').update({ is_active: false }).eq('document_template_id', selected.document_template_id);
    setSelected(null); setIsNew(false);
    await loadTemplates();
  };

  const handleRun = async () => {
    const templateId = selected?.document_template_id;
    if (!templateId) return;
    setRunning(true); setRunOutput(null); setRunErr('');
    setSavePrompt(false); setSavedToRefs(false);
    try {
      const res  = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ template_id: templateId, override_instructions: editInstructions.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Run failed');
      setRunOutput(data.output);
    } catch (err: any) { setRunErr(err.message ?? 'Run failed'); }
    finally { setRunning(false); }
  };

  const handleSaveToRefs = async () => {
    if (!runOutput || !selected) return;
    setSavingToRefs(true);
    try {
      const dateStr  = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const fileName = `${editName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.md`;
      const { error } = await supabase.from('external_reference').insert({
        user_id:              userId,
        title:                `${editName} — ${dateStr}`,
        description:          editDesc || null,
        filename:             fileName,
        location:             'generated',
        notes:                runOutput,
        context_id:           selected.context_id || null,
        document_template_id: selected.document_template_id,
        ref_type:             'generated',
        tags:                 [],
      });
      if (error) throw error;
      setSavedToRefs(true); setSavePrompt(false);
      // refresh extract counts so the badge updates immediately
      loadExtractCounts();
    } catch (err: any) { setRunErr(err.message ?? 'Save failed'); setSavePrompt(false); }
    finally { setSavingToRefs(false); }
  };

  const handleCopy = async () => {
    if (!runOutput) return;
    await navigator.clipboard.writeText(runOutput);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadMd = () => {
    if (!runOutput) return;
    const blob = new Blob([runOutput], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${editName || 'document'}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleAssist = async () => {
    const msg = assistInput.trim();
    if (!msg || assistLoading) return;
    setAssistInput(''); setAssistLoading(true);
    setAssistHistory(h => [...h, { role: 'user', content: msg }]);
    try {
      const res  = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({
          message:              msg,
          history:              assistHistory.map(m => ({ role: m.role, content: m.content })),
          current_instructions: editInstructions,
          current_data_sources: editDs,
        }),
      });
      const data = await res.json();
      setAssistHistory(h => [...h, { role: 'assistant', content: data.response ?? '' }]);
      if (data.suggested_instructions) { setEditInstructions(data.suggested_instructions); setShowInstructions(true); }
      if (data.suggested_data_sources) setEditDs(data.suggested_data_sources);
    } catch {
      setAssistHistory(h => [...h, { role: 'assistant', content: 'Something went wrong. Try again.' }]);
    } finally { setAssistLoading(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = templates.filter(t => {
    const matchS = !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? '').toLowerCase().includes(search.toLowerCase());
    const matchT = filterType === 'all' ? true : filterType === 'system' ? t.is_system : !t.is_system;
    return matchS && matchT;
  });

  const isEditing = isNew || !!selected;
  const isSystem  = selected?.is_system ?? false;

  const templateIcon    = getObjectIcon(concepts, 'document_template') || '📄';
  const completionVocab = getObjectLabel(concepts, 'completion') || 'completions';
  const contextVocab    = concepts.find(c => c.concept_key === 'context')?.label || 'context';
  const assistPlaceholder = assistHistory.length > 0
    ? 'Refine further...'
    : `e.g. "A weekly status showing ${completionVocab} by ${contextVocab} with key wins"`;

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: 8, display: 'flex', flexDirection: 'column', fontFamily: 'monospace', overflow: 'hidden', pointerEvents: 'all', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

        {/* HEADER */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>
              {templateIcon} {getObjectLabel(concepts, 'document_template') || 'Templates'}
            </span>
            <span style={{ color: '#000', fontSize: '0.7rem', opacity: 0.5 }}>TM · {templates.length} template{templates.length !== 1 ? 's' : ''}</span>
          </div>
          <button onMouseDown={e => e.stopPropagation()} onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6, lineHeight: 1 }}>✕</button>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* LEFT PANEL */}
          <div style={{ width: leftW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..."
                style={{ width: '100%', background: '#fafafa', border: '1px solid #e5e7eb', color: '#222', padding: '0.4rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none', boxSizing: 'border-box', marginBottom: '0.5rem' }} />
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                {(['all', 'system', 'mine'] as const).map(f => (
                  <button key={f} onClick={() => setFilterType(f)}
                    style={{ background: filterType === f ? ACCENT_BG : 'transparent', border: `1px solid ${filterType === f ? ACCENT : '#333'}`, color: filterType === f ? ACCENT : '#666', padding: '0.2rem 0.5rem', borderRadius: 3, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>{f}</button>
                ))}
              </div>
            </div>

            <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
              <button onClick={startNew}
                style={{ width: '100%', background: isNew ? ACCENT_BG : 'transparent', border: `1px solid ${isNew ? ACCENT : '#333'}`, color: isNew ? ACCENT : '#888', padding: '0.4rem', borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                + new template
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
              {loading
                ? <div style={{ padding: '1rem', color: '#666', fontSize: '0.75rem' }}>Loading...</div>
                : filtered.length === 0
                  ? <div style={{ padding: '1rem', color: '#888', fontSize: '0.75rem' }}>No templates found</div>
                  : filtered.map((t, idx) => {
                      const isActive   = selected?.document_template_id === t.document_template_id;
                      const runCount   = extractCounts[t.document_template_id] ?? 0; // ← NEW
                      return (
                        <div key={t.document_template_id} onClick={() => selectTemplate(t)}
                          style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', background: isActive ? ACCENT_BG : 'transparent', borderLeft: isActive ? `2px solid ${ACCENT}` : '2px solid transparent', transition: 'background 0.1s' }}
                          onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f5f5f5'; }}
                          onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                            <span style={{ color: ACCENT, fontSize: '0.6rem', opacity: 0.5, fontWeight: 600 }}>TM{idx + 1}</span>
                            <span style={{ fontSize: '0.75rem' }}>{templateIcon}</span>
                            <span style={{ color: '#222', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                            {/* ← NEW: extract run count badge */}
                            {runCount > 0 && (
                              <span style={{ fontSize: '0.58rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', padding: '0.02rem 0.3rem', borderRadius: 2, flexShrink: 0 }}>
                                {runCount} run{runCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                            {t.is_system && <span style={{ fontSize: '0.6rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, padding: '0.05rem 0.3rem', borderRadius: 2 }}>system</span>}
                            {t.implementation_type && <span style={{ fontSize: '0.6rem', color: '#8b5cf6', background: '#120a1a', border: '1px solid #3a1a5a', padding: '0.05rem 0.3rem', borderRadius: 2 }}>{t.implementation_type}</span>}
                            {t.doc_type && <span style={{ fontSize: '0.6rem', color: '#666', background: '#e5e5e5', border: '1px solid #e5e7eb', padding: '0.05rem 0.3rem', borderRadius: 2 }}>{t.doc_type}</span>}
                            {t.data_sources?.completions && <span style={{ fontSize: '0.65rem' }} title={`${completionVocab}`}>{getObjectIcon(concepts, 'completion')}</span>}
                            {t.data_sources?.meetings    && <span style={{ fontSize: '0.65rem' }} title="meetings">{getObjectIcon(concepts, 'meeting')}</span>}
                            {t.data_sources?.tasks       && <span style={{ fontSize: '0.65rem' }} title="tasks">✅</span>}
                          </div>
                        </div>
                      );
                    })
              }
            </div>
          </div>

          {/* RESIZABLE DIVIDER */}
          <div
            onMouseDown={e => { leftDragging.current = true; leftDragStart.current = { mx: e.clientX, w: leftW }; }}
            style={{ width: 5, flexShrink: 0, background: '#e5e5e5', cursor: 'col-resize', transition: 'background 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BORDER)}
            onMouseLeave={e => (e.currentTarget.style.background = '#e5e7eb')}
          />

          {/* RIGHT PANEL */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

            {/* Empty state */}
            {!isEditing && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '0.8rem', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ opacity: 0.3, fontSize: '1.5rem' }}>{templateIcon}</div>
                <div>Select a template or create a new one</div>
                {concepts.length > 0 && (
                  <div style={{ display: 'flex', gap: '0.5rem', opacity: 0.4, fontSize: '0.65rem' }}>
                    {concepts.filter(c => c.concept_type === 'bucket').slice(0, 4).map(c => (
                      <span key={c.concept_key}>{c.icon} {c.label}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Edit panel */}
            {isEditing && !runOutput && !running && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>

                  {isSystem && (
                    <div style={{ padding: '0.4rem 0.7rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, color: '#92400e', fontSize: '0.7rem', marginBottom: '1rem' }}>
                      System template — read only. Duplicate to customize.
                    </div>
                  )}

                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Name {!isSystem && <span style={{ color: '#ef4444' }}>*</span>}</div>
                    <input value={editName} onChange={e => setEditName(e.target.value)} disabled={isSystem}
                      style={inputSt(isSystem)} placeholder="Weekly Status Report" />
                  </div>

                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Description</div>
                    <input value={editDesc} onChange={e => setEditDesc(e.target.value)} disabled={isSystem}
                      style={inputSt(isSystem)} placeholder="What this template produces..." />
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <div style={{ flex: 1 }}>
                      <div style={labelSt}>Category</div>
                      <input value={editDocType} onChange={e => setEditDocType(e.target.value)} disabled={isSystem}
                        style={inputSt(isSystem)} placeholder="report / debrief / pip..." />
                    </div>
                    <div style={{ width: 140 }}>
                      <div style={labelSt}>Output Format</div>
                      <select value={editFormat} onChange={e => setEditFormat(e.target.value)} disabled={isSystem}
                        style={{ ...inputSt(isSystem), cursor: isSystem ? 'not-allowed' : 'pointer' } as any}>
                        <option value="markdown">Markdown</option>
                        <option value="docx">Word (.docx)</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Data Sources</div>
                    <div style={{ padding: '0.75rem', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 4 }}>
                      {isSystem
                        ? <div style={{ color: '#888', fontSize: '0.7rem', whiteSpace: 'pre-wrap' }}>{JSON.stringify(editDs, null, 2)}</div>
                        : <DataSourcesEditor ds={editDs} onChange={setEditDs} concepts={concepts} />
                      }
                    </div>
                  </div>

                  {!isSystem && (
                    <div style={{ border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, overflow: 'hidden', marginBottom: '0.75rem' }}>
                      <div style={{ padding: '0.5rem 0.75rem', background: ACCENT_BG, borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: ACCENT, fontSize: '0.68rem', fontWeight: 700 }}>KARL ASSIST</span>
                        <span style={{ color: '#2d6e65', fontSize: '0.65rem' }}>— describe what you want, Karl drafts the generation instructions</span>
                        {concepts.length > 0 && (
                          <span style={{ marginLeft: 'auto', color: '#2d6e65', fontSize: '0.6rem', opacity: 0.7 }}>
                            {concepts.filter(c => c.concept_type === 'bucket').slice(0, 3).map(c => `${c.icon} ${c.label}`).join(' · ')}
                          </span>
                        )}
                      </div>

                      {assistHistory.length === 0 && !editInstructions && (
                        <div style={{ padding: '0.75rem', background: '#f0fdfa' }}>
                          <div style={{ color: '#888', fontSize: '0.72rem', lineHeight: 1.5 }}>
                            Tell Karl what you want this template to produce. For example:<br />
                            <span style={{ color: '#666', fontStyle: 'italic' }}>"{assistPlaceholder}"</span>
                          </div>
                        </div>
                      )}

                      {assistHistory.length > 0 && (
                        <div style={{ maxHeight: 200, overflowY: 'auto', padding: '0.6rem 0.75rem', background: '#f5f5f5', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                          {assistHistory.map((m, i) => (
                            <div key={i} style={{ marginBottom: '0.5rem', fontSize: '0.75rem', color: m.role === 'user' ? '#0f766e' : '#374151', paddingLeft: m.role === 'user' ? '0.5rem' : 0, borderLeft: m.role === 'user' ? '2px solid #99f6e4' : 'none', lineHeight: 1.5 }}>
                              {m.content}
                            </div>
                          ))}
                          {assistLoading && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0' }}>
                              <KarlSpinner size="sm" color={ACCENT} />
                              <span style={{ color: '#666', fontSize: '0.72rem' }}>Karl is thinking...</span>
                            </div>
                          )}
                          <div ref={assistBottomRef} />
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 0.75rem', background: '#fafafa' }}>
                        <textarea
                          value={assistInput}
                          onChange={e => setAssistInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAssist(); } }}
                          placeholder={assistPlaceholder}
                          rows={2}
                          style={{ flex: 1, background: '#fafafa', border: '1px solid #e5e7eb', color: '#222', padding: '0.35rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.72rem', outline: 'none', resize: 'vertical', minHeight: 36 }}
                          onFocus={e => (e.target.style.borderColor = ACCENT)}
                          onBlur={e => (e.target.style.borderColor = '#ddd')}
                        />
                        <button onClick={handleAssist} disabled={!assistInput.trim() || assistLoading}
                          style={{ background: assistInput.trim() ? ACCENT_BG : 'transparent', border: `1px solid ${assistInput.trim() ? ACCENT : '#333'}`, color: assistInput.trim() ? ACCENT : '#555', padding: '0.35rem 0.65rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: assistInput.trim() ? 'pointer' : 'not-allowed', alignSelf: 'flex-end' }}>
                          ask
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ marginBottom: '0.5rem' }}>
                    <div
                      onClick={() => setShowInstructions(v => !v)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: showInstructions ? '0.5rem' : 0 }}
                    >
                      <span style={{ color: showInstructions ? ACCENT : '#444', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                        {showInstructions ? '▾' : '▸'} Generation Instructions {!isSystem && <span style={{ color: '#555', textTransform: 'none', fontWeight: 400, letterSpacing: 0 }}>(Karl-authored — edit carefully)</span>}
                      </span>
                      {editInstructions && !showInstructions && (
                        <span style={{ fontSize: '0.62rem', color: '#2d6e65', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 3, padding: '0.05rem 0.3rem' }}>✓ drafted</span>
                      )}
                      {!editInstructions && !showInstructions && (
                        <span style={{ fontSize: '0.62rem', color: '#888' }}>use Karl Assist above to build</span>
                      )}
                    </div>

                    {showInstructions && (
                      <textarea
                        value={editInstructions}
                        onChange={e => setEditInstructions(e.target.value)}
                        disabled={isSystem}
                        rows={8}
                        placeholder="Use Karl Assist above to draft these instructions, or write them manually..."
                        style={{ ...inputSt(isSystem), resize: 'vertical', minHeight: 160, lineHeight: 1.5 } as any}
                      />
                    )}
                  </div>

                </div>

                {/* Footer */}
                <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  {saveErr && <span style={{ color: '#ef4444', fontSize: '0.7rem', flex: 1 }}>{saveErr}</span>}
                  {!saveErr && <span style={{ flex: 1 }} />}

                  {!isSystem && selected && (
                    <button onClick={handleDelete}
                      style={{ background: 'transparent', border: '1px solid #3a1a1a', color: '#ef4444', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                      delete
                    </button>
                  )}

                  {!isSystem && (
                    <button onClick={handleSave} disabled={saving}
                      style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.35rem 0.9rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                      {saving ? 'saving...' : 'save'}
                    </button>
                  )}

                  {/* ← NEW: view extracts button — only shows when template has runs and onOpenExtracts is wired */}
                  {selected && (extractCounts[selected.document_template_id] ?? 0) > 0 && onOpenExtracts && (
                    <button
                      onClick={() => { onOpenExtracts(selected.document_template_id); onClose(); }}
                      style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {extractCounts[selected.document_template_id]} extract{extractCounts[selected.document_template_id] !== 1 ? 's' : ''} →
                    </button>
                  )}

                  {selected && (
                    <button onClick={handleRun}
                      style={{ background: ACCENT, border: 'none', color: '#000', padding: '0.35rem 1rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>
                      ▶ preview
                    </button>
                  )}
                </div>
              </div>
            )}

            {running && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
                <KarlSpinner size="lg" color={ACCENT} />
                <div style={{ color: '#666', fontSize: '0.8rem' }}>Karl is generating your document...</div>
                <div style={{ color: '#555', fontSize: '0.7rem' }}>This is a test run — nothing is saved yet</div>
              </div>
            )}

            {runOutput && !running && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  <span style={{ color: ACCENT, fontSize: '0.7rem', fontWeight: 600 }}>{templateIcon} PREVIEW</span>
                  <span style={{ color: '#555', fontSize: '0.65rem' }}>· test run · nothing saved</span>
                  <span style={{ flex: 1 }} />
                  <button onClick={handleCopy}
                    style={{ background: copied ? ACCENT_BG : 'transparent', border: `1px solid ${copied ? ACCENT : '#333'}`, color: copied ? ACCENT : '#666', padding: '0.25rem 0.6rem', borderRadius: 3, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                    {copied ? '✓ copied' : 'copy'}
                  </button>
                  <button onClick={handleDownloadMd}
                    style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.25rem 0.6rem', borderRadius: 3, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                    ↓ .md
                  </button>
                  <button onClick={() => { setRunOutput(null); setRunErr(''); setSavePrompt(false); }}
                    style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.25rem 0.6rem', borderRadius: 3, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                    ← back
                  </button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                  <pre style={{ color: '#555', fontSize: '0.8rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'monospace', margin: 0 }}>{runOutput}</pre>
                </div>

                <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', flexShrink: 0 }}>
                  {!savePrompt && !savedToRefs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#888', fontSize: '0.72rem' }}>Happy with this?</div>
                        <div style={{ color: '#888', fontSize: '0.65rem', marginTop: '0.1rem' }}>Save to your {getObjectLabel(concepts, 'external_reference') || 'Extracts'} so you can rerun it anytime — or just copy and go.</div>
                      </div>
                      <button onClick={handleRun} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer' }}>▶ preview again</button>
                      <button onClick={() => setSavePrompt(true)} style={{ background: ACCENT, border: 'none', color: '#000', padding: '0.35rem 1rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>Save & Track</button>
                    </div>
                  )}
                  {savePrompt && !savedToRefs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#222', fontSize: '0.72rem' }}>Save this to your {getObjectLabel(concepts, 'external_reference') || 'Extracts'}?</div>
                        <div style={{ color: '#666', fontSize: '0.65rem', marginTop: '0.1rem' }}>We'll keep a copy so you can rerun it anytime.</div>
                      </div>
                      <button onClick={() => setSavePrompt(false)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer' }}>no thanks</button>
                      <button onClick={handleSaveToRefs} disabled={savingToRefs} style={{ background: ACCENT, border: 'none', color: '#000', padding: '0.35rem 1rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>{savingToRefs ? 'saving...' : 'yes, save it'}</button>
                    </div>
                  )}
                  {savedToRefs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span style={{ color: ACCENT, fontSize: '0.72rem' }}>✓ Saved to {getObjectLabel(concepts, 'external_reference') || 'Extracts'}.</span>
                      <span style={{ color: '#888', fontSize: '0.65rem' }}>Find it anytime — or rerun it from there.</span>
                      <span style={{ flex: 1 }} />
                      <button onClick={handleRun} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer' }}>▶ preview again</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {runErr && !running && (
              <div style={{ padding: '1rem', color: '#ef4444', fontSize: '0.75rem' }}>
                Error: {runErr}
                <button onClick={() => setRunErr('')} style={{ marginLeft: '1rem', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '0.7rem' }}>dismiss</button>
              </div>
            )}

          </div>
        </div>

        <div
          onMouseDown={e => { resizing.current = true; resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }; }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: 16, height: 16, cursor: 'nwse-resize' }}
        />

      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const labelSt: React.CSSProperties = {
  color: '#666', fontSize: '0.65rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.3rem',
};

const inputSt = (disabled: boolean): React.CSSProperties => ({
  width: '100%', background: disabled ? '#f5f5f5' : '#fafafa', border: '1px solid #ddd',
  color: disabled ? '#aaa' : '#222', padding: '0.45rem 0.6rem', borderRadius: 4,
  fontFamily: 'monospace', fontSize: '0.8rem', outline: 'none',
  boxSizing: 'border-box', cursor: disabled ? 'not-allowed' : 'text',
});
