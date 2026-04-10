'use client';

import { useEffect, useState } from 'react';
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
  group_name?: string;
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

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function TagPicker({ selected, allTags, tagGroups, onChange }: {
  selected: string[];
  allTags: Tag[];
  tagGroups: TagGroup[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (tagName: string) => {
    if (selected.includes(tagName)) {
      onChange(selected.filter(t => t !== tagName));
    } else {
      onChange([...selected, tagName]);
    }
  };

  const tagsByGroup: Record<string, Tag[]> = {};
  for (const g of tagGroups) tagsByGroup[g.tag_group_id] = [];
  for (const t of allTags) {
    if (tagsByGroup[t.tag_group_id]) tagsByGroup[t.tag_group_id].push(t);
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Selected pills */}
      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.4rem', minHeight: '1.5rem' }}>
        {selected.map(tag => (
          <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#1a2a1a', border: '1px solid #2a4a2a', borderRadius: '4px', padding: '0.15rem 0.5rem', fontSize: '0.72rem', color: '#4ade80' }}>
            {tag}
            <span onClick={() => toggle(tag)} style={{ cursor: 'pointer', color: '#4ade80', fontWeight: 700, marginLeft: '0.1rem' }}>×</span>
          </span>
        ))}
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: '#111', border: '1px solid #222', borderRadius: '4px', padding: '0.15rem 0.5rem', fontSize: '0.72rem', color: '#555', cursor: 'pointer' }}
        >
          {selected.length === 0 ? 'Add tags' : '+'} <span style={{ fontSize: '0.6rem' }}>{open ? '▴' : '▾'}</span>
        </div>
      </div>

      {/* Dropdown */}
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 50, background: '#0d0d0d', border: '1px solid #222', borderRadius: '6px', padding: '0.5rem', minWidth: '200px', maxHeight: '250px', overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}>
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
          {allTags.length === 0 && <div style={{ color: '#444', fontSize: '0.75rem', padding: '0.5rem' }}>No tags — add some in Admin</div>}
        </div>
      )}
    </div>
  );
}

function BucketPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {BUCKET_OPTIONS.map(b => (
        <div key={b.key}
          onClick={() => onChange(b.key)}
          style={{
            padding: '0.35rem 0.75rem',
            borderRadius: '4px',
            fontSize: '0.75rem',
            cursor: 'pointer',
            border: `1px solid ${value === b.key ? b.color : '#222'}`,
            background: value === b.key ? `${b.color}22` : '#111',
            color: value === b.key ? b.color : '#555',
            transition: 'all 0.15s',
          }}
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

  // ── Load everything ──────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        // Task record
        const { data: taskData, error: taskErr } = await supabase
          .from('task')
          .select('*')
          .eq('task_id', taskId)
          .single();
        if (taskErr) throw taskErr;

        // Field metadata for task
        const { data: metaData } = await supabase
          .from('ko_field_metadata')
          .select('*')
          .eq('user_id', userId)
          .eq('object_type', 'task')
          .order('display_order');

        // Tags and tag groups
        const { data: tagData }   = await supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId);
        const { data: groupData } = await supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).order('display_order');

        // FK data — context and task_status
        const { data: contextData }    = await supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false);
        const { data: taskStatusData } = await supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order');

        setTask(taskData);
        setDraft(taskData);
        setFields((metaData ?? []) as FieldMeta[]);
        setAllTags(tagData ?? []);
        setTagGroups(groupData ?? []);
        setFkData({
          context_id:     (contextData    ?? []).map(r => ({ value: r.context_id,    label: r.name })),
          task_status_id: (taskStatusData ?? []).map(r => ({ value: r.task_status_id, label: r.label })),
        });
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [taskId, userId]);

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!task) return;

    // Validate delegated_to if bucket is delegate
    if (draft.bucket_key === 'delegate' && !draft.delegated_to?.trim()) {
      setErr('Delegated to is required when bucket is Delegated');
      return;
    }

    setSaving(true); setErr('');
    try {
      const { error } = await supabase
        .from('task')
        .update({
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
        })
        .eq('task_id', taskId);

      if (error) throw error;
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Close on backdrop click ──────────────────────────────────────────────
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={backdropStyle} onClick={handleBackdrop}>
        <div style={modalStyle}>
          <div style={{ color: '#444', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!task) return null;

  const curated = isCurated(draft);
  const missing = missingForCuration(draft);

  // Visible editable fields — exclude system fields, tags, bucket, delegated fields (handled specially)
  const specialFields = ['tags', 'bucket_key', 'is_delegated', 'delegated_to', ...SYSTEM_FIELDS];
  const editableFields = fields.filter(f =>
    f.update_behavior === 'editable' &&
    f.display_order < 999 &&
    !specialFields.includes(f.field)
  ).sort((a, b) => a.display_order - b.display_order);

  const readonlyFields = fields.filter(f =>
    f.update_behavior === 'readonly' &&
    f.display_order < 999 &&
    !specialFields.includes(f.field)
  ).sort((a, b) => a.display_order - b.display_order);

  return (
    <div style={backdropStyle} onClick={handleBackdrop}>
      <div style={modalStyle}>

        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div>
            <div style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem' }}>
              Task Detail
            </div>
            {!curated && (
              <div style={{ fontSize: '0.68rem', color: '#f97316', background: '#1a0e00', border: '1px solid #3a2000', borderRadius: '4px', padding: '0.2rem 0.5rem', display: 'inline-block' }}>
                Not curated — needs {missing.join(' and ')}
              </div>
            )}
            {curated && (
              <div style={{ fontSize: '0.68rem', color: '#4ade80', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '4px', padding: '0.2rem 0.5rem', display: 'inline-block' }}>
                ✓ Curated
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}>✕</button>
        </div>

        {/* BUCKET PICKER */}
        <div style={fieldGroupStyle}>
          <div style={labelStyle}>Bucket<span style={{ color: '#ef4444' }}>*</span></div>
          <BucketPicker value={draft.bucket_key} onChange={v => setDraft(d => ({ ...d, bucket_key: v }))} />
        </div>

        {/* DELEGATED TO — shown only when bucket is delegate */}
        {draft.bucket_key === 'delegate' && (
          <div style={fieldGroupStyle}>
            <div style={labelStyle}>Delegated To<span style={{ color: '#ef4444' }}>*</span></div>
            <input
              value={draft.delegated_to ?? ''}
              onChange={e => setDraft(d => ({ ...d, delegated_to: e.target.value }))}
              placeholder="Who is this delegated to?"
              style={inputStyle}
            />
          </div>
        )}

        {/* TAGS */}
        <div style={fieldGroupStyle}>
          <div style={labelStyle}>Tags<span style={{ color: '#ef4444' }}>*</span></div>
          <TagPicker
            selected={draft.tags ?? []}
            allTags={allTags}
            tagGroups={tagGroups}
            onChange={tags => setDraft(d => ({ ...d, tags }))}
          />
        </div>

        {/* EDITABLE FIELDS */}
        {editableFields.map(f => (
          <div key={f.field} style={fieldGroupStyle}>
            <div style={labelStyle}>{f.label}</div>
            {fkData[f.field] ? (
              <select
                value={draft[f.field] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                style={selectStyle}
              >
                <option value="">— none —</option>
                {fkData[f.field].map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : f.field_type === 'boolean' ? (
              <input
                type="checkbox"
                checked={!!draft[f.field]}
                onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.checked }))}
                style={{ accentColor: '#4ade80', cursor: 'pointer' }}
              />
            ) : f.field_type === 'date' ? (
              <input
                type="date"
                value={draft[f.field] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                style={inputStyle}
              />
            ) : f.field === 'description' || f.field === 'notes' ? (
              <textarea
                value={draft[f.field] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', height: 'auto' }}
              />
            ) : (
              <input
                value={draft[f.field] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
                style={inputStyle}
              />
            )}
          </div>
        ))}

        {/* READONLY FIELDS */}
        {readonlyFields.length > 0 && (
          <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
            <div style={{ color: '#333', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>Read Only</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
              {readonlyFields.map(f => (
                <div key={f.field}>
                  <div style={{ color: '#444', fontSize: '0.65rem', marginBottom: '0.15rem' }}>{f.label}</div>
                  <div style={{ color: '#555', fontSize: '0.75rem' }}>{task[f.field] ?? '—'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ERROR */}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.75rem' }}>{err}</div>}

        {/* FOOTER */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.5rem', borderTop: '1px solid #1a1a1a', paddingTop: '1rem' }}>
          <button onClick={onClose} style={cancelBtnStyle}>cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ ...saveBtnStyle, opacity: saving ? 0.6 : 1 }}
          >{saving ? 'saving...' : 'save'}</button>
        </div>

      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.75)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 100,
};

const modalStyle: React.CSSProperties = {
  background: '#0d0d0d',
  border: '1px solid #222',
  borderRadius: '8px',
  padding: '1.5rem',
  width: '560px',
  maxHeight: '85vh',
  overflowY: 'auto',
  fontFamily: 'monospace',
  scrollbarWidth: 'thin',
  scrollbarColor: '#222 transparent',
};

const fieldGroupStyle: React.CSSProperties = {
  marginBottom: '1rem',
};

const labelStyle: React.CSSProperties = {
  color: '#555',
  fontSize: '0.65rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '0.35rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #222',
  color: '#e5e5e5',
  padding: '0.5rem 0.65rem',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '0.82rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  background: '#111',
  border: '1px solid #222',
  color: '#e5e5e5',
  padding: '0.5rem 0.65rem',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '0.82rem',
  outline: 'none',
};

const cancelBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #333',
  color: '#666',
  padding: '0.4rem 0.9rem',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '0.75rem',
  cursor: 'pointer',
};

const saveBtnStyle: React.CSSProperties = {
  background: '#1a2a1a',
  border: '1px solid #2a4a2a',
  color: '#4ade80',
  padding: '0.4rem 0.9rem',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '0.75rem',
  cursor: 'pointer',
};
