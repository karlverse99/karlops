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
  context: { name: string } | null;
  task: { title: string } | null;
  meeting: { title: string } | null;
}

interface FieldMeta {
  field_name: string;
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

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function CompletionsModal({ userId, accessToken, onClose, onCountChange }: CompletionsModalProps) {
  const [mode, setMode]               = useState<'list' | 'add' | 'edit'>('list');
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loading, setLoading]         = useState(true);
  const [expandedId, setExpandedId]   = useState<string | null>(null);
  const [contexts, setContexts]       = useState<Context[]>([]);
  const [allTags, setAllTags]         = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]     = useState<TagGroup[]>([]);
  const [fieldMeta, setFieldMeta]     = useState<FieldMeta[]>([]);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  // ─── Drag/resize state ─────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 800, h: 580 });
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
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [showTagDropdown, setShowTagDropdown] = useState(false);

  // ─── Load data ─────────────────────────────────────────────────────────────

  const loadCompletions = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('completion')
      .select(`
        completion_id, title, outcome, description, completed_at, tags,
        context:context_id ( name ),
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
    .select('field_name, label, display_order, insert_behavior, update_behavior')
    .eq('object_type', 'completion')
    .lt('display_order', 999)
    .order('display_order');
  if (data) setFieldMeta(data);
};

  useEffect(() => {
    loadCompletions();
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

  // ─── Drag/resize mouse events ──────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({
          x: dragStart.current.x + (e.clientX - dragStart.current.mx),
          y: dragStart.current.y + (e.clientY - dragStart.current.my),
        });
        setCentered(false);
      }
      if (resizing.current) {
        setSize({
          w: Math.max(520, resizeStart.current.w + (e.clientX - resizeStart.current.mx)),
          h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)),
        });
      }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditId(null);
    setFormTitle('');
    setFormOutcome('');
    setFormDescription('');
    setFormCompletedAt(new Date().toISOString().slice(0, 16));
    setFormTags([]);
    setFormContextId('');
    setTagSearch('');
    setSelectedGroupId('');
    setErr('');
    setMode('add');
  };

  const openEdit = (c: Completion) => {
    setEditId(c.completion_id);
    setFormTitle(c.title);
    setFormOutcome(c.outcome ?? '');
    setFormDescription(c.description ?? '');
    setFormCompletedAt(c.completed_at ? c.completed_at.slice(0, 16) : '');
    setFormTags(c.tags ?? []);
    setFormContextId('');
    setTagSearch('');
    setSelectedGroupId('');
    setErr('');
    setMode('edit');
  };

  const toggleTag = (name: string) => {
    setFormTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    if (!formOutcome.trim()) { setErr('Outcome is required'); return; }
    if (!formCompletedAt) { setErr('Completed date is required'); return; }

    setSaving(true); setErr('');

    const payload: any = {
      title:        formTitle.trim(),
      outcome:      formOutcome.trim(),
      description:  formDescription.trim() || null,
      completed_at: new Date(formCompletedAt).toISOString(),
      tags:         formTags.length > 0 ? formTags : null,
      context_id:   formContextId || null,
    };

    try {
      if (mode === 'add') {
        const { error } = await supabase
          .from('completion')
          .insert({ ...payload, user_id: userId });
        if (error) throw error;
      } else if (mode === 'edit' && editId) {
        const { error } = await supabase
          .from('completion')
          .update(payload)
          .eq('completion_id', editId)
          .eq('user_id', userId);
        if (error) throw error;
      }
      await loadCompletions();
      setMode('list');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Field renderers ───────────────────────────────────────────────────────

  const filteredTags = allTags.filter(t => {
    const matchesGroup  = selectedGroupId ? t.tag_group_id === selectedGroupId : true;
    const matchesSearch = tagSearch ? t.name.toLowerCase().includes(tagSearch.toLowerCase()) : true;
    const notSelected   = !formTags.includes(t.name);
    return matchesGroup && matchesSearch && notSelected;
  });

  const renderField = (meta: FieldMeta, isAdd: boolean) => {
    const isReadonly = isAdd
      ? meta.insert_behavior === 'automatic'
      : meta.update_behavior === 'readonly' || meta.update_behavior === 'automatic';

    if (isReadonly) return null;

    const required = isAdd
      ? meta.insert_behavior === 'required'
      : false;

    const label = (
      <div style={labelStyle}>
        {meta.label}{required && <span style={{ color: '#ef4444' }}>*</span>}
      </div>
    );

    switch (meta.field_name) {

      case 'title':
        return (
          <div key="title" style={{ marginBottom: '0.85rem' }}>
            {label}
            <input autoFocus value={formTitle} onChange={e => setFormTitle(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = '#f97316')}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'outcome':
        return (
          <div key="outcome" style={{ marginBottom: '0.85rem' }}>
            {label}
            <textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)}
              rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: '64px' }}
              onFocus={e => (e.target.style.borderColor = '#f97316')}
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
              onFocus={e => (e.target.style.borderColor = '#f97316')}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'completed_at':
        return (
          <div key="completed_at" style={{ marginBottom: '0.85rem' }}>
            {label}
            <input type="datetime-local" value={formCompletedAt} onChange={e => setFormCompletedAt(e.target.value)}
              style={{ ...inputStyle, colorScheme: 'light' }}
              onFocus={e => (e.target.style.borderColor = '#f97316')}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );

      case 'tags':
        return (
          <div key="tags" style={{ marginBottom: '0.85rem' }}>
            {label}
            {formTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
                {formTags.map(tag => (
                  <span key={tag} onClick={() => toggleTag(tag)}
                    style={{ fontSize: '0.72rem', color: '#fff', background: '#f97316', border: '1px solid #f97316', borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
                  >{tag} <span style={{ opacity: 0.8 }}>✕</span></span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <select value={selectedGroupId} onChange={e => setSelectedGroupId(e.target.value)}
                style={{ ...inputStyle, flex: '0 0 140px', fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}
              >
                <option value="">All groups</option>
                {tagGroups.map(g => (
                  <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>
                ))}
              </select>
              <div style={{ position: 'relative', flex: 1 }}>
                <input value={tagSearch}
                  onChange={e => { setTagSearch(e.target.value); setShowTagDropdown(true); }}
                  onFocus={() => setShowTagDropdown(true)}
                  onBlur={() => setTimeout(() => setShowTagDropdown(false), 150)}
                  placeholder="Search tags..."
                  style={{ ...inputStyle, marginBottom: 0 }}
                  onFocusCapture={e => (e.target.style.borderColor = '#f97316')}
                  onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
                />
                {showTagDropdown && filteredTags.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 20, maxHeight: '160px', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                    {filteredTags.map(tag => (
                      <div key={tag.tag_id}
                        onMouseDown={() => { toggleTag(tag.name); setTagSearch(''); }}
                        style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#fff8f0')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                      >{tag.name}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {showTagDropdown && filteredTags.length === 0 && (tagSearch || selectedGroupId) && (
              <div style={{ color: '#bbb', fontSize: '0.7rem', marginTop: '0.25rem', fontFamily: 'monospace' }}>No matching tags</div>
            )}
          </div>
        );

      case 'context_id':
        return (
          <div key="context_id" style={{ marginBottom: '0.85rem' }}>
            {label}
            <select value={formContextId} onChange={e => setFormContextId(e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
              onFocus={e => (e.target.style.borderColor = '#f97316')}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            >
              <option value="">— none —</option>
              {contexts.map(c => (
                <option key={c.context_id} value={c.context_id}>{c.name}</option>
              ))}
            </select>
          </div>
        );

      // task_id and meeting_id are readonly on update — skip in form
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
            style={{ background: '#f97316', border: '1px solid #f97316', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
          >{saving ? '...' : isAdd ? 'save completion' : 'save changes'}</button>
        </div>
      </div>
    );
  };

  // ─── Render: list ──────────────────────────────────────────────────────────

  const renderList = () => (
    <div style={{ overflowY: 'auto', flex: 1, padding: '0.75rem 1.25rem' }}>
      {loading ? (
        <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem 0', fontFamily: 'monospace' }}>Loading...</div>
      ) : completions.length === 0 ? (
        <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem 0', fontFamily: 'monospace' }}>No completions yet.</div>
      ) : (
        completions.map(c => {
          const isExpanded = expandedId === c.completion_id;
          return (
            <div key={c.completion_id} style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
              <div onClick={() => setExpandedId(isExpanded ? null : c.completion_id)}
                style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', cursor: 'pointer' }}
              >
                <span style={{ color: '#f97316', fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>{formatDate(c.completed_at)}</span>
                <span style={{ color: '#111', fontSize: '0.82rem', flex: 1, fontFamily: 'monospace' }}>{c.title}</span>
                {c.context && <span style={{ color: '#555', fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>{c.context.name}</span>}
                <span style={{ color: '#bbb', fontSize: '0.65rem', flexShrink: 0 }}>{isExpanded ? '▴' : '▾'}</span>
              </div>

              {c.tags && c.tags.length > 0 && (
                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                  {c.tags.map(tag => (
                    <span key={tag} style={{ fontSize: '0.62rem', color: '#f97316', background: '#fff8f0', border: '1px solid #fde8d0', borderRadius: '3px', padding: '0.1rem 0.35rem', fontFamily: 'monospace' }}>{tag}</span>
                  ))}
                </div>
              )}

              {isExpanded && (
                <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div>
                    <div style={expandLabelStyle}>Outcome</div>
                    <div style={{ color: '#333', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: '4px', padding: '0.5rem 0.65rem', fontFamily: 'monospace' }}>{c.outcome}</div>
                  </div>
                  {c.description && (
                    <div>
                      <div style={expandLabelStyle}>Description</div>
                      <div style={{ color: '#555', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{c.description}</div>
                    </div>
                  )}
                  {c.task && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={expandLabelStyle}>Task</span>
                      <span style={{ color: '#333', fontSize: '0.75rem', fontFamily: 'monospace' }}>{c.task.title}</span>
                    </div>
                  )}
                  {c.meeting && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={expandLabelStyle}>Meeting</span>
                      <span style={{ color: '#333', fontSize: '0.75rem', fontFamily: 'monospace' }}>{c.meeting.title}</span>
                    </div>
                  )}
                  <div style={{ color: '#bbb', fontSize: '0.65rem', fontFamily: 'monospace' }}>{formatDateTime(c.completed_at)}</div>
                  <div>
                    <button onClick={() => openEdit(c)}
                      style={{ background: 'none', border: '1px solid #e0e0e0', color: '#888', padding: '0.25rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = '#f97316')}
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
      <div ref={modalRef} style={{ ...modalStyle, background: '#ffffff', border: '2px solid #f97316', borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

        {/* Header — orange bg, black text, drag handle */}
        <div
          onMouseDown={e => {
            dragging.current = true;
            const rect = modalRef.current!.getBoundingClientRect();
            dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top };
            setCentered(false);
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: '#f97316', cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>
              {mode === 'list' ? 'Completions' : mode === 'add' ? 'New Completion' : 'Edit Completion'}
            </span>
            {mode === 'list' && (
              <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.5 }}>{completions.length} total</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {mode === 'list' && (
              <button onClick={openAdd}
                style={{ background: '#000', border: '1px solid #000', color: '#f97316', padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
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
            <path d="M1 7L7 1M4 7L7 4" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round"/>
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
