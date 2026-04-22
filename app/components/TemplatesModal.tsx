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
  output_format: string;
  tags: string[];
  is_system: boolean;
  is_active: boolean;
  implementation_type: string | null;
  context_id: string | null;
  created_at: string;
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
  onOpenExtracts?: (templateId: string) => void;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getObjectIcon(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.icon ?? '';
}

function getObjectLabel(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.label ?? key;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function TemplatesModal({ userId, accessToken, onClose, onCountChange, onOpenExtracts }: TemplatesModalProps) {

  // ── State ──────────────────────────────────────────────────────────────────
  const [templates, setTemplates]     = useState<Template[]>([]);
  const [loading, setLoading]         = useState(true);
  const [selected, setSelected]       = useState<Template | null>(null);
  const [isNew, setIsNew]             = useState(false);
  const [search, setSearch]           = useState('');
  const [concepts, setConcepts]       = useState<ConceptEntry[]>([]);
  const [extractCounts, setExtractCounts] = useState<Record<string, number>>({});
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Edit state
  const [editName, setEditName]                 = useState('');
  const [editDesc, setEditDesc]                 = useState('');
  const [editFormat, setEditFormat]             = useState('md');
  const [editInstructions, setEditInstructions] = useState('');
  const [saving, setSaving]                     = useState(false);
  const [saveErr, setSaveErr]                   = useState('');
  const [savedFlash, setSavedFlash]             = useState(false);

  // Run / iteration state — output lives alongside editor, never replaces it
  const [running, setRunning]           = useState(false);
  const [runOutput, setRunOutput]       = useState<string | null>(null);
  const [runErr, setRunErr]             = useState('');
  const [runMode, setRunMode]           = useState<'preview' | 'generate'>('preview');
  const [copied, setCopied]             = useState(false);
  const [savingToRefs, setSavingToRefs] = useState(false);
  const [savedToRefs, setSavedToRefs]   = useState(false);

  // Karl Assist
  const [assistOpen, setAssistOpen]       = useState(false);
  const [assistInput, setAssistInput]     = useState('');
  const [assistHistory, setAssistHistory] = useState<AssistMessage[]>([]);
  const [assistLoading, setAssistLoading] = useState(false);

  // Modal drag/resize
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 580));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 400));
  const [pos, setPos]     = useState({ x: initX, y: initY });
  const [size, setSize]   = useState({ w: 1160, h: 800 });
  const [leftW, setLeftW] = useState(260);

  const leftDragging  = useRef(false);
  const leftDragStart = useRef({ mx: 0, w: 0 });
  const dragging      = useRef(false);
  const resizing      = useRef(false);
  const dragStart     = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const resizeStart   = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const assistBottom  = useRef<HTMLDivElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadTemplates();
    loadConceptRegistry();
    loadExtractCounts();
  }, []);

  useEffect(() => {
    assistBottom.current?.scrollIntoView({ behavior: 'smooth' });
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
      const { data: koUser } = await supabase.from('ko_user').select('implementation_type').eq('id', userId).maybeSingle();
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
      if (dragging.current)    setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.x), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.y) });
      if (resizing.current)    setSize({ w: Math.max(900, resizeStart.current.w + e.clientX - resizeStart.current.x), h: Math.max(560, resizeStart.current.h + e.clientY - resizeStart.current.y) });
      if (leftDragging.current) setLeftW(Math.max(200, Math.min(420, leftDragStart.current.w + e.clientX - leftDragStart.current.mx)));
    };
    const onUp = () => { dragging.current = false; resizing.current = false; leftDragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const selectTemplate = (t: Template) => {
    setSelected(t); setIsNew(false); setDeleteConfirm(false);
    setEditName(t.name);
    setEditDesc(t.description ?? '');
    setEditFormat(t.output_format === 'markdown' ? 'md' : (t.output_format ?? 'md'));
    setEditInstructions(t.prompt_template ?? '');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
    setSavedToRefs(false); setSavedFlash(false);
  };

  const startNew = () => {
    setSelected(null); setIsNew(true); setDeleteConfirm(false);
    setEditName(''); setEditDesc(''); setEditFormat('md'); setEditInstructions('');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
    setSavedToRefs(false); setSavedFlash(false);
  };

  const handleSave = async () => {
    if (!editName.trim()) { setSaveErr('Name is required'); return; }
    setSaving(true); setSaveErr('');
    try {
      if (isNew) {
        const { error } = await supabase.from('document_template').insert({
          user_id: userId, name: editName.trim(), description: editDesc.trim() || null,
          doc_type: '', output_format: editFormat, prompt_template: editInstructions.trim() || '',
          is_system: false, is_active: true,
        });
        if (error) throw error;
      } else if (selected && !selected.is_system) {
        const { error } = await supabase.from('document_template').update({
          name: editName.trim(), description: editDesc.trim() || null,
          output_format: editFormat, prompt_template: editInstructions.trim() || '',
          updated_at: new Date().toISOString(),
        }).eq('document_template_id', selected.document_template_id);
        if (error) throw error;
      }
      await loadTemplates();
      setIsNew(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err: any) { setSaveErr(err.message ?? 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || selected.is_system) return;
    await supabase.from('document_template').update({ is_active: false }).eq('document_template_id', selected.document_template_id);
    setSelected(null); setIsNew(false); setDeleteConfirm(false);
    await loadTemplates();
  };

  // ── Core run — same route, same logic as chat path ─────────────────────────
  const handleRun = async (mode: 'preview' | 'generate') => {
    const templateId = selected?.document_template_id;
    if (!templateId) return;
    setRunMode(mode);
    setRunning(true); setRunErr(''); setSavedToRefs(false);
    try {
      const res = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({
          template_id:           templateId,
          override_instructions: editInstructions.trim() || undefined,
          run_mode:              mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Run failed');
      setRunOutput(data.output ?? data.output_text ?? '');
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
        user_id: userId, title: `${editName} — ${dateStr}`, description: editDesc || null,
        filename: fileName, location: 'generated', notes: runOutput,
        context_id: selected.context_id || null,
        document_template_id: selected.document_template_id,
        ref_type: 'generated', tags: [],
      });
      if (error) throw error;
      setSavedToRefs(true);
      loadExtractCounts();
    } catch (err: any) { setRunErr(err.message ?? 'Save failed'); }
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
      const res = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ message: msg, history: assistHistory, current_instructions: editInstructions }),
      });
      const data = await res.json();
      setAssistHistory(h => [...h, { role: 'assistant', content: data.response ?? '' }]);
      if (data.suggested_instructions) setEditInstructions(data.suggested_instructions);
    } catch {
      setAssistHistory(h => [...h, { role: 'assistant', content: 'Something went wrong. Try again.' }]);
    } finally { setAssistLoading(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered     = templates.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? '').toLowerCase().includes(search.toLowerCase())
  );
  const isEditing    = isNew || !!selected;
  const isSystem     = selected?.is_system ?? false;
  const templateIcon = getObjectIcon(concepts, 'document_template') || '📄';
  const extractLabel = getObjectLabel(concepts, 'external_reference') || 'Extracts';

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: 8, display: 'flex', flexDirection: 'column', fontFamily: 'monospace', overflow: 'hidden', pointerEvents: 'all', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>
              {templateIcon} {getObjectLabel(concepts, 'document_template') || 'Document Template'}
            </span>
            <span style={{ color: '#000', fontSize: '0.7rem', opacity: 0.5 }}>TM · {templates.length} template{templates.length !== 1 ? 's' : ''}</span>
          </div>
          <button onMouseDown={e => e.stopPropagation()} onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}>✕</button>
        </div>

        {/* ── BODY ───────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* ── LEFT: template list ───────────────────────────────────── */}
          <div style={{ width: leftW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #e5e7eb' }}>

            {/* Search — no filter buttons */}
            <div style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..."
                style={{ width: '100%', background: '#fafafa', border: '1px solid #e5e7eb', color: '#222', padding: '0.4rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none', boxSizing: 'border-box' }} />
            </div>

            {/* New template button */}
            <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
              <button onClick={startNew}
                style={{ width: '100%', background: isNew ? ACCENT_BG : 'transparent', border: `1px solid ${isNew ? ACCENT : '#ddd'}`, color: isNew ? ACCENT : '#888', padding: '0.4rem', borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                + new template
              </button>
            </div>

            {/* Template list */}
            <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
              {loading
                ? <div style={{ padding: '1rem', color: '#666', fontSize: '0.75rem' }}>Loading...</div>
                : filtered.length === 0
                  ? <div style={{ padding: '1rem', color: '#888', fontSize: '0.75rem' }}>No templates found</div>
                  : filtered.map((t, idx) => {
                      const isActive = selected?.document_template_id === t.document_template_id;
                      const runCount = extractCounts[t.document_template_id] ?? 0;
                      return (
                        <div key={t.document_template_id} onClick={() => selectTemplate(t)}
                          style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: isActive ? ACCENT_BG : 'transparent', borderLeft: isActive ? `3px solid ${ACCENT}` : '3px solid transparent', transition: 'background 0.1s' }}
                          onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f9f9f9'; }}
                          onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ color: ACCENT, fontSize: '0.58rem', opacity: 0.6, fontWeight: 600, flexShrink: 0 }}>TM{idx + 1}</span>
                            <span style={{ color: '#222', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                            {runCount > 0 && (
                              <span style={{ fontSize: '0.58rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', padding: '0.02rem 0.3rem', borderRadius: 2, flexShrink: 0 }}>
                                {runCount}×
                              </span>
                            )}
                          </div>
                          {t.description && (
                            <div style={{ color: '#888', fontSize: '0.65rem', marginTop: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</div>
                          )}
                        </div>
                      );
                    })
              }
            </div>
          </div>

          {/* ── RESIZABLE DIVIDER ─────────────────────────────────────── */}
          <div
            onMouseDown={e => { leftDragging.current = true; leftDragStart.current = { mx: e.clientX, w: leftW }; }}
            style={{ width: 4, flexShrink: 0, background: '#e5e5e5', cursor: 'col-resize' }}
            onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BORDER)}
            onMouseLeave={e => (e.currentTarget.style.background = '#e5e5e5')}
          />

          {/* ── RIGHT: WORK AREA ─────────────────────────────────────── */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

            {/* Empty state */}
            {!isEditing && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: '0.8rem', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{ fontSize: '1.5rem', opacity: 0.2 }}>{templateIcon}</span>
                <span>Select a template or create a new one</span>
              </div>
            )}

            {isEditing && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                {/* ── TOP STRIP: name / desc / format ─────────────────── */}
                <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #e5e7eb', background: '#fafafa', flexShrink: 0, display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>

                  {isSystem && (
                    <div style={{ width: '100%', padding: '0.3rem 0.6rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, color: '#92400e', fontSize: '0.68rem', marginBottom: '0.25rem' }}>
                      System template — read only
                    </div>
                  )}

                  {/* Name */}
                  <div style={{ flex: '2 1 200px' }}>
                    <div style={labelSt}>Name {!isSystem && <span style={{ color: '#ef4444' }}>*</span>}</div>
                    <input value={editName} onChange={e => setEditName(e.target.value)} disabled={isSystem}
                      placeholder="Template name" style={inputSt(isSystem)} />
                  </div>

                  {/* Description */}
                  <div style={{ flex: '3 1 280px' }}>
                    <div style={labelSt}>Description</div>
                    <input value={editDesc} onChange={e => setEditDesc(e.target.value)} disabled={isSystem}
                      placeholder="What this produces..." style={inputSt(isSystem)} />
                  </div>

                  {/* Format */}
                  <div style={{ flex: '0 0 160px' }}>
                    <div style={labelSt}>Format</div>
                    <select value={editFormat} onChange={e => setEditFormat(e.target.value)} disabled={isSystem}
                      style={{ ...inputSt(isSystem), cursor: isSystem ? 'not-allowed' : 'pointer' } as any}>
                      <option value="md">Markdown (.md)</option>
                      <option value="html">HTML (.html)</option>
                      <option value="txt">Plain text (.txt)</option>
                      <option value="docx">Word (.docx)</option>
                    </select>
                  </div>
                </div>

                {/* ── MAIN WORK AREA: instructions left, output right ── */}
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

                  {/* Instructions column */}
                  <div style={{ flex: '1 1 40%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #e5e7eb', minWidth: 0 }}>

                    {/* Instructions header */}
                    <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, background: '#fafafa' }}>
                      <span style={{ ...labelSt, marginBottom: 0 }}>Formatting Instructions</span>
                      {!isSystem && (
                        <button
                          onClick={() => setAssistOpen(v => !v)}
                          style={{ marginLeft: 'auto', background: assistOpen ? ACCENT_BG : 'transparent', border: `1px solid ${assistOpen ? ACCENT : '#ddd'}`, color: assistOpen ? ACCENT : '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                          ✦ Karl Assist
                        </button>
                      )}
                    </div>

                    {/* Karl Assist panel */}
                    {!isSystem && assistOpen && (
                      <div style={{ borderBottom: `1px solid ${ACCENT_BORDER}`, background: '#f8fffe', flexShrink: 0 }}>
                        {assistHistory.length > 0 && (
                          <div style={{ maxHeight: 140, overflowY: 'auto', padding: '0.5rem 0.75rem', scrollbarWidth: 'thin' }}>
                            {assistHistory.map((m, i) => (
                              <div key={i} style={{ marginBottom: '0.35rem', fontSize: '0.7rem', color: m.role === 'user' ? '#0f766e' : '#374151', paddingLeft: m.role === 'user' ? '0.4rem' : 0, borderLeft: m.role === 'user' ? `2px solid ${ACCENT_BORDER}` : 'none', lineHeight: 1.5 }}>
                                {m.content}
                              </div>
                            ))}
                            {assistLoading && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.15rem 0' }}>
                                <KarlSpinner size="sm" color={ACCENT} />
                                <span style={{ color: '#666', fontSize: '0.65rem' }}>thinking...</span>
                              </div>
                            )}
                            <div ref={assistBottom} />
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '0.4rem', padding: '0.4rem 0.6rem' }}>
                          <textarea
                            value={assistInput}
                            onChange={e => setAssistInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAssist(); } }}
                            placeholder={editInstructions ? 'Describe a change...' : 'Describe what you want this template to produce...'}
                            rows={2}
                            style={{ flex: 1, background: '#fff', border: '1px solid #ddd', color: '#222', padding: '0.3rem 0.5rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.7rem', outline: 'none', resize: 'none', minHeight: 32 }}
                          />
                          <button onClick={handleAssist} disabled={!assistInput.trim() || assistLoading}
                            style={{ background: assistInput.trim() ? ACCENT_BG : 'transparent', border: `1px solid ${assistInput.trim() ? ACCENT : '#ddd'}`, color: assistInput.trim() ? ACCENT : '#aaa', padding: '0.3rem 0.6rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: assistInput.trim() ? 'pointer' : 'not-allowed', alignSelf: 'flex-end' }}>
                            ask
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Instructions textarea — fills remaining space */}
                    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                      <textarea
                        value={editInstructions}
                        onChange={e => setEditInstructions(e.target.value)}
                        disabled={isSystem}
                        placeholder={isSystem ? '' : 'Write formatting instructions here, or use Karl Assist above to draft them.\n\nDescribe: sections to include, fields to show per section, visual layout, heading style.'}
                        style={{ flex: 1, width: '100%', background: isSystem ? '#f5f5f5' : '#fff', border: 'none', borderTop: '1px solid #f0f0f0', color: isSystem ? '#aaa' : '#222', padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.8rem', outline: 'none', resize: 'none', lineHeight: 1.6, boxSizing: 'border-box' } as any}
                      />
                    </div>
                  </div>

                  {/* Output column */}
                  <div style={{ flex: '1 1 60%', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

                    {/* Output header */}
                    <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, background: '#fafafa' }}>
                      {runOutput
                        ? <>
                            <span style={{ color: ACCENT, fontSize: '0.65rem', fontWeight: 600 }}>
                              {runMode === 'preview' ? '🔍 PREVIEW' : '📄 OUTPUT'}
                            </span>
                            {runMode === 'preview' && <span style={{ color: '#999', fontSize: '0.6rem' }}>· stub data</span>}
                            <span style={{ flex: 1 }} />
                            <button onClick={handleCopy}
                              style={{ background: copied ? ACCENT_BG : 'transparent', border: `1px solid ${copied ? ACCENT : '#ddd'}`, color: copied ? ACCENT : '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                              {copied ? '✓ copied' : 'copy'}
                            </button>
                            <button onClick={handleDownloadMd}
                              style={{ background: 'transparent', border: '1px solid #ddd', color: '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                              ↓ .md
                            </button>
                          </>
                        : <span style={{ color: '#bbb', fontSize: '0.65rem' }}>Output will appear here</span>
                      }
                    </div>

                    {/* Output body */}
                    <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                      {running && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', background: '#fff' }}>
                          <KarlSpinner size="lg" color={ACCENT} />
                          <span style={{ color: '#888', fontSize: '0.78rem' }}>Generating...</span>
                        </div>
                      )}
                      {!running && runErr && (
                        <div style={{ padding: '1rem', color: '#ef4444', fontSize: '0.75rem' }}>
                          {runErr}
                          <button onClick={() => setRunErr('')} style={{ marginLeft: '0.75rem', background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '0.7rem' }}>dismiss</button>
                        </div>
                      )}
                      {!running && !runErr && runOutput && (
                        <div style={{ height: '100%', overflowY: 'auto', padding: '0.75rem 1rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                          <pre style={{ color: '#333', fontSize: '0.78rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'monospace', margin: 0 }}>{runOutput}</pre>
                        </div>
                      )}
                      {!running && !runErr && !runOutput && (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.5rem', color: '#ccc' }}>
                          <span style={{ fontSize: '1.5rem' }}>▶</span>
                          <span style={{ fontSize: '0.75rem' }}>Run a preview to see output here</span>
                          <span style={{ fontSize: '0.65rem', color: '#ddd' }}>Tweak instructions, run again, repeat until right</span>
                        </div>
                      )}
                    </div>

                    {/* Save to extracts strip — only shown after real generate */}
                    {runOutput && runMode === 'generate' && (
                      <div style={{ padding: '0.5rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                        {savedToRefs
                          ? <span style={{ color: ACCENT, fontSize: '0.7rem' }}>✓ Saved to {extractLabel}</span>
                          : <>
                              <span style={{ color: '#666', fontSize: '0.7rem', flex: 1 }}>Save this run to {extractLabel}?</span>
                              <button onClick={handleSaveToRefs} disabled={savingToRefs}
                                style={{ background: ACCENT, border: 'none', color: '#000', padding: '0.25rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>
                                {savingToRefs ? 'saving...' : 'save it'}
                              </button>
                            </>
                        }
                        {selected && (extractCounts[selected.document_template_id] ?? 0) > 0 && onOpenExtracts && (
                          <button
                            onClick={() => { onOpenExtracts(selected.document_template_id); onClose(); }}
                            style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, padding: '0.25rem 0.6rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                            {extractCounts[selected.document_template_id]}× runs →
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── FOOTER: actions ─────────────────────────────────── */}
                <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>

                  {saveErr && <span style={{ color: '#ef4444', fontSize: '0.68rem' }}>{saveErr}</span>}
                  {savedFlash && !saveErr && <span style={{ color: ACCENT, fontSize: '0.68rem' }}>✓ Saved</span>}
                  <span style={{ flex: 1 }} />

                  {/* Delete */}
                  {!isSystem && selected && !deleteConfirm && (
                    <button onClick={() => setDeleteConfirm(true)}
                      style={{ background: 'transparent', border: '1px solid #fca5a5', color: '#ef4444', padding: '0.3rem 0.65rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                      delete
                    </button>
                  )}
                  {!isSystem && selected && deleteConfirm && (
                    <>
                      <span style={{ fontSize: '0.68rem', color: '#ef4444' }}>Delete "{selected.name}"?</span>
                      <button onClick={() => setDeleteConfirm(false)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.3rem 0.6rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>cancel</button>
                      <button onClick={handleDelete} style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '0.3rem 0.7rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>yes, delete</button>
                    </>
                  )}

                  {/* Save template */}
                  {!isSystem && (
                    <button onClick={handleSave} disabled={saving}
                      style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.85rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: saving ? 'not-allowed' : 'pointer' }}>
                      {saving ? 'saving...' : 'save'}
                    </button>
                  )}

                  {/* Preview — stub data, iterate freely */}
                  {selected && !isNew && (
                    <button onClick={() => handleRun('preview')} disabled={running}
                      style={{ background: 'transparent', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.85rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: running ? 'not-allowed' : 'pointer' }}>
                      {running && runMode === 'preview' ? '...' : '▶ preview'}
                    </button>
                  )}

                  {/* Generate — real data, saves to extracts */}
                  {selected && !isNew && (
                    <button onClick={() => handleRun('generate')} disabled={running}
                      style={{ background: running && runMode === 'generate' ? '#0f2a27' : ACCENT, border: 'none', color: '#000', padding: '0.3rem 1rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: running ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
                      {running && runMode === 'generate' ? '...' : '⚡ generate'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Resize handle */}
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
  color: '#888', fontSize: '0.6rem', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: '0.25rem',
};

const inputSt = (disabled: boolean): React.CSSProperties => ({
  width: '100%', background: disabled ? '#f5f5f5' : '#fff', border: '1px solid #e5e7eb',
  color: disabled ? '#aaa' : '#222', padding: '0.4rem 0.55rem', borderRadius: 4,
  fontFamily: 'monospace', fontSize: '0.78rem', outline: 'none',
  boxSizing: 'border-box', cursor: disabled ? 'not-allowed' : 'text',
});
