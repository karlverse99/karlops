'use client';

import { useEffect, useState, useRef } from 'react';
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
  a.href = url;
  a.download = `completions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportAsMD(completions: Completion[]): void {
  const lines = ['# Completions', ''];
  for (const c of completions) {
    lines.push(`## ${c.title}`);
    lines.push(`**Date:** ${formatDate(c.completed_at)}`);
    if (c.context) lines.push(`**Context:** ${c.context.name}`);
    if (c.tags?.length) lines.push(`**Tags:** ${c.tags.join(', ')}`);
    lines.push('');
    lines.push(`**Outcome:**`);
    lines.push(c.outcome ?? '');
    if (c.description) { lines.push(''); lines.push(`**Description:**`); lines.push(c.description); }
    if (c.task) lines.push(`**Task:** ${c.task.title}`);
    if (c.meeting) lines.push(`**Meeting:** ${c.meeting.title}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `completions-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

const ACCENT = '#f97316';
const ACCENT_BG = '#fff8f0';
const ACCENT_BORDER = '#fde8d0';

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function CompletionsModal({ userId, accessToken, onClose, onCountChange }: CompletionsModalProps) {
  const [mode, setMode]                   = useState<'browse' | 'add' | 'edit'>('browse');
  const [completions, setCompletions]     = useState<Completion[]>([]);
  const [loading, setLoading]             = useState(true);
  const [selected, setSelected]           = useState<Completion | null>(null);
  const [contexts, setContexts]           = useState<Context[]>([]);
  const [allTags, setAllTags]             = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]         = useState<TagGroup[]>([]);
  const [fieldMeta, setFieldMeta]         = useState<FieldMeta[]>([]);
  const [saving, setSaving]               = useState(false);
  const [err, setErr]                     = useState('');

  // ─── Search/filter state ───────────────────────────────────────────────────
  const [search, setSearch]               = useState('');
  const [filterTag, setFilterTag]         = useState('');
  const [filterDateRange, setFilterDateRange] = useState<'all' | 'week' | 'month'>('all');
  const [showExportMenu, setShowExportMenu] = useState(false);

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 1000, h: 640 });
  const [centered, setCentered] = useState(true);
  const dragging                = useRef(false);
  const resizing                = useRef(false);
  const dragStart               = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef                = useRef<HTMLDivElement>(null);

  // ─── Form state ────────────────────────────────────────────────────────────
  const [editId, setEditId]                   = useState<string | null>(null);
  const [formTitle, setFormTitle]             = useState('');
  const [formOutcome, setFormOutcome]         = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCompletedAt, setFormCompletedAt] = useState('');
  const [formTags, setFormTags]               = useState<string[]>([]);
  const [formContextId, setFormContextId]     = useState('');
  const [tagSearch, setTagSearch]             = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [showTagDrop, setShowTagDrop]         = useState(false);

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadCompletions = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('completion')
      .select(`
        completion_id, title, outcome, description, completed_at, tags,
        context:context_id ( name, context_id ),
        task:task_id ( title ),
        meeting:meeting_id ( title )
      `)
      .eq('user_id', userId)
      .order('completed_at', { ascending: false });

    if (data) {
      setCompletions(data as any);
      onCountChange(data.length);
    }
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
    const { data } = await supabase
      .from('ko_field_metadata')
      .select('field, label, display_order, insert_behavior, update_behavior')
      .eq('user_id', userId)
      .eq('object_type', 'completion')
      .lt('display_order', 999)
      .order('display_order');
    if (data) setFieldMeta(data);
  };

  useEffect(() => { loadCompletions(); loadContexts(); loadTags(); loadFieldMeta(); }, []);

  // ─── Keyboard / drag / resize ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) { setPos({ x: dragStart.current.x + (e.clientX - dragStart.current.mx), y: dragStart.current.y + (e.clientY - dragStart.current.my) }); setCentered(false); }
      if (resizing.current) { setSize({ w: Math.max(700, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)) }); }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Filtered list ─────────────────────────────────────────────────────────

  const filtered = completions.filter(c => {
    if (search && !c.title.toLowerCase().includes(search.toLowerCase()) && !(c.outcome ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTag && !(c.tags ?? []).includes(filterTag)) return false;
    if (filterDateRange !== 'all') {
      const d = new Date(c.completed_at);
      const now = new Date();
      if (filterDateRange === 'week') { const wk = new Date(now); wk.setDate(now.getDate() - 7); if (d < wk) return false; }
      if (filterDateRange === 'month') { const mo = new Date(now); mo.setMonth(now.getMonth() - 1); if (d < mo) return false; }
    }
    return true;
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditId(null); setFormTitle(''); setFormOutcome(''); setFormDescription('');
    setFormCompletedAt(new Date().toISOString().slice(0, 16));
    setFormTags([]); setFormContextId(''); setTagSearch(''); setSelectedGroupId(''); setErr('');
    setMode('add');
  };

  const openEdit = (c: Completion) => {
    setEditId(c.completion_id); setFormTitle(c.title); setFormOutcome(c.outcome ?? '');
    setFormDescription(c.description ?? '');
    setFormCompletedAt(c.completed_at ? c.completed_at.slice(0, 16) : '');
    setFormTags(c.tags ?? []); setFormContextId(c.context?.context_id ?? '');
    setTagSearch(''); setSelectedGroupId(''); setErr('');
    setMode('edit');
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
        const { data, error } = await supabase.from('completion').insert({ ...payload, user_id: userId }).select(`completion_id, title, outcome, description, completed_at, tags, context:context_id(name,context_id), task:task_id(title), meeting:meeting_id(title)`).single();
        if (error) throw error;
        await loadCompletions();
        setSelected(data as any);
      } else if (mode === 'edit' && editId) {
        const { error } = await supabase.from('completion').update(payload).eq('completion_id', editId).eq('user_id', userId);
        if (error) throw error;
        await loadCompletions();
        // Refresh selected
        const updated = { ...selected!, ...payload, context: contexts.find(c => c.context_id === formContextId) ? { name: contexts.find(c => c.context_id === formContextId)!.name, context_id: formContextId } : null };
        setSelected(updated as any);
      }
      setMode('browse');
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const toggleTag = (name: string) => setFormTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);

  const filteredPickerTags = allTags.filter(t => {
    const matchesGroup = selectedGroupId ? t.tag_group_id === selectedGroupId : true;
    const matchesSearch = tagSearch ? t.name.toLowerCase().includes(tagSearch.toLowerCase()) : true;
    return matchesGroup && matchesSearch && !formTags.includes(t.name);
  });

  // ─── Render: left panel ────────────────────────────────────────────────────

  const renderList = () => (
    <div style={{ width: '340px', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${ACCENT_BORDER}`, height: '100%' }}>

      {/* Search + filters */}
      <div style={{ padding: '0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title or outcome..."
          style={{ ...inputStyle, fontSize: '0.75rem', padding: '0.4rem 0.6rem' }}
          onFocus={e => (e.target.style.borderColor = ACCENT)}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <select value={filterTag} onChange={e => setFilterTag(e.target.value)}
            style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}
          >
            <option value="">All tags</option>
            {allTags.map(t => <option key={t.tag_id} value={t.name}>{t.name}</option>)}
          </select>
          <select value={filterDateRange} onChange={e => setFilterDateRange(e.target.value as any)}
            style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}
          >
            <option value="all">All time</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
          </select>
        </div>
        <div style={{ color: '#999', fontSize: '0.65rem', fontFamily: 'monospace' }}>{filtered.length} of {completions.length}</div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>No completions found.</div>
        ) : (
          filtered.map((c, idx) => {
            const isSelected = selected?.completion_id === c.completion_id;
            const identifier = `CM${completions.indexOf(c) + 1}`;
            return (
              <div key={c.completion_id}
                onClick={() => { setSelected(c); setMode('browse'); }}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', cursor: 'pointer', background: isSelected ? ACCENT_BG : 'transparent', borderLeft: `3px solid ${isSelected ? ACCENT : 'transparent'}`, transition: 'all 0.1s' }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#fafafa'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: ACCENT, fontSize: '0.6rem', fontWeight: 600, opacity: 0.5, flexShrink: 0, fontFamily: 'monospace' }}>{identifier}</span>
                <span style={{ color: ACCENT, fontSize: '0.62rem', flexShrink: 0, fontFamily: 'monospace' }}>{formatDate(c.completed_at)}</span>
                <span style={{ color: '#111', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace' }}>{c.title}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  // ─── Render: right panel — detail ─────────────────────────────────────────

  const renderDetail = () => {
    if (!selected) return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', fontSize: '0.8rem', fontFamily: 'monospace', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '1.5rem', opacity: 0.3 }}>✓</div>
        <div>Select a completion to view details</div>
      </div>
    );

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* Title + actions */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div style={{ color: '#111', fontSize: '1rem', fontWeight: 700, fontFamily: 'monospace', flex: 1 }}>{selected.title}</div>
          <button onClick={() => openEdit(selected)}
            style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.25rem 0.7rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600, flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ea6c00')}
            onMouseLeave={e => (e.currentTarget.style.background = ACCENT)}
          >edit</button>
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: ACCENT, fontSize: '0.72rem', fontFamily: 'monospace' }}>{formatDateTime(selected.completed_at)}</span>
          {selected.context && <span style={{ color: '#555', fontSize: '0.72rem', fontFamily: 'monospace' }}>{selected.context.name}</span>}
          {selected.task && <span style={{ color: '#777', fontSize: '0.72rem', fontFamily: 'monospace' }}>↳ {selected.task.title}</span>}
          {selected.meeting && <span style={{ color: '#777', fontSize: '0.72rem', fontFamily: 'monospace' }}>↳ {selected.meeting.title}</span>}
        </div>

        {/* Tags */}
        {selected.tags && selected.tags.length > 0 && (
          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
            {selected.tags.map(tag => (
              <span key={tag} style={{ fontSize: '0.68rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '3px', padding: '0.15rem 0.4rem', fontFamily: 'monospace' }}>{tag}</span>
            ))}
          </div>
        )}

        {/* Outcome */}
        <div>
          <div style={detailLabelStyle}>Outcome</div>
          <div style={{ color: '#222', fontSize: '0.82rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: '6px', padding: '0.75rem 1rem', fontFamily: 'monospace' }}>{selected.outcome}</div>
        </div>

        {/* Description */}
        {selected.description && (
          <div>
            <div style={detailLabelStyle}>Description</div>
            <div style={{ color: '#444', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{selected.description}</div>
          </div>
        )}

      </div>
    );
  };

  // ─── Render: right panel — form ────────────────────────────────────────────

  const renderForm = () => {
    const isAdd = mode === 'add';
    const visibleFields = fieldMeta.filter(f => isAdd ? f.insert_behavior !== 'automatic' : f.update_behavior !== 'automatic' && f.update_behavior !== 'readonly');

    const renderField = (meta: FieldMeta) => {
      const required = isAdd ? meta.insert_behavior === 'required' : false;
      const label = <div style={formLabelStyle}>{meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}</div>;

      switch (meta.field) {
        case 'title':
          return <div key="title" style={{ marginBottom: '0.85rem' }}>{label}<input autoFocus value={formTitle} onChange={e => setFormTitle(e.target.value)} style={inputStyle} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
        case 'outcome':
          return <div key="outcome" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
        case 'description':
          return <div key="description" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formDescription} onChange={e => setFormDescription(e.target.value)} rows={1} style={{ ...inputStyle, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
        case 'completed_at':
          return <div key="completed_at" style={{ marginBottom: '0.85rem' }}>{label}<input type="datetime-local" value={formCompletedAt} onChange={e => setFormCompletedAt(e.target.value)} style={{ ...inputStyle, colorScheme: 'light' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
        case 'tags':
          return (
            <div key="tags" style={{ marginBottom: '0.85rem' }}>
              {label}
              {formTags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
                  {formTags.map(tag => (
                    <span key={tag} onClick={() => toggleTag(tag)} style={{ fontSize: '0.72rem', color: '#fff', background: ACCENT, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}>{tag} <span style={{ opacity: 0.8 }}>✕</span></span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <select value={selectedGroupId} onChange={e => setSelectedGroupId(e.target.value)} style={{ ...inputStyle, flex: '0 0 130px', fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}>
                  <option value="">All groups</option>
                  {tagGroups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
                </select>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input value={tagSearch} onChange={e => { setTagSearch(e.target.value); setShowTagDrop(true); }} onFocus={() => setShowTagDrop(true)} onBlur={() => setTimeout(() => setShowTagDrop(false), 150)} placeholder="Search tags..." style={{ ...inputStyle, marginBottom: 0 }} onFocusCapture={e => (e.target.style.borderColor = ACCENT)} onBlurCapture={e => (e.target.style.borderColor = '#ddd')} />
                  {showTagDrop && filteredPickerTags.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 20, maxHeight: '140px', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                      {filteredPickerTags.map(tag => <div key={tag.tag_id} onMouseDown={() => { toggleTag(tag.name); setTagSearch(''); }} style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>{tag.name}</div>)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        case 'context_id':
          return (
            <div key="context_id" style={{ marginBottom: '0.85rem' }}>{label}
              <select value={formContextId} onChange={e => setFormContextId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
                <option value="">— none —</option>
                {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
              </select>
            </div>
          );
        default: return null;
      }
    };

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem' }}>
        <div style={{ color: '#111', fontSize: '0.85rem', fontWeight: 700, fontFamily: 'monospace', marginBottom: '1rem' }}>{isAdd ? 'New Completion' : 'Edit Completion'}</div>
        {visibleFields.map(f => renderField(f))}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.5rem' }}>
          <button onClick={() => setMode('browse')} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>{saving ? '...' : isAdd ? 'save completion' : 'save changes'}</button>
        </div>
      </div>
    );
  };

  // ─── Modal position ────────────────────────────────────────────────────────

  const modalStyle: React.CSSProperties = centered
    ? { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: size.w, height: size.h }
    : { position: 'fixed', top: pos.y, left: pos.x, width: size.w, height: size.h };

  // ─── Render: shell ─────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100 }}>
      <div ref={modalRef} style={{ ...modalStyle, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; const rect = modalRef.current!.getBoundingClientRect(); dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top }; setCentered(false); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>Completions</span>
            <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{completions.length} total</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Export menu */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowExportMenu(v => !v)}
                style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#222')}
                onMouseLeave={e => (e.currentTarget.style.background = '#000')}
              >export ▾</button>
              {showExportMenu && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '0.25rem', background: '#fff', border: '1px solid #ddd', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 10, minWidth: '120px' }}>
                  <div onClick={() => { exportAsCSV(filtered); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace', borderBottom: '1px solid #f0f0f0' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Export CSV</div>
                  <div onClick={() => { exportAsMD(filtered); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Export MD</div>
                </div>
              )}
            </div>
            <button onClick={openAdd}
              style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.background = '#222')}
              onMouseLeave={e => (e.currentTarget.style.background = '#000')}
            >+ new</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.5 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>✕</button>
          </div>
        </div>

        {/* Body — split panel */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {renderList()}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {mode === 'browse' ? renderDetail() : renderForm()}
          </div>
        </div>

        {/* Resize handle */}
        <div onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }} style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>

      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const formLabelStyle: React.CSSProperties = {
  color: '#000', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
};

const detailLabelStyle: React.CSSProperties = {
  color: '#999', fontSize: '0.62rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.35rem', fontFamily: 'monospace',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
