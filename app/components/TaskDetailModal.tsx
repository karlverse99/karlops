'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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

interface ListFieldItem {
  field: string;
  label?: string;
  field_order: number;
}

function parseListFields(raw: unknown): ListFieldItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: Record<string, unknown>) => ({
      field: String(row?.field ?? ''),
      label: typeof row?.label === 'string' ? row.label : undefined,
      field_order: typeof row?.field_order === 'number' ? row.field_order : Number(row?.field_order) || 0,
    }))
    .filter((r) => r.field);
}

/** Merge list view field order with ko_field_metadata (same idea as CompletionsModal). */
function orderCompletionFields(listFields: ListFieldItem[], meta: FieldMeta[]): FieldMeta[] {
  const metaByField = new Map(meta.map((m) => [m.field, m]));
  const merged: FieldMeta[] = [];
  const seen = new Set<string>();
  for (const lf of [...listFields].sort((a, b) => a.field_order - b.field_order)) {
    const base = metaByField.get(lf.field);
    if (!base || base.display_order >= 999) continue;
    merged.push(lf.label ? { ...base, label: lf.label } : base);
    seen.add(lf.field);
  }
  const rest = [...meta]
    .filter((m) => !seen.has(m.field) && m.display_order < 999)
    .sort((a, b) => a.display_order - b.display_order);
  return [...merged, ...rest];
}

/** Prepend a dated block so the log reads newest-first (no versioning — one `notes` field). */
function prependDatedStatusNote(existing: string | null | undefined, addition: string): string {
  const t = addition.trim();
  if (!t) return String(existing ?? '').replace(/\s+$/, '');
  const date = new Date().toISOString().slice(0, 10);
  const block = `[${date}]\n${t}\n\n`;
  const prev = (existing ?? '').trim();
  return prev ? `${block}${prev}` : `[${date}]\n${t}\n`;
}

function slugForStatusFilename(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\w\-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 48) || 'task';
}

