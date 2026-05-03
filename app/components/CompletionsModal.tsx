'use client';

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import TagPicker from '@/app/components/TagPicker';
import TaskReportBuilderModal from '@/app/components/TaskReportBuilderModal';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Completion {
  completion_id: string;
  title: string;
  outcome: string;
  description: string | null;
  completed_at: string;
  tags: string[] | null;
  context: { name: string; context_id: string } | null;
  task: { title: string } | null;
  meeting: { title: string } | null;
}

interface FieldMeta {
  field: string;
  label: string;
  display_order: number;
  insert_behavior: string;
  update_behavior: string;
}

interface Context { context_id: string; name: string; }
interface Tag { tag_id: string; name: string; tag_group_id: string; }
interface TagGroup { tag_group_id: string; name: string; }

interface CompletionsModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange: (count: number) => void;
}

/** Fields shown in the default “essentials” completion editor (matches common quick edits). */
const ESSENTIAL_COMPLETION_FIELDS = new Set(['title', 'outcome', 'completed_at']);

interface ListFieldItem {
  field: string;
  label?: string;
  field_order: number;
}

function parseListFields(raw: unknown): ListFieldItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: Record<string, unknown>) => ({
      field: String(row?.field ?? ''),
      label: typeof row?.label === 'string' ? row.label : undefined,
      field_order: typeof row?.field_order === 'number' ? row.field_order : Number(row?.field_order) || 0,
    }))
    .filter((r) => r.field);
}

