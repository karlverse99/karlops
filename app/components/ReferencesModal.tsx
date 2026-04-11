'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Reference {
  external_reference_id: string;
  title: string;
  ref_type: string | null;
  url: string | null;
  description: string | null;
  notes: string | null;
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

interface ReferencesModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange: (count: number) => void;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function exportAsCSV(refs: Reference[]): void {
  const headers = ['Title', 'Type', 'URL', 'Description', 'Notes', 'Tags', 'Context', 'Task', 'Meeting'];
  const rows = refs.map(r => [
    `"${r.title.replace(/"/g, '""')}"`,
    r.ref_type ?? '',
    r.url ?? '',
    `"${(r.description ?? '').replace(/"/g, '""')}"`,
    `"${(r.notes ?? '').replace(/"/g, '""')}"`,
    `"${(r.tags ?? []).join(', ')}"`,
    r.context?.name ?? '',
    r.task?.title ?? '',
    r.meeting?.title ?? '',
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `references-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function exportAsMD(refs: Reference[]): void {
  const lines = ['# External References', ''];
  for (const r of refs) {
    lines.push(`## ${r.title}`);
    if (r.ref_type) lines.push(`**Type:** ${r.ref_type}`);
    if (r.url) lines.push(`**URL:** ${r.url}`);
    if (r.context) lines.push(`**Context:** ${r.context.name}`);
    if (r.tags?.length) lines.push(`**Tags:** ${r.tags.join(', ')}`);
    if (r.description) { lines.push(''); lines.push('**Description:**'); lines.push(r.description); }
    if (r.notes) { lines.push(''); lines.push('**Notes:**'); lines.push(r.notes); }
    if (r.task) lines.push(`**Task:** ${r.task.title}`);
    if (r.meeting) lines.push(`**Meeting:** ${r.meeting.title}`);
    lines.push(''); lines.push('---'); lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `references-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  URL.revokeObjectURL(url);
}

const ACCENT        = '#8b5cf6';
const ACCENT_DARK   = '#7c3aed';
const ACCENT_BG     = '#f5f3ff';
const ACCENT_BORDER = '#ddd6fe';

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function ReferencesModal({ userId, accessToken, onClose, onCountChange }: ReferencesModalProps) {
  const [mode, setMode]             = useState<'empty' | 'edit' | 'add'>('empty');
  const [refs, setRefs]             = useState<Reference[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState<Reference | null>(null);
  const [contexts, setContexts]     = useState<Context[]>([]);
  const [allTags, setAllTags]       = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]   = useState<TagGroup[]>([]);
  const [fieldMeta, setFieldMeta]   = useState<FieldMeta[]>([]);
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');
  const [showExportMenu, setShowExportMenu] = useState(false);

  // ─── Search/filter ─────────────────────────────────────────────────────────
  const [search, setSearch]               = useState('');
  const [filterTag, setFilterTag]         = useState('');
  const [filterContext, setFilterContext] = useState('');

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 1000, h: 720 });
  const [centered, setCentered] = useState(true);
  const dragging                = useRef(false);
  const resizing                = useRef(false);
  const dragStart               = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef                = useRef<HTMLDivElement>(null);

  // ─── Form state ────────────────────────────────────────────────────────────
  const [editId, setEditId]                   = useState<string | null>(null);
  const [formTitle, setFormTitle]             = useState('');
  const [formRefType, setFormRefType]         = useState('');
  const [formUrl, setFormUrl]                 = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formNotes, setFormNotes]             = useState('');
  const [formTags, setFormTags]               = useState<string[]>([]);
  const [formContextId, setFormContextId]     = useState('');
  const [tagSearch, setTagSearch]             = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [showTagDrop, setShowTagDrop]         = useState(false);

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadRefs = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('external_reference')
      .select(`external_reference_id, title, ref_type, url, description, notes, tags,
        context:context_id ( name, context_id ),
        task:task_id ( title ),
        meeting:meeting_id ( title )`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) { setRefs(data as any); onCountChange(data.length); }
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
      .eq('object_type', 'external_reference')
      .lt('display_order', 999)
      .order('display_order');
    if (data) setFieldMeta(data);
  };

  useEffect(() => { loadRefs(); loadContexts(); loadTags(); loadFieldMeta(); }, []);

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

  const filtered = refs.filter(r => {
    if (search && !r.title.toLowerCase().includes(search.toLowerCase()) && !(r.url ?? '').toLowerCase().includes(search.toLowerCase()) && !(r.description ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTag && !(r.tags ?? []).includes(filterTag)) return false;
    if (filterContext && r.context?.context_id !== filterContext) return false;
    return true;
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const loadIntoForm = (r: Reference) => {
    setEditId(r.external_reference_id);
    setFormTitle(r.title);
    setFormRefType(r.ref_type ?? '');
    setFormUrl(r.url ?? '');
    setFormDescription(r.description ?? '');
    setFormNotes(r.notes ?? '');
    setFormTags(r.tags ?? []);
    setFormContextId(r.context?.context_id ?? '');
    setTagSearch(''); setSelectedGroupId(''); setErr('');
    setSelected(r); setMode('edit');
  };

  const openAdd = () => {
    setEditId(null); setFormTitle(''); setFormRefType(''); setFormUrl('');
    setFormDescription(''); setFormNotes(''); setFormTags([]); setFormContextId('');
    setTagSearch(''); setSelectedGroupId(''); setErr('');
    setSelected(null); setMode('add');
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    setSaving(true); setErr('');

    const payload: any = {
      title:       formTitle.trim(),
      ref_type:    formRefType.trim() || null,
      url:         formUrl.trim() || null,
      description: formDescription.trim() || null,
      notes:       formNotes.trim() || null,
      tags:        formTags.length > 0 ? formTags : null,
      context_id:  formContextId || null,
    };

    try {
      if (mode === 'add') {
        const { error } = await supabase.from('external_reference').insert({ ...payload, user_id: userId });
        if (error) throw error;
      } else if (mode === 'edit' && editId) {
        const { error } = await supabase.from('external_reference').update(payload).eq('external_reference_id', editId).eq('user_id', userId);
        if (error) throw error;
      }
      await loadRefs();
      setMode('empty'); setSelected(null);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const toggleTag = (name: string) => setFormTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);

  const filteredPickerTags = allTags.filter(t =>
    (selectedGroupId ? t.tag_group_id === selectedGroupId : true) &&
    (tagSearch ? t.name.toLowerCase().includes(tagSearch.toLowerCase()) : true) &&
    !formTags.includes(t.name)
  );

  // ─── Field renderer ────────────────────────────────────────────────────────

  const renderField = (meta: FieldMeta) => {
    const isAdd = mode === 'add';
    const isReadonly = isAdd
      ? meta.insert_behavior === 'automatic'
      : meta.update_behavior === 'readonly' || meta.update_behavior === 'automatic';
    if (isReadonly) return null;

    // ref_type is always optional in the form regardless of metadata
    const required = isAdd && meta.insert_behavior === 'required' && meta.field === 'title';
    const label = <div style={formLabelStyle}>{meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}</div>;

    switch (meta.field) {
      case 'title':
        return <div key="title" style={{ marginBottom: '0.85rem' }}>{label}<input value={formTitle} onChange={e => setFormTitle(e.target.value)} style={inputStyle} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'ref_type':
        return <div key="ref_type" style={{ marginBottom: '0.85rem' }}>{label}<input value={formRefType} onChange={e => setFormRefType(e.target.value)} placeholder="link, doc, video, file..." style={inputStyle} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'url':
        return <div key="url" style={{ marginBottom: '0.85rem' }}>{label}<input value={formUrl} onChange={e => setFormUrl(e.target.value)} placeholder="https://..." style={inputStyle} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'description':
        return <div key="description" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formDescription} onChange={e => setFormDescription(e.target.value)} rows={1} style={{ ...inputStyle, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'notes':
        return <div key="notes" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: '64px' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;

      case 'tags':
        return (
          <div key="tags" style={{ marginBottom: '0.85rem' }}>
            {label}
            {formTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
                {formTags.map(tag => (
                  <span key={tag} onClick={() => toggleTag(tag)} style={{ fontSize: '0.72rem', color: '#fff', background: ACCENT, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}>
                    {tag} <span style={{ opacity: 0.8 }}>✕</span>
                  </span>
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

  // ─── Render: left panel ────────────────────────────────────────────────────

  const renderLeft = () => (
    <div style={{ width: '340px', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${ACCENT_BORDER}`, height: '100%' }}>
      <div style={{ padding: '0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, URL, description..."
          style={{ ...inputStyle, fontSize: '0.75rem', padding: '0.4rem 0.6rem' }}
          onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <select value={filterContext} onChange={e => setFilterContext(e.target.value)} style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
            <option value="">All contexts</option>
            {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
          </select>
          <select value={filterTag} onChange={e => setFilterTag(e.target.value)} style={{ ...inputStyle, flex: 1, fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
            <option value="">All tags</option>
            {allTags.map(t => <option key={t.tag_id} value={t.name}>{t.name}</option>)}
          </select>
        </div>
        <div style={{ color: '#999', fontSize: '0.65rem', fontFamily: 'monospace' }}>{filtered.length} of {refs.length}</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>No references found.</div>
        ) : (
          filtered.map((r) => {
            const isSelected = selected?.external_reference_id === r.external_reference_id;
            const identifier = `ER${refs.indexOf(r) + 1}`;
            return (
              <div key={r.external_reference_id}
                onClick={() => loadIntoForm(r)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem', cursor: 'pointer', background: isSelected ? ACCENT_BG : 'transparent', borderLeft: `3px solid ${isSelected ? ACCENT : 'transparent'}`, borderBottom: '1px solid #f5f5f5', transition: 'all 0.1s' }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#fafafa'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: ACCENT, fontSize: '0.65rem', fontWeight: 700, opacity: 0.6, flexShrink: 0, fontFamily: 'monospace' }}>{identifier}</span>
                {r.ref_type && <span style={{ color: ACCENT, fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace', fontWeight: 500, opacity: 0.8 }}>{r.ref_type}</span>}
                <span style={{ color: '#111', fontSize: '0.82rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace', fontWeight: 500 }}>{r.title}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  // ─── Render: right panel ───────────────────────────────────────────────────

  const renderRight = () => {
    if (mode === 'empty') return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', fontSize: '0.8rem', fontFamily: 'monospace', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '2rem', opacity: 0.2 }}>🔗</div>
        <div>Select a reference to edit</div>
      </div>
    );

    const isAdd = mode === 'add';
    const visibleFields = fieldMeta.filter(f =>
      isAdd ? f.insert_behavior !== 'automatic' : f.update_behavior !== 'automatic' && f.update_behavior !== 'readonly'
    );
    const identifier = !isAdd ? `ER${refs.findIndex(r => r.external_reference_id === editId) + 1}` : null;

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>
        <div style={{ color: '#888', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {isAdd ? 'New Reference' : `Editing ${identifier}`}
        </div>

        {/* URL quick-open if present */}
        {!isAdd && selected?.url && (
          <div style={{ marginBottom: '1rem' }}>
            <a href={selected.url} target="_blank" rel="noopener noreferrer"
              style={{ color: ACCENT, fontSize: '0.75rem', fontFamily: 'monospace', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              onMouseEnter={e => (e.currentTarget.style.color = ACCENT_DARK)}
              onMouseLeave={e => (e.currentTarget.style.color = ACCENT)}
            >↗ {selected.url.length > 60 ? selected.url.slice(0, 60) + '...' : selected.url}</a>
          </div>
        )}

        {visibleFields.map(f => renderField(f))}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: '1rem' }}>
          <button onClick={() => { setMode('empty'); setSelected(null); }} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>{saving ? '...' : isAdd ? 'save reference' : 'save changes'}</button>
        </div>
      </div>
    );
  };

  // ─── Modal position ────────────────────────────────────────────────────────

  const modalStyle: React.CSSProperties = centered
    ? { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: size.w, height: size.h }
    : { position: 'fixed', top: pos.y, left: pos.x, width: size.w, height: size.h };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100 }}>
      <div ref={modalRef} style={{ ...modalStyle, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; const rect = modalRef.current!.getBoundingClientRect(); dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top }; setCentered(false); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>External References</span>
            <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{refs.length} total</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowExportMenu(v => !v)}
                style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#222')} onMouseLeave={e => (e.currentTarget.style.background = '#000')}
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
              onMouseEnter={e => (e.currentTarget.style.background = '#222')} onMouseLeave={e => (e.currentTarget.style.background = '#000')}
            >+ new</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.5 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {renderLeft()}
          {renderRight()}
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

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
