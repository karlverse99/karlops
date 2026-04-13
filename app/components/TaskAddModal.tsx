'use client';

// app/components/TaskAddModal.tsx
// KarlOps L — Two-mode task creation
// Quick Capture: title list only, defaults applied silently, lands in capture
// Bulk Add: shared metadata set once, applied to all tasks in list

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Tag {
  tag_id: string;
  name: string;
  tag_group_id: string;
}

interface TagGroup {
  tag_group_id: string;
  name: string;
}

interface Context {
  context_id: string;
  name: string;
}

interface TaskStatus {
  task_status_id: string;
  label: string;
}

interface Defaults {
  bucket_key: string;
  context_id: string | null;
  task_status_id: string | null;
}

interface Props {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BUCKET_OPTIONS = [
  { key: 'now',      label: 'On Fire',   color: '#ef4444' },
  { key: 'soon',     label: 'Up Next',   color: '#f97316' },
  { key: 'realwork', label: 'Real Work', color: '#3b82f6' },
  { key: 'later',    label: 'Later',     color: '#6b7280' },
  { key: 'delegate', label: 'Delegated', color: '#8b5cf6' },
  { key: 'capture',  label: 'Capture',   color: '#10b981' },
];

const DEFAULT_W = 560;
const DEFAULT_H = 620;
const MIN_W = 400;
const MIN_H = 420;

// ─── TagPicker (copied from TaskDetailModal pattern) ─────────────────────────

function TagPicker({ selected, allTags, tagGroups, onChange }: {
  selected: string[];
  allTags: Tag[];
  tagGroups: TagGroup[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef         = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (tagName: string) => {
    onChange(selected.includes(tagName) ? selected.filter(t => t !== tagName) : [...selected, tagName]);
  };

  const filtered = search.trim()
    ? allTags.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
    : allTags;

  const tagsByGroup: Record<string, Tag[]> = {};
  for (const g of tagGroups) tagsByGroup[g.tag_group_id] = [];
  for (const t of filtered) {
    if (tagsByGroup[t.tag_group_id]) tagsByGroup[t.tag_group_id].push(t);
    else tagsByGroup['__ungrouped__'] = [...(tagsByGroup['__ungrouped__'] ?? []), t];
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.4rem', minHeight: '1.5rem' }}>
        {selected.map(tag => (
          <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#1a2a1a', border: '1px solid #2a4a2a', borderRadius: '4px', padding: '0.15rem 0.5rem', fontSize: '0.72rem', color: '#4ade80' }}>
            {tag}
            <span onClick={() => toggle(tag)} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
          </span>
        ))}
        {selected.length === 0 && <span style={{ color: '#333', fontSize: '0.72rem' }}>none selected</span>}
      </div>
      <button onClick={() => setOpen(v => !v)}
        style={{ background: '#111', border: '1px solid #222', color: '#4ade80', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer' }}
      >{open ? '▲ close' : '▼ add tags'}</button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, background: '#111', border: '1px solid #222', borderRadius: '6px', padding: '0.5rem', width: '280px', maxHeight: '220px', overflowY: 'auto', marginTop: '0.25rem', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tags..."
            style={{ width: '100%', background: '#0d0d0d', border: '1px solid #333', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none', boxSizing: 'border-box', marginBottom: '0.5rem' }}
          />
          {tagGroups.map(g => {
            const groupTags = tagsByGroup[g.tag_group_id] ?? [];
            if (groupTags.length === 0) return null;
            return (
              <div key={g.tag_group_id} style={{ marginBottom: '0.5rem' }}>
                <div style={{ color: '#444', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem', paddingLeft: '0.25rem' }}>{g.name}</div>
                {groupTags.map(tag => (
                  <div key={tag.tag_id} onClick={() => toggle(tag.name)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', color: selected.includes(tag.name) ? '#4ade80' : '#aaa', fontSize: '0.78rem' }}
                  >
                    <span style={{ fontSize: '0.65rem', width: '12px' }}>{selected.includes(tag.name) ? '☑' : '☐'}</span>
                    {tag.name}
                  </div>
                ))}
              </div>
            );
          })}
          {filtered.length === 0 && <div style={{ color: '#444', fontSize: '0.75rem', padding: '0.5rem' }}>No tags found</div>}
        </div>
      )}
    </div>
  );
}

// ─── BucketPicker ─────────────────────────────────────────────────────────────

function BucketPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {BUCKET_OPTIONS.map(b => (
        <div key={b.key} onClick={() => onChange(b.key)}
          style={{ padding: '0.35rem 0.75rem', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer', border: `1px solid ${value === b.key ? b.color : '#222'}`, background: value === b.key ? `${b.color}22` : '#111', color: value === b.key ? b.color : '#555', transition: 'all 0.15s' }}
        >{b.label}</div>
      ))}
    </div>
  );
}

// ─── MAIN MODAL ───────────────────────────────────────────────────────────────

export default function TaskAddModal({ userId, accessToken, onClose, onSaved }: Props) {

  // ─── Mode ────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'capture' | 'bulk'>('capture');

  // ─── Reference data ──────────────────────────────────────────────────────
  const [allTags, setAllTags]     = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [contexts, setContexts]   = useState<Context[]>([]);
  const [statuses, setStatuses]   = useState<TaskStatus[]>([]);
  const [defaults, setDefaults]   = useState<Defaults>({ bucket_key: 'capture', context_id: null, task_status_id: null });
  const [loading, setLoading]     = useState(true);

  // ─── Shared metadata (Bulk Add mode) ────────────────────────────────────
  const [bucket, setBucket]       = useState('capture');
  const [contextId, setContextId] = useState<string>('');
  const [statusId, setStatusId]   = useState<string>('');
  const [tags, setTags]           = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState('');
  const [delegatedTo, setDelegatedTo] = useState('');

  // ─── Task list ───────────────────────────────────────────────────────────
  const [rawInput, setRawInput]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');
  const [saved, setSaved]         = useState<string[]>([]);

  // ─── Drag & resize ───────────────────────────────────────────────────────
  const initX = Math.max(20, Math.round(window.innerWidth  / 2 - DEFAULT_W / 2));
  const initY = Math.max(20, Math.round(window.innerHeight / 2 - DEFAULT_H / 2));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragOffset      = useRef({ x: 0, y: 0 });
  const resizeStart     = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // ─── ESC to close ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ─── Drag/resize handlers ────────────────────────────────────────────────
  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    e.preventDefault();
    e.stopPropagation();
  }, [size]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (dragging.current) setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
      if (resizing.current) {
        setSize({
          w: Math.max(MIN_W, resizeStart.current.w + (e.clientX - resizeStart.current.x)),
          h: Math.max(MIN_H, resizeStart.current.h + (e.clientY - resizeStart.current.y)),
        });
      }
    };
    const onMouseUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
  }, []);

  // ─── Load reference data + defaults ─────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [tagRes, groupRes, ctxRes, statusRes, defaultRes] = await Promise.all([
          supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId),
          supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).order('display_order'),
          supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false).eq('is_visible', true).order('name'),
          supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order'),
          supabase.from('ko_default_registry').select('field, value').eq('user_id', userId).eq('object_type', 'task'),
        ]);

        setAllTags(tagRes.data ?? []);
        setTagGroups(groupRes.data ?? []);
        setContexts(ctxRes.data ?? []);
        setStatuses(statusRes.data ?? []);

        // Build defaults map
        const dm: Record<string, string> = {};
        for (const d of defaultRes.data ?? []) dm[d.field] = d.value;

        const d: Defaults = {
          bucket_key:     dm['bucket_key']     ?? 'capture',
          context_id:     dm['context_id']     ?? null,
          task_status_id: dm['task_status_id'] ?? null,
        };
        setDefaults(d);

        // Pre-populate bulk add fields with defaults
        setBucket(d.bucket_key);
        setContextId(d.context_id ?? '');
        setStatusId(d.task_status_id ?? '');

      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [userId]);

  // ─── Parse titles from raw input ────────────────────────────────────────
  const parseTitles = (raw: string): string[] =>
    raw.split('\n').map(t => t.replace(/^[-•*]\s*/, '').trim()).filter(t => t.length > 0);

  const previews = parseTitles(rawInput);

  // ─── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (previews.length === 0) { setErr('Enter at least one task'); return; }
    if (mode === 'bulk' && bucket === 'delegate' && !delegatedTo.trim()) {
      setErr('Delegated to is required when bucket is Delegated');
      return;
    }

    setSaving(true); setErr('');

    try {
      const records = previews.map(title => {
        if (mode === 'capture') {
          // Quick Capture — defaults applied silently
          return {
            user_id:        userId,
            title,
            bucket_key:     defaults.bucket_key,
            context_id:     defaults.context_id     || null,
            task_status_id: defaults.task_status_id || null,
            tags:           [],
          };
        } else {
          // Bulk Add — shared metadata applied
          return {
            user_id:        userId,
            title,
            bucket_key:     bucket,
            context_id:     contextId  || null,
            task_status_id: statusId   || null,
            tags,
            target_date:    targetDate || null,
            is_delegated:   bucket === 'delegate',
            delegated_to:   bucket === 'delegate' ? delegatedTo : null,
          };
        }
      });

      const { data, error } = await supabase.from('task').insert(records).select('title');
      if (error) throw error;

      setSaved(data?.map(t => t.title) ?? []);
      setRawInput('');
      onSaved();

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const headerColor = mode === 'capture' ? '#10b981' : '#f97316';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div
        style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 8px 32px rgba(0,0,0,0.7)', pointerEvents: 'all', overflow: 'hidden' }}
      >
        {/* HEADER */}
        <div
          onMouseDown={onDragStart}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: headerColor, cursor: 'grab', flexShrink: 0, userSelect: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.82rem', fontWeight: 700 }}>Add Tasks</span>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '0.15rem' }}>
              <button
                onClick={() => setMode('capture')}
                style={{ background: mode === 'capture' ? 'rgba(0,0,0,0.4)' : 'none', border: 'none', color: mode === 'capture' ? '#fff' : 'rgba(0,0,0,0.5)', padding: '0.15rem 0.6rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: 'pointer', fontWeight: mode === 'capture' ? 700 : 400 }}
              >Quick Capture</button>
              <button
                onClick={() => setMode('bulk')}
                style={{ background: mode === 'bulk' ? 'rgba(0,0,0,0.4)' : 'none', border: 'none', color: mode === 'bulk' ? '#fff' : 'rgba(0,0,0,0.5)', padding: '0.15rem 0.6rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: 'pointer', fontWeight: mode === 'bulk' ? 700 : 400 }}
              >Bulk Add</button>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(0,0,0,0.5)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>✕</button>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>

          {loading ? (
            <div style={{ color: '#444', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>Loading...</div>
          ) : (
            <>
              {/* ── QUICK CAPTURE MODE ──────────────────────────────────── */}
              {mode === 'capture' && (
                <div style={{ background: '#111', border: '1px solid #1a1a1a', borderRadius: '6px', padding: '0.6rem 0.75rem', marginBottom: '1rem', fontSize: '0.72rem', color: '#444' }}>
                  Defaults applied silently — bucket: <span style={{ color: '#10b981' }}>{defaults.bucket_key}</span>
                  {defaults.context_id && <span> · context: <span style={{ color: '#10b981' }}>{contexts.find(c => c.context_id === defaults.context_id)?.name ?? '—'}</span></span>}
                  {defaults.task_status_id && <span> · status: <span style={{ color: '#10b981' }}>{statuses.find(s => s.task_status_id === defaults.task_status_id)?.label ?? '—'}</span></span>}
                </div>
              )}

              {/* ── BULK ADD MODE — shared metadata header ──────────────── */}
              {mode === 'bulk' && (
                <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '6px', padding: '0.75rem', marginBottom: '1rem' }}>

                  {/* Bucket */}
                  <div style={fieldGroup}>
                    <div style={labelStyle}>Bucket<span style={{ color: '#ef4444' }}>*</span></div>
                    <BucketPicker value={bucket} onChange={setBucket} />
                  </div>

                  {/* Delegated To */}
                  {bucket === 'delegate' && (
                    <div style={fieldGroup}>
                      <div style={labelStyle}>Delegated To<span style={{ color: '#ef4444' }}>*</span></div>
                      <input value={delegatedTo} onChange={e => setDelegatedTo(e.target.value)} placeholder="Who is this delegated to?"
                        style={inputStyle} />
                    </div>
                  )}

                  {/* Context + Status side by side */}
                  <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ flex: 1 }}>
                      <div style={labelStyle}>Context</div>
                      <select value={contextId} onChange={e => setContextId(e.target.value)} style={selectStyle}>
                        <option value="">— none —</option>
                        {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={labelStyle}>Status</div>
                      <select value={statusId} onChange={e => setStatusId(e.target.value)} style={selectStyle}>
                        <option value="">— none —</option>
                        {statuses.map(s => <option key={s.task_status_id} value={s.task_status_id}>{s.label}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Tags */}
                  <div style={fieldGroup}>
                    <div style={labelStyle}>Tags <span style={{ color: '#333', textTransform: 'none', letterSpacing: 0 }}>— applied to all tasks</span></div>
                    <TagPicker selected={tags} allTags={allTags} tagGroups={tagGroups} onChange={setTags} />
                  </div>

                  {/* Target Date */}
                  <div style={{ ...fieldGroup, marginBottom: 0 }}>
                    <div style={labelStyle}>Target Date <span style={{ color: '#333', textTransform: 'none', letterSpacing: 0 }}>— applied to all tasks</span></div>
                    <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)}
                      style={{ ...inputStyle, colorScheme: 'dark', cursor: 'pointer', width: '180px' }} />
                  </div>
                </div>
              )}

              {/* ── TASK LIST INPUT (both modes) ─────────────────────────── */}
              <div style={fieldGroup}>
                <div style={labelStyle}>
                  Tasks<span style={{ color: '#ef4444' }}>*</span>
                  <span style={{ color: '#333', textTransform: 'none', letterSpacing: 0, marginLeft: '0.5rem' }}>— one per line</span>
                </div>
                <textarea
                  autoFocus
                  value={rawInput}
                  onChange={e => setRawInput(e.target.value)}
                  placeholder={mode === 'capture'
                    ? 'Call Jennifer\nReview Q1 numbers\nFix the login bug'
                    : 'Wire up help / language reference\nAdd custom date filter to Completions\nChat commands for task updates'
                  }
                  rows={6}
                  style={{ ...inputStyle, resize: 'vertical', height: 'auto' }}
                />
              </div>

              {/* Preview */}
              {previews.length > 0 && (
                <div>
                  <div style={{ color: '#333', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem' }}>
                    {previews.length} task{previews.length > 1 ? 's' : ''} to add
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {previews.map((t, i) => (
                      <div key={i} style={{ color: mode === 'capture' ? '#10b981' : '#f97316', fontSize: '0.75rem', padding: '0.2rem 0.5rem', background: mode === 'capture' ? '#0d1a14' : '#1a0e00', border: `1px solid ${mode === 'capture' ? '#0d2a1a' : '#2a1800'}`, borderRadius: '4px' }}>
                        {t}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Success state */}
              {saved.length > 0 && (
                <div style={{ marginTop: '1rem', padding: '0.6rem 0.75rem', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '6px' }}>
                  <div style={{ color: '#4ade80', fontSize: '0.72rem', marginBottom: '0.25rem' }}>✓ {saved.length} task{saved.length > 1 ? 's' : ''} added</div>
                  {saved.map((t, i) => <div key={i} style={{ color: '#555', fontSize: '0.7rem' }}>{t}</div>)}
                </div>
              )}

              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}
            </>
          )}
        </div>

        {/* FOOTER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderTop: '1px solid #1a1a1a', background: '#111', flexShrink: 0 }}>
          <div style={{ color: '#333', fontSize: '0.65rem' }}>
            {mode === 'capture' ? 'Defaults applied · triage later' : 'Metadata applied to all tasks'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={onClose} style={cancelBtn}>cancel</button>
            <button
              onClick={handleSubmit}
              disabled={saving || previews.length === 0}
              style={{ ...saveBtn, background: mode === 'capture' ? '#0d1a14' : '#1a0e00', borderColor: mode === 'capture' ? '#10b981' : '#f97316', color: mode === 'capture' ? '#10b981' : '#f97316', opacity: saving || previews.length === 0 ? 0.5 : 1 }}
            >
              {saving ? 'adding...' : `add ${previews.length > 0 ? previews.length : ''} task${previews.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>

        {/* RESIZE HANDLE */}
        <div onMouseDown={onResizeStart}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'nwse-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M9 1L1 9M9 5L5 9M9 9H9" stroke="#333" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const fieldGroup: React.CSSProperties = { marginBottom: '1rem' };

const labelStyle: React.CSSProperties = {
  color: '#555', fontSize: '0.63rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.35rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#111', border: '1px solid #222',
  color: '#e5e5e5', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  width: '100%', background: '#111', border: '1px solid #222',
  color: '#e5e5e5', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
};

const cancelBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #333', color: '#666',
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};

const saveBtn: React.CSSProperties = {
  border: '1px solid', padding: '0.4rem 0.9rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer',
};
