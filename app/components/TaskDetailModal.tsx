'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import TagPicker from '@/app/components/TagPicker';

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

interface Tag { tag_id: string; name: string; tag_group_id: string; description: string | null; }
interface TagGroup { tag_group_id: string; name: string; }
interface TaskDetail { [key: string]: any; }

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

const SYSTEM_FIELDS  = ['task_id', 'user_id', 'created_at', 'updated_at', 'completed_at', 'is_completed', 'is_archived', 'is_delegated', 'delegated_to', 'sort_order'];
const SPECIAL_FIELDS = ['tags', 'bucket_key', 'title', 'notes', 'description', ...SYSTEM_FIELDS];

const ACCENT        = '#fbbf24';
const ACCENT_BG     = '#fffbeb';
const ACCENT_BORDER = '#fde68a';
const DEFAULT_W     = 580;
const DEFAULT_H     = 700;
const MIN_W         = 420;
const MIN_H         = 400;

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

// ─── BucketPicker ─────────────────────────────────────────────────────────────

function BucketPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {BUCKET_OPTIONS.map(b => (
        <div key={b.key} onClick={() => onChange(b.key)}
          style={{ padding: '0.3rem 0.65rem', borderRadius: '4px', fontSize: '0.72rem', cursor: 'pointer', fontFamily: 'monospace', transition: 'all 0.15s', border: `1px solid ${value === b.key ? b.color : '#ddd'}`, background: value === b.key ? `${b.color}15` : '#fafafa', color: value === b.key ? b.color : '#666' }}
          onMouseEnter={e => { if (value !== b.key) e.currentTarget.style.borderColor = '#bbb'; }}
          onMouseLeave={e => { if (value !== b.key) e.currentTarget.style.borderColor = '#ddd'; }}
        >{b.label}</div>
      ))}
    </div>
  );
}

// ─── DelegateePicker ──────────────────────────────────────────────────────────
// Single-select People tag picker. "Other" always pinned at top.