function orderCompletionFields(listFields: ListFieldItem[], meta: FieldMeta[]): FieldMeta[] {
  const metaByField = new Map(meta.map((m) => [m.field, m]));
  const merged: FieldMeta[] = [];
  const seen = new Set<string>();
  for (const lf of [...listFields].sort((a, b) => a.field_order - b.field_order)) {
    const base = metaByField.get(lf.field);
    if (!base || base.display_order >= 999) continue;
    merged.push(lf.label ? { ...base, label: lf.label } : base);
    seen.add(lf.field);
  }
  const rest = [...meta]
    .filter((m) => !seen.has(m.field) && m.display_order < 999)
    .sort((a, b) => a.display_order - b.display_order);
  return [...merged, ...rest];
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function exportAsCSV(completions: Completion[]): void {
  const headers = ['Date', 'Title', 'Outcome', 'Description', 'Tags', 'Context', 'Task', 'Meeting'];
  const rows = completions.map(c => [
    formatDate(c.completed_at),
    `"${c.title.replace(/"/g, '""')}"`,
    `"${(c.outcome ?? '').replace(/"/g, '""')}"`,
    `"${(c.description ?? '').replace(/"/g, '""')}"`,
    `"${(c.tags ?? []).join(', ')}"`,
    c.context?.name ?? '',
    c.task?.title ?? '',
    c.meeting?.title ?? '',
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `completions-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function exportAsMD(completions: Completion[]): void {
  const lines = ['# Completions', ''];
  for (const c of completions) {
    lines.push(`## ${c.title}`);
    lines.push(`**Date:** ${formatDate(c.completed_at)}`);
    if (c.context) lines.push(`**Context:** ${c.context.name}`);
    if (c.tags?.length) lines.push(`**Tags:** ${c.tags.join(', ')}`);
    lines.push(''); lines.push('**Outcome:**'); lines.push(c.outcome ?? '');
    if (c.description) { lines.push(''); lines.push('**Description:**'); lines.push(c.description); }
    if (c.task) lines.push(`**Task:** ${c.task.title}`);
    if (c.meeting) lines.push(`**Meeting:** ${c.meeting.title}`);
    lines.push(''); lines.push('---'); lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `completions-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  URL.revokeObjectURL(url);
}

const ACCENT        = '#f97316';
const ACCENT_BG     = '#fff8f0';
const ACCENT_BORDER = '#fde8d0';

/** Match Task Detail modal chrome for the per-completion editor overlay. */
const DETAIL_ACCENT        = '#fbbf24';
const DETAIL_BORDER        = '#fde68a';
const DETAIL_BG            = '#fffbeb';
const DETAIL_DEFAULT_W     = 560;
const DETAIL_DEFAULT_H     = 640;
const DETAIL_MIN_W         = 420;
const DETAIL_MIN_H         = 400;

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function CompletionsModal({ userId, accessToken, onClose, onCountChange }: CompletionsModalProps) {
  const [mode, setMode]               = useState<'empty' | 'edit' | 'add'>('empty');
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loading, setLoading]         = useState(true);
  const [selected, setSelected]       = useState<Completion | null>(null);
  const [contexts, setContexts]       = useState<Context[]>([]);
  const [allTags, setAllTags]         = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]     = useState<TagGroup[]>([]);
  const [fieldMeta, setFieldMeta]     = useState<FieldMeta[]>([]);
  const [listFields, setListFields]   = useState<ListFieldItem[]>([]);
  const [detailFullForm, setDetailFullForm] = useState(true);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showReportBuilder, setShowReportBuilder] = useState(false);
  const [confirmDelete, setConfirmDelete]   = useState(false);
  const [deleting, setDeleting]             = useState(false);

  // ─── Search/filter ─────────────────────────────────────────────────────────
  const [search, setSearch]               = useState('');
  const [filterTag, setFilterTag]         = useState('');
  const [filterContext, setFilterContext] = useState('');
  const [filterDateRange, setFilterDateRange] = useState<'all' | 'today' | 'week' | 'month'>('all');

  // ─── Drag/resize (main list modal) ─────────────────────────────────────────
  const defaultListW = 920;
  const defaultListH = 800;
  const initX = Math.max(20, Math.round(window.innerWidth / 2 - defaultListW / 2));
  const initY = Math.max(20, Math.round(window.innerHeight / 2 - defaultListH / 2));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: defaultListW, h: defaultListH });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragStart       = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeStart     = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef        = useRef<HTMLDivElement>(null);

  // ─── Drag/resize (completion detail overlay — Task Detail style) ─────────
  const detailInitX = Math.max(20, Math.round(window.innerWidth / 2 - DETAIL_DEFAULT_W / 2));
  const detailInitY = Math.max(20, Math.round(window.innerHeight / 2 - DETAIL_DEFAULT_H / 2));
  const [detailPos, setDetailPos]     = useState({ x: detailInitX, y: detailInitY });
  const [detailSize, setDetailSize]   = useState({ w: DETAIL_DEFAULT_W, h: DETAIL_DEFAULT_H });
  const detailDragging                = useRef(false);
  const detailResizing                = useRef(false);
  const detailDragOffset              = useRef({ x: 0, y: 0 });
  const detailResizeStart             = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // ─── Form state ────────────────────────────────────────────────────────────
  const [editId, setEditId]                   = useState<string | null>(null);
  const [formTitle, setFormTitle]             = useState('');
  const [formOutcome, setFormOutcome]         = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCompletedAt, setFormCompletedAt] = useState('');
  const [formTags, setFormTags]               = useState<string[]>([]);
  const [formContextId, setFormContextId]     = useState('');

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadCompletions = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('completion')
      .select(`completion_id, title, outcome, description, completed_at, tags,
        context:context_id ( name, context_id ),
        task:task_id ( title ),
        meeting:meeting_id ( title )`)
      .eq('user_id', userId)
      .order('completed_at', { ascending: false });
    if (data) { setCompletions(data as any); onCountChange(data.length); }
    setLoading(false);
  };

  const loadContexts = async () => {
    const { data } = await supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false).order('name');
    if (data) setContexts(data);
  };

  const loadTags = async () => {
    const { data: groups } = await supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).order('name');
    if (groups) setTagGroups(groups);
    const { data: tags } = await supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId).order('name');
    if (tags) setAllTags(tags);
  };

  const loadFieldMeta = async () => {
    const [metaRes, listRes] = await Promise.all([
      supabase
        .from('ko_field_metadata')
        .select('field, label, display_order, insert_behavior, update_behavior')
        .eq('user_id', userId)
        .eq('object_type', 'completion')
        .order('display_order'),
      supabase.from('ko_list_view_config').select('list_fields').eq('user_id', userId).eq('object_type', 'completion').maybeSingle(),
    ]);
    if (metaRes.data) setFieldMeta(metaRes.data);
    setListFields(parseListFields(listRes.data?.list_fields));
  };

  useEffect(() => { loadCompletions(); loadContexts(); loadTags(); loadFieldMeta(); }, []);

  const closeDetail = useCallback(() => {
    setMode('empty');
    setSelected(null);
    setConfirmDelete(false);
    setErr('');
    setShowExportMenu(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showReportBuilder) {
        setShowReportBuilder(false);
        return;
      }
      if (confirmDelete) {
        setConfirmDelete(false);
        return;
      }
      if (mode !== 'empty') {
        closeDetail();
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, confirmDelete, showReportBuilder, closeDetail, onClose]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.mx), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.my) });
      }
      if (resizing.current) {
        setSize({ w: Math.max(400, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)) });
      }
      if (detailDragging.current) {
        setDetailPos({
          x: Math.max(0, e.clientX - detailDragOffset.current.x),
          y: Math.max(0, e.clientY - detailDragOffset.current.y),
        });
      }
      if (detailResizing.current) {
        setDetailSize({
          w: Math.max(DETAIL_MIN_W, detailResizeStart.current.w + (e.clientX - detailResizeStart.current.x)),
          h: Math.max(DETAIL_MIN_H, detailResizeStart.current.h + (e.clientY - detailResizeStart.current.y)),
        });
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
      detailDragging.current = false;
      detailResizing.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  const onDetailDragStart = useCallback((e: React.MouseEvent) => {
    detailDragging.current = true;
    detailDragOffset.current = { x: e.clientX - detailPos.x, y: e.clientY - detailPos.y };
    e.preventDefault();
  }, [detailPos]);

  const onDetailResizeStart = useCallback((e: React.MouseEvent) => {
    detailResizing.current = true;
    detailResizeStart.current = { x: e.clientX, y: e.clientY, w: detailSize.w, h: detailSize.h };
    e.preventDefault();
    e.stopPropagation();
  }, [detailSize]);

  // ─── Filtered list ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return completions.filter((c) => {
      if (search && !c.title.toLowerCase().includes(search.toLowerCase()) && !(c.outcome ?? '').toLowerCase().includes(search.toLowerCase())) return false;
      if (filterTag && !(c.tags ?? []).includes(filterTag)) return false;
      if (filterContext && c.context?.context_id !== filterContext) return false;
      if (filterDateRange !== 'all') {
        const d = new Date(c.completed_at);
        const now = new Date();
        if (filterDateRange === 'today') {
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const end = new Date(start);
          end.setDate(end.getDate() + 1);
          if (d < start || d >= end) return false;
        }
        if (filterDateRange === 'week') {
          const wk = new Date(now);
          wk.setDate(now.getDate() - 7);
          if (d < wk) return false;
        }
        if (filterDateRange === 'month') {
          const mo = new Date(now);
          mo.setMonth(now.getMonth() - 1);
          if (d < mo) return false;
        }
      }
      return true;
    });
  }, [completions, search, filterTag, filterContext, filterDateRange]);

  const completionReportScope = useMemo(
    () => ({
      contextId: filterContext,
      tag: filterTag,
      dateRange: filterDateRange,
      filteredCount: filtered.length,
    }),
    [filterContext, filterTag, filterDateRange, filtered.length]
  );

  const orderedFormFields = useMemo(() => orderCompletionFields(listFields, fieldMeta), [listFields, fieldMeta]);

  const visibleFieldsForForm = useMemo(() => {
    if (mode === 'empty') return [];
    const isAdd = mode === 'add';
    return orderedFormFields.filter((f) =>
      isAdd ? f.insert_behavior !== 'automatic' : f.update_behavior !== 'automatic' && f.update_behavior !== 'readonly'
    );
  }, [orderedFormFields, mode]);

  const hasExtraBeyondEssentials = useMemo(
    () => mode === 'edit' && visibleFieldsForForm.some((f) => !ESSENTIAL_COMPLETION_FIELDS.has(f.field)),
    [mode, visibleFieldsForForm]
  );

  const fieldsToRender = useMemo(() => {
    if (mode === 'add' || detailFullForm) return visibleFieldsForForm;
    const ess = visibleFieldsForForm.filter((f) => ESSENTIAL_COMPLETION_FIELDS.has(f.field));
    return ess.length > 0 ? ess : visibleFieldsForForm;
  }, [mode, detailFullForm, visibleFieldsForForm]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const centerDetailPanel = () => {
    setDetailPos({
      x: Math.max(20, Math.round(window.innerWidth / 2 - DETAIL_DEFAULT_W / 2)),
      y: Math.max(20, Math.round(window.innerHeight / 2 - DETAIL_DEFAULT_H / 2)),
    });
    setDetailSize({ w: DETAIL_DEFAULT_W, h: DETAIL_DEFAULT_H });
  };

  const loadIntoForm = (c: Completion) => {
    setEditId(c.completion_id);
    setFormTitle(c.title);
    setFormOutcome(c.outcome ?? '');
    setFormDescription(c.description ?? '');
    setFormCompletedAt(c.completed_at ? c.completed_at.slice(0, 16) : '');
    setFormTags(c.tags ?? []);
    setFormContextId(c.context?.context_id ?? '');
    setErr('');
    setConfirmDelete(false);
    setSelected(c);
    setDetailFullForm(false);
    centerDetailPanel();
    setMode('edit');
  };

  const openAdd = () => {
    setEditId(null);
    setFormTitle('');
    setFormOutcome('');
    setFormDescription('');
    setFormCompletedAt(new Date().toISOString().slice(0, 16));
    setFormTags([]);
    setFormContextId('');
    setErr('');
    setConfirmDelete(false);
    setSelected(null);
    setDetailFullForm(true);
    centerDetailPanel();
    setMode('add');
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    if (!formOutcome.trim()) { setErr('Outcome is required'); return; }
    if (!formCompletedAt) { setErr('Completed date is required'); return; }
    setSaving(true); setErr('');

    const payload: any = {
      title: formTitle.trim(), outcome: formOutcome.trim(),
      description: formDescription.trim() || null,
      completed_at: new Date(formCompletedAt).toISOString(),
      tags: formTags.length > 0 ? formTags : null,
      context_id: formContextId || null,
    };

    try {
      if (mode === 'add') {
        const { error } = await supabase.from('completion').insert({ ...payload, user_id: userId });
        if (error) throw error;
      } else if (mode === 'edit' && editId) {
        const { error } = await supabase.from('completion').update(payload).eq('completion_id', editId).eq('user_id', userId);
        if (error) throw error;
      }
      await loadCompletions();
      closeDetail();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!editId) return;
    setDeleting(true); setErr('');
    try {
      const { error } = await supabase.from('completion').delete().eq('completion_id', editId).eq('user_id', userId);
      if (error) throw error;
      await loadCompletions();
      closeDetail();
      setConfirmDelete(false);
    } catch (e: any) { setErr(e.message); }
    finally { setDeleting(false); }
  };

  // ─── Field renderer ────────────────────────────────────────────────────────

  const renderField = (meta: FieldMeta) => {
    const isAdd = mode === 'add';
    const isReadonly = isAdd ? meta.insert_behavior === 'automatic' : meta.update_behavior === 'readonly' || meta.update_behavior === 'automatic';
    if (isReadonly) return null;

    const required = isAdd && meta.insert_behavior === 'required';
    const label = (
      <div style={formLabelStyle}>
        {meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}
      </div>
    );

    const outcomeRows = detailFullForm || mode === 'add' ? 6 : 4;

    switch (meta.field) {
      case 'title':
        return <div key="title" style={detailFieldGroup}>{label}<input value={formTitle} onChange={e => setFormTitle(e.target.value)} style={inputStyle} onFocus={e => (e.target.style.borderColor = DETAIL_ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'outcome':
        return <div key="outcome" style={detailFieldGroup}>{label}<textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)} rows={outcomeRows} style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }} onFocus={e => (e.target.style.borderColor = DETAIL_ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'description':
        return <div key="description" style={detailFieldGroup}>{label}<textarea value={formDescription} onChange={e => setFormDescription(e.target.value)} rows={detailFullForm || mode === 'add' ? 4 : 2} style={{ ...inputStyle, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = DETAIL_ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'completed_at':
        return <div key="completed_at" style={detailFieldGroup}>{label}<input type="datetime-local" value={formCompletedAt} onChange={e => setFormCompletedAt(e.target.value)} style={{ ...inputStyle, colorScheme: 'light' }} onFocus={e => (e.target.style.borderColor = DETAIL_ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'tags':
        return (
          <div key="tags" style={{ ...detailFieldGroup, borderTop: '1px solid #f0f0f0', paddingTop: '0.75rem' }}>
            <TagPicker
              selected={formTags}
              allTags={allTags}
              tagGroups={tagGroups}
              onChange={setFormTags}
              onTagCreated={loadTags}
              accentColor={DETAIL_ACCENT}
              objectType="completion"
              contextText={formTitle}
              accessToken={accessToken}
              userId={userId}
              label="Tags"
            />
          </div>
        );

      case 'context_id':
        return (
          <div key="context_id" style={detailFieldGroup}>{label}
            <select value={formContextId} onChange={e => setFormContextId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} onFocus={e => (e.target.style.borderColor = DETAIL_ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
              <option value="">— none —</option>
              {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
            </select>
          </div>
        );

      default: return null;
    }
  };

  const isAdd = mode === 'add';
  const detailTitle =
    isAdd ? 'New completion' : `Completion · CM${completions.findIndex((c) => c.completion_id === editId) + 1}`;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div ref={modalRef} style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden', pointerEvents: 'all' }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>Completions</span>
            <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{completions.length} total</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowExportMenu(v => !v)}
                style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#222')} onMouseLeave={e => (e.currentTarget.style.background = '#000')}
              >export ▾</button>
              {showExportMenu && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '0.25rem', background: '#fff', border: '1px solid #ddd', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 10, minWidth: '160px' }}>
                  <div onClick={() => { setShowReportBuilder(true); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace', borderBottom: '1px solid #f0f0f0' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Report Builder</div>
                  <div onClick={() => { exportAsCSV(filtered); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace', borderBottom: '1px solid #f0f0f0' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Export CSV</div>
                  <div onClick={() => { exportAsMD(filtered); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Export MD</div>
                </div>
              )}
            </div>
            <button onClick={openAdd}
              style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.background = '#222')} onMouseLeave={e => (e.currentTarget.style.background = '#000')}
            >+ new</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.5 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>✕</button>
          </div>
        </div>

        {/* Body — single column: filters + completion cards (task-detail style rows) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '0.5rem 0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column', gap: '0.35rem', flexShrink: 0 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or outcome..."
              style={{ ...inputStyle, fontSize: '0.72rem', padding: '0.38rem 0.55rem' }}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)} onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            />
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <select value={filterContext} onChange={(e) => setFilterContext(e.target.value)} style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.28rem 0.45rem' }}>
                <option value="">All contexts</option>
                {contexts.map((c) => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
              </select>
              <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.28rem 0.45rem' }}>
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t.tag_id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <select value={filterDateRange} onChange={(e) => setFilterDateRange(e.target.value as 'all' | 'today' | 'week' | 'month')} style={{ ...inputStyle, fontSize: '0.7rem', padding: '0.28rem 0.45rem' }}>
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
            <div style={{ color: '#999', fontSize: '0.62rem', fontFamily: 'monospace', lineHeight: 1.35 }}>
              {filtered.length} of {completions.length} · CSV / MD use this list. Report Builder uses the same filters (plus optional extra scope tags).
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '0.45rem 0.65rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
            {loading ? (
              <div style={{ color: '#999', fontSize: '0.78rem', padding: '1.5rem', fontFamily: 'monospace', textAlign: 'center' }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ color: '#bbb', fontSize: '0.78rem', padding: '1.5rem', fontFamily: 'monospace', textAlign: 'center' }}>No completions match.</div>
            ) : (
              filtered.map((c) => {
                const idx = completions.findIndex((x) => x.completion_id === c.completion_id) + 1;
                const isOpen = mode === 'edit' && selected?.completion_id === c.completion_id;
                return (
                  <div
                    key={c.completion_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => loadIntoForm(c)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadIntoForm(c); } }}
                    style={{
                      border: `1px solid ${DETAIL_BORDER}`,
                      borderRadius: '6px',
                      padding: '0.4rem 0.55rem',
                      marginBottom: '0.38rem',
                      background: '#fff',
                      cursor: 'pointer',
                      outline: 'none',
                      boxShadow: isOpen ? `0 0 0 2px ${DETAIL_ACCENT}` : '0 1px 2px rgba(0,0,0,0.04)',
                      transition: 'box-shadow 0.12s, border-color 0.12s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{ color: '#ca8a04', fontSize: '0.62rem', fontWeight: 700, fontFamily: 'monospace' }}>{`CM${idx}`}</span>
                      <span style={{ color: '#888', fontSize: '0.65rem', fontFamily: 'monospace', flexShrink: 0 }}>{formatDate(c.completed_at)}</span>
                    </div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#111', marginTop: '0.15rem', lineHeight: 1.3 }}>{c.title}</div>
                    {(c.outcome ?? '').trim() ? (
                      <div
                        style={{
                          fontSize: '0.7rem',
                          color: '#555',
                          marginTop: '0.2rem',
                          lineHeight: 1.38,
                          display: '-webkit-box',
                          WebkitLineClamp: 1,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {c.outcome}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.22rem', marginTop: '0.28rem', alignItems: 'center' }}>
                      {c.context ? (
                        <span style={{ fontSize: '0.58rem', padding: '0.06rem 0.32rem', borderRadius: '3px', background: DETAIL_BG, border: `1px solid ${DETAIL_BORDER}`, color: '#444' }}>{c.context.name}</span>
                      ) : null}
                      {(c.tags ?? []).map((t) => (
                        <span key={t} style={{ fontSize: '0.58rem', padding: '0.06rem 0.32rem', borderRadius: '3px', background: '#fafafa', border: '1px solid #e5e5e5', color: '#555' }}>{t}</span>
                      ))}
                      {c.task?.title ? (
                        <span style={{ fontSize: '0.6rem', color: '#999', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }} title={c.task.title}>↳ {c.task.title}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Resize handle */}
        <div onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }} style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>

      </div>
    </div>

    {/* Completion detail — Task Detail–style overlay */}
    {mode !== 'empty' && (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 110, background: 'rgba(0,0,0,0.14)', pointerEvents: 'all' }}
        onClick={() => { if (!saving && !deleting) closeDetail(); }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: detailPos.x,
            top: detailPos.y,
            width: detailSize.w,
            height: detailSize.h,
            background: '#fff',
            border: `2px solid ${DETAIL_ACCENT}`,
            borderRadius: '8px',
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'monospace',
            boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
            overflow: 'hidden',
          }}
        >
          <div
            onMouseDown={onDetailDragStart}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.85rem 1.25rem',
              background: DETAIL_ACCENT,
              cursor: 'grab',
              userSelect: 'none',
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>{detailTitle}</span>
            <button
              type="button"
              onClick={() => { if (!saving && !deleting) closeDetail(); }}
              style={{ background: 'none', border: 'none', color: 'rgba(0,0,0,0.45)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#000')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(0,0,0,0.45)')}
            >✕</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              <div style={{ color: '#888', fontSize: '0.72rem', lineHeight: 1.45, maxWidth: '72%' }}>
                {isAdd ? 'Add a standalone completion. All editable fields from your workspace settings are shown.' : 'Edit inline. Open all fields when you need tags, context, or longer notes.'}
              </div>
              {hasExtraBeyondEssentials ? (
                <button
                  type="button"
                  onClick={() => setDetailFullForm((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '0.28rem 0.75rem',
                    borderRadius: '999px',
                    fontSize: '0.68rem',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    border: detailFullForm ? '1px solid #ddd' : `1px solid ${DETAIL_ACCENT}`,
                    background: detailFullForm ? '#fafafa' : DETAIL_BG,
                    color: '#111',
                  }}
                >
                  {detailFullForm ? '← essentials' : 'all fields →'}
                </button>
              ) : null}
            </div>
            {fieldsToRender.map((f) => renderField(f))}
            {err ? <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.5rem' }}>{err}</div> : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.25rem', borderTop: `1px solid ${DETAIL_BORDER}`, background: '#fafafa', flexShrink: 0 }}>
            {confirmDelete ? (
              <div style={{ fontSize: '0.72rem', color: '#ef4444', textAlign: 'center' }}>Delete this completion? This cannot be undone.</div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div>
                {mode === 'edit' && !confirmDelete ? (
                  <button type="button" onClick={() => setConfirmDelete(true)}
                    style={{ background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '0.4rem 0.85rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>
                    ✕ delete
                  </button>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
                {confirmDelete ? (
                  <>
                    <button type="button" onClick={() => setConfirmDelete(false)} style={detailCancelBtn}>back</button>
                    <button type="button" onClick={handleDelete} disabled={deleting} style={{ ...detailSaveBtn, background: '#ef4444', borderColor: '#ef4444', color: '#fff' }}>{deleting ? '…' : 'delete'}</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => { if (!saving) closeDetail(); }} style={detailCancelBtn}>cancel</button>
                    <button type="button" onClick={handleSave} disabled={saving} style={{ ...detailSaveBtn, background: DETAIL_ACCENT, borderColor: DETAIL_ACCENT, color: '#000', fontWeight: 700 }}>
                      {saving ? '…' : isAdd ? 'save completion' : 'save'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          <div
            onMouseDown={onDetailResizeStart}
            style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1 7L7 1M4 7L7 4" stroke={DETAIL_ACCENT} strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>
    )}

    {showReportBuilder && (
      <TaskReportBuilderModal
        userId={userId}
        accessToken={accessToken}
        contextOptions={contexts}
        initialScopeTags={filterTag ? [filterTag] : []}
        variant="completion"
        completionScope={completionReportScope}
        onClose={() => setShowReportBuilder(false)}
      />
    )}
    </>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const formLabelStyle: React.CSSProperties = {
  color: '#000', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
};

const detailFieldGroup: React.CSSProperties = { marginBottom: '1rem' };

const detailCancelBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #ddd', color: '#666',
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};

const detailSaveBtn: React.CSSProperties = {
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer', border: '1px solid transparent',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
