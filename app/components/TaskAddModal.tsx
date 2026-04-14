'use client';

// app/components/TaskAddModal.tsx
// KarlOps L — Add tasks with full metadata
// Flow: Task → Bucket → Context/Status → Target Date → Tell Karl More → Tags
// Tags required for non-capture buckets
// Auto-suggest fires on task title blur
// Capture warning shown if saved without tags

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import TagPicker from '@/app/components/TagPicker';
import TagManagerModal from '@/app/components/TagManagerModal';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Tag { tag_id: string; name: string; tag_group_id: string; }
interface TagGroup { tag_group_id: string; name: string; }
interface Context { context_id: string; name: string; }
interface TaskStatus { task_status_id: string; label: string; }

interface Props {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BUCKET_OPTIONS = [
  { key: 'capture',  label: 'Capture',   color: '#10b981' },
  { key: 'now',      label: 'On Fire',   color: '#ef4444' },
  { key: 'soon',     label: 'Up Next',   color: '#f97316' },
  { key: 'realwork', label: 'Real Work', color: '#3b82f6' },
  { key: 'later',    label: 'Later',     color: '#6b7280' },
  { key: 'delegate', label: 'Delegated', color: '#8b5cf6' },
];

const ACCENT        = '#10b981';
const ACCENT_BG     = '#f0fdf4';
const ACCENT_BORDER = '#bbf7d0';
const DEFAULT_W     = 560;
const DEFAULT_H     = 700;
const MIN_W         = 420;
const MIN_H         = 500;

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

// ─── MAIN MODAL ───────────────────────────────────────────────────────────────

export default function TaskAddModal({ userId, accessToken, onClose, onSaved }: Props) {

  // ─── Reference data ──────────────────────────────────────────────────────
  const [allTags, setAllTags]     = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [contexts, setContexts]   = useState<Context[]>([]);
  const [statuses, setStatuses]   = useState<TaskStatus[]>([]);
  const [loading, setLoading]     = useState(true);

  // ─── Form state ──────────────────────────────────────────────────────────
  const [rawInput, setRawInput]      = useState('');
  const [multiMode, setMultiMode]    = useState(false);
  const [bucket, setBucket]          = useState('capture');
  const [contextId, setContextId]    = useState('');
  const [statusId, setStatusId]      = useState('');
  const [targetDate, setTargetDate]  = useState('');
  const [karlContext, setKarlContext]   = useState('');
  const [suggestInvoked, setSuggestInvoked] = useState(false);
  const [notes, setNotes]              = useState('');
  const [tags, setTags]              = useState<string[]>([]);
  const [showTagManager, setShowTagManager] = useState(false);

  // ─── Submit/feedback state ────────────────────────────────────────────────
  const [saving, setSaving]                 = useState(false);
  const [err, setErr]                       = useState('');
  const [savedToCapture, setSavedToCapture] = useState<string[]>([]);
  const [savedCurated, setSavedCurated]     = useState<string[]>([]);

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

  // ─── Load reference data + defaults ──────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [tagRes, groupRes, ctxRes, statusRes, defaultRes] = await Promise.all([
          supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId).eq('is_archived', false).order('name'),
          supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).eq('is_archived', false).order('display_order'),
          supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false).eq('is_visible', true).order('name'),
          supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('display_order'),
          supabase.from('ko_default_registry').select('field, value').eq('user_id', userId).eq('object_type', 'task'),
        ]);
        setAllTags(tagRes.data ?? []);
        setTagGroups(groupRes.data ?? []);
        setContexts(ctxRes.data ?? []);
        setStatuses(statusRes.data ?? []);
        const dm: Record<string, string> = {};
        for (const d of defaultRes.data ?? []) dm[d.field] = d.value;
        setBucket(dm['bucket_key']       ?? 'capture');
        setContextId(dm['context_id']    ?? '');
        setStatusId(dm['task_status_id'] ?? '');
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [userId]);

  // ─── Derived ─────────────────────────────────────────────────────────────

  const parseTitles = (raw: string): string[] =>
    multiMode
      ? raw.split('\n').map(t => t.replace(/^[-•*]\s*/, '').trim()).filter(t => t.length > 0)
      : raw.trim() ? [raw.trim()] : [];

  const previews     = parseTitles(rawInput);
  const isCapture    = bucket === 'capture';
  const isCurated    = !isCapture && tags.length > 0;
  const needsTagWarn = !isCapture && tags.length === 0;
  const contextText  = rawInput.trim() + (karlContext.trim() ? '\n' + karlContext.trim() : '');

  // ─── Submit ──────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (previews.length === 0) { setErr('Enter at least one task'); return; }
    if (!isCapture && tags.length === 0) {
      setErr(`Tags required for ${bucket} bucket — add at least one tag or move to Capture`);
      return;
    }
    setSaving(true); setErr('');
    setSavedToCapture([]); setSavedCurated([]);

    try {
      const records = previews.map(title => ({
        user_id:        userId,
        title,
        bucket_key:     bucket,
        context_id:     contextId  || null,
        task_status_id: statusId   || null,
        tags:           tags,
        target_date:    targetDate || null,
        notes:          notes.trim() || null,
      }));

      const { data, error } = await supabase.from('task').insert(records).select('title');
      if (error) throw error;

      const titles = data?.map(t => t.title) ?? [];
      if (isCapture && tags.length === 0) {
        setSavedToCapture(titles);
      } else {
        setSavedCurated(titles);
      }

      setRawInput('');
      setTags([]);
      setKarlContext('');
      setNotes('');
      onSaved();

    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <>
    {showTagManager && (
      <TagManagerModal
        userId={userId}
        accessToken={accessToken}
        onClose={() => setShowTagManager(false)}
        onChanged={async () => {
          const { data } = await supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId).eq('is_archived', false).order('name');
          if (data) setAllTags(data);
          const { data: groups } = await supabase.from('tag_group').select('tag_group_id, name').eq('user_id', userId).eq('is_archived', false).order('display_order');
          if (groups) setTagGroups(groups);
        }}
      />
    )}
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', pointerEvents: 'all', overflow: 'hidden' }}>

        {/* HEADER */}
        <div onMouseDown={onDragStart}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', flexShrink: 0, userSelect: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>Add Task</span>
            {isCurated && (
              <span style={{ fontSize: '0.65rem', color: '#16a34a', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '4px', padding: '0.15rem 0.5rem' }}>✓ curated</span>
            )}
            {needsTagWarn && (
              <span style={{ fontSize: '0.65rem', color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '4px', padding: '0.15rem 0.5rem' }}>tags required</span>
            )}
            {isCapture && tags.length === 0 && (
              <span style={{ fontSize: '0.65rem', color: '#000', background: 'rgba(0,0,0,0.12)', borderRadius: '4px', padding: '0.15rem 0.5rem' }}>capture</span>
            )}
            {/* Single / Multi toggle */}
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.15)', borderRadius: '4px', padding: '0.1rem' }}>
              <div onClick={() => { setMultiMode(false); setRawInput(''); }}
                style={{ padding: '0.15rem 0.5rem', borderRadius: '3px', fontSize: '0.65rem', cursor: 'pointer', background: !multiMode ? 'rgba(0,0,0,0.3)' : 'transparent', color: !multiMode ? '#000' : 'rgba(0,0,0,0.5)', fontWeight: !multiMode ? 700 : 400, transition: 'all 0.15s' }}
              >single</div>
              <div onClick={() => { setMultiMode(true); setRawInput(''); }}
                style={{ padding: '0.15rem 0.5rem', borderRadius: '3px', fontSize: '0.65rem', cursor: 'pointer', background: multiMode ? 'rgba(0,0,0,0.3)' : 'transparent', color: multiMode ? '#000' : 'rgba(0,0,0,0.5)', fontWeight: multiMode ? 700 : 400, transition: 'all 0.15s' }}
              >multi</div>
            </div>
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
          ) : (
            <>
              {/* 1. TASK */}
              <div style={fieldGroup}>
                <div style={labelStyle}>
                  {multiMode ? 'Tasks' : 'Task'} <span style={{ color: '#ef4444' }}>*</span>
                  {multiMode && <span style={{ color: '#aaa', textTransform: 'none', letterSpacing: 0, marginLeft: '0.4rem' }}>— one per line</span>}
                </div>
                {multiMode ? (
                  <textarea autoFocus value={rawInput} onChange={e => setRawInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSubmit(); }}
                    placeholder={'Buy olive oil\nBoil water\nCook pasta al dente'}
                    rows={4} style={{ ...inputStyle, resize: 'vertical' }}
                    onFocus={e => (e.target.style.borderColor = ACCENT)}
                    onBlur={e => (e.target.style.borderColor = '#ddd')}
                  />
                ) : (
                  <input autoFocus value={rawInput} onChange={e => setRawInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
                    placeholder="What needs doing?" style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = ACCENT)}
                    onBlur={e => (e.target.style.borderColor = '#ddd')}
                  />
                )}
                {multiMode && previews.length > 0 && (
                  <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {previews.map((t, i) => (
                      <div key={i} style={{ color: '#16a34a', fontSize: '0.75rem', padding: '0.2rem 0.5rem', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '4px' }}>{t}</div>
                    ))}
                  </div>
                )}
                {multiMode && <div style={{ color: '#aaa', fontSize: '0.63rem', marginTop: '0.25rem' }}>⌘↵ to add</div>}
              </div>

              {/* 1b. NOTES */}
              {!multiMode && (
                <div style={{ marginBottom: '1rem', marginTop: '-0.5rem' }}>
                  <div style={labelStyle}>Notes</div>
                  <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Instructions, context, extra detail..."
                    rows={2}
                    style={{ ...inputStyle, resize: 'vertical', minHeight: '52px' }}
                    onFocus={e => (e.target.style.borderColor = ACCENT)}
                    onBlur={e => (e.target.style.borderColor = '#ddd')}
                  />
                </div>
              )}

              {/* 2. BUCKET */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Bucket</div>
                <BucketPicker value={bucket} onChange={setBucket} />
              </div>

              {/* 3. CONTEXT + STATUS */}
              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>Context</div>
                  <select value={contextId} onChange={e => setContextId(e.target.value)} style={selectStyle}
                    onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
                    <option value="">— none —</option>
                    {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>Status</div>
                  <select value={statusId} onChange={e => setStatusId(e.target.value)} style={selectStyle}
                    onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
                    <option value="">— none —</option>
                    {statuses.map(s => <option key={s.task_status_id} value={s.task_status_id}>{s.label}</option>)}
                  </select>
                </div>
              </div>

              {/* 4. TARGET DATE */}
              <div style={fieldGroup}>
                <div style={labelStyle}>Target Date</div>
                <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)}
                  style={{ ...inputStyle, colorScheme: 'light', cursor: 'pointer', width: '180px' }}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                />
              </div>

              {/* 5. TAGS */}
              <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '1rem' }}>
                <TagPicker
                  selected={tags}
                  allTags={allTags}
                  tagGroups={tagGroups}
                  onChange={setTags}
                  onTagCreated={async () => {
                    const { data } = await supabase.from('tag').select('tag_id, name, tag_group_id').eq('user_id', userId).eq('is_archived', false).order('name');
                    if (data) setAllTags(data);
                  }}
                  accentColor={ACCENT}
                  objectType="task"
                  contextText={contextText}
                  accessToken={accessToken}
                  userId={userId}
                  label={isCapture ? 'Tags' : 'Tags *'}
                  onSuggestInvoked={() => setSuggestInvoked(true)}
                  onOpenTagManager={() => setShowTagManager(true)}
                />

              </div>

              {/* 6. TELL KARL MORE — appears after suggest pressed */}
              {suggestInvoked && (
                <div style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                    <div style={labelStyle}>Tell Karl More</div>
                    <span style={{ fontSize: '0.62rem', color: '#aaa', fontStyle: 'italic' }}>helps tag suggestion — not saved</span>
                  </div>
                  <textarea value={karlContext} onChange={e => setKarlContext(e.target.value)}
                    placeholder="Paste context, background, or notes — Karl reads this to suggest better tags..."
                    rows={2} style={{ ...inputStyle, resize: 'vertical', background: '#fffdf5', borderColor: '#e5e0c8', color: '#666', fontSize: '0.78rem' }}
                    onFocus={e => (e.target.style.borderColor = '#c8b96a')}
                    onBlur={e => (e.target.style.borderColor = '#e5e0c8')}
                  />
                </div>
              )}

              {/* SUCCESS — curated */}
              {savedCurated.length > 0 && (
                <div style={{ padding: '0.6rem 0.75rem', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '6px', marginBottom: '0.5rem', marginTop: '0.75rem' }}>
                  <div style={{ color: '#16a34a', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.25rem' }}>✓ {savedCurated.length} task{savedCurated.length > 1 ? 's' : ''} added</div>
                  {savedCurated.map((t, i) => <div key={i} style={{ color: '#aaa', fontSize: '0.7rem' }}>{t}</div>)}
                </div>
              )}

              {/* SUCCESS — sent to capture warning */}
              {savedToCapture.length > 0 && (
                <div style={{ padding: '0.6rem 0.75rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', marginBottom: '0.5rem', marginTop: '0.75rem' }}>
                  <div style={{ color: '#dc2626', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.15rem' }}>⚠ Sent to Capture — no tags</div>
                  <div style={{ color: '#ef4444', fontSize: '0.68rem', marginBottom: '0.35rem' }}>Add tags and move out of capture to curate</div>
                  {savedToCapture.map((t, i) => <div key={i} style={{ color: '#aaa', fontSize: '0.7rem' }}>{t}</div>)}
                </div>
              )}

              {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginTop: '0.5rem' }}>{err}</div>}
            </>
          )}
        </div>

        {/* FOOTER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.25rem', borderTop: `1px solid ${ACCENT_BORDER}`, background: '#fafafa', flexShrink: 0 }}>
          <div style={{ color: '#aaa', fontSize: '0.65rem' }}>
            {isCurated ? '✓ will be curated on save' : isCapture ? 'capture — add tags to curate' : 'tags required to save'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={onClose}
              style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}
            >cancel</button>
            <button onClick={handleSubmit} disabled={saving || previews.length === 0}
              style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#000', padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 600, cursor: previews.length === 0 ? 'not-allowed' : 'pointer', opacity: saving || previews.length === 0 ? 0.5 : 1 }}
            >
              {saving ? 'adding...' : `add ${previews.length > 1 ? `${previews.length} tasks` : 'task'}`}
            </button>
          </div>
        </div>

        {/* RESIZE HANDLE */}
        <div onMouseDown={onResizeStart}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>

      </div>
    </div>
  </>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

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
