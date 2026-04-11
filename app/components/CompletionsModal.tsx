'use client';

import { useEffect, useState } from 'react';
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
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  // ─── Add/Edit form state ───────────────────────────────────────────────────
  const [editId, setEditId]               = useState<string | null>(null);
  const [formTitle, setFormTitle]         = useState('');
  const [formOutcome, setFormOutcome]     = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCompletedAt, setFormCompletedAt] = useState('');
  const [formTags, setFormTags]           = useState('');
  const [formContextId, setFormContextId] = useState('');

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

  useEffect(() => {
    loadCompletions();
    loadContexts();
  }, []);

  // ─── Keyboard close ────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditId(null);
    setFormTitle('');
    setFormOutcome('');
    setFormDescription('');
    setFormCompletedAt(new Date().toISOString().slice(0, 16));
    setFormTags('');
    setFormContextId('');
    setErr('');
    setMode('add');
  };

  const openEdit = (c: Completion) => {
    setEditId(c.completion_id);
    setFormTitle(c.title);
    setFormOutcome(c.outcome ?? '');
    setFormDescription(c.description ?? '');
    setFormCompletedAt(c.completed_at ? c.completed_at.slice(0, 16) : '');
    setFormTags(c.tags ? c.tags.join(', ') : '');
    setFormContextId(''); // context_id not in join result — would need separate lookup
    setErr('');
    setMode('edit');
  };

  const handleSave = async () => {
    if (!formTitle.trim()) { setErr('Title is required'); return; }
    if (!formOutcome.trim()) { setErr('Outcome is required'); return; }
    if (!formCompletedAt) { setErr('Completed date is required'); return; }

    setSaving(true); setErr('');

    const tags = formTags.split(',').map(t => t.trim()).filter(Boolean);
    const payload: any = {
      title:        formTitle.trim(),
      outcome:      formOutcome.trim(),
      description:  formDescription.trim() || null,
      completed_at: new Date(formCompletedAt).toISOString(),
      tags:         tags.length > 0 ? tags : null,
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

  // ─── Render: form ──────────────────────────────────────────────────────────

  const renderForm = () => (
    <div style={{ padding: '1.25rem', overflowY: 'auto', flex: 1 }}>

      {/* Title */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Title<span style={{ color: '#ef4444' }}>*</span></div>
        <input
          autoFocus
          value={formTitle}
          onChange={e => setFormTitle(e.target.value)}
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = '#555')}
          onBlur={e => (e.target.style.borderColor = '#333')}
        />
      </div>

      {/* Outcome */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Outcome<span style={{ color: '#ef4444' }}>*</span></div>
        <textarea
          value={formOutcome}
          onChange={e => setFormOutcome(e.target.value)}
          rows={4}
          style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }}
          onFocus={e => (e.target.style.borderColor = '#555')}
          onBlur={e => (e.target.style.borderColor = '#333')}
        />
      </div>

      {/* Description */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Description</div>
        <textarea
          value={formDescription}
          onChange={e => setFormDescription(e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
          onFocus={e => (e.target.style.borderColor = '#555')}
          onBlur={e => (e.target.style.borderColor = '#333')}
        />
      </div>

      {/* Completed At */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Completed<span style={{ color: '#ef4444' }}>*</span></div>
        <input
          type="datetime-local"
          value={formCompletedAt}
          onChange={e => setFormCompletedAt(e.target.value)}
          style={{ ...inputStyle, colorScheme: 'dark' }}
          onFocus={e => (e.target.style.borderColor = '#555')}
          onBlur={e => (e.target.style.borderColor = '#333')}
        />
      </div>

      {/* Tags */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={labelStyle}>Tags <span style={{ color: '#444', textTransform: 'none', letterSpacing: 0 }}>— comma separated</span></div>
        <input
          value={formTags}
          onChange={e => setFormTags(e.target.value)}
          placeholder="work, personal, project..."
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = '#555')}
          onBlur={e => (e.target.style.borderColor = '#333')}
        />
      </div>

      {/* Context */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={labelStyle}>Context</div>
        <select
          value={formContextId}
          onChange={e => setFormContextId(e.target.value)}
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
        <button onClick={() => setMode('list')} style={cancelBtnStyle}>cancel</button>
        <button onClick={handleSave} disabled={saving} style={saveBtnStyle}>
          {saving ? '...' : mode === 'add' ? 'save completion' : 'save changes'}
        </button>
      </div>
    </div>
  );

  // ─── Render: list ──────────────────────────────────────────────────────────

  const renderList = () => (
    <div style={{ overflowY: 'auto', flex: 1, padding: '0.75rem 1.25rem' }}>
      {loading ? (
        <div style={{ color: '#555', fontSize: '0.75rem', padding: '1rem 0' }}>Loading...</div>
      ) : completions.length === 0 ? (
        <div style={{ color: '#444', fontSize: '0.75rem', padding: '1rem 0' }}>No completions yet.</div>
      ) : (
        completions.map(c => {
          const isExpanded = expandedId === c.completion_id;
          return (
            <div
              key={c.completion_id}
              style={{ borderBottom: '1px solid #1a1a1a', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}
            >
              {/* Row header */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : c.completion_id)}
                style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', cursor: 'pointer' }}
              >
                <span style={{ color: '#f97316', fontSize: '0.65rem', flexShrink: 0 }}>
                  {formatDate(c.completed_at)}
                </span>
                <span style={{ color: '#e5e5e5', fontSize: '0.82rem', flex: 1 }}>{c.title}</span>
                {c.context && (
                  <span style={{ color: '#555', fontSize: '0.65rem', flexShrink: 0 }}>{c.context.name}</span>
                )}
                <span style={{ color: '#444', fontSize: '0.65rem', flexShrink: 0 }}>{isExpanded ? '▴' : '▾'}</span>
              </div>

              {/* Tags row */}
              {c.tags && c.tags.length > 0 && (
                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem', paddingLeft: '0' }}>
                  {c.tags.map(tag => (
                    <span key={tag} style={{ fontSize: '0.62rem', color: '#aaa', background: '#1e1e1e', border: '1px solid #2a2a2a', borderRadius: '3px', padding: '0.1rem 0.35rem' }}>{tag}</span>
                  ))}
                </div>
              )}

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ marginTop: '0.75rem', paddingLeft: '0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

                  {/* Outcome */}
                  <div>
                    <div style={{ color: '#555', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>Outcome</div>
                    <div style={{ color: '#ccc', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#111', border: '1px solid #1e1e1e', borderRadius: '4px', padding: '0.5rem 0.65rem' }}>
                      {c.outcome}
                    </div>
                  </div>

                  {/* Description */}
                  {c.description && (
                    <div>
                      <div style={{ color: '#555', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>Description</div>
                      <div style={{ color: '#888', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{c.description}</div>
                    </div>
                  )}

                  {/* Linked task */}
                  {c.task && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ color: '#555', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Task</span>
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>{c.task.title}</span>
                    </div>
                  )}

                  {/* Linked meeting */}
                  {c.meeting && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ color: '#555', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Meeting</span>
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>{c.meeting.title}</span>
                    </div>
                  )}

                  {/* Completed at full */}
                  <div style={{ color: '#444', fontSize: '0.65rem' }}>{formatDateTime(c.completed_at)}</div>

                  {/* Edit button */}
                  <div>
                    <button
                      onClick={() => openEdit(c)}
                      style={{ background: 'none', border: '1px solid #2a2a2a', color: '#666', padding: '0.25rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#666')}
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

  // ─── Render: modal shell ───────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '8px', width: '640px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>

        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#f97316', fontSize: '0.85rem', fontWeight: 600 }}>
              {mode === 'list' ? 'Completions' : mode === 'add' ? 'New Completion' : 'Edit Completion'}
            </span>
            {mode === 'list' && (
              <span style={{ color: '#444', fontSize: '0.7rem' }}>{completions.length} total</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {mode === 'list' && (
              <button
                onClick={openAdd}
                style={{ background: '#1a0e00', border: '1px solid #4a2a00', color: '#f97316', padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#2a1800')}
                onMouseLeave={e => (e.currentTarget.style.background = '#1a0e00')}
              >+ new</button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
          </div>
        </div>

        {/* Modal body */}
        {mode === 'list' ? renderList() : renderForm()}

      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  color: '#555', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#111', border: '1px solid #333',
  color: '#e5e5e5', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};

const cancelBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #333', color: '#666',
  padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};

const saveBtnStyle: React.CSSProperties = {
  background: '#1a0e00', border: '1px solid #4a2a00', color: '#f97316',
  padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};
