'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import TaskDetailModal from '@/app/components/TaskDetailModal';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Task {
  task_id: string;
  title: string;
  bucket_key: string;
  tags: string[];
  is_completed: boolean;
  is_archived: boolean;
  created_at: string;
  context_id: string | null;
  task_status_id: string | null;
  target_date: string | null;
  context: { name: string; context_id: string } | null;
}

interface Context { context_id: string; name: string; }
interface TaskStatus { task_status_id: string; label: string; }

interface TaskListModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BUCKET_META: Record<string, { color: string; accent: string; label: string; id: string }> = {
  now:      { color: '#ef4444', accent: '#fca5a5', label: 'Now',       id: 'N'  },
  soon:     { color: '#f97316', accent: '#fdba74', label: 'Soon',      id: 'S'  },
  realwork: { color: '#3b82f6', accent: '#93c5fd', label: 'Real Work', id: 'RW' },
  later:    { color: '#6b7280', accent: '#9ca3af', label: 'Later',     id: 'L'  },
  delegate: { color: '#8b5cf6', accent: '#c4b5fd', label: 'Delegate',  id: 'D'  },
  capture:  { color: '#10b981', accent: '#6ee7b7', label: 'Capture',   id: 'CP' },
};

const ACCENT        = '#fbbf24';
const ACCENT_BG     = '#fffbeb';
const ACCENT_BORDER = '#fde68a';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function exportAsCSV(tasks: Task[], statusMap: Record<string, string>): void {
  const headers = ['Identifier', 'Title', 'Bucket', 'Status', 'Context', 'Target Date', 'Tags', 'Completed', 'Archived', 'Created'];
  const rows = tasks.map((t, i) => [
    `${BUCKET_META[t.bucket_key]?.id ?? t.bucket_key}${i + 1}`,
    `"${t.title.replace(/"/g, '""')}"`,
    BUCKET_META[t.bucket_key]?.label ?? t.bucket_key,
    t.task_status_id ? (statusMap[t.task_status_id] ?? '') : '',
    t.context?.name ?? '',
    t.target_date ? formatDate(t.target_date) : '',
    `"${(t.tags ?? []).join(', ')}"`,
    t.is_completed ? 'yes' : 'no',
    t.is_archived ? 'yes' : 'no',
    formatDate(t.created_at),
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tasks-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function TaskListModal({ userId, accessToken, onClose, onSaved }: TaskListModalProps) {
  const [tasks, setTasks]           = useState<Task[]>([]);
  const [loading, setLoading]       = useState(true);
  const [contexts, setContexts]     = useState<Context[]>([]);
  const [statuses, setStatuses]     = useState<TaskStatus[]>([]);
  const [statusMap, setStatusMap]   = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // ─── Filters + sort ────────────────────────────────────────────────────────
  const [search, setSearch]               = useState('');
  const [filterBucket, setFilterBucket]   = useState('');
  const [filterContext, setFilterContext] = useState('');
  const [filterStatus, setFilterStatus]   = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [showArchived, setShowArchived]   = useState(false);
  const [sortBy, setSortBy]               = useState<'created' | 'target' | 'bucket' | 'title' | 'status'>('created');
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('desc');

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 0, y: 0 });
  const [size, setSize]         = useState({ w: 1100, h: 780 });
  const [centered, setCentered] = useState(true);
  const dragging                = useRef(false);
  const resizing                = useRef(false);
  const dragStart               = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef                = useRef<HTMLDivElement>(null);

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadTasks = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('task')
      .select('task_id, title, bucket_key, tags, is_completed, is_archived, created_at, context_id, task_status_id, target_date, context:context_id ( name, context_id )')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setTasks(data as any);
    setLoading(false);
  };

  const loadContexts = async () => {
    const { data } = await supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_archived', false).order('name');
    if (data) setContexts(data);
  };

  const loadStatuses = async () => {
    const { data } = await supabase.from('task_status').select('task_status_id, label').eq('user_id', userId).order('label');
    if (data) {
      setStatuses(data);
      const map: Record<string, string> = {};
      for (const s of data) map[s.task_status_id] = s.label;
      setStatusMap(map);
    }
  };

  useEffect(() => { loadTasks(); loadContexts(); loadStatuses(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !selectedTaskId) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedTaskId]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) { setPos({ x: dragStart.current.x + (e.clientX - dragStart.current.mx), y: dragStart.current.y + (e.clientY - dragStart.current.my) }); setCentered(false); }
      if (resizing.current) { setSize({ w: Math.max(800, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(500, resizeStart.current.h + (e.clientY - resizeStart.current.my)) }); }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Filter + sort ─────────────────────────────────────────────────────────

  const filtered = tasks
    .filter(t => {
      if (!showCompleted && t.is_completed) return false;
      if (!showArchived && t.is_archived) return false;
      if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterBucket && t.bucket_key !== filterBucket) return false;
      if (filterContext && t.context_id !== filterContext) return false;
      if (filterStatus && t.task_status_id !== filterStatus) return false;
      return true;
    })
    .sort((a, b) => {
      let av: any, bv: any;
      switch (sortBy) {
        case 'title':   av = a.title.toLowerCase();   bv = b.title.toLowerCase(); break;
        case 'bucket':  av = a.bucket_key;             bv = b.bucket_key; break;
        case 'target':  av = a.target_date ?? '';      bv = b.target_date ?? ''; break;
        case 'status':  av = statusMap[a.task_status_id ?? ''] ?? ''; bv = statusMap[b.task_status_id ?? ''] ?? ''; break;
        default:        av = a.created_at;             bv = b.created_at; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const sortIcon = (col: typeof sortBy) => {
    if (sortBy !== col) return <span style={{ opacity: 0.3 }}>⇅</span>;
    return <span>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // ─── Stats ─────────────────────────────────────────────────────────────────

  const totalAll       = tasks.length;
  const totalOpen      = tasks.filter(t => !t.is_completed && !t.is_archived).length;
  const totalCompleted = tasks.filter(t => t.is_completed).length;
  const totalArchived  = tasks.filter(t => t.is_archived).length;

  // ─── Modal position ────────────────────────────────────────────────────────

  const modalStyle: React.CSSProperties = centered
    ? { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: size.w, height: size.h }
    : { position: 'fixed', top: pos.y, left: pos.x, width: size.w, height: size.h };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100 }}>
        <div ref={modalRef} style={{ ...modalStyle, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

          {/* Header */}
          <div
            onMouseDown={e => { dragging.current = true; const rect = modalRef.current!.getBoundingClientRect(); dragStart.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top }; setCentered(false); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ color: '#000', fontSize: '0.85rem', fontWeight: 700 }}>All Tasks</span>
              <span style={{ color: '#000', fontSize: '0.72rem', opacity: 0.6 }}>{totalOpen} open · {totalCompleted} done · {totalArchived} archived · {totalAll} total</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setShowExportMenu(v => !v)}
                  style={{ background: '#000', border: '1px solid #000', color: ACCENT, padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#222')} onMouseLeave={e => (e.currentTarget.style.background = '#000')}
                >export ▾</button>
                {showExportMenu && (
                  <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '0.25rem', background: '#fff', border: '1px solid #ddd', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 10, minWidth: '120px' }}>
                    <div onClick={() => { exportAsCSV(filtered, statusMap); setShowExportMenu(false); }} style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#333', cursor: 'pointer', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>Export CSV</div>
                  </div>
                )}
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.5 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}>✕</button>
            </div>
          </div>

          {/* Filter bar */}
          <div style={{ padding: '0.65rem 1.25rem', borderBottom: `1px solid ${ACCENT_BORDER}`, background: ACCENT_BG, display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks..."
              style={{ ...inputStyle, width: '200px', fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
            <select value={filterBucket} onChange={e => setFilterBucket(e.target.value)} style={{ ...inputStyle, width: '130px', fontSize: '0.72rem', padding: '0.3rem 0.5rem' }}>
              <option value="">All buckets</option>
              {Object.entries(BUCKET_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
            <select value={filterContext} onChange={e => setFilterContext(e.target.value)} style={{ ...inputStyle, width: '130px', fontSize: '0.72rem', padding: '0.3rem 0.5rem' }}>
              <option value="">All contexts</option>
              {contexts.map(c => <option key={c.context_id} value={c.context_id}>{c.name}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inputStyle, width: '130px', fontSize: '0.72rem', padding: '0.3rem 0.5rem' }}>
              <option value="">All statuses</option>
              {statuses.map(s => <option key={s.task_status_id} value={s.task_status_id}>{s.label}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: '#555', cursor: 'pointer', fontFamily: 'monospace' }}>
              <input type="checkbox" checked={showCompleted} onChange={e => setShowCompleted(e.target.checked)} />
              completed
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: '#555', cursor: 'pointer', fontFamily: 'monospace' }}>
              <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
              archived
            </label>
            <span style={{ color: '#999', fontSize: '0.65rem', fontFamily: 'monospace', marginLeft: 'auto' }}>{filtered.length} of {totalAll}</span>
          </div>

          {/* Table header */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '0.4rem 1.25rem', borderBottom: '1px solid #eee', background: '#fafafa', flexShrink: 0, gap: '0.5rem' }}>
            <div style={{ width: '52px', flexShrink: 0 }}>
              <button onClick={() => toggleSort('bucket')} style={colBtnStyle}>Bucket {sortIcon('bucket')}</button>
            </div>
            <div style={{ flex: 1 }}>
              <button onClick={() => toggleSort('title')} style={colBtnStyle}>Title {sortIcon('title')}</button>
            </div>
            <div style={{ width: '110px', flexShrink: 0 }}>
              <button onClick={() => toggleSort('status')} style={colBtnStyle}>Status {sortIcon('status')}</button>
            </div>
            <div style={{ width: '110px', flexShrink: 0 }}>Context</div>
            <div style={{ width: '90px', flexShrink: 0 }}>
              <button onClick={() => toggleSort('target')} style={colBtnStyle}>Target {sortIcon('target')}</button>
            </div>
            <div style={{ width: '90px', flexShrink: 0 }}>
              <button onClick={() => toggleSort('created')} style={colBtnStyle}>Created {sortIcon('created')}</button>
            </div>
            <div style={{ width: '60px', flexShrink: 0, textAlign: 'center', fontSize: '0.65rem', color: '#aaa', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>State</div>
          </div>

          {/* Table body */}
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
            {loading ? (
              <div style={{ color: '#999', fontSize: '0.75rem', padding: '1.5rem', fontFamily: 'monospace' }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1.5rem', fontFamily: 'monospace' }}>No tasks match the current filters.</div>
            ) : (
              filtered.map((t, idx) => {
                const bm = BUCKET_META[t.bucket_key];
                const identifier = `${bm?.id ?? t.bucket_key}${idx + 1}`;
                const isCompleted = t.is_completed;
                const isArchived  = t.is_archived;

                return (
                  <div key={t.task_id}
                    onClick={() => setSelectedTaskId(t.task_id)}
                    style={{ display: 'flex', alignItems: 'center', padding: '0.55rem 1.25rem', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', gap: '0.5rem', background: isCompleted ? '#f9fafb' : isArchived ? '#f5f5f5' : '#fff', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BG)}
                    onMouseLeave={e => (e.currentTarget.style.background = isCompleted ? '#f9fafb' : isArchived ? '#f5f5f5' : '#fff')}
                  >
                    {/* Bucket identifier */}
                    <div style={{ width: '52px', flexShrink: 0 }}>
                      <span style={{ color: bm?.accent ?? '#999', fontSize: '0.65rem', fontWeight: 700, fontFamily: 'monospace', background: '#f5f5f5', borderLeft: `3px solid ${bm?.color ?? '#999'}`, padding: '0.1rem 0.3rem', borderRadius: '2px' }}>{identifier}</span>
                    </div>

                    {/* Title */}
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <span style={{ color: isCompleted || isArchived ? '#999' : '#111', fontSize: '0.82rem', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', textDecoration: isCompleted ? 'line-through' : 'none' }}>{t.title}</span>
                    </div>

                    {/* Status */}
                    <div style={{ width: '110px', flexShrink: 0 }}>
                      {t.task_status_id && statusMap[t.task_status_id] && (
                        <span style={{ fontSize: '0.65rem', color: '#666', background: '#f0f0f0', borderRadius: '3px', padding: '0.1rem 0.35rem', fontFamily: 'monospace' }}>{statusMap[t.task_status_id]}</span>
                      )}
                    </div>

                    {/* Context */}
                    <div style={{ width: '110px', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.7rem', color: '#555', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{t.context?.name ?? ''}</span>
                    </div>

                    {/* Target date */}
                    <div style={{ width: '90px', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.7rem', color: '#888', fontFamily: 'monospace' }}>{t.target_date ? formatDate(t.target_date) : ''}</span>
                    </div>

                    {/* Created */}
                    <div style={{ width: '90px', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.7rem', color: '#bbb', fontFamily: 'monospace' }}>{formatDate(t.created_at)}</span>
                    </div>

                    {/* State badges */}
                    <div style={{ width: '60px', flexShrink: 0, display: 'flex', gap: '0.2rem', justifyContent: 'center' }}>
                      {isCompleted && <span style={{ fontSize: '0.6rem', color: '#10b981', background: '#ecfdf5', borderRadius: '3px', padding: '0.1rem 0.3rem', fontFamily: 'monospace' }}>done</span>}
                      {isArchived  && <span style={{ fontSize: '0.6rem', color: '#6b7280', background: '#f3f4f6', borderRadius: '3px', padding: '0.1rem 0.3rem', fontFamily: 'monospace' }}>arch</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Resize handle */}
          <div onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }} style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
          </div>

        </div>
      </div>

      {/* TaskDetailModal on top */}
      {selectedTaskId && (
        <TaskDetailModal
          taskId={selectedTaskId}
          userId={userId}
          accessToken={accessToken}
          onClose={() => setSelectedTaskId(null)}
          onSaved={() => { loadTasks(); setSelectedTaskId(null); onSaved(); }}
        />
      )}
    </>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #ddd', color: '#222',
  padding: '0.5rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace',
  fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.15s',
};

const colBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace',
  fontSize: '0.65rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em',
  padding: 0, display: 'flex', alignItems: 'center', gap: '0.2rem',
};
