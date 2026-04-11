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
  context: { name: string } | null;
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

const ACCENT = '#3b82f6';
const ACCENT_DARK = '#2563eb';
const ACCENT_BG = '#eff6ff';
const ACCENT_BORDER = '#bfdbfe';

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function MeetingsModal({ userId, accessToken, onClose, onCountChange }: MeetingsModalProps) {
  const [mode, setMode]           = useState<'list' | 'add' | 'edit'>('list');
  const [meetings, setMeetings]   = useState<Meeting[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contexts, setContexts]   = useState<Context[]>([]);
  const [allTags, setAllTags]     = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [fieldMeta, setFieldMeta] = useState<FieldMeta[]>([]);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 800, h: 788 });
  const [centered, setCentered] = useState(true);
  const dragging                = useRef(false);
  const resizing                = useRef(false);
  const dragStart               = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef                = useRef<HTMLDivElement>(null);

  // ─── Form state ────────────────────────────────────────────────────────────
  const [editId, setEditId]                   = useState<string | null>(null);
  const [formTitle, setFormTitle]             = useState('');
  const [formMeetingDate, setFormMeetingDate] = useState('');
  const [formOutcome, setFormOutcome]         = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formNotes, setFormNotes]             = useState('');
  const [formAttendees, setFormAttendees]     = useState<string[]>([]);
  const [formTags, setFormTags]               = useState<string[]>([]);
  const [formContextId, setFormContextId]     = useState('');

  // Tag picker state — shared for both tags and attendees
  const [activePickerField, setActivePickerField]     = useState<'tags' | 'attendees' | null>(null);
  const [tagSearch, setTagSearch]                     = useState('');
  const [attendeeSearch, setAttendeeSearch]           = useState('');
  const [selectedTagGroupId, setSelectedTagGroupId]   = useState('');
  const [selectedPeopleGroupId, setSelectedPeopleGroupId] = useState('');
  const [showTagDrop, setShowTagDrop]                 = useState(false);
  const [showAttendeeDrop, setShowAttendeeDrop]       = useState(false);

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadMeetings = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('meeting')
      .select(`
        meeting_id, title, meeting_date, outcome, description, notes, attendees, tags,
        context:context_id ( name ),
        task:task_id ( title )
      `)
      .eq('user_id', userId)
      .order('meeting_date', { ascending: false });

    if (data) {
      setMeetings(data as any);
      onCountChange(data.length);
    }
    setLoading(false);
  };

  const loadContexts = async () => {
    const { data } = await supabase
      .from('context')
      .select('context_id, name')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('name');
    if (data) setContexts(data);
  };

  const loadTags = async () => {
    const { data: groups } = await supabase
      .from('tag_group')
      .select('tag_group_id, name')
      .eq('user_id', userId)
      .order('name');
    if (groups) setTagGroups(groups);

    const { data: tags } = await supabase
      .from('tag')
      .select('tag_id, name, tag_group_id')
      .eq('user_id', userId)
      .order('name');
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

  useEffect(() => {
    loadMeetings();
    loadContexts();
    loadTags();
    loadFieldMeta();
  }, []);

  // ─── Keyboard close ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ─── Drag/resize events ────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: dragStart.current.x + (e.clientX - dragStart.current.mx), y: dragStart.current.y + (e.clientY - dragStart.current.my) });
        setCentered(false);
      }
      if (resizing.current) {
        setSize({ w: Math.max(520, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)) });
      }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const resetForm = () => {
    setEditId(null);
    setFormTitle('');
    setFormMeetingDate(new Date().toISOString().slice(0, 16));
    setFormOutcome('');
    setFormDescription('');
    setFormNotes('');
    setFormAttendees([]);
    setFormTags([]);
    setFormContextId('');
    setTagSearch('');
    setAttendeeSearch('');
    setSelectedTagGroupId('');
    setSelectedPeopleGroupId('');
    setErr('');
  };

  const openAdd = () => { resetForm(); setMode('add'); };

  const openEdit = (m: Meeting) => {
    resetForm();
    setEditId(m.meeting_id);
    setFormTitle(m.title);
    setFormMeetingDate(m.meeting_date ? m.meeting_date.slice(0, 16) : '');
    setFormOutcome(m.outcome ?? '');
    setFormDescription(m.description ?? '');
    setFormNotes(m.notes ?? '');
    setFormAttendees(m.attendees ?? []);
    setFormTags(m.tags ?? []);
    setMode('edit');
  };

  const toggleTag = (name: string) => {
    setFormTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  };

  const toggleAttendee = (name: string) => {
    setFormAttendees(prev => prev.includes(name) ? prev.filter(a => a !== name) : [...prev, name]);
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    setSaving(true); setErr('');

    const payload: any = {
      title:        formTitle.trim(),
      meeting_date: formMeetingDate ? new Date(formMeetingDate).toISOString() : null,
      outcome:      formOutcome.trim() || null,
      description:  formDescription.trim() || null,
      notes:        formNotes.trim() || null,
      attendees:    formAttendees.length > 0 ? formAttendees : null,
      tags:         formTags.length > 0 ? formTags : null,
      context_id:   formContextId || null,
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
      setMode('list');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Tag picker renderer ───────────────────────────────────────────────────

  const renderTagPicker = (
    field: 'tags' | 'attendees',
    label: string,
    selected: string[],
    toggle: (name: string) => void,
    search: string,
    setSearch: (v: string) => void,
    groupId: string,
    setGroupId: (v: string) => void,
    showDrop: boolean,
    setShowDrop: (v: boolean) => void,
  ) => {
    const filtered = allTags.filter(t => {
      const matchesGroup  = groupId ? t.tag_group_id === groupId : true;
      const matchesSearch = search ? t.name.toLowerCase().includes(search.toLowerCase()) : true;
      const notSelected   = !selected.includes(t.name);
      return matchesGroup && matchesSearch && notSelected;
    });

    return (
      <div key={field} style={{ marginBottom: '0.85rem' }}>
        <div style={labelStyle}>{label}</div>
        {selected.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
            {selected.map(name => (
              <span key={name} onClick={() => toggle(name)}
                style={{ fontSize: '0.72rem', color: '#fff', background: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
              >{name} <span style={{ opacity: 0.8 }}>✕</span></span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select value={groupId} onChange={e => setGroupId(e.target.value)}
            style={{ ...inputStyle, flex: '0 0 140px', fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}
          >
            <option value="">All groups</option>
            {tagGroups.map(g => (
              <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>
            ))}
          </select>
          <div style={{ position: 'relative', flex: 1 }}>
            <input value={search}
              onChange={e => { setSearch(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              onBlur={() => setTimeout(() => setShowDrop(false), 150)}
              placeholder="Search..."
              style={{ ...inputStyle, marginBottom: 0 }}
              onFocusCapture={e => (e.target.style.borderColor = ACCENT)}
              onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
            />
            {showDrop && filtered.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 20, maxHeight: '160px', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                {filtered.map(tag => (
                  <div key={tag.tag_id}
                    onMouseDown={() => { toggle(tag.name); setSearch(''); }}
                    style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }}
                    onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >{tag.name}</div>
                ))}
              </div>
            )}
          </div>
        </div>
        {showDrop && filtered.length === 0 && (search || groupId) && (
          <div style={{ color: '#bbb', fontSize: '0.7rem', marginTop: '0.25rem', fontFamily: 'monospace' }}>No matching tags</div>
        )}
      </div>
    );
  };

  // ─── Field renderer ────────────────────────────────────────────────────────

  const renderField = (meta: FieldMeta, isAdd: boolean) => {
    const isReadonly = isAdd
      ? meta.insert_behavior === 'automatic'
      : meta.update_behavior === 'readonly' || meta.update_behavior === 'automatic';
    if (isReadonly) return null;

    const required = isAdd ? meta.insert_behavior === 'required' : false;
    const label = (
      <div style={labelStyle}>
        {meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}
      </div>
    );

    switch (meta.field) {

      case 'title':
        return (
          <div key="title" style={{ marginBottom: '0.85rem' }}>
            {label}
            <input autoFocus value={formTitle} onChange={e => setFormTitle(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'meeting_date':
        return (
          <div key="meeting_date" style={{ marginBottom: '0.85rem' }}>
            {label}
            <input type="datetime-local" value={formMeetingDate} onChange={e => setFormMeetingDate(e.target.value)}
              style={{ ...inputStyle, colorScheme: 'light' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'outcome':
        return (
          <div key="outcome" style={{ marginBottom: '0.85rem' }}>
            {label}
            <textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)}
              rows={2} style={{ ...inputStyle, resize: 'vertical' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'description':
        return (
          <div key="description" style={{ marginBottom: '0.85rem' }}>
            {label}
            <textarea value={formDescription} onChange={e => setFormDescription(e.target.value)}
              rows={1} style={{ ...inputStyle, resize: 'vertical' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'notes':
        return (
          <div key="notes" style={{ marginBottom: '0.85rem' }}>
            {label}
            <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)}
              rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: '64px' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'attendees':
        return renderTagPicker(
          'attendees', 'Attendees',
          formAttendees, toggleAttendee,
          attendeeSearch, setAttendeeSearch,
          selectedPeopleGroupId, setSelectedPeopleGroupId,
          showAttendeeDrop, setShowAttendeeDrop,
        );

      case 'tags':
        return renderTagPicker(
          'tags', 'Tags',
          formTags, toggleTag,
          tagSearch, setTagSearch,
          selectedTagGroupId, setSelectedTagGroupId,
          showTagDrop, setShowTagDrop,
        );

      case 'context_id':
        return (
          <div key="context_id" style={{ marginBottom: '0.85rem' }}>
            {label}
            <select value={formContextId} onChange={e => setFormContextId(e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            >
              <option value="">— none —</option>
              {contexts.map(c => (
                <option key={c.context_id} value={c.context_id}>{c.name}</option>
              ))}
            </select>
          </div>
        );

      default:
        return null;
    }
  };

  // ─── Render: form ──────────────────────────────────────────────────────────

  const renderForm = () => {
    const isAdd = mode === 'add';
    const visibleFields = fieldMeta.filter(f => {
      if (isAdd) return f.insert_behavior !== 'automatic';
      return f.update_behavior !== 'automatic' && f.update_behavior !== 'readonly';
    });

    return (
      <div style={{ padding: '1rem 1.25rem', overflowY: 'auto', flex: 1 }}>
        {visibleFields.map(f => renderField(f, isAdd))}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.5rem' }}>
          <button onClick={() => setMode('list')}
            style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}
          >cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
          >{saving ? '...' : isAdd ? 'save meeting' : 'save changes'}</button>
        </div>
      </div>
    );
  };

  // ─── Render: list ──────────────────────────────────────────────────────────

  const renderList = () => (
    <div style={{ overflowY: 'auto', flex: 1, padding: '0.75rem 1.25rem' }}>
      {loading ? (
        <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem 0', fontFamily: 'monospace' }}>Loading...</div>
      ) : meetings.length === 0 ? (
        <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem 0', fontFamily: 'monospace' }}>No meetings yet.</div>
      ) : (
        meetings.map(m => {
          const isExpanded = expandedId === m.meeting_id;
          return (
            <div key={m.meeting_id} style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
              <div onClick={() => setExpandedId(isExpanded ? null : m.meeting_id)}
                style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', cursor: 'pointer' }}
              >
                <span style={{ color: ACCENT, fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>
                  {m.meeting_date ? formatDate(m.meeting_date) : '—'}
                </span>
                <span style={{ color: '#111', fontSize: '0.82rem', flex: 1, fontFamily: 'monospace' }}>{m.title}</span>
                {m.context && <span style={{ color: '#555', fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>{m.context.name}</span>}
                <span style={{ color: '#bbb', fontSize: '0.65rem', flexShrink: 0 }}>{isExpanded ? '▴' : '▾'}</span>
              </div>

              {/* Attendees + tags row */}
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                {m.attendees?.map(a => (
                  <span key={a} style={{ fontSize: '0.62rem', color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '3px', padding: '0.1rem 0.35rem', fontFamily: 'monospace' }}>{a}</span>
                ))}
                {m.tags?.map(tag => (
                  <span key={tag} style={{ fontSize: '0.62rem', color: '#666', background: '#f5f5f5', border: '1px solid #e5e5e5', borderRadius: '3px', padding: '0.1rem 0.35rem', fontFamily: 'monospace' }}>{tag}</span>
                ))}
              </div>

              {isExpanded && (
                <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {m.outcome && (
                    <div>
                      <div style={expandLabelStyle}>Outcome</div>
                      <div style={{ color: '#333', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: '4px', padding: '0.5rem 0.65rem', fontFamily: 'monospace' }}>{m.outcome}</div>
                    </div>
                  )}
                  {m.description && (
                    <div>
                      <div style={expandLabelStyle}>Description</div>
                      <div style={{ color: '#555', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{m.description}</div>
                    </div>
                  )}
                  {m.notes && (
                    <div>
                      <div style={expandLabelStyle}>Notes</div>
                      <div style={{ color: '#555', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: '4px', padding: '0.5rem 0.65rem', fontFamily: 'monospace' }}>{m.notes}</div>
                    </div>
                  )}
                  {m.task && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={expandLabelStyle}>Task</span>
                      <span style={{ color: '#333', fontSize: '0.75rem', fontFamily: 'monospace' }}>{m.task.title}</span>
                    </div>
                  )}
                  {m.meeting_date && (
                    <div style={{ color: '#bbb', fontSize: '0.65rem', fontFamily: 'monospace' }}>{formatDateTime(m.meeting_date)}</div>
                  )}
                  <div>
                    <button onClick={() => openEdit(m)}
                      style={{ background: 'none', border: '1px solid #e0e0e0', color: '#888', padding: '0.25rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = ACCENT)}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#e0e0e0')}
                    >edit</button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

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
          onMouseDown={e => {
            dragging.current = true;
            const rect = modalRef.current!.getBoundingClientRect();
            dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top };
            setCentered(false);
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>
              {mode === 'list' ? 'Meetings' : mode === 'add' ? 'New Meeting' : 'Edit Meeting'}
            </span>
            {mode === 'list' && (
              <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{meetings.length} total</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {mode === 'list' && (
              <button onClick={openAdd}
                style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#222')}
                onMouseLeave={e => (e.currentTarget.style.background = '#000')}
              >+ new</button>
            )}
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.5 }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
            >✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {mode === 'list' ? renderList() : renderForm()}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>

      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  color: '#000', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
};

const expandLabelStyle: React.CSSProperties = {
  color: '#999', fontSize: '0.62rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.2rem', fontFamily: 'monospace',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
