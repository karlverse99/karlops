'use client';

import { useEffect, useState, useRef } from 'react';
import TagPicker from '@/app/components/TagPicker';
import { supabase } from '@/lib/supabase';
import KarlSpinner from './KarlSpinner';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Extract {
  external_reference_id: string;
  title: string;
  filename: string | null;
  location: string | null;
  ref_type: string | null;
  description: string | null;
  notes: string | null;
  tags: string[] | null;
  document_template_id: string | null;
  created_at: string;
  context: { name: string; context_id: string } | null;
  task: { title: string; task_id: string } | null;
}

interface Template {
  document_template_id: string;
  name: string;
  doc_type: string | null;
  prompt_template: string;
  data_sources: any;
  output_format: string;
}

interface Context { context_id: string; name: string; }
interface Tag { tag_id: string; name: string; tag_group_id: string; }
interface TagGroup { tag_group_id: string; name: string; }

interface ExtractsModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange: (count: number) => void;
  // Optional: open directly filtered to a template (e.g. from TemplatesModal)
  initialTemplateFilter?: string | null;
}

type CreatePath = 'choose' | 'template' | 'manual';
type RightMode  = 'empty' | 'view' | 'edit' | 'create';

const ACCENT        = '#8b5cf6';
const ACCENT_BG     = '#f5f3ff';
const ACCENT_BORDER = '#ddd6fe';

// ─── DOWNLOAD HELPERS ─────────────────────────────────────────────────────────

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function downloadMD(content: string, title: string) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${slugify(title)}.md`; a.click();
  URL.revokeObjectURL(url);
}

function downloadTXT(content: string, title: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${slugify(title)}.txt`; a.click();
  URL.revokeObjectURL(url);
}

async function downloadPDF(content: string, title: string) {
  try {
    // @ts-ignore
    const { jsPDF } = await import(/* webpackIgnore: true */ 'jspdf');
    const doc   = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const lines = doc.splitTextToSize(content, 170);
    let y = 20;
    doc.setFontSize(14); doc.text(title, 20, y); y += 10;
    doc.setFontSize(10);
    for (const line of lines) {
      if (y > 280) { doc.addPage(); y = 20; }
      doc.text(line, 20, y); y += 5;
    }
    doc.save(`${slugify(title)}.pdf`);
  } catch {
    const win = window.open('', '_blank');
    if (win) { win.document.write(`<pre style="font-family:monospace;font-size:12px;padding:2rem">${content}</pre>`); win.print(); }
  }
}

