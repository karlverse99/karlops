'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Meeting {
  meeting_id: string;
  title: string;
  meeting_date: string | null;
  outcome: string | null;
  description: string | null;
  notes: string | null;
  attendees: string[] | null;
  tags: string[] | null;
  is_completed: boolean;
  context: { name: string; context_id: string } | null;
  task: { title: string } | null;
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

interface MeetingsModalProps {
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

function exportAsCSV(meetings: Meeting[]): void {
  const headers = ['Date', 'Title', 'Outcome', 'Description', 'Notes', 'Attendees', 'Tags', 'Context', 'Task'];
  const rows = meetings.map(m => [
    m.meeting_date ? formatDate(m.meeting_date) : '',
    `"${m.title.replace(/"/g, '""')}"`,
    `"${(m.outcome ?? '').replace(/"/g, '""')}"`,
    `"${(m.description ?? '').replace(/"/g, '""')}"`,
    `"${(m.notes ?? '').replace(/"/g, '""')}"`,
    `"${(m.attendees ?? []).join(', ')}"`,
    `"${(m.tags ?? []).join(', ')}"`,
    m.context?.name ?? '',
    m.task?.title ?? '',
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `meetings-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function exportAsMD(meetings: Meeting[]): void {
  const lines = ['# Meetings', ''];
  for (const m of meetings) {
    lines.push(`## ${m.title}`);
    if (m.meeting_date) lines.push(`**Date:** ${formatDate(m.meeting_date)}`);
    if (m.context) lines.push(`**Context:** ${m.context.name}`);
    if (m.attendees?.length) lines.push(`**Attendees:** ${m.attendees.join(', ')}`);
    if (m.tags?.length) lines.push(`**Tags:** ${m.tags.join(', ')}`);
    if (m.outcome) { lines.push(''); lines.push('**Outcome:**'); lines.push(m.outcome); }
    if (m.description) { lines.push(''); lines.push('**Description:**'); lines.push(m.description); }
    if (m.notes) { lines.push(''); lines.push('**Notes:**'); lines.push(m.notes); }
    if (m.task) lines.push(`**Task:** ${m.task.title}`);
    lines.push(''); lines.push('---'); lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `meetings-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  URL.revokeObjectURL(url);
}

const ACCENT        = '#3b82f6';
const ACCENT_DARK   = '#2563eb';
const ACCENT_BG     = '#eff6ff';
const ACCENT_BORDER = '#bfdbfe';

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function MeetingsModal({ userId, accessToken, onClose, onCountChange }: MeetingsModalProps) {
  const [mode, setMode]             = useState<'empty' | 'edit' | 'add' | 'complete'>('empty');
  const [meetings, setMeetings]     = useState<Meeting[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState<Meeting | null>(null);
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
  const [filterDateRange, setFilterDateRange] = useState<'all' | 'week' | 'month'>('all');

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 1000, h: 860 });
  const [centered, setCentered] = useState(true);
  const dragging                = useRef(false);
  const resizing                = useRef(false);
  const dragStart               = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef                = useRef<HTMLDivElement>(null);

  // ─── Meeting form state ────────────────────────────────────────────────────
  const [editId, setEditId]                   = useState<string | null>(null);
  const [formTitle, setFormTitle]             = useState('');
  const [formMeetingDate, setFormMeetingDate] = useState('');
  const [formOutcome, setFormOutcome]         = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formNotes, setFormNotes]             = useState('');
  const [formAttendees, setFormAttendees]     = useState<string[]>([]);
  const [formTags, setFormTags]               = useState<string[]>([]);
  const [formContextId, setFormContextId]     = useState('');

  // ─── Tag picker state ──────────────────────────────────────────────────────
  const [tagSearch, setTagSearch]                         = useState('');
  const [attendeeSearch, setAttendeeSearch]               = useState('');
  const [selectedTagGroupId, setSelectedTagGroupId]       = useState('');
  const [selectedPeopleGroupId, setSelectedPeopleGroupId] = useState('');
  const [showTagDrop, setShowTagDrop]                     = useState(false);
  const [showAttendeeDrop, setShowAttendeeDrop]           = useState(false);

  // ─── Complete form state ───────────────────────────────────────────────────
  const [completeOutcome, setCompleteOutcome]     = useState('');
  const [completeTags, setCompleteTags]           = useState<string[]>([]);
  const [completeContextId, setCompleteContextId] = useState('');
  const [completeTagSearch, setCompleteTagSearch] = useState('');
  const [completeTagGroupId, setCompleteTagGroupId] = useState('');
  const [showCompleteTagDrop, setShowCompleteTagDrop] = useState(false);
  const [completeSaving, setCompleteSaving]       = useState(false);
  const [completeErr, setCompleteErr]             = useState('');

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadMeetings = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('meeting')
      .select(`meeting_id, title, meeting_date, outcome, description, notes, attendees, tags, is_completed,
        context:context_id ( name, context_id ),
        task:task_id ( title )`)
      .eq('user_id', userId)
      .eq('is_completed', false)
      .order('meeting_date', { ascending: false });
    if (data) { setMeetings(data as any); onCountChange(data.length); }
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
      .eq('object_type', 'meeting')
      .lt('display_order', 999)
      .order('display_order');
    if (data) setFieldMeta(data);
  };

  useEffect(() => { loadMeetings(); loadContexts(); loadTags(); loadFieldMeta(); }, []);

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

  const filtered = meetings.filter(m => {
    if (search && !m.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTag && !(m.tags ?? []).includes(filterTag)) return false;
    if (filterContext && m.context?.context_id !== filterContext) return false;
    if (filterDateRange !== 'all' && m.meeting_date) {
      const d = new Date(m.meeting_date); const now = new Date();
      if (filterDateRange === 'week') { const wk = new Date(now); wk.setDate(now.getDate() - 7); if (d < wk) return false; }
      if (filterDateRange === 'month') { const mo = new Date(now); mo.setMonth(now.getMonth() - 1); if (d < mo) return false; }
    }
    return true;
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const loadIntoForm = (m: Meeting) => {
    setEditId(m.meeting_id);
    setFormTitle(m.title);
    setFormMeetingDate(m.meeting_date ? m.meeting_date.slice(0, 16) : '');
    setFormOutcome(m.outcome ?? '');
    setFormDescription(m.description ?? '');
    setFormNotes(m.notes ?? '');
    setFormAttendees(m.attendees ?? []);
    setFormTags(m.tags ?? []);
    setFormContextId(m.context?.context_id ?? '');
    setTagSearch(''); setAttendeeSearch(''); setSelectedTagGroupId(''); setSelectedPeopleGroupId('');
    setErr(''); setSelected(m); setMode('edit');
  };

  const openAdd = () => {
    setEditId(null); setFormTitle(''); setFormMeetingDate(new Date().toISOString().slice(0, 16));
    setFormOutcome(''); setFormDescription(''); setFormNotes('');
    setFormAttendees([]); setFormTags([]); setFormContextId('');
    setTagSearch(''); setAttendeeSearch(''); setSelectedTagGroupId(''); setSelectedPeopleGroupId('');
    setErr(''); setSelected(null); setMode('add');
  };

  const openComplete = (m: Meeting) => {
    setCompleteOutcome(m.outcome ?? '');
    setCompleteTags(m.tags ?? []);
    setCompleteContextId(m.context?.context_id ?? '');
    setCompleteTagSearch(''); setCompleteTagGroupId(''); setCompleteErr('');
    setSelected(m); setMode('complete');
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    setSaving(true); setErr('');

    const payload: any = {
      title: formTitle.trim(),
      meeting_date: formMeetingDate ? new Date(formMeetingDate).toISOString() : null,
      outcome: formOutcome.trim() || null,
      description: formDescription.trim() || null,
      notes: formNotes.trim() || null,
      attendees: formAttendees.length > 0 ? formAttendees : null,
      tags: formTags.length > 0 ? formTags : null,
      context_id: formContextId || null,
    };

    try {
      if (mode === 'add') {
        const { error } = await supabase.from('meeting').insert({ ...payload, user_id: userId });
        if (error) throw error;
      } else if (mode === 'edit' && editId) {
        const { error } = await supabase.from('meeting').update(payload).eq('meeting_id', editId).eq('user_id', userId);
        if (error) throw error;
      }
      await loadMeetings();
      setMode('empty'); setSelected(null);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const handleComplete = async () => {
    if (!completeOutcome.trim()) { setCompleteErr('Outcome is required'); return; }
    if (!selected) return;
    setCompleteSaving(true); setCompleteErr('');

    try {
      const { error: compErr } = await supabase.from('completion').insert({
        user_id: userId, title: selected.title, outcome: completeOutcome.trim(),
        completed_at: new Date().toISOString(),
        tags: completeTags.length > 0 ? completeTags : null,
        context_id: completeContextId || null,
        meeting_id: selected.meeting_id,
      });
      if (compErr) throw compErr;

      const { error: meetErr } = await supabase.from('meeting')
        .update({ is_completed: true, outcome: completeOutcome.trim() })
        .eq('meeting_id', selected.meeting_id).eq('user_id', userId);
      if (meetErr) throw meetErr;

      await loadMeetings();
      setMode('empty'); setSelected(null);
    } catch (e: any) { setCompleteErr(e.message); }
    finally { setCompleteSaving(false); }
  };

  const toggleTag = (name: string) => setFormTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  const toggleAttendee = (name: string) => setFormAttendees(prev => prev.includes(name) ? prev.filter(a => a !== name) : [...prev, name]);
  const toggleCompleteTag = (name: string) => setCompleteTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);

  // ─── Tag picker renderer ───────────────────────────────────────────────────

  const renderTagPicker = (
    key: string, label: string, selected: string[], toggle: (n: string) => void,
    search: string, setSearch: (v: string) => void,
    groupId: string, setGroupId: (v: string) => void,
    showDrop: boolean, setShowDrop: (v: boolean) => void,
  ) => {
    const filtered = allTags.filter(t =>
      (groupId ? t.tag_group_id === groupId : true) &&
      (search ? t.name.toLowerCase().includes(search.toLowerCase()) : true) &&
      !selected.includes(t.name)
    );

    return (
      <div key={key} style={{ marginBottom: '0.85rem' }}>
        <div style={formLabelStyle}>{label}</div>
        {selected.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
            {selected.map(name => (
              <span key={name} onClick={() => toggle(name)}
                style={{ fontSize: '0.72rem', color: '#fff', background: ACCENT, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
              >{name} <span style={{ opacity: 0.8 }}>✕</span></span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select value={groupId} onChange={e => setGroupId(e.target.value)} style={{ ...inputStyle, flex: '0 0 130px', fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}>
            <option value="">All groups</option>
            {tagGroups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
          </select>
          <div style={{ position: 'relative', flex: 1 }}>
            <input value={search} onChange={e => { setSearch(e.target.value); setShowDrop(true); }} onFocus={() => setShowDrop(true)} onBlur={() => setTimeout(() => setShowDrop(false), 150)} placeholder="Search..." style={{ ...inputStyle, marginBottom: 0 }} onFocusCapture={e => (e.target.style.borderColor = ACCENT)} onBlurCapture={e => (e.target.style.borderColor = '#ddd')} />
            {showDrop && filtered.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 20, maxHeight: '140px', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                {filtered.map(tag => <div key={tag.tag_id} onMouseDown={() => { toggle(tag.name); setSearch(''); }} style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>{tag.name}</div>)}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ─── Field renderer ────────────────────────────────────────────────────────

  const renderField = (meta: FieldMeta) => {
    const isAdd = mode === 'add';
    const isReadonly = isAdd ? meta.insert_behavior === 'automatic' : meta.update_behavior === 'readonly' || meta.update_behavior === 'automatic';
    if (isReadonly) return null;

    const required = isAdd && meta.insert_behavior === 'required';
    const label = <div style={formLabelStyle}>{meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}</div>;

    switch (meta.field) {
      case 'title':
        return <div key="title" style={{ marginBottom: '0.85rem' }}>{label}<input value={formTitle} onChange={e => setFormTitle(e.target.value)} style={inputStyle} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
      case 'meeting_date':
        return <div key="meeting_date" style={{ marginBottom: '0.85rem' }}>{label}<input type="datetime-local" value={formMeetingDate} onChange={e => setFormMeetingDate(e.target.value)} style={{ ...inputStyle, colorScheme: 'light' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
      case 'outcome':
        return <div key="outcome" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
      case 'description':
        return <div key="description" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formDescription} onChange={e => setFormDescription(e.target.value)} rows={1} style={{ ...inputStyle, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
      case 'notes':
        return <div key="notes" style={{ marginBottom: '0.85rem' }}>{label}<textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: '64px' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} /></div>;
      case 'attendees':
        return renderTagPicker('attendees', 'Attendees', formAttendees, toggleAttendee, attendeeSearch, setAttendeeSearch, selectedPeopleGroupId, setSelectedPeopleGroupId, showAttendeeDrop, setShowAttendeeDrop);
      case 'tags':
        return renderTagPicker('tags', 'Tags', formTags, toggleTag, tagSearch, setTagSearch, selectedTagGroupId, setSelectedTagGroupId, showTagDrop, setShowTagDrop);
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
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search meetings..."
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
        <select value={filterDateRange} onChange={e => setFilterDateRange(e.target.value as any)} style={{ ...inputStyle, fontSize: '0.7rem', padding: '0.3rem 0.5rem' }}>
          <option value="all">All time</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
        <div style={{ color: '#999', fontSize: '0.65rem', fontFamily: 'monospace' }}>{filtered.length} of {meetings.length}</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>No meetings found.</div>
        ) : (
          filtered.map((m) => {
            const isSelected = selected?.meeting_id === m.meeting_id;
            const identifier = `MT${meetings.indexOf(m) + 1}`;
            return (
              <div key={m.meeting_id}
                onClick={() => loadIntoForm(m)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.75rem', cursor: 'pointer', background: isSelected ? ACCENT_BG : 'transparent', borderLeft: `3px solid ${isSelected ? ACCENT : 'transparent'}`, borderBottom: '1px solid #f5f5f5', transition: 'all 0.1s' }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#fafafa'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: ACCENT, fontSize: '0.65rem', fontWeight: 700, opacity: 0.6, flexShrink: 0, fontFamily: 'monospace' }}>{identifier}</span>
                <span style={{ color: ACCENT, fontSize: '0.7rem', flexShrink: 0, fontFamily: 'monospace', fontWeight: 500 }}>{m.meeting_date ? formatDate(m.meeting_date) : '—'}</span>
                <span style={{ color: '#111', fontSize: '0.82rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace', fontWeight: 500 }}>{m.title}</span>
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
        <div style={{ fontSize: '2rem', opacity: 0.2 }}>📅</div>
        <div>Select a meeting to edit</div>
      </div>
    );

    if (mode === 'complete' && selected) return renderCompleteForm();

    const isAdd = mode === 'add';
    const visibleFields = fieldMeta.filter(f =>
      isAdd ? f.insert_behavior !== 'automatic' : f.update_behavior !== 'automatic' && f.update_behavior !== 'readonly'
    );
    const identifier = !isAdd ? `MT${meetings.findIndex(m => m.meeting_id === editId) + 1}` : null;

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div style={{ color: '#888', fontSize: '0.7rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {isAdd ? 'New Meeting' : `Editing ${identifier}`}
          </div>
          {!isAdd && (
            <button onClick={() => openComplete(selected!)}
              style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.25rem 0.7rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.background = ACCENT_DARK)}
              onMouseLeave={e => (e.currentTarget.style.background = ACCENT)}
            >complete meeting</button>
          )}
        </div>
        {visibleFields.map(f => renderField(f))}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: '1rem' }}>
          <button onClick={() => { setMode('empty'); setSelected(null); }} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>{saving ? '...' : isAdd ? 'save meeting' : 'save changes'}</button>
        </div>
      </div>
    );
  };

  // ─── Render: complete form ─────────────────────────────────────────────────

  const renderCompleteForm = () => (
    <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div style={{ color: ACCENT, fontSize: '0.85rem', fontWeight: 700, fontFamily: 'monospace' }}>Complete Meeting</div>
        <button onClick={() => setMode('edit')} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.2rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}>← back</button>
      </div>
      <div style={{ color: '#333', fontSize: '0.82rem', fontFamily: 'monospace', marginBottom: '1rem', fontWeight: 600 }}>{selected?.title}</div>

      <div style={{ marginBottom: '0.85rem' }}>
        <div style={formLabelStyle}>Outcome<span style={{ color: '#ef4444' }}>*</span></div>
        <textarea value={completeOutcome} onChange={e => setCompleteOutcome(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
      </div>

      {renderTagPicker('complete_tags', 'Tags', completeTags, toggleCompleteTag, completeTagSearch, setCompleteTagSearch, completeTagGroupId, setCompleteTagGroupId, showCompleteTagDrop, setShowCompleteTagDrop)}

      <div style={{ marginBottom: '0.85rem' }}>
        <div style={formLabelStyle}>Context</div>
        <select value={completeContextId} onChange={e => setCompleteContextId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
          <option value="">— none —</option>
          {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
        </select>
      </div>

      {completeErr && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{completeErr}</div>}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: '1rem' }}>
        <button onClick={() => setMode('edit')} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
        <button onClick={handleComplete} disabled={completeSaving} style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>{completeSaving ? '...' : 'save & complete'}</button>
      </div>
    </div>
  );

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
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>Meetings</span>
            <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{meetings.length} total</span>
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
