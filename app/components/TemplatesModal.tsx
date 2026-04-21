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

// ─── CONCEPT REGISTRY HELPERS ─────────────────────────────────────────────────

function getObjectIcon(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.icon ?? '';
}

function getObjectLabel(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.label ?? key;
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
  const [concepts, setConcepts]     = useState<ConceptEntry[]>([]);
  const [extractCounts, setExtractCounts] = useState<Record<string, number>>({});

  // Inline delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Edit state
  const [editName, setEditName]                 = useState('');
  const [editDesc, setEditDesc]                 = useState('');
  const [editFormat, setEditFormat]             = useState('md');
  const [editInstructions, setEditInstructions] = useState('');
  const [saving, setSaving]                     = useState(false);
  const [saveErr, setSaveErr]                   = useState('');

  // Run/preview state
  const [running, setRunning]           = useState(false);
  const [runOutput, setRunOutput]       = useState<string | null>(null);
  const [runErr, setRunErr]             = useState('');
  const [copied, setCopied]             = useState(false);
  const [savePrompt, setSavePrompt]     = useState(false);
  const [savingToRefs, setSavingToRefs] = useState(false);
  const [savedToRefs, setSavedToRefs]   = useState(false);

  // Karl Assist — collapsed by default, expands on button click
  const [assistOpen, setAssistOpen]       = useState(false);
  const [assistInput, setAssistInput]     = useState('');
  const [assistHistory, setAssistHistory] = useState<AssistMessage[]>([]);
  const [assistLoading, setAssistLoading] = useState(false);

  // Modal drag/resize
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 550));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 390));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 1100, h: 780 });
  const [leftW, setLeftW] = useState(300);

  const leftDragging    = useRef(false);
  const leftDragStart   = useRef({ mx: 0, w: 0 });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragStart       = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const resizeStart     = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const assistBottomRef = useRef<HTMLDivElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadTemplates();
    loadConceptRegistry();
    loadExtractCounts();
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
    setSelected(t); setIsNew(false); setDeleteConfirm(false);
    setEditName(t.name);
    setEditDesc(t.description ?? '');
    setEditFormat(t.output_format === 'markdown' ? 'md' : (t.output_format ?? 'md'));
    setEditInstructions(t.prompt_template ?? '');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
    setSavePrompt(false); setSavedToRefs(false);
  };

  const startNew = () => {
    setSelected(null); setIsNew(true); setDeleteConfirm(false);
    setEditName(''); setEditDesc(''); setEditFormat('md');
    setEditInstructions('');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
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
          doc_type:        '',
          output_format:   editFormat,
          prompt_template: editInstructions.trim() || '',
          is_system:       false,
          is_active:       true,
        });
        if (error) throw error;
      } else if (selected && !selected.is_system) {
        const { error } = await supabase.from('document_template').update({
          name:            editName.trim(),
          description:     editDesc.trim() || null,
          output_format:   editFormat,
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
    await supabase.from('document_template').update({ is_active: false }).eq('document_template_id', selected.document_template_id);
    setSelected(null); setIsNew(false); setDeleteConfirm(false);
    await loadTemplates();
  };

  const handleRun = async () => {
    const templateId = selected?.document_template_id;
    if (!templateId) return;
    setRunning(true); setRunOutput(null); setRunErr('');
    setSavePrompt(false); setSavedToRefs(false);
    try {
      const res = await fetch('/api/ko/template/run', {
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
      const res = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({
          message:              msg,
          history:              assistHistory.map(m => ({ role: m.role, content: m.content })),
          current_instructions: editInstructions,
        }),
      });
      const data = await res.json();
      setAssistHistory(h => [...h, { role: 'assistant', content: data.response ?? '' }]);
      if (data.suggested_instructions) {
        setEditInstructions(data.suggested_instructions);
      }
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
  const templateIcon = getObjectIcon(concepts, 'document_template') || '📄';

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
              {templateIcon} {getObjectLabel(concepts, 'document_template') || 'Document Template'}
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
                      const isActive = selected?.document_template_id === t.document_template_id;
                      const runCount = extractCounts[t.document_template_id] ?? 0;
                      return (
                        <div key={t.document_template_id} onClick={() => selectTemplate(t)}
                          style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', background: isActive ? ACCENT_BG : 'transparent', borderLeft: isActive ? `2px solid ${ACCENT}` : '2px solid transparent', transition: 'background 0.1s', position: 'relative' }}
                          onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f5f5f5'; }}
                          onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                            <span style={{ color: ACCENT, fontSize: '0.6rem', opacity: 0.5, fontWeight: 600 }}>TM{idx + 1}</span>
                            <span style={{ fontSize: '0.75rem' }}>{templateIcon}</span>
                            <span style={{ color: '#222', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                            {runCount > 0 && (
                              <span style={{ fontSize: '0.58rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', padding: '0.02rem 0.3rem', borderRadius: 2, flexShrink: 0 }}>
                                {runCount} run{runCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                            {t.is_system && <span style={{ fontSize: '0.6rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, padding: '0.05rem 0.3rem', borderRadius: 2 }}>system</span>}
                            {t.doc_type && <span style={{ fontSize: '0.6rem', color: '#666', background: '#e5e5e5', border: '1px solid #e5e7eb', padding: '0.05rem 0.3rem', borderRadius: 2 }}>{t.doc_type}</span>}
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

                  {/* Name */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Name {!isSystem && <span style={{ color: '#ef4444' }}>*</span>}</div>
                    <input value={editName} onChange={e => setEditName(e.target.value)} disabled={isSystem}
                      style={inputSt(isSystem)} placeholder="Weekly Status Report" />
                  </div>

                  {/* Description */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Description</div>
                    <input value={editDesc} onChange={e => setEditDesc(e.target.value)} disabled={isSystem}
                      style={inputSt(isSystem)} placeholder="What this template produces..." />
                  </div>

                  {/* Output Format */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={labelSt}>Output Format <span style={{ color: '#ef4444' }}>*</span></div>
                    <select value={editFormat} onChange={e => setEditFormat(e.target.value)} disabled={isSystem}
                      style={{ ...inputSt(isSystem), cursor: isSystem ? 'not-allowed' : 'pointer', width: 180 } as any}>
                      <option value="md">Markdown (.md)</option>
                      <option value="html">HTML (.html)</option>
                      <option value="pdf">PDF (.pdf)</option>
                      <option value="txt">Plain text (.txt)</option>
                      <option value="docx">Word (.docx)</option>
                    </select>
                  </div>

                  {/* Formatting Instructions */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                      <div style={labelSt}>
                        Formatting Instructions
                        {!isSystem && <span style={{ color: '#555', textTransform: 'none', fontWeight: 400, letterSpacing: 0, marginLeft: '0.35rem' }}>(Karl-authored — edit carefully)</span>}
                      </div>
                      {/* Karl Assist button — collapsed by default */}
                      {!isSystem && (
                        <button
                          onClick={() => setAssistOpen(v => !v)}
                          style={{ marginLeft: 'auto', background: assistOpen ? ACCENT_BG : 'transparent', border: `1px solid ${assistOpen ? ACCENT : '#ccc'}`, color: assistOpen ? ACCENT : '#888', padding: '0.2rem 0.55rem', borderRadius: 3, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer', whiteSpace: 'nowrap' }}
                          title="Karl Assist — describe what you want, Karl will update the formatting instructions"
                        >
                          ✦ Karl Assist
                        </button>
                      )}
                    </div>

                    {/* Karl Assist panel — only shown when open */}
                    {!isSystem && assistOpen && (
                      <div style={{ border: `1px solid ${ACCENT_BORDER}`, borderRadius: 5, overflow: 'hidden', marginBottom: '0.6rem', background: '#fafafa' }}>
                        {assistHistory.length > 0 && (
                          <div style={{ maxHeight: 160, overflowY: 'auto', padding: '0.6rem 0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                            {assistHistory.map((m, i) => (
                              <div key={i} style={{ marginBottom: '0.4rem', fontSize: '0.73rem', color: m.role === 'user' ? '#0f766e' : '#374151', paddingLeft: m.role === 'user' ? '0.5rem' : 0, borderLeft: m.role === 'user' ? `2px solid ${ACCENT_BORDER}` : 'none', lineHeight: 1.5 }}>
                                {m.content}
                              </div>
                            ))}
                            {assistLoading && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0' }}>
                                <KarlSpinner size="sm" color={ACCENT} />
                                <span style={{ color: '#666', fontSize: '0.7rem' }}>Karl is thinking...</span>
                              </div>
                            )}
                            <div ref={assistBottomRef} />
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 0.6rem' }}>
                          <textarea
                            value={assistInput}
                            onChange={e => setAssistInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAssist(); } }}
                            placeholder={editInstructions
                              ? 'Describe a change — Karl will update the instructions below...'
                              : 'Describe what you want this template to produce...'}
                            rows={2}
                            style={{ flex: 1, background: '#fff', border: '1px solid #e5e7eb', color: '#222', padding: '0.35rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.72rem', outline: 'none', resize: 'vertical', minHeight: 36 }}
                            onFocus={e => (e.target.style.borderColor = ACCENT)}
                            onBlur={e => (e.target.style.borderColor = '#e5e7eb')}
                          />
                          <button onClick={handleAssist} disabled={!assistInput.trim() || assistLoading}
                            style={{ background: assistInput.trim() ? ACCENT_BG : 'transparent', border: `1px solid ${assistInput.trim() ? ACCENT : '#ccc'}`, color: assistInput.trim() ? ACCENT : '#aaa', padding: '0.35rem 0.65rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: assistInput.trim() ? 'pointer' : 'not-allowed', alignSelf: 'flex-end' }}>
                            ask
                          </button>
                        </div>
                      </div>
                    )}

                    <textarea
                      value={editInstructions}
                      onChange={e => setEditInstructions(e.target.value)}
                      disabled={isSystem}
                      rows={10}
                      placeholder={isSystem ? '' : 'Formatting instructions for this template. Use Karl Assist above to draft, or write manually.'}
                      style={{ ...inputSt(isSystem), resize: 'vertical', minHeight: 200, lineHeight: 1.6 } as any}
                    />
                  </div>

                </div>

                {/* Footer */}
                <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  {saveErr && <span style={{ color: '#ef4444', fontSize: '0.7rem', flex: 1 }}>{saveErr}</span>}
                  {!saveErr && <span style={{ flex: 1 }} />}

                  {!isSystem && selected && !deleteConfirm && (
                    <button onClick={() => setDeleteConfirm(true)}
                      style={{ background: 'transparent', border: '1px solid #3a1a1a', color: '#ef4444', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                      delete
                    </button>
                  )}

                  {!isSystem && selected && deleteConfirm && (
                    <>
                      <span style={{ fontSize: '0.7rem', color: '#ef4444' }}>Delete "{selected.name}"?</span>
                      <button onClick={() => setDeleteConfirm(false)}
                        style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.6rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                        cancel
                      </button>
                      <button onClick={handleDelete}
                        style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>
                        yes, delete
                      </button>
                    </>
                  )}

                  {!isSystem && (
                    <button onClick={handleSave} disabled={saving}
                      style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.35rem 0.9rem', borderRadius: 4, fontSize: '0.72rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                      {saving ? 'saving...' : 'save'}
                    </button>
                  )}

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

            {/* Running state */}
            {running && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
                <KarlSpinner size="lg" color={ACCENT} />
                <div style={{ color: '#666', fontSize: '0.8rem' }}>Karl is generating your document...</div>
                <div style={{ color: '#555', fontSize: '0.7rem' }}>This is a test run — nothing is saved yet</div>
              </div>
            )}

            {/* Output state */}
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
                  <pre style={{ color: '#333', fontSize: '0.8rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'monospace', margin: 0 }}>{runOutput}</pre>
                </div>

                <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', flexShrink: 0 }}>
                  {!savePrompt && !savedToRefs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#888', fontSize: '0.72rem' }}>Happy with this?</div>
                        <div style={{ color: '#888', fontSize: '0.65rem', marginTop: '0.1rem' }}>Save to your {getObjectLabel(concepts, 'external_reference') || 'Extracts'} so you can track it — or just copy and go.</div>
                      </div>
                      <button onClick={handleRun} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer' }}>▶ run again</button>
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
                      <button onClick={handleRun} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.35rem 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer' }}>▶ run again</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error state */}
            {runErr && !running && (
              <div style={{ padding: '1rem', color: '#ef4444', fontSize: '0.75rem' }}>
                Error: {runErr}
                <button onClick={() => setRunErr('')} style={{ marginLeft: '1rem', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '0.7rem' }}>dismiss</button>
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
  color: '#666', fontSize: '0.65rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.3rem',
};

const inputSt = (disabled: boolean): React.CSSProperties => ({
  width: '100%', background: disabled ? '#f5f5f5' : '#fafafa', border: '1px solid #ddd',
  color: disabled ? '#aaa' : '#222', padding: '0.45rem 0.6rem', borderRadius: 4,
  fontFamily: 'monospace', fontSize: '0.8rem', outline: 'none',
  boxSizing: 'border-box', cursor: disabled ? 'not-allowed' : 'text',
});