async function downloadDOCX(content: string, title: string) {
  try {
    // @ts-ignore
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import(/* webpackIgnore: true */ 'docx');
    const lines    = content.split('\n');
    const children: any[] = [];
    for (const line of lines) {
      if (line.startsWith('## '))      children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      else if (line.startsWith('# ')) children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      else                             children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
    const doc  = new Document({ sections: [{ properties: {}, children }] });
    const blob = await Packer.toBlob(doc);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${slugify(title)}.docx`; a.click();
    URL.revokeObjectURL(url);
  } catch {
    downloadTXT(content, title);
  }
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ExtractsModal({ userId, accessToken, onClose, onCountChange, initialTemplateFilter = null }: ExtractsModalProps) {

  // ── Data ───────────────────────────────────────────────────────────────────
  const [extracts, setExtracts]   = useState<Extract[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [contexts, setContexts]   = useState<Context[]>([]);
  const [allTags, setAllTags]         = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]     = useState<TagGroup[]>([]);
  const [saveCount, setSaveCount]     = useState(0);
  const [loading, setLoading]     = useState(true);

  // ── UI ─────────────────────────────────────────────────────────────────────
  const [rightMode, setRightMode]         = useState<RightMode>('empty');
  const [selected, setSelected]           = useState<Extract | null>(null);
  const [search, setSearch]               = useState('');
  const [filterContext, setFilterContext] = useState('');
  const [filterTemplate, setFilterTemplate] = useState<string>(initialTemplateFilter ?? ''); // ← NEW
  const [filterType, setFilterType]       = useState<'all' | 'generated' | 'manual'>('all');
  const [sortBy, setSortBy]               = useState<'date' | 'title' | 'template'>('date');

  // ── Create flow ────────────────────────────────────────────────────────────
  const [createPath, setCreatePath]             = useState<CreatePath>('choose');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [focusPrompt, setFocusPrompt]           = useState('');
  const [previewContent, setPreviewContent]     = useState('');
  const [generating, setGenerating]             = useState(false);
  const [refineInput, setRefineInput]           = useState('');
  const [refining, setRefining]                 = useState(false);
  const [refineHistory, setRefineHistory]       = useState<{ role: 'user' | 'karl'; content: string }[]>([]);

  // ── Manual create ──────────────────────────────────────────────────────────
  const [manualTitle, setManualTitle]           = useState('');
  const [manualNotes, setManualNotes]           = useState('');
  const [manualContext, setManualContext]       = useState('');
  const [manualTags, setManualTags]             = useState<string[]>([]);
  const [manualFilename, setManualFilename]     = useState('');
  const [karlAssistInput, setKarlAssistInput]   = useState('');
  const [karlAssistLoading, setKarlAssistLoading] = useState(false);
  const [karlAssistHistory, setKarlAssistHistory] = useState<{ role: 'user' | 'karl'; content: string }[]>([]);

  // ── Save metadata ──────────────────────────────────────────────────────────
  const [saveTitle, setSaveTitle]       = useState('');
  const [saveContext, setSaveContext]   = useState('');
  const [saveTags, setSaveTags]         = useState<string[]>([]);
  const [saving, setSaving]             = useState(false);
  const [saveErr, setSaveErr]           = useState('');

  // ── Edit form state ────────────────────────────────────────────────────────
  const [editTitle, setEditTitle]         = useState('');
  const [editFilename, setEditFilename]   = useState('');
  const [editContext, setEditContext]     = useState('');
  const [editTags, setEditTags]           = useState<string[]>([]);
  const [editNotes, setEditNotes]         = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editErr, setEditErr]             = useState('');
  const [editSaving, setEditSaving]       = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // ── Drag/resize ────────────────────────────────────────────────────────────
  const initX = Math.max(20, Math.round(window.innerWidth  / 2 - 600));
  const initY = Math.max(20, Math.round(window.innerHeight / 2 - 390));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 1200, h: 780 });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragStart       = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeStart     = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const refineBottomRef = useRef<HTMLDivElement>(null);
  const karlBottomRef   = useRef<HTMLDivElement>(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  const loadAll = async () => {
    setLoading(true);
    const [{ data: exData }, { data: tmData }, { data: ctxData }, { data: grData }, { data: tgData }] = await Promise.all([
      supabase.from('external_reference')
        .select(`external_reference_id, title, filename, location, ref_type, description, notes, tags, document_template_id, created_at,
          context:context_id ( name, context_id ),
          task:task_id ( title, task_id )`)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase.from('document_template')
        .select('document_template_id, name, doc_type, prompt_template, data_sources, output_format')
        .or(`user_id.eq.${userId},is_system.eq.true`)
        .eq('is_active', true)
        .order('name'),
      supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false).order('name'),
      supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).order('name'),
      supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId).order('name'),
    ]);
    if (exData)  { setExtracts(exData as any); onCountChange(exData.length); }
    if (tmData)  setTemplates(tmData as any);
    if (ctxData) setContexts(ctxData);
    if (grData)  setTagGroups(grData);
    if (tgData)  setAllTags(tgData);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.mx), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.my) });
      if (resizing.current) setSize({ w: Math.max(900, resizeStart.current.w + e.clientX - resizeStart.current.mx), h: Math.max(500, resizeStart.current.h + e.clientY - resizeStart.current.my) });
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  useEffect(() => { refineBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [refineHistory, refining]);
  useEffect(() => { karlBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [karlAssistHistory, karlAssistLoading]);

  // ── Filtered list ──────────────────────────────────────────────────────────

  const filtered = extracts
    .filter(r => {
      if (search && !r.title.toLowerCase().includes(search.toLowerCase()) && !(r.filename ?? '').toLowerCase().includes(search.toLowerCase())) return false;
      if (filterContext  && r.context?.context_id !== filterContext) return false;
      if (filterTemplate && r.document_template_id !== filterTemplate) return false; // ← NEW
      if (filterType === 'generated' && !r.document_template_id) return false;
      if (filterType === 'manual'    &&  r.document_template_id) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'title')    return a.title.localeCompare(b.title);
      if (sortBy === 'template') return (a.document_template_id ?? '').localeCompare(b.document_template_id ?? '');
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  // ── Handlers ───────────────────────────────────────────────────────────────

  const openView = (r: Extract) => {
    setSelected(r);
    setEditTitle(r.title);
    setEditFilename(r.filename ?? '');
    setEditContext(r.context?.context_id ?? '');
    setEditTags(r.tags ?? []);
    setEditNotes(r.notes ?? '');
    setEditDescription(r.description ?? '');
    setEditErr('');
    setDeleteConfirm(false);
    setRightMode('edit');
    setSaveErr('');
  };

  const openCreate = () => {
    setSelected(null); setRightMode('create'); setCreatePath('choose');
    setSelectedTemplateId(''); setFocusPrompt(''); setPreviewContent(''); setRefineHistory([]);
    setManualTitle(''); setManualNotes(''); setManualContext(''); setManualTags([]); setManualFilename('');
    setKarlAssistHistory([]); setSaveTitle(''); setSaveContext(''); setSaveTags([]); setSaveErr('');
  };

  const handleGenerate = async () => {
    if (!selectedTemplateId) return;
    setGenerating(true); setPreviewContent('');
    const tmpl = templates.find(t => t.document_template_id === selectedTemplateId);
    try {
      const res  = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ template_id: selectedTemplateId, focus_prompt: focusPrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Generate failed');
      setPreviewContent(data.output);
      setSaveTitle(`${tmpl?.name ?? 'Extract'} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    } catch (err: any) {
      setPreviewContent(`Error: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleRefine = async () => {
    const msg = refineInput.trim();
    if (!msg || !previewContent || refining) return;
    setRefineInput(''); setRefining(true);
    setRefineHistory(h => [...h, { role: 'user', content: msg }]);
    const tmpl = templates.find(t => t.document_template_id === selectedTemplateId);
    try {
      const res  = await fetch('/api/ko/extract/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ current_content: previewContent, refinement_instruction: msg, template_instructions: tmpl?.prompt_template ?? '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Refine failed');
      setPreviewContent(data.output);
      setRefineHistory(h => [...h, { role: 'karl', content: `✓ Rewritten with: "${msg}"` }]);
    } catch (err: any) {
      setRefineHistory(h => [...h, { role: 'karl', content: `Error: ${err.message}` }]);
    } finally {
      setRefining(false);
    }
  };

  const handleKarlAssist = async () => {
    const msg = karlAssistInput.trim();
    if (!msg || karlAssistLoading) return;
    setKarlAssistInput(''); setKarlAssistLoading(true);
    setKarlAssistHistory(h => [...h, { role: 'user', content: msg }]);
    try {
      const res  = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ message: msg, history: karlAssistHistory.map(m => ({ role: m.role === 'karl' ? 'assistant' : 'user', content: m.content })), current_instructions: manualNotes, current_data_sources: {} }),
      });
      const data = await res.json();
      if (data.suggested_instructions) setManualNotes(data.suggested_instructions);
      setKarlAssistHistory(h => [...h, { role: 'karl', content: data.response ?? '' }]);
    } catch (err: any) {
      setKarlAssistHistory(h => [...h, { role: 'karl', content: `Error: ${err.message}` }]);
    } finally {
      setKarlAssistLoading(false);
    }
  };

  const handleSaveGenerated = async () => {
    if (!saveTitle.trim()) { setSaveErr('Title is required'); return; }
    setSaving(true); setSaveErr('');
    const tmpl    = templates.find(t => t.document_template_id === selectedTemplateId);
    const dateSlug = new Date().toISOString().slice(0, 10);
    try {
      const { error } = await supabase.from('external_reference').insert({
        user_id:              userId,
        title:                saveTitle.trim(),
        filename:             `${slugify(saveTitle.trim())}-${dateSlug}.md`,
        location:             'generated',
        notes:                previewContent,
        description:          tmpl?.name ?? null,
        context_id:           saveContext || null,
        document_template_id: selectedTemplateId || null,
        ref_type:             'generated',
        tags:                 saveTags.length > 0 ? saveTags : [],
      });
      if (error) throw error;
      await loadAll(); setRightMode('empty'); setSaveCount(c => c + 1);
    } catch (err: any) { setSaveErr(err.message); }
    finally { setSaving(false); }
  };

  const handleSaveManual = async () => {
    if (!manualTitle.trim()) { setSaveErr('Title is required'); return; }
    setSaving(true); setSaveErr('');
    try {
      const { error } = await supabase.from('external_reference').insert({
        user_id:    userId,
        title:      manualTitle.trim(),
        filename:   manualFilename.trim() || null,
        notes:      manualNotes.trim() || null,
        context_id: manualContext || null,
        ref_type:   'manual',
        tags:       manualTags.length > 0 ? manualTags : [],
      });
      if (error) throw error;
      await loadAll(); setRightMode('empty'); setSaveCount(c => c + 1);
    } catch (err: any) { setSaveErr(err.message); }
    finally { setSaving(false); }
  };

  const handleNewVersion = (extract: Extract) => {
    if (!extract.document_template_id) return;
    const tmpl = templates.find(t => t.document_template_id === extract.document_template_id);
    setSelected(null); setRightMode('create'); setCreatePath('template');
    setSelectedTemplateId(extract.document_template_id);
    setFocusPrompt(''); setPreviewContent(''); setRefineHistory([]);
    setSaveTitle(`${tmpl?.name ?? extract.title} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    setSaveContext(extract.context?.context_id ?? '');
    setSaveTags(extract.tags ?? []);
    setSaveErr('');
  };

  const handleEditSave = async () => {
    if (!selected || !editTitle.trim()) { setEditErr('Title is required'); return; }
    setEditSaving(true); setEditErr('');
    try {
      const { error } = await supabase.from('external_reference').update({
        title:       editTitle.trim(),
        filename:    editFilename.trim() || null,
        context_id:  editContext || null,
        tags:        editTags.length > 0 ? editTags : [],
        notes:       editNotes.trim() || null,
        description: editDescription.trim() || null,
      }).eq('external_reference_id', selected.external_reference_id).eq('user_id', userId);
      if (error) throw error;
      await loadAll();
      setRightMode('empty'); setSelected(null);
    } catch (e: any) { setEditErr(e.message); }
    finally { setEditSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const { error } = await supabase
      .from('external_reference')
      .delete()
      .eq('external_reference_id', selected.external_reference_id)
      .eq('user_id', userId);
    if (error) { setEditErr(error.message); return; }
    await loadAll();
    setRightMode('empty'); setSelected(null); setDeleteConfirm(false);
  };

  const selectedTemplate = templates.find(t => t.document_template_id === selectedTemplateId);

  // ── Derived: extract counts per template (for filter dropdown labels) ──────
  const extractCountByTemplate = extracts.reduce<Record<string, number>>((acc, r) => {
    if (r.document_template_id) acc[r.document_template_id] = (acc[r.document_template_id] ?? 0) + 1;
    return acc;
  }, {});

  // ─── RENDER ────────────────────────────────────────────────────────────────

  const renderLeft = () => (
    <div style={{ width: 340, flexShrink: 0, borderRight: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column', gap: '0.35rem', flexShrink: 0 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search extracts..."
          style={inputSt} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />

        {/* Row 1: context + type */}
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <select value={filterContext} onChange={e => setFilterContext(e.target.value)} style={{ ...inputSt, flex: 1, fontSize: '0.68rem', padding: '0.3rem 0.4rem' } as any}>
            <option value="">All contexts</option>
            {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
          </select>
          <select value={filterType} onChange={e => setFilterType(e.target.value as any)} style={{ ...inputSt, flex: 1, fontSize: '0.68rem', padding: '0.3rem 0.4rem' } as any}>
            <option value="all">All types</option>
            <option value="generated">Generated</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        {/* Row 2: template filter + sort — NEW */}
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <select value={filterTemplate} onChange={e => setFilterTemplate(e.target.value)} style={{ ...inputSt, flex: 2, fontSize: '0.68rem', padding: '0.3rem 0.4rem' } as any}>
            <option value="">All templates</option>
            {templates
              .filter(t => extractCountByTemplate[t.document_template_id])
              .map(t => (
                <option key={t.document_template_id} value={t.document_template_id}>
                  {t.name} ({extractCountByTemplate[t.document_template_id]})
                </option>
              ))
            }
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} style={{ ...inputSt, flex: 1, fontSize: '0.68rem', padding: '0.3rem 0.4rem' } as any}>
            <option value="date">Date ↓</option>
            <option value="title">Title</option>
            <option value="template">Template</option>
          </select>
        </div>

        {/* Active filter indicator */}
        {(filterTemplate || filterContext || filterType !== 'all') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ color: '#aaa', fontSize: '0.6rem' }}>{filtered.length} of {extracts.length} shown</span>
            <button onClick={() => { setFilterTemplate(''); setFilterContext(''); setFilterType('all'); }}
              style={{ background: 'none', border: 'none', color: ACCENT, fontSize: '0.6rem', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
              clear filters
            </button>
          </div>
        )}
        {!(filterTemplate || filterContext || filterType !== 'all') && (
          <div style={{ color: '#ccc', fontSize: '0.6rem' }}>{extracts.length} total</div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${ACCENT_BORDER} transparent` }}>
        {loading
          ? <div style={{ padding: '1rem', color: '#aaa', fontSize: '0.75rem' }}>Loading...</div>
          : filtered.length === 0
            ? <div style={{ padding: '1rem', color: '#ccc', fontSize: '0.75rem' }}>No extracts found.</div>
            : filtered.map((r, idx) => {
                const isSel  = selected?.external_reference_id === r.external_reference_id;
                const tmplNm = r.document_template_id ? templates.find(t => t.document_template_id === r.document_template_id)?.name : null;
                return (
                  <div key={r.external_reference_id} onClick={() => openView(r)}
                    style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', background: isSel ? ACCENT_BG : 'transparent', borderLeft: `3px solid ${isSel ? ACCENT : 'transparent'}`, transition: 'all 0.1s' }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = '#fafafa'; }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.1rem' }}>
                      <span style={{ color: ACCENT, fontSize: '0.58rem', fontWeight: 700, opacity: 0.5, flexShrink: 0 }}>EX{idx + 1}</span>
                      <span style={{ color: '#111', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>{r.title}</span>
                      <span style={{ color: '#ccc', fontSize: '0.6rem', flexShrink: 0 }}>{fmtDate(r.created_at)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', paddingLeft: '0.9rem', flexWrap: 'wrap' }}>
                      {tmplNm && <span style={{ fontSize: '0.6rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 2, padding: '0.02rem 0.3rem' }}>{tmplNm}</span>}
                      {r.context && <span style={{ fontSize: '0.6rem', color: '#aaa' }}>{r.context.name}</span>}
                      {r.tags?.slice(0, 2).map(t => <span key={t} style={{ fontSize: '0.58rem', color: '#ccc' }}>#{t}</span>)}
                    </div>
                  </div>
                );
              })
        }
      </div>
    </div>
  );

  const renderEmpty = () => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem', color: '#ccc' }}>
      <div style={{ fontSize: '2.5rem', opacity: 0.12 }}>⬡</div>
      <div style={{ fontSize: '0.8rem' }}>Select an extract or create a new one</div>
      <button onClick={openCreate} style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.5rem 1.25rem', borderRadius: 6, fontSize: '0.8rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 600 }}>+ new extract</button>
    </div>
  );

  const renderEdit = () => {
    if (!selected) return null;
    const identifier = `EX${extracts.findIndex(r => r.external_reference_id === selected.external_reference_id) + 1}`;
    const tmplNm = selected.document_template_id ? templates.find(t => t.document_template_id === selected.document_template_id)?.name : null;
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', scrollbarWidth: 'thin', scrollbarColor: `${ACCENT_BORDER} transparent` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ color: '#888', fontSize: '0.7rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Editing {identifier}</div>
            {tmplNm && <span style={{ fontSize: '0.6rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 2, padding: '0.02rem 0.35rem' }}>via {tmplNm}</span>}
          </div>
          {selected.document_template_id && (
            <button onClick={() => handleNewVersion(selected)}
              style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.25rem 0.7rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}>
              ▶ new version
            </button>
          )}
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={labelSt}>Title <span style={{ color: '#ef4444' }}>*</span></div>
          <input value={editTitle} onChange={e => setEditTitle(e.target.value)} style={inputSt}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={labelSt}>Filename</div>
          <input value={editFilename} onChange={e => setEditFilename(e.target.value)} placeholder="report.pdf, notes.md..." style={inputSt}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={labelSt}>Context</div>
          <select value={editContext} onChange={e => setEditContext(e.target.value)} style={{ ...inputSt, cursor: 'pointer' } as any}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
            <option value="">— none —</option>
            {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <TagPicker
            key={`edit-tags-${selected.external_reference_id}`}
            selected={editTags}
            allTags={allTags}
            tagGroups={tagGroups}
            onChange={setEditTags}
            onTagCreated={loadAll}
            accentColor={ACCENT}
            objectType="extract"
            contextText={editTitle}
            accessToken={accessToken}
            userId={userId}
            label="Tags"
          />
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={labelSt}>Description</div>
          <input value={editDescription} onChange={e => setEditDescription(e.target.value)} style={inputSt}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={labelSt}>Notes / Content</div>
          <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={8}
            style={{ ...inputSt, resize: 'vertical', minHeight: 140 } as any}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        {editErr && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{editErr}</div>}

        {/* Download row — only shown when there's content */}
        {editNotes && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingBottom: '0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, marginBottom: '0.75rem' }}>
            <span style={{ color: '#aaa', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '0.25rem' }}>Download</span>
            {(['MD', 'TXT', 'PDF', 'DOCX'] as const).map(fmt => (
              <button key={fmt} onClick={() => {
                const c = editNotes; const t = editTitle || selected?.title || 'extract';
                if (fmt === 'MD')   downloadMD(c, t);
                if (fmt === 'TXT')  downloadTXT(c, t);
                if (fmt === 'PDF')  downloadPDF(c, t);
                if (fmt === 'DOCX') downloadDOCX(c, t);
              }} style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, padding: '0.2rem 0.5rem', borderRadius: 3, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >.{fmt.toLowerCase()}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: '0' }}>
          {!deleteConfirm && (
            <button onClick={() => setDeleteConfirm(true)}
              style={{ background: 'transparent', border: '1px solid #3a1a1a', color: '#ef4444', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', marginRight: 'auto' }}>
              delete
            </button>
          )}
          {deleteConfirm && (
            <>
              <span style={{ fontSize: '0.7rem', color: '#ef4444', marginRight: 'auto', alignSelf: 'center' }}>Delete this extract?</span>
              <button onClick={() => setDeleteConfirm(false)}
                style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.7rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
              <button onClick={handleDelete}
                style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 700 }}>yes, delete</button>
            </>
          )}
          {!deleteConfirm && (
            <>
              <button onClick={() => { setRightMode('empty'); setSelected(null); }}
                style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
              <button onClick={handleEditSave} disabled={editSaving}
                style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>
                {editSaving ? '...' : 'save changes'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderCreate = () => {
    if (createPath === 'choose') return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ color: '#888', fontSize: '0.82rem' }}>How do you want to create this extract?</div>
        <div style={{ display: 'flex', gap: '1.25rem' }}>
          {[
            { path: 'template' as CreatePath, icon: '⚡', title: 'From Template', sub: 'Karl generates from your workspace data' },
            { path: 'manual'   as CreatePath, icon: '✍️', title: 'Manual',        sub: 'Write it yourself, Karl can help' },
          ].map(opt => (
            <div key={opt.path} onClick={() => setCreatePath(opt.path)}
              style={{ width: 190, padding: '1.5rem 1rem', border: `2px solid ${ACCENT_BORDER}`, borderRadius: 8, cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = ACCENT; e.currentTarget.style.background = ACCENT_BG; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = ACCENT_BORDER; e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{opt.icon}</div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#333', marginBottom: '0.25rem' }}>{opt.title}</div>
              <div style={{ fontSize: '0.7rem', color: '#aaa' }}>{opt.sub}</div>
            </div>
          ))}
        </div>
        <button onClick={() => setRightMode('empty')} style={{ background: 'none', border: 'none', color: '#ccc', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
      </div>
    );

    if (createPath === 'template' && !previewContent && !generating) return (
      <div style={{ flex: 1, padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={labelSt}>From Template</div>

        <div>
          <div style={labelSt}>Template <span style={{ color: '#ef4444' }}>*</span></div>
          <select value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)} style={{ ...inputSt, cursor: 'pointer' } as any}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
            <option value="">— select a template —</option>
            {templates.map(t => (
              <option key={t.document_template_id} value={t.document_template_id}>
                {t.name}{t.doc_type ? ` · ${t.doc_type}` : ''}{extractCountByTemplate[t.document_template_id] ? ` · ${extractCountByTemplate[t.document_template_id]} runs` : ''}
              </option>
            ))}
          </select>
        </div>

        {selectedTemplate && (
          <div style={{ padding: '0.6rem 0.75rem', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: 4, fontSize: '0.72rem', color: '#777' }}>
            <strong style={{ color: ACCENT }}>Data sources:</strong>{' '}
            {[
              selectedTemplate.data_sources?.situation && 'situation',
              selectedTemplate.data_sources?.tasks && `tasks (${(selectedTemplate.data_sources.tasks.buckets ?? []).join(', ')})`,
              selectedTemplate.data_sources?.completions && `completions (${selectedTemplate.data_sources.completions.window_days}d)`,
              selectedTemplate.data_sources?.meetings && `meetings (${selectedTemplate.data_sources.meetings.window_days}d)`,
              selectedTemplate.data_sources?.references && 'references',
            ].filter(Boolean).join(' · ') || 'none configured'}
          </div>
        )}

        <div>
          <div style={labelSt}>Focus prompt <span style={{ color: '#bbb', textTransform: 'none', fontWeight: 400, letterSpacing: 0 }}>— optional</span></div>
          <textarea value={focusPrompt} onChange={e => setFocusPrompt(e.target.value)} rows={3}
            placeholder="e.g. Focus on the Communication requirement. Include the Oct 15 meeting with my manager."
            style={{ ...inputSt, resize: 'vertical' } as any}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: 'auto' }}>
          <button onClick={() => setCreatePath('choose')} style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.4rem 0.8rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>← back</button>
          <button onClick={handleGenerate} disabled={!selectedTemplateId}
            style={{ background: selectedTemplateId ? ACCENT : '#e5e7eb', border: 'none', color: selectedTemplateId ? '#fff' : '#aaa', padding: '0.4rem 1.25rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', cursor: selectedTemplateId ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
            ▶ Generate
          </button>
        </div>
      </div>
    );

    if (createPath === 'template' && generating) return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
        <KarlSpinner size="lg" color={ACCENT} />
        <div style={{ color: '#888', fontSize: '0.8rem' }}>Karl is generating your extract...</div>
        <div style={{ color: '#ccc', fontSize: '0.7rem' }}>This may take a moment</div>
      </div>
    );

    if (createPath === 'template' && previewContent) return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '0.5rem 1rem', borderBottom: `1px solid ${ACCENT_BORDER}`, background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          <span style={{ color: ACCENT, fontSize: '0.68rem', fontWeight: 600 }}>PREVIEW</span>
          <span style={{ color: '#ccc', fontSize: '0.68rem' }}>— edit directly or refine with Karl →</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => { setPreviewContent(''); setRefineHistory([]); }}
            style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: '#888', padding: '0.2rem 0.5rem', borderRadius: 3, fontSize: '0.67rem', fontFamily: 'monospace', cursor: 'pointer' }}>
            ← regenerate
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <textarea value={previewContent} onChange={e => setPreviewContent(e.target.value)}
            style={{ flex: 3, background: '#fff', border: 'none', borderRight: `1px solid ${ACCENT_BORDER}`, outline: 'none', padding: '1rem', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: 1.7, color: '#222', resize: 'none' }} />

          <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', background: '#fafafa', overflow: 'hidden' }}>
            <div style={{ padding: '0.45rem 0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, flexShrink: 0 }}>
              <span style={{ color: ACCENT, fontSize: '0.63rem', fontWeight: 600 }}>KARL REFINE</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.6rem 0.75rem', scrollbarWidth: 'thin', scrollbarColor: `${ACCENT_BORDER} transparent` }}>
              {refineHistory.length === 0 && <div style={{ color: '#ccc', fontSize: '0.7rem', fontStyle: 'italic' }}>Tell Karl how to improve it. Your hand edits are preserved as input.</div>}
              {refineHistory.map((m, i) => (
                <div key={i} style={{ marginBottom: '0.5rem', fontSize: '0.7rem', color: m.role === 'user' ? '#444' : ACCENT, paddingLeft: m.role === 'user' ? '0.5rem' : 0, borderLeft: m.role === 'user' ? `2px solid ${ACCENT_BORDER}` : 'none' }}>
                  {m.content}
                </div>
              ))}
              {refining && <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><KarlSpinner size="sm" color={ACCENT} /><span style={{ color: '#aaa', fontSize: '0.7rem' }}>Rewriting...</span></div>}
              <div ref={refineBottomRef} />
            </div>
            <div style={{ padding: '0.5rem', borderTop: `1px solid ${ACCENT_BORDER}`, flexShrink: 0 }}>
              <textarea value={refineInput} onChange={e => setRefineInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRefine(); } }}
                placeholder="e.g. More detail on requirement 2..." rows={2}
                style={{ width: '100%', background: '#fff', border: `1px solid #ddd`, borderRadius: 4, padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.7rem', outline: 'none', resize: 'none', boxSizing: 'border-box' }}
                onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              <button onClick={handleRefine} disabled={!refineInput.trim() || refining}
                style={{ marginTop: '0.3rem', width: '100%', background: refineInput.trim() ? ACCENT : '#e5e7eb', border: 'none', color: refineInput.trim() ? '#fff' : '#aaa', padding: '0.3rem', borderRadius: 3, fontSize: '0.7rem', fontFamily: 'monospace', cursor: refineInput.trim() ? 'pointer' : 'not-allowed' }}>
                rewrite ↵
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: '0.65rem 1rem', borderTop: `1px solid ${ACCENT_BORDER}`, background: '#fafafa', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' }}>
            <input value={saveTitle} onChange={e => setSaveTitle(e.target.value)} placeholder="Title *"
              style={{ ...inputSt, flex: 2 }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
            <select value={saveContext} onChange={e => setSaveContext(e.target.value)} style={{ ...inputSt, flex: 1 } as any}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
              <option value="">— context —</option>
              {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
            </select>
          </div>
          <TagPicker
            key={`save-tags-${saveCount}`}
            selected={saveTags}
            allTags={allTags}
            tagGroups={tagGroups}
            onChange={setSaveTags}
            onTagCreated={loadAll}
            accentColor={ACCENT}
            objectType="extract"
            contextText={saveTitle}
            accessToken={accessToken}
            userId={userId}
            label="Tags"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.35rem' }}>
            {saveErr && <span style={{ color: '#ef4444', fontSize: '0.7rem', flex: 1 }}>{saveErr}</span>}
            <button onClick={() => setRightMode('empty')} style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.35rem 0.7rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer' }}>cancel</button>
            <button onClick={handleSaveGenerated} disabled={saving}
              style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.35rem 1rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600 }}>
              {saving ? 'saving...' : 'save extract'}
            </button>
          </div>
        </div>
      </div>
    );

    // Manual path
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem', scrollbarWidth: 'thin', scrollbarColor: `${ACCENT_BORDER} transparent` }}>
          <div style={labelSt}>Manual Extract</div>

          <div>
            <div style={labelSt}>Title <span style={{ color: '#ef4444' }}>*</span></div>
            <input value={manualTitle} onChange={e => setManualTitle(e.target.value)} style={inputSt}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
          </div>

          <div>
            <div style={labelSt}>Filename</div>
            <input value={manualFilename} onChange={e => setManualFilename(e.target.value)} placeholder="report.pdf, notes.md..." style={inputSt}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
          </div>

          <div>
            <div style={labelSt}>Context</div>
            <select value={manualContext} onChange={e => setManualContext(e.target.value)} style={{ ...inputSt, cursor: 'pointer' } as any}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
              <option value="">— none —</option>
              {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <TagPicker
              key={`manual-tags-${saveCount}`}
              selected={manualTags}
              allTags={allTags}
              tagGroups={tagGroups}
              onChange={setManualTags}
              onTagCreated={loadAll}
              accentColor={ACCENT}
              objectType="extract"
              contextText={manualTitle}
              accessToken={accessToken}
              userId={userId}
              label="Tags"
            />
          </div>

          <div>
            <div style={labelSt}>Notes / Content</div>
            <textarea value={manualNotes} onChange={e => setManualNotes(e.target.value)} rows={7}
              placeholder="Write your content here, or use Karl Assist below..."
              style={{ ...inputSt, resize: 'vertical', minHeight: 140 } as any}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
          </div>

          <div style={{ border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ padding: '0.4rem 0.75rem', background: ACCENT_BG, borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ color: ACCENT, fontSize: '0.63rem', fontWeight: 600 }}>KARL ASSIST</span>
              <span style={{ color: '#bbb', fontSize: '0.63rem' }}>— describe what you want, Karl drafts the content</span>
            </div>
            {karlAssistHistory.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: 'auto', padding: '0.5rem 0.75rem', background: '#fff' }}>
                {karlAssistHistory.map((m, i) => (
                  <div key={i} style={{ marginBottom: '0.4rem', fontSize: '0.7rem', color: m.role === 'user' ? '#444' : ACCENT, paddingLeft: m.role === 'user' ? '0.5rem' : 0, borderLeft: m.role === 'user' ? `2px solid ${ACCENT_BORDER}` : 'none' }}>{m.content}</div>
                ))}
                {karlAssistLoading && <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><KarlSpinner size="sm" color={ACCENT} /><span style={{ color: '#aaa', fontSize: '0.7rem' }}>Karl is thinking...</span></div>}
                <div ref={karlBottomRef} />
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem', background: '#fafafa' }}>
              <input value={karlAssistInput} onChange={e => setKarlAssistInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleKarlAssist(); }}
                placeholder="What should go in this extract?" style={{ ...inputSt, marginBottom: 0 }}
                onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              <button onClick={handleKarlAssist} disabled={!karlAssistInput.trim() || karlAssistLoading}
                style={{ background: karlAssistInput.trim() ? ACCENT : '#e5e7eb', border: 'none', color: karlAssistInput.trim() ? '#fff' : '#aaa', padding: '0 0.75rem', borderRadius: 4, fontSize: '0.7rem', fontFamily: 'monospace', cursor: karlAssistInput.trim() ? 'pointer' : 'not-allowed', flexShrink: 0 }}>
                ask
              </button>
            </div>
          </div>

          {saveErr && <div style={{ color: '#ef4444', fontSize: '0.72rem' }}>{saveErr}</div>}
        </div>

        <div style={{ padding: '0.75rem 1.25rem', borderTop: `1px solid ${ACCENT_BORDER}`, background: '#fafafa', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button onClick={() => setCreatePath('choose')} style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.4rem 0.8rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>← back</button>
          <button onClick={handleSaveManual} disabled={saving}
            style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.4rem 1rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>
            {saving ? 'saving...' : 'save extract'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#fff', border: `2px solid ${ACCENT}`, borderRadius: 8, display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden', pointerEvents: 'all' }}>

        <div onMouseDown={e => { dragging.current = true; dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700 }}>Extracts</span>
            <span style={{ color: '#fff', fontSize: '0.7rem', opacity: 0.6 }}>{extracts.length} total</span>
            {filterTemplate && (
              <span style={{ color: '#fff', fontSize: '0.65rem', opacity: 0.8, background: 'rgba(255,255,255,0.15)', padding: '0.1rem 0.4rem', borderRadius: 3 }}>
                ↳ {templates.find(t => t.document_template_id === filterTemplate)?.name}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button onClick={openCreate}
              style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '0.25rem 0.75rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.25)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}>
              + new extract
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.7 }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {renderLeft()}
          {rightMode === 'empty'  && renderEmpty()}
          {rightMode === 'edit'   && renderEdit()}
          {rightMode === 'create' && renderCreate()}
        </div>

        <div onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: 18, height: 18, cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 4 }}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>
      </div>
    </div>
  );
}

const labelSt: React.CSSProperties = {
  color: '#666', fontSize: '0.63rem', marginBottom: '0.3rem',
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
};

const inputSt: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.45rem 0.6rem', borderRadius: 4,
  fontFamily: 'monospace', fontSize: '0.8rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