/** Shareable status doc from current notes (email hook can reuse this body later). */
function downloadStatusMarkdown(taskTitle: string, notes: string | null | undefined): void {
  const title = taskTitle.trim() || 'Task';
  const body = notes?.trim() || '_(No notes / status log yet.)_';
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const md = [
    `# Status — ${title}`,
    '',
    `_Exported ${stamp} UTC · source: task notes / status in KarlOps_`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `status-${slugForStatusFilename(title)}-${d}.md`;
  a.click();
  URL.revokeObjectURL(url);
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
// Single-select People tag picker. "Other" always pinned at top. Search when > 5 tags.

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
  const [search, setSearch] = useState('');

  const selectedTag = peopleTags.find(t => t.tag_id === value);

  const sorted = [
    ...peopleTags.filter(t => t.name === 'Other'),
    ...peopleTags.filter(t => t.name !== 'Other').sort((a, b) => a.name.localeCompare(b.name)),
  ].filter(t =>
    !search ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.description ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      {/* Selected confirmation strip */}
      {value && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', padding: '0.3rem 0.6rem', background: `${DELEGATE_PURPLE}10`, border: `1px solid ${DELEGATE_PURPLE}40`, borderRadius: '4px' }}>
          <span style={{ color: DELEGATE_PURPLE, fontSize: '0.72rem' }}>→</span>
          <span style={{ color: DELEGATE_PURPLE, fontWeight: 700, fontSize: '0.78rem' }}>{selectedTag?.name}</span>
          <span
            onClick={() => onChange('', '')}
            style={{ marginLeft: 'auto', fontSize: '0.62rem', color: '#bbb', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#888')}
            onMouseLeave={e => (e.currentTarget.style.color = '#bbb')}
          >✕ clear</span>
        </div>
      )}

      {/* Search — only shown when list is long */}
      {peopleTags.length > 5 && (
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          style={{ width: '100%', background: '#fafafa', border: '1px solid #ddd', borderRadius: '4px', padding: '0.3rem 0.5rem', fontFamily: 'monospace', fontSize: '0.72rem', color: '#333', outline: 'none', boxSizing: 'border-box' as const, marginBottom: '0.4rem' }}
          onFocus={e => (e.target.style.borderColor = DELEGATE_PURPLE)}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
      )}

      {/* Pills */}
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
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
                border: `1px solid ${isSelected ? DELEGATE_PURPLE : '#ddd'}`,
                background: isSelected ? `${DELEGATE_PURPLE}15` : '#fafafa',
                color: isSelected ? DELEGATE_PURPLE : isOther ? '#999' : '#555',
                fontWeight: isSelected ? 700 : 400,
                fontStyle: isOther ? 'italic' : 'normal',
              }}
              onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.borderColor = DELEGATE_PURPLE; e.currentTarget.style.color = DELEGATE_PURPLE; } }}
              onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.color = isOther ? '#999' : '#555'; } }}
            >
              {t.name}
            </div>
          );
        })}
      </div>
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
  const [pendingStatusNote, setPendingStatusNote] = useState('');

  // ─── Complete flow (driven by ko_field_metadata + ko_list_view_config for completion) ─
  const [completing, setCompleting]               = useState(false);
  const [completionMeta, setCompletionMeta]       = useState<FieldMeta[]>([]);
  const [completionListFields, setCompletionListFields] = useState<ListFieldItem[]>([]);
  const [completionTitle, setCompletionTitle]     = useState('');
  const [completionOutcome, setCompletionOutcome] = useState('');
  const [completionDescription, setCompletionDescription] = useState('');
  const [completionCompletedAt, setCompletionCompletedAt] = useState('');
  const [completionTags, setCompletionTags]       = useState<string[]>([]);
  const [completionContextId, setCompletionContextId] = useState('');
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
        const [taskRes, metaRes, tagRes, groupRes, ctxRes, statusRes, compMetaRes, listCfgRes] = await Promise.all([
          supabase.from('task').select('*').eq('task_id', taskId).single(),
          supabase.from('ko_field_metadata').select('*').eq('user_id', userId).eq('object_type', 'task').order('display_order'),
          supabase.from('tag').select('tag_id, name, tag_group_id, description').eq('user_id', userId).eq('is_archived', false).order('name'),
          supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).eq('is_archived', false).order('display_order'),
          supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false),
          supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order'),
          supabase.from('ko_field_metadata').select('*').eq('user_id', userId).eq('object_type', 'completion').order('display_order'),
          supabase.from('ko_list_view_config').select('list_fields').eq('user_id', userId).eq('object_type', 'completion').maybeSingle(),
        ]);

        if (taskRes.error) throw taskRes.error;
        setTask(taskRes.data);
        setDraft(taskRes.data);

        const allTagData   = tagRes.data ?? [];
        const allGroupData = groupRes.data ?? [];
        setAllTags(allTagData);
        setTagGroups(allGroupData);
        setFields((metaRes.data ?? []) as FieldMeta[]);
        setCompletionMeta((compMetaRes.data ?? []) as FieldMeta[]);
        setCompletionListFields(parseListFields(listCfgRes.data?.list_fields));

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

  const completionVisibleFields = useMemo(() => {
    const ordered = orderCompletionFields(completionListFields, completionMeta);
    return ordered.filter((f) => f.insert_behavior !== 'automatic' && f.field !== 'task_id');
  }, [completionListFields, completionMeta]);

  const useDynamicCompletionForm = completionVisibleFields.length > 0;

  const completionRequiredOk = useMemo(() => {
    if (!useDynamicCompletionForm) return !!completionTitle.trim();
    for (const f of completionVisibleFields) {
      if (f.insert_behavior !== 'required') continue;
      if (f.field === 'title' && !completionTitle.trim()) return false;
      if (f.field === 'outcome' && !completionOutcome.trim()) return false;
      if (f.field === 'completed_at' && !completionCompletedAt) return false;
    }
    return true;
  }, [
    useDynamicCompletionForm,
    completionVisibleFields,
    completionTitle,
    completionOutcome,
    completionCompletedAt,
  ]);

  const renderCompletionField = (meta: FieldMeta, autoFocus: boolean) => {
    const required = meta.insert_behavior === 'required';
    const lab = (
      <div style={labelStyle}>
        {meta.label}
        {required && <span style={{ color: '#ef4444' }}>*</span>}
      </div>
    );

    switch (meta.field) {
      case 'title':
        return (
          <div key="title" style={fieldGroup}>
            {lab}
            <input
              autoFocus={autoFocus}
              value={completionTitle}
              onChange={(e) => setCompletionTitle(e.target.value)}
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );
      case 'outcome':
        return (
          <div key="outcome" style={fieldGroup}>
            {lab}
            <textarea
              autoFocus={autoFocus}
              value={completionOutcome}
              onChange={(e) => setCompletionOutcome(e.target.value)}
              placeholder="What was the result? What changed?"
              rows={meta.field_type === 'textarea' ? 5 : 4}
              style={{ ...inputStyle, resize: 'vertical', minHeight: '80px' }}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );
      case 'description':
        return (
          <div key="description" style={fieldGroup}>
            {lab}
            <textarea
              autoFocus={autoFocus}
              value={completionDescription}
              onChange={(e) => setCompletionDescription(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );
      case 'completed_at':
        return (
          <div key="completed_at" style={fieldGroup}>
            {lab}
            <input
              type="datetime-local"
              autoFocus={autoFocus}
              value={completionCompletedAt}
              onChange={(e) => setCompletionCompletedAt(e.target.value)}
              style={{ ...inputStyle, colorScheme: 'light' }}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            />
          </div>
        );
      case 'tags':
        return (
          <div key="tags" style={{ ...fieldGroup, borderTop: '1px solid #f0f0f0', paddingTop: '0.75rem' }}>
            <TagPicker
              selected={completionTags}
              allTags={allTags}
              tagGroups={tagGroups}
              onChange={setCompletionTags}
              onTagCreated={loadTags}
              accentColor={ACCENT}
              objectType="completion"
              contextText={completionTitle}
              accessToken={accessToken}
              userId={userId}
              label={meta.label}
            />
          </div>
        );
      case 'context_id':
        return (
          <div key="context_id" style={fieldGroup}>
            {lab}
            <select
              value={completionContextId}
              onChange={(e) => setCompletionContextId(e.target.value)}
              style={selectStyle}
              onFocus={(e) => (e.target.style.borderColor = ACCENT)}
              onBlur={(e) => (e.target.style.borderColor = '#ddd')}
            >
              <option value="">— none —</option>
              {(fkData.context_id ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        );
      default:
        return null;
    }
  };

  // ─── Complete ─────────────────────────────────────────────────────────────
  const handleCompleteConfirm = async () => {
    if (!completionRequiredOk) {
      setErr(completionVisibleFields.length > 0 ? 'Fill all required fields.' : 'Completion title is required');
      return;
    }
    setCompletionSaving(true); setErr('');
    try {
      const completedAtIso = new Date(completionCompletedAt || new Date().toISOString()).toISOString();
      const { error: compErr } = await supabase.from('completion').insert({
        user_id:        userId,
        task_id:        taskId,
        title:          completionTitle.trim(),
        outcome:        completionOutcome.trim() || null,
        description:    completionDescription.trim() || null,
        completed_at:   completedAtIso,
        tags:           completionTags.length > 0 ? completionTags : null,
        context_id:     completionContextId || null,
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

            // ─── COMPLETION FORM (ko_field_metadata + list_fields order) ───
            <div>
              <div style={{ color: '#888', fontSize: '0.78rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                {completionVisibleFields.length > 0
                  ? 'Log the completion using your workspace field settings. Task link is saved automatically.'
                  : 'Log what you accomplished. Edit the title if needed.'}
              </div>
              {completionVisibleFields.length > 0 ? (
                completionVisibleFields.map((f, idx) => renderCompletionField(f, idx === 0))
              ) : (
                <>
                  <div style={fieldGroup}>
                    <div style={labelStyle}>What did you complete <span style={{ color: '#ef4444' }}>*</span></div>
                    <input autoFocus value={completionTitle} onChange={(e) => setCompletionTitle(e.target.value)} style={inputStyle}
                      onFocus={(e) => (e.target.style.borderColor = ACCENT)} onBlur={(e) => (e.target.style.borderColor = '#ddd')} />
                  </div>
                  <div style={fieldGroup}>
                    <div style={labelStyle}>Outcome / what happened</div>
                    <textarea value={completionOutcome} onChange={(e) => setCompletionOutcome(e.target.value)}
                      placeholder="What was the result? What changed? What did you learn?"
                      rows={5} style={{ ...inputStyle, resize: 'vertical' }}
                      onFocus={(e) => (e.target.style.borderColor = ACCENT)} onBlur={(e) => (e.target.style.borderColor = '#ddd')} />
                  </div>
                  <div style={{ color: '#aaa', fontSize: '0.68rem', marginTop: '0.5rem' }}>
                    No completion field metadata found — simple form. Add completion fields in Admin → Field metadata.
                  </div>
                </>
              )}
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

              {/* NOTES / STATUS — single field; dated prepends for quick updates */}
              <div style={fieldGroup}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <div style={labelStyle}>Notes / Status</div>
                  <button
                    type="button"
                    onClick={() => downloadStatusMarkdown(String(draft.title ?? ''), draft.notes)}
                    style={{
                      background: 'none',
                      border: '1px solid #ddd',
                      color: '#666',
                      padding: '0.22rem 0.5rem',
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '0.65rem',
                      cursor: 'pointer',
                    }}
                    title="Download current log as Markdown (share with client or archive)"
                  >
                    download status (.md)
                  </button>
                </div>
                <p style={{ fontSize: '0.65rem', color: '#888', margin: '0 0 0.45rem', lineHeight: 1.45 }}>
                  One running log on the task — no separate versions. Add dated lines below (prepended), or edit the whole field. Save persists to the task.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.5rem' }}>
                  <textarea
                    value={pendingStatusNote}
                    onChange={(e) => setPendingStatusNote(e.target.value)}
                    placeholder="Add a note or status line…"
                    rows={2}
                    style={{ ...inputStyle, resize: 'vertical', minHeight: '44px', fontSize: '0.78rem' }}
                    onFocus={(e) => (e.target.style.borderColor = ACCENT)}
                    onBlur={(e) => (e.target.style.borderColor = '#ddd')}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      disabled={!pendingStatusNote.trim()}
                      onClick={() => {
                        const next = prependDatedStatusNote(draft.notes, pendingStatusNote);
                        setDraft((d) => ({ ...d, notes: next }));
                        setPendingStatusNote('');
                      }}
                      style={{
                        background: pendingStatusNote.trim() ? `${ACCENT}22` : '#f5f5f5',
                        border: `1px solid ${pendingStatusNote.trim() ? ACCENT : '#e5e5e5'}`,
                        color: pendingStatusNote.trim() ? '#92400e' : '#bbb',
                        padding: '0.3rem 0.65rem',
                        borderRadius: '4px',
                        fontFamily: 'monospace',
                        fontSize: '0.72rem',
                        cursor: pendingStatusNote.trim() ? 'pointer' : 'not-allowed',
                        fontWeight: 600,
                      }}
                    >
                      add to log (prepend date)
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: '0.62rem', color: '#999', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
                  Full field (saved with task)
                </div>
                <textarea
                  value={draft.notes ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  placeholder="Instructions, context, full status trail…"
                  rows={4}
                  style={{ ...inputStyle, resize: 'vertical', minHeight: '72px' }}
                  onFocus={(e) => (e.target.style.borderColor = ACCENT)}
                  onBlur={(e) => (e.target.style.borderColor = '#ddd')}
                />
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
                      Required — select a person or choose Other.
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
              <button onClick={handleCompleteConfirm} disabled={completionSaving || !completionRequiredOk}
                style={{ ...actionBtn, background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c', opacity: completionSaving || !completionRequiredOk ? 0.5 : 1 }}>
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
                <button
                  onClick={() => {
                    setCompletionTitle(draft.title ?? '');
                    setCompletionOutcome('');
                    setCompletionDescription('');
                    setCompletionCompletedAt(new Date().toISOString().slice(0, 16));
                    setCompletionTags([...(draft.tags ?? [])]);
                    setCompletionContextId(draft.context_id ?? '');
                    setCompleting(true);
                    setErr('');
                  }}
                  disabled={loading}
                  style={{ ...actionBtn, background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c' }}
                >
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
