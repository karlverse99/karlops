'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface FieldMeta {
  field: string;
  label: string;
  field_type: string;
  update_behavior: 'editable' | 'readonly' | 'automatic';
  insert_behavior: string;
  display_order: number;
  fk_table: string | null;
  fk_label: string | null;
}

interface Tag {
  tag_id: string;
  name: string;
  tag_group_id: string;
}

interface TagGroup {
  tag_group_id: string;
  name: string;
}

interface TaskDetail {
  [key: string]: any;
}

interface Props {
  taskId: string;
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
];

const SYSTEM_FIELDS = ['task_id', 'user_id', 'created_at', 'updated_at', 'completed_at', 'is_completed', 'is_archived'];

const DEFAULT_W = 580;
const DEFAULT_H = 680;
const MIN_W = 420;
const MIN_H = 400;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isCurated(task: TaskDetail): boolean {
  return task.bucket_key && task.bucket_key !== 'capture' && task.tags?.length > 0;
}

function missingForCuration(task: TaskDetail): string[] {
  const missing: string[] = [];
  if (!task.bucket_key || task.bucket_key === 'capture') missing.push('a real bucket');
  if (!task.tags || task.tags.length === 0) missing.push('at least one tag');
  return missing;
}

// ─── COMPONENTS: TagPicker ───────────────────────────────────────────────────

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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (tagName: string) => {
    if (selected.includes(tagName)) {
      onChange(selected.filter(t => t !== tagName));
    } else {
      onChange([...selected, tagName]);
    }
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
            <span onClick={() => toggle(tag)} style={{ cursor: 'pointer', fontWeight: 700, marginLeft: '0.1rem' }}>×</span>
          </span>
        ))}
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#111', border: '1px solid #222', borderRadius: '4px', padding: '0.15rem 0.5rem', fontSize: '0.72rem', color: '#555', cursor: 'pointer' }}
        >
          {selected.length === 0 ? 'Add tags' : '+'} <span style={{ fontSize: '0.6rem' }}>{open ? '▴' : '▾'}</span>
        </div>
      </div>

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 200, background: '#0d0d0d', border: '1px solid #222', borderRadius: '6px', padding: '0.5rem', minWidth: '220px', maxHeight: '260px', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}>
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tags..."
            style={{ width: '100%', background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.3rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box' }}
          />
          {tagGroups.map(group => {
            const groupTags = tagsByGroup[group.tag_group_id] ?? [];
            if (groupTags.length === 0) return null;
            return (
              <div key={group.tag_group_id} style={{ marginBottom: '0.5rem' }}>
                <div style={{ color: '#444', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem', padding: '0 0.25rem' }}>{group.name}</div>
                {groupTags.map(tag => (
                  <div key={tag.tag_id}
                    onClick={() => toggle(tag.name)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', color: selected.includes(tag.name) ? '#4ade80' : '#aaa', fontSize: '0.78rem', background: selected.includes(tag.name) ? '#0d1a0d' : 'transparent' }}
                    onMouseEnter={e => { if (!selected.includes(tag.name)) e.currentTarget.style.background = '#111'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = selected.includes(tag.name) ? '#0d1a0d' : 'transparent'; }}
                  >
                    <span style={{ fontSize: '0.65rem', width: '12px' }}>{selected.includes(tag.name) ? '☑' : '☐'}</span>
                    {tag.name}
                  </div>
                ))}
              </div>
            );
          })}
          {(tagsByGroup['__ungrouped__'] ?? []).map(tag => (
            <div key={tag.tag_id}
              onClick={() => toggle(tag.name)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', color: selected.includes(tag.name) ? '#4ade80' : '#aaa', fontSize: '0.78rem' }}
            >
              <span style={{ fontSize: '0.65rem', width: '12px' }}>{selected.includes(tag.name) ? '☑' : '☐'}</span>
              {tag.name}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ color: '#444', fontSize: '0.75rem', padding: '0.5rem' }}>No tags found</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── COMPONENTS: BucketPicker ────────────────────────────────────────────────

function BucketPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {BUCKET_OPTIONS.map(b => (
        <div key={b.key}
          onClick={() => onChange(b.key)}
          style={{ padding: '0.35rem 0.75rem', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer', border: `1px solid ${value === b.key ? b.color : '#222'}`, background: value === b.key ? `${b.color}22` : '#111', color: value === b.key ? b.color : '#555', transition: 'all 0.15s' }}
        >
          {b.label}
        </div>
      ))}
    </div>
  );
}

// ─── MAIN MODAL ───────────────────────────────────────────────────────────────

export default function TaskDetailModal({ taskId, userId, accessToken, onClose, onSaved }: Props) {
  const [task, setTask]           = useState<TaskDetail | null>(null);
  const [draft, setDraft]         = useState<TaskDetail>({});
  const [fields, setFields]       = useState<FieldMeta[]>([]);
  const [allTags, setAllTags]     = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [fkData, setFkData]       = useState<Record<string, { value: string; label: string }[]>>({});
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  // ─── Complete flow state ─────────────────────────────────────────────────
  const [completing, setCompleting]       = useState(false);
  const [completionTitle, setCompletionTitle] = useState('');
  const [completionOutcome, setCompletionOutcome] = useState('');
  const [completionSaving, setCompletionSaving]   = useState(false);

  // ─── Drag & resize state ────────────────────────────────────────────────
  const [pos, setPos]   = useState({ x: window.innerWidth / 2 - DEFAULT_W / 2, y: window.innerHeight / 2 - DEFAULT_H / 2 });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragOffset      = useRef({ x: 0, y: 0 });
  const resizeStart     = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const modalRef        = useRef<HTMLDivElement>(null);

  // ─── Drag handlers ──────────────────────────────────────────────────────
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
      if (dragging.current) {
        setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
      }
      if (resizing.current) {
        const newW = Math.max(MIN_W, resizeStart.current.w + (e.clientX - resizeStart.current.x));
        const newH = Math.max(MIN_H, resizeStart.current.h + (e.clientY - resizeStart.current.y));
        setSize({ w: newW, h: newH });
      }
    };
    const onMouseUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
  }, []);

  // ─── Load data ──────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data: taskData, error: taskErr } = await supabase
          .from('task').select('*').eq('task_id', taskId).single();
        if (taskErr) throw taskErr;

        const { data: metaData } = await supabase
          .from('ko_field_metadata').select('*')
          .eq('user_id', userId).eq('object_type', 'task').order('display_order');

        const { data: tagData }     = await supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId);
        const { data: groupData }   = await supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).order('display_order');
        const { data: contextData } = await supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false);
        const { data: statusData }  = await supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order');

        setTask(taskData);
        setDraft(taskData);
        setCompletionTitle(taskData.title ?? '');
        setFields((metaData ?? []) as FieldMeta[]);
        setAllTags(tagData ?? []);
        setTagGroups(groupData ?? []);
        setFkData({
          context_id:     (contextData ?? []).map(r => ({ value: r.context_id,     label: r.name })),
          task_status_id: (statusData  ?? []).map(r => ({ value: r.task_status_id, label: r.label })),
        });
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [taskId, userId]);

  // ─── Save ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!task) return;
    if (draft.bucket_key === 'delegate' && !draft.delegated_to?.trim()) {
      setErr('Delegated to is required when bucket is Delegated');
      return;
    }
    setSaving(true); setErr('');
    try {
      const { error } = await supabase.from('task').update({
        title:          draft.title,
        bucket_key:     draft.bucket_key,
        context_id:     draft.context_id     || null,
        task_status_id: draft.task_status_id || null,
        tags:           draft.tags           ?? [],
        description:    draft.description    || null,
        notes:          draft.notes          || null,
        target_date:    draft.target_date    || null,
        is_delegated:   draft.bucket_key === 'delegate',
        delegated_to:   draft.bucket_key === 'delegate' ? draft.delegated_to : null,
      }).eq('task_id', taskId);
      if (error) throw error;
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Complete ─────────────────────────────────────────────────────────────
  const handleCompleteConfirm = async () => {
    if (!completionTitle.trim()) { setErr('Completion title is required'); return; }
    setCompletionSaving(true); setErr('');
    try {
      // Insert completion record
      const { error: compErr } = await supabase.from('completion').insert({
        user_id:      userId,
        task_id:      taskId,
        title:        completionTitle.trim(),
        outcome:      completionOutcome.trim() || null,
        completed_at: new Date().toISOString().slice(0, 10),
        tags:         draft.tags ?? [],
        context_id:   draft.context_id || null,
      });
      if (compErr) throw compErr;

      // Mark task complete
      const { error: taskErr } = await supabase.from('task').update({
        is_completed:  true,
        completed_at:  new Date().toISOString(),
      }).eq('task_id', taskId);
      if (taskErr) throw taskErr;

      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setCompletionSaving(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const specialFields = ['tags', 'bucket_key', 'is_delegated', 'delegated_to', ...SYSTEM_FIELDS];
  const editableFields = fields.filter(f =>
    f.update_behavior === 'editable' && f.display_order < 999 && !specialFields.includes(f.field)
  ).sort((a, b) => a.display_order - b.display_order);

  const readonlyFields = fields.filter(f =>
    f.update_behavior === 'readonly' && f.display_order < 999 && !specialFields.includes(f.field)
  ).sort((a, b) => a.display_order - b.display_order);

  const curated = isCurated(draft);
  const missing = missingForCuration(draft);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div
        ref={modalRef}
        style={{
          position: 'absolute',
          left: pos.x,
          top:  pos.y,
          width:  size.w,
          height: size.h,
          background: '#0d0d0d',
          border: '1px solid #2a2a2a',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'monospace',
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          pointerEvents: 'all',
          overflow: 'hidden',
        }}
      >
        {/* DRAG HANDLE / HEADER */}
        <div
          onMouseDown={onDragStart}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: '#111', borderBottom: '1px solid #1a1a1a', cursor: 'grab', flexShrink: 0, userSelect: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#fff', fontSize: '0.82rem', fontWeight: 600 }}>
              {completing ? 'Complete Task' : 'Task Detail'}
            </span>
            {!loading && !completing && (
              curated
                ? <span style={{ fontSize: '0.65rem', color: '#4ade80', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '4px', padding: '0.15rem 0.4rem' }}>✓ Curated</span>
                : <span style={{ fontSize: '0.65rem', color: '#f97316', background: '#1a0e00', border: '1px solid #3a2000', borderRadius: '4px', padding: '0.15rem 0.4rem' }}>Needs {missing.join(' & ')}</span>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, pointerEvents: 'all' }}>✕</button>
        </div>

        {/* SCROLLABLE BODY */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>
          {loading ? (
            <div style={{ color: '#444', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>Loading...</div>
          ) : completing ? (

            // ─── COMPLETION FORM ────────────────────────────────────────────
            <div>
              <div style={{ color: '#aaa', fontSize: '0.78rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                Log what you accomplished. The title is pre-filled from the task — edit if needed.
              </div>

              <div style={fieldGroup}>
                <div style={labelStyle}>What did you complete<span style={{ color: '#ef4444' }}>*</span></div>
                <input
                  autoFocus
                  value={completionTitle}
                  onChange={e => setCompletionTitle(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div style={fieldGroup}>
                <div style={labelStyle}>Outcome / what happened</div>
                <textarea
                  value={completionOutcome}
                  onChange={e => setCompletionOutcome(e.target.value)}
                  placeholder="What was the result? What changed? What did you learn?"
                  rows={5}
                  style={{ ...inputStyle, resize: 'vertical', height: 'auto' }}
                />
              </div>

              <div style={{ color: '#444', fontSize: '0.68rem', marginTop: '0.5rem' }}>
                Tags and context will be inherited from the task. Completed today.
              </div>

              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}
            </div>

          ) : (

            // ─── TASK DETAIL FORM ───────────────────────────────────────────
            <>
              {/* BUCKET */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Bucket<span style={{ color: '#ef4444' }}>*</span></div>
                <BucketPicker value={draft.bucket_key} onChange={v => setDraft(d => ({ ...d, bucket_key: v }))} />
              </div>

              {/* DELEGATED TO */}
              {draft.bucket_key === 'delegate' && (
                <div style={fieldGroup}>
                  <div style={labelStyle}>Delegated To<span style={{ color: '#ef4444' }}>*</span></div>
                  <input value={draft.delegated_to ?? ''} onChange={e => setDraft(d => ({ ...d, delegated_to: e.target.value }))} placeholder="Who is this delegated to?" style={inputStyle} />
                </div>
              )}

              {/* TAGS */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Tags<span style={{ color: '#ef4444' }}>*</span></div>
                <TagPicker selected={draft.tags ?? []} allTags={allTags} tagGroups={tagGroups} onChange={tags => setDraft(d => ({ ...d, tags }))} />
              </div>

              {/* EDITABLE FIELDS */}
              {editableFields.map(f => (
                <div key={f.field} style={fieldGroup}>
                  <div style={labelStyle}>{f.label}</div>
                  {fkData[f.field] ? (
                    <select value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))} style={selectStyle}>
                      <option value="">— none —</option>
                      {fkData[f.field].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.field_type === 'boolean' ? (
                    <input type="checkbox" checked={!!draft[f.field]} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.checked }))} style={{ accentColor: '#4ade80', cursor: 'pointer', width: '16px', height: '16px' }} />
                  ) : f.field_type === 'date' ? (
                    <input type="date" value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))} style={{ ...inputStyle, colorScheme: 'dark', cursor: 'pointer' }} />
                  ) : f.field === 'description' || f.field === 'notes' ? (
                    <textarea value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))} rows={3} style={{ ...inputStyle, resize: 'vertical', height: 'auto' }} />
                  ) : (
                    <input value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))} style={inputStyle} />
                  )}
                </div>
              ))}

              {/* READONLY FIELDS */}
              {readonlyFields.length > 0 && (
                <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
                  <div style={{ color: '#333', fontSize: '0.63rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>Read Only</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                    {readonlyFields.map(f => (
                      <div key={f.field}>
                        <div style={{ color: '#444', fontSize: '0.65rem', marginBottom: '0.15rem' }}>{f.label}</div>
                        <div style={{ color: '#555', fontSize: '0.75rem' }}>{task?.[f.field] ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}
            </>
          )}
        </div>

        {/* FOOTER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', borderTop: '1px solid #1a1a1a', background: '#111', flexShrink: 0 }}>

          {completing ? (
            // ─── COMPLETION FOOTER ────────────────────────────────────────
            <>
              <button
                onClick={() => { setCompleting(false); setErr(''); }}
                style={cancelBtn}
              >← back</button>
              <button
                onClick={handleCompleteConfirm}
                disabled={completionSaving || !completionTitle.trim()}
                style={{ ...completeBtn, opacity: completionSaving || !completionTitle.trim() ? 0.5 : 1 }}
              >
                {completionSaving ? 'logging...' : '✓ log completion'}
              </button>
            </>
          ) : (
            // ─── NORMAL FOOTER ────────────────────────────────────────────
            <>
              <button
                onClick={() => { setCompleting(true); setErr(''); }}
                disabled={loading}
                style={completeBtn}
              >
                ✓ complete
              </button>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={onClose} style={cancelBtn}>cancel</button>
                <button onClick={handleSave} disabled={saving || loading} style={{ ...saveBtn, opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'saving...' : 'save'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* RESIZE HANDLE */}
        <div
          onMouseDown={onResizeStart}
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

// ─── STYLES ───────────────────────────────────────────────────────────────────

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
  background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80',
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};

const completeBtn: React.CSSProperties = {
  background: '#1a1000', border: '1px solid #3a2800', color: '#f97316',
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};
