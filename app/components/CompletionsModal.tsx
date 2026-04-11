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

interface Context { context_id: string; name: string; }
interface Tag { tag_id: string; name: string; }

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
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  // ─── Drag/resize state ─────────────────────────────────────────────────────
  const [pos, setPos]       = useState({ x: 0, y: 0 });
  const [size, setSize]     = useState({ w: 720, h: 560 });
  const [centered, setCentered] = useState(true);
  const dragging            = useRef(false);
  const resizing            = useRef(false);
  const dragStart           = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart         = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef            = useRef<HTMLDivElement>(null);

  // ─── Form state ────────────────────────────────────────────────────────────
  const [editId, setEditId]               = useState<string | null>(null);
  const [formTitle, setFormTitle]         = useState('');
  const [formOutcome, setFormOutcome]     = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCompletedAt, setFormCompletedAt] = useState('');
  const [formTags, setFormTags]           = useState<string[]>([]);
  const [formContextId, setFormContextId] = useState('');
  const [tagSearch, setTagSearch]         = useState('');
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
    const { data } = await supabase
      .from('tag')
      .select('tag_id, name')
      .eq('user_id', userId)
      .order('name');
    if (data) setAllTags(data);
  };

  useEffect(() => {
    loadCompletions();
    loadContexts();
    loadTags();
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

  // ─── Tag picker ────────────────────────────────────────────────────────────

  const filteredTags = allTags.filter(t =>
    t.name.toLowerCase().includes(tagSearch.toLowerCase()) && !formTags.includes(t.name)
  );

  const renderTagPicker = () => (
    <div style={{ marginBottom: '1rem' }}>
      <div style={labelStyle}>Tags</div>

      {/* Selected tags */}
      {formTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.4rem' }}>
          {formTags.map(tag => (
            <span key={tag}
              onClick={() => toggleTag(tag)}
              style={{ fontSize: '0.72rem', color: '#fff', background: '#f97316', border: '1px solid #f97316', borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
            >
              {tag} <span style={{ opacity: 0.7 }}>✕</span>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div style={{ position: 'relative' }}>
        <input
          value={tagSearch}
          onChange={e => { setTagSearch(e.target.value); setShowTagDropdown(true); }}
          onFocus={() => setShowTagDropdown(true)}
          onBlur={() => setTimeout(() => setShowTagDropdown(false), 150)}
          placeholder="Search tags..."
          style={{ ...inputStyle, marginBottom: 0 }}
        />
        {showTagDropdown && filteredTags.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 10, maxHeight: '140px', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
            {filteredTags.map(tag => (
              <div
                key={tag.tag_id}
                onMouseDown={() => { toggleTag(tag.name); setTagSearch(''); }}
                style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fff8f0')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
              >
                {tag.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ─── Render: form ──────────────────────────────────────────────────────────

  const renderForm = () => (
    <div style={{ padding: '1.25rem', overflowY: 'auto', flex: 1 }}>

      {/* Title */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Title<span style={{ color: '#ef4444' }}>*</span></div>
        <input autoFocus value={formTitle} onChange={e => setFormTitle(e.target.value)}
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = '#f97316')}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
      </div>

      {/* Outcome */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Outcome<span style={{ color: '#ef4444' }}>*</span></div>
        <textarea value={formOutcome} onChange={e => setFormOutcome(e.target.value)}
          rows={4} style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }}
          onFocus={e => (e.target.style.borderColor = '#f97316')}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
      </div>

      {/* Description */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Description</div>
        <textarea value={formDescription} onChange={e => setFormDescription(e.target.value)}
          rows={2} style={{ ...inputStyle, resize: 'vertical' }}
          onFocus={e => (e.target.style.borderColor = '#f97316')}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
      </div>

      {/* Completed At */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Completed<span style={{ color: '#ef4444' }}>*</span></div>
        <input type="datetime-local" value={formCompletedAt} onChange={e => setFormCompletedAt(e.target.value)}
          style={{ ...inputStyle, colorScheme: 'light' }}
          onFocus={e => (e.target.style.borderColor = '#f97316')}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
      </div>

      {/* Tags */}
      {renderTagPicker()}

      {/* Context */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={labelStyle}>Context</div>
        <select value={formContextId} onChange={e => setFormContextId(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">— none —</option>
          {contexts.map(c => (
            <option key={c.context_id} value={c.context_id}>{c.name}</option>
          ))}
        </select>
      </div>

      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}

      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button onClick={() => setMode('list')}
          style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}
        >cancel</button>
        <button onClick={handleSave} disabled={saving}
          style={{ background: '#f97316', border: '1px solid #f97316', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
        >{saving ? '...' : mode === 'add' ? 'save completion' : 'save changes'}</button>
      </div>
    </div>
  );

  // ─── Render: list ──────────────────────────────────────────────────────────

  const renderList = () => (
    <div style={{ overflowY: 'auto', flex: 1, padding: '0.75rem 1.25rem' }}>
      {loading ? (
        <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem 0' }}>Loading...</div>
      ) : completions.length === 0 ? (
        <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem 0' }}>No completions yet.</div>
      ) : (
        completions.map(c => {
          const isExpanded = expandedId === c.completion_id;
          return (
            <div key={c.completion_id}
              style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}
            >
              {/* Row header */}
              <div onClick={() => setExpandedId(isExpanded ? null : c.completion_id)}
                style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', cursor: 'pointer' }}
              >
                <span style={{ color: '#f97316', fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>
                  {formatDate(c.completed_at)}
                </span>
                <span style={{ color: '#111', fontSize: '0.82rem', flex: 1, fontFamily: 'monospace' }}>{c.title}</span>
                {c.context && (
                  <span style={{ color: '#555', fontSize: '0.65rem', flexShrink: 0, fontFamily: 'monospace' }}>{c.context.name}</span>
                )}
                <span style={{ color: '#bbb', fontSize: '0.65rem', flexShrink: 0 }}>{isExpanded ? '▴' : '▾'}</span>
              </div>

              {/* Tags row */}
              {c.tags && c.tags.length > 0 && (
                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                  {c.tags.map(tag => (
                    <span key={tag} style={{ fontSize: '0.62rem', color: '#f97316', background: '#fff8f0', border: '1px solid #fde8d0', borderRadius: '3px', padding: '0.1rem 0.35rem', fontFamily: 'monospace' }}>{tag}</span>
                  ))}
                </div>
              )}

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

                  <div>
                    <div style={{ color: '#999', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem', fontFamily: 'monospace' }}>Outcome</div>
                    <div style={{ color: '#333', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#fafafa', border: '1px solid #eee', borderRadius: '4px', padding: '0.5rem 0.65rem', fontFamily: 'monospace' }}>
                      {c.outcome}
                    </div>
                  </div>

                  {c.description && (
                    <div>
                      <div style={{ color: '#999', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem', fontFamily: 'monospace' }}>Description</div>
                      <div style={{ color: '#555', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{c.description}</div>
                    </div>
                  )}

                  {c.task && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ color: '#999', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'monospace' }}>Task</span>
                      <span style={{ color: '#333', fontSize: '0.75rem', fontFamily: 'monospace' }}>{c.task.title}</span>
                    </div>
                  )}

                  {c.meeting && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ color: '#999', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'monospace' }}>Meeting</span>
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

  // ─── Modal position style ──────────────────────────────────────────────────

  const modalStyle: React.CSSProperties = centered
    ? { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: size.w, height: size.h }
    : { position: 'fixed', top: pos.y, left: pos.x, width: size.w, height: size.h };

  // ─── Render: modal shell ───────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100 }}>
      <div
        ref={modalRef}
        style={{
          ...modalStyle,
          background: '#ffffff',
          border: '2px solid #f97316',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'monospace',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        {/* Modal header — drag handle */}
        <div
          onMouseDown={e => {
            dragging.current = true;
            const rect = modalRef.current!.getBoundingClientRect();
            dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top };
            setCentered(false);
          }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', borderBottom: '1px solid #fde8d0', cursor: 'grab', userSelect: 'none', background: '#fff8f0', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#f97316', fontSize: '0.85rem', fontWeight: 700 }}>
              {mode === 'list' ? 'Completions' : mode === 'add' ? 'New Completion' : 'Edit Completion'}
            </span>
            {mode === 'list' && (
              <span style={{ color: '#bbb', fontSize: '0.7rem' }}>{completions.length} total</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {mode === 'list' && (
              <button onClick={openAdd}
                style={{ background: '#f97316', border: '1px solid #f97316', color: '#fff', padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#ea6c00')}
                onMouseLeave={e => (e.currentTarget.style.background = '#f97316')}
              >+ new</button>
            )}
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#f97316')}
              onMouseLeave={e => (e.currentTarget.style.color = '#bbb')}
            >✕</button>
          </div>
        </div>

        {/* Modal body */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {mode === 'list' ? renderList() : renderForm()}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={e => {
            resizing.current = true;
            resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h };
          }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '16px', height: '16px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '3px' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1 7L7 1M4 7L7 4M7 7L7 7" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>

      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  color: '#888', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