function DelegateePicker({
  value,
  onChange,
  peopleTags,
}: {
  value: string | null;
  onChange: (tagId: string, tagName: string) => void;
  peopleTags: Tag[];
}) {
  const DELEGATE_PURPLE = '#8b5cf6';

  // Sort: Other first, then alphabetical
  const sorted = [
    ...peopleTags.filter(t => t.name === 'Other'),
    ...peopleTags.filter(t => t.name !== 'Other').sort((a, b) => a.name.localeCompare(b.name)),
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {sorted.map(t => {
          const isSelected = value === t.tag_id;
          const isOther    = t.name === 'Other';
          return (
            <div
              key={t.tag_id}
              onClick={() => onChange(t.tag_id, t.name)}
              title={t.description ?? undefined}
              style={{
                padding: '0.3rem 0.65rem',
                borderRadius: '4px',
                fontSize: '0.72rem',
                cursor: 'pointer',
                fontFamily: 'monospace',
                transition: 'all 0.15s',
                border: `1px solid ${isSelected ? DELEGATE_PURPLE : isOther ? '#ddd' : '#ddd'}`,
                background: isSelected ? `${DELEGATE_PURPLE}15` : isOther ? '#f5f5f5' : '#fafafa',
                color: isSelected ? DELEGATE_PURPLE : isOther ? '#999' : '#555',
                fontStyle: isOther ? 'italic' : 'normal',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = '#bbb'; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = '#ddd'; }}
            >
              {isOther ? 'Other ↙ skip' : t.name}
            </div>
          );
        })}
      </div>
      {value && (
        <div
          onClick={() => onChange('', '')}
          style={{ marginTop: '0.4rem', fontSize: '0.65rem', color: '#aaa', cursor: 'pointer', display: 'inline-block' }}
        >
          ✕ clear
        </div>
      )}
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
  const [peopleTags, setPeopleTags] = useState<Tag[]>([]);
  const [fkData, setFkData]       = useState<Record<string, { value: string; label: string }[]>>({});
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  // ─── Complete flow ────────────────────────────────────────────────────────
  const [completing, setCompleting]               = useState(false);
  const [completionTitle, setCompletionTitle]     = useState('');
  const [completionOutcome, setCompletionOutcome] = useState('');
  const [completionSaving, setCompletionSaving]   = useState(false);

  // ─── Delete state ─────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmDelete) { setConfirmDelete(false); return; }
        if (completing)    { setCompleting(false); setErr(''); return; }
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete, completing]);

  // ─── Drag/resize ─────────────────────────────────────────────────────────
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
      if (resizing.current) setSize({ w: Math.max(MIN_W, resizeStart.current.w + (e.clientX - resizeStart.current.x)), h: Math.max(MIN_H, resizeStart.current.h + (e.clientY - resizeStart.current.y)) });
    };
    const onMouseUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
  }, []);

  // ─── Load ────────────────────────────────────────────────────────────────
  const loadTags = async () => {
    const { data } = await supabase.from('tag').select('tag_id, name, tag_group_id, description').eq('user_id', userId).eq('is_archived', false).order('name');
    if (data) setAllTags(data);
  };

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [taskRes, metaRes, tagRes, groupRes, ctxRes, statusRes] = await Promise.all([
          supabase.from('task').select('*').eq('task_id', taskId).single(),
          supabase.from('ko_field_metadata').select('*').eq('user_id', userId).eq('object_type', 'task').order('display_order'),
          supabase.from('tag').select('tag_id, name, tag_group_id, description').eq('user_id', userId).eq('is_archived', false).order('name'),
          supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).eq('is_archived', false).order('display_order'),
          supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false),
          supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order'),
        ]);

        if (taskRes.error) throw taskRes.error;
        setTask(taskRes.data);
        setDraft(taskRes.data);
        setCompletionTitle(taskRes.data.title ?? '');

        const allTagData   = tagRes.data ?? [];
        const allGroupData = groupRes.data ?? [];
        setAllTags(allTagData);
        setTagGroups(allGroupData);
        setFields((metaRes.data ?? []) as FieldMeta[]);

        // Resolve People tag group and filter People tags
        const peopleGroup = allGroupData.find(g => g.name === 'People');
        if (peopleGroup) {
          setPeopleTags(allTagData.filter(t => t.tag_group_id === peopleGroup.tag_group_id));
        }

        setFkData({
          context_id:     (ctxRes.data    ?? []).map(r => ({ value: r.context_id,     label: r.name })),
          task_status_id: (statusRes.data ?? []).map(r => ({ value: r.task_status_id, label: r.label })),
        });
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [taskId, userId]);

  // ─── Bucket change — clear delegated_to when leaving delegate ────────────
  const handleBucketChange = (v: string) => {
    setDraft(d => ({
      ...d,
      bucket_key:   v,
      delegated_to: v === 'delegate' ? (d.delegated_to ?? null) : null,
    }));
  };

  // ─── Save ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!task) return;

    // Validate delegate requires delegee
    if (draft.bucket_key === 'delegate' && !draft.delegated_to) {
      setErr('Delegated tasks require a delegee. Select a person or choose "Other".');
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
        delegated_to:   draft.bucket_key === 'delegate' ? (draft.delegated_to || null) : null,
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
      const { error: taskErr } = await supabase.from('task').update({ is_completed: true, completed_at: new Date().toISOString() }).eq('task_id', taskId);
      if (taskErr) throw taskErr;
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setCompletionSaving(false);
    }
  };

  // ─── Delete ───────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    setDeleting(true); setErr('');
    try {
      const { error } = await supabase.from('task').delete().eq('task_id', taskId).eq('user_id', userId);
      if (error) throw error;
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // ─── Derived ─────────────────────────────────────────────────────────────
  const editableFields = fields.filter(f =>
    f.update_behavior === 'editable' && f.display_order < 999 && !SPECIAL_FIELDS.includes(f.field)
  ).sort((a, b) => a.display_order - b.display_order);

  const curated     = isCurated(draft);
  const missing     = missingForCuration(draft);
  const contextText = `${draft.title ?? ''} ${draft.notes ?? ''} ${draft.description ?? ''}`.trim();
  const isDelegate  = draft.bucket_key === 'delegate';

  // Resolve delegated_to name for display
  const delegatedToName = draft.delegated_to
    ? peopleTags.find(t => t.tag_id === draft.delegated_to)?.name ?? null
    : null;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', pointerEvents: 'all', overflow: 'hidden' }}>

        {/* HEADER */}
        <div onMouseDown={onDragStart}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', flexShrink: 0, userSelect: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>
              {completing ? 'Complete Task' : 'Task Detail'}
            </span>
            {!loading && !completing && !confirmDelete && (
              curated
                ? <span style={{ fontSize: '0.65rem', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '4px', padding: '0.15rem 0.5rem' }}>✓ Curated</span>
                : <span style={{ fontSize: '0.65rem', color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '4px', padding: '0.15rem 0.5rem' }}>Needs {missing.join(' & ')}</span>
            )}
            {!loading && !completing && !confirmDelete && isDelegate && delegatedToName && (
              <span style={{ fontSize: '0.65rem', color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '4px', padding: '0.15rem 0.5rem' }}>
                → {delegatedToName}
              </span>
            )}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'rgba(0,0,0,0.5)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#000')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(0,0,0,0.5)')}
          >✕</button>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
          {loading ? (
            <div style={{ color: '#aaa', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>Loading...</div>
          ) : completing ? (

            // ─── COMPLETION FORM ─────────────────────────────────────────
            <div>
              <div style={{ color: '#888', fontSize: '0.78rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                Log what you accomplished. Edit the title if needed.
              </div>
              <div style={fieldGroup}>
                <div style={labelStyle}>What did you complete <span style={{ color: '#ef4444' }}>*</span></div>
                <input autoFocus value={completionTitle} onChange={e => setCompletionTitle(e.target.value)} style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              </div>
              <div style={fieldGroup}>
                <div style={labelStyle}>Outcome / what happened</div>
                <textarea value={completionOutcome} onChange={e => setCompletionOutcome(e.target.value)}
                  placeholder="What was the result? What changed? What did you learn?"
                  rows={5} style={{ ...inputStyle, resize: 'vertical' }}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              </div>
              <div style={{ color: '#aaa', fontSize: '0.68rem', marginTop: '0.5rem' }}>
                Tags and context will be inherited from the task. Completed today.
              </div>
              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}
            </div>

          ) : confirmDelete ? (

            // ─── DELETE CONFIRM ──────────────────────────────────────────
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1rem', padding: '2rem', textAlign: 'center' }}>
              <div style={{ fontSize: '1.5rem', opacity: 0.3 }}>⚠</div>
              <div style={{ color: '#ef4444', fontSize: '0.88rem', fontWeight: 600 }}>Delete this task?</div>
              <div style={{ color: '#888', fontSize: '0.78rem', lineHeight: 1.6, maxWidth: 320 }}>
                <strong style={{ color: '#333' }}>{task?.title}</strong> will be permanently deleted. This cannot be undone.
              </div>
              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem' }}>{err}</div>}
            </div>

          ) : (

            // ─── TASK DETAIL FORM ────────────────────────────────────────
            <>
              {/* TITLE */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Title <span style={{ color: '#ef4444' }}>*</span></div>
                <input value={draft.title ?? ''} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              </div>

              {/* NOTES */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Notes</div>
                <textarea value={draft.notes ?? ''} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
                  placeholder="Instructions, context, extra detail..."
                  rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: '52px' }}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
              </div>

              {/* BUCKET */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Bucket <span style={{ color: '#ef4444' }}>*</span></div>
                <BucketPicker value={draft.bucket_key} onChange={handleBucketChange} />
              </div>

              {/* DELEGEE — only when bucket = delegate */}
              {isDelegate && (
                <div style={{ ...fieldGroup, background: '#faf5ff', border: '1px solid #ede9fe', borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
                  <div style={{ ...labelStyle, color: '#7c3aed' }}>
                    Delegated To <span style={{ color: '#ef4444' }}>*</span>
                  </div>
                  {peopleTags.length === 0 ? (
                    <div style={{ fontSize: '0.72rem', color: '#aaa' }}>No People tags found. Add contacts or create People tags first.</div>
                  ) : (
                    <DelegateePicker
                      value={draft.delegated_to ?? null}
                      onChange={(tagId, _tagName) => setDraft(d => ({ ...d, delegated_to: tagId || null }))}
                      peopleTags={peopleTags}
                    />
                  )}
                  {!draft.delegated_to && (
                    <div style={{ fontSize: '0.65rem', color: '#a78bfa', marginTop: '0.4rem' }}>
                      Required. Choose "Other ↙ skip" if you don't need to track who.
                    </div>
                  )}
                </div>
              )}

              {/* EDITABLE FK FIELDS — context, status, target_date from metadata */}
              {editableFields.map(f => (
                <div key={f.field} style={fieldGroup}>
                  <div style={labelStyle}>{f.label}</div>
                  {fkData[f.field] ? (
                    <select value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                      style={selectStyle}
                      onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
                      <option value="">— none —</option>
                      {fkData[f.field].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.field_type === 'date' ? (
                    <input type="date" value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                      style={{ ...inputStyle, colorScheme: 'light', cursor: 'pointer' }}
                      onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
                  ) : f.field_type === 'boolean' ? (
                    <input type="checkbox" checked={!!draft[f.field]} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.checked }))}
                      style={{ accentColor: ACCENT, cursor: 'pointer', width: '16px', height: '16px' }} />
                  ) : (
                    <input value={draft[f.field] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                      style={inputStyle}
                      onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
                  )}
                </div>
              ))}

              {/* TAGS */}
              <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '1rem' }}>
                <TagPicker
                  selected={draft.tags ?? []}
                  allTags={allTags}
                  tagGroups={tagGroups}
                  onChange={tags => setDraft(d => ({ ...d, tags }))}
                  onTagCreated={loadTags}
                  accentColor={ACCENT}
                  objectType="task"
                  contextText={contextText}
                  accessToken={accessToken}
                  userId={userId}
                />
              </div>

              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}
            </>
          )}
        </div>

        {/* FOOTER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1.25rem', borderTop: `1px solid ${ACCENT_BORDER}`, background: '#fafafa', flexShrink: 0 }}>
          {completing ? (
            <>
              <button onClick={() => { setCompleting(false); setErr(''); }}
                style={cancelBtn}>← back</button>
              <button onClick={handleCompleteConfirm} disabled={completionSaving || !completionTitle.trim()}
                style={{ ...actionBtn, background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c', opacity: completionSaving || !completionTitle.trim() ? 0.5 : 1 }}>
                {completionSaving ? 'logging...' : '✓ log completion'}
              </button>
            </>
          ) : confirmDelete ? (
            <>
              <button onClick={() => { setConfirmDelete(false); setErr(''); }} style={cancelBtn}>← cancel</button>
              <button onClick={handleDelete} disabled={deleting}
                style={{ ...actionBtn, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
                {deleting ? 'deleting...' : '✕ delete forever'}
              </button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => { setCompleting(true); setErr(''); }} disabled={loading}
                  style={{ ...actionBtn, background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c' }}>
                  ✓ complete
                </button>
                <button onClick={() => { setConfirmDelete(true); setErr(''); }} disabled={loading}
                  style={{ ...actionBtn, background: 'none', border: '1px solid #fecaca', color: '#ef4444' }}>
                  ✕ delete
                </button>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={onClose} style={cancelBtn}>cancel</button>
                <button onClick={handleSave} disabled={saving || loading}
                  style={{ ...actionBtn, background: ACCENT, border: `1px solid ${ACCENT}`, color: '#000', fontWeight: 700, opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'saving...' : 'save'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* RESIZE HANDLE */}
        <div onMouseDown={onResizeStart}
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

// ─── STYLES ───────────────────────────────────────────────────────────────────

const fieldGroup: React.CSSProperties = { marginBottom: '1rem' };

const labelStyle: React.CSSProperties = {
  color: '#000', fontSize: '0.65rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.35rem', fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};

const selectStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  transition: 'border-color 0.15s',
};

const cancelBtn: React.CSSProperties = {
  background: 'none', border: '1px solid #ddd', color: '#666',
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};

const actionBtn: React.CSSProperties = {
  padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.75rem', cursor: 'pointer',
};
