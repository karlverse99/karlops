'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import TaskDetailModal from '@/app/components/TaskDetailModal';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface KOUser { id: string; email: string; display_name: string; implementation_type: string; }
interface Task {
  id: string;
  title: string;
  bucket_key: string;
  tags: string[];
  is_completed: boolean;
  is_archived: boolean;
  created_at: string;
  context_id: string | null;
  task_status_id: string | null;
  target_date: string | null;
}
interface ChatMessage { role: 'user' | 'assistant'; content: string; timestamp: Date; }
interface BucketDef { key: string; label: string; icon: string; color: string; accent: string; }
interface Context { context_id: string; name: string; }
interface TaskStatus { task_status_id: string; name: string; label: string; }
interface PendingAction { intent: string; payload: Record<string, any>; summary: string; }

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// Colors stay hardcoded — design decision, not data
const BUCKET_COLORS: Record<string, { color: string; accent: string }> = {
  now:      { color: '#ef4444', accent: '#fca5a5' },
  soon:     { color: '#f97316', accent: '#fdba74' },
  realwork: { color: '#3b82f6', accent: '#93c5fd' },
  later:    { color: '#6b7280', accent: '#9ca3af' },
  delegate: { color: '#8b5cf6', accent: '#c4b5fd' },
  capture:  { color: '#10b981', accent: '#6ee7b7' },
};

// Task identifiers — stable, hardcoded, matches Karl's internal references
const BUCKET_ID: Record<string, string> = {
  now:      'N',
  soon:     'S',
  realwork: 'RW',
  later:    'L',
  delegate: 'D',
  capture:  'CP',
};

const CONFIRM_WORDS = ['yes', 'yeah', 'yep', 'yup', 'do it', 'confirm', 'ok', 'sure', 'go', 'capture it', 'add it', 'capture them', 'add them', 'all of them'];
const DENY_WORDS    = ['no', 'nope', 'cancel', 'stop', 'nevermind', 'never mind', 'nah'];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function groupTasksByBucket(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  for (const key of Object.keys(BUCKET_COLORS)) grouped[key] = [];
  for (const task of tasks) {
    if (grouped[task.bucket_key]) grouped[task.bucket_key].push(task);
  }
  return grouped;
}

function renderMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: '#fff', fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i} style={{ color: '#ccc' }}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} style={{ background: '#1e1e1e', padding: '0.1rem 0.3rem', borderRadius: '3px', fontSize: '0.78rem', color: '#4ade80' }}>{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{part}</span>;
  });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── COMPONENTS: TaskPill ────────────────────────────────────────────────────

function TaskPill({ task, bucket, statusLabel, taskIndex, onClick }: {
  task: Task;
  bucket: BucketDef;
  statusLabel?: string;
  taskIndex: number;
  onClick: () => void;
}) {
  const isCaptured = task.bucket_key === 'capture';

  return (
    <div
      onClick={onClick}
      style={{ padding: '0.5rem 0.75rem', background: '#161616', border: '1px solid #222', borderLeft: `2px solid ${bucket.color}`, borderRadius: '4px', marginBottom: '0.375rem', cursor: 'pointer', transition: 'background 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1c1c1c')}
      onMouseLeave={e => (e.currentTarget.style.background = '#161616')}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
        <span style={{ color: bucket.accent, fontSize: '0.62rem', fontWeight: 600, flexShrink: 0, opacity: 0.5 }}>{BUCKET_ID[task.bucket_key] ?? task.bucket_key}{taskIndex}</span>
        <span style={{ color: '#e5e5e5', fontSize: '0.82rem', lineHeight: 1.4 }}>{task.title}</span>
      </div>

      {!isCaptured && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
          {/* Status */}
          {statusLabel && statusLabel !== 'Open' && (
            <span style={{ fontSize: '0.62rem', color: '#888', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '3px', padding: '0.1rem 0.35rem' }}>
              {statusLabel}
            </span>
          )}

          {/* Target date */}
          {task.target_date && (
            <span style={{ fontSize: '0.62rem', color: '#666', marginLeft: statusLabel && statusLabel !== 'Open' ? '0' : '0' }}>
              {formatDate(task.target_date)}
            </span>
          )}

          {/* Tags */}
          {task.tags?.length > 0 && (
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
              {task.tags.map(tag => (
                <span key={tag} style={{ fontSize: '0.65rem', color: '#aaa', background: '#1e1e1e', border: '1px solid #2a2a2a', borderRadius: '3px', padding: '0.1rem 0.35rem' }}>{tag}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── COMPONENTS: BucketSection ───────────────────────────────────────────────

function BucketSection({ bucket, tasks, statusMap, onTaskClick }: {
  bucket: BucketDef;
  tasks: Task[];
  statusMap: Record<string, string>;
  onTaskClick: (task: Task) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div onClick={() => setCollapsed(c => !c)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ fontSize: '0.75rem' }}>{bucket.icon}</span>
        <span style={{ color: bucket.accent, fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{bucket.label}</span>
        <span style={{ color: '#888', fontSize: '0.65rem', marginLeft: 'auto' }}>{tasks.length > 0 ? tasks.length : '—'}</span>
        <span style={{ color: '#888', fontSize: '0.65rem' }}>{collapsed ? '▸' : '▾'}</span>
      </div>
      {!collapsed && (
        <div>
          {tasks.length === 0
            ? <div style={{ color: '#444', fontSize: '0.75rem', paddingLeft: '1rem', paddingBottom: '0.25rem' }}>empty</div>
            : tasks.map((task, idx) => (
                <TaskPill
                  key={task.id}
                  task={task}
                  bucket={bucket}
                  statusLabel={task.task_status_id ? statusMap[task.task_status_id] : undefined}
                  taskIndex={idx + 1}
                  onClick={() => onTaskClick(task)}
                />
              ))
          }
        </div>
      )}
    </div>
  );
}

// ─── COMPONENTS: ContextFilter ───────────────────────────────────────────────

function ContextFilter({ contexts, selected, onChange }: {
  contexts: Context[];
  selected: string | null;
  onChange: (contextId: string | null) => void;
}) {
  if (contexts.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid #1a1a1a' }}>
      <button
        onClick={() => onChange(null)}
        style={{ background: selected === null ? '#1a1a1a' : 'none', border: `1px solid ${selected === null ? '#333' : '#1a1a1a'}`, color: selected === null ? '#ccc' : '#444', padding: '0.2rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer', transition: 'all 0.15s' }}
      >all</button>
      {contexts.map(c => (
        <button
          key={c.context_id}
          onClick={() => onChange(c.context_id)}
          style={{ background: selected === c.context_id ? '#1a1a1a' : 'none', border: `1px solid ${selected === c.context_id ? '#333' : '#1a1a1a'}`, color: selected === c.context_id ? '#ccc' : '#444', padding: '0.2rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer', transition: 'all 0.15s' }}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}

// ─── COMPONENTS: ChatBubble ──────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const lines  = msg.content.split('\n');
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem', paddingLeft: isUser ? '3rem' : '0' }}>
      <div style={{ maxWidth: '70%', padding: '0.6rem 0.9rem', borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px', background: isUser ? '#1a2a1a' : '#1a1a1a', border: `1px solid ${isUser ? '#2a4a2a' : '#252525'}`, color: isUser ? '#86efac' : '#d4d4d4', fontSize: '0.82rem', lineHeight: 1.6 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ minHeight: line === '' ? '0.6rem' : undefined }}>
            {isUser ? line : renderMarkdown(line)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── COMPONENTS: CaptureModal ────────────────────────────────────────────────

function CaptureModal({ onClose, onCapture }: { onClose: () => void; onCapture: (titles: string[]) => Promise<void> }) {
  const [value, setValue]   = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const parseTitles = (raw: string): string[] =>
    raw.split(',').map(t => t.trim()).filter(t => t.length > 0);

  const previews = parseTitles(value);

  const handleSubmit = async () => {
    if (previews.length === 0) { setErr('Enter at least one task'); return; }
    setSaving(true); setErr('');
    try { await onCapture(previews); onClose(); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '8px', padding: '1.5rem', width: '520px', fontFamily: 'monospace' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 600 }}>Quick Capture</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
        </div>
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ color: '#555', fontSize: '0.65rem', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Task(s)<span style={{ color: '#ef4444' }}>*</span>
            <span style={{ color: '#333', marginLeft: '0.5rem', textTransform: 'none', letterSpacing: 0 }}>— separate multiple with commas</span>
          </div>
          <textarea
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Call Jennifer, Review Q1 numbers, Fix the login bug..."
            rows={3}
            style={{ width: '100%', background: '#111', border: '1px solid #333', color: '#e5e5e5', padding: '0.6rem 0.75rem', borderRadius: '6px', fontFamily: 'monospace', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box', resize: 'vertical' }}
            onFocus={e => (e.target.style.borderColor = '#555')}
            onBlur={e => (e.target.style.borderColor = '#333')}
          />
        </div>
        {previews.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ color: '#555', fontSize: '0.65rem', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {previews.length} task{previews.length > 1 ? 's' : ''} to capture
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {previews.map((t, i) => (
                <div key={i} style={{ color: '#4ade80', fontSize: '0.75rem', padding: '0.2rem 0.5rem', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '4px' }}>{t}</div>
              ))}
            </div>
          </div>
        )}
        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid #333', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
          <button onClick={handleSubmit} disabled={saving || previews.length === 0}
            style={{ background: previews.length > 0 ? '#1a2a1a' : '#111', border: `1px solid ${previews.length > 0 ? '#2a4a2a' : '#1a1a1a'}`, color: previews.length > 0 ? '#4ade80' : '#555', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: previews.length > 0 ? 'pointer' : 'not-allowed' }}
          >{saving ? '...' : `capture ${previews.length > 1 ? `${previews.length} tasks` : 'task'}`}</button>
        </div>
      </div>
    </div>
  );
}

// ─── PAGE: WorkspacePage ─────────────────────────────────────────────────────

export default function WorkspacePage() {

  // ─── PAGE: State ───────────────────────────────────────────────────────────

  const [koUser, setKoUser]               = useState<KOUser | null>(null);
  const [tasks, setTasks]                 = useState<Task[]>([]);
  const [buckets, setBuckets]             = useState<BucketDef[]>([]);
  const [contexts, setContexts]           = useState<Context[]>([]);
  const [statusMap, setStatusMap]         = useState<Record<string, string>>({});
  const [contextFilter, setContextFilter] = useState<string | null>(null);
  const [chat, setChat]                   = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState('');
  const [sessionReady, setSessionReady]   = useState(false);
  const [sessionError, setSessionError]   = useState('');
  const [thinking, setThinking]           = useState(false);
  const [pending, setPending]             = useState<PendingAction | null>(null);
  const [accessToken, setAccessToken]     = useState('');
  const [showCapture, setShowCapture]     = useState(false);
  const [selectedTask, setSelectedTask]   = useState<Task | null>(null);

  const chatBottomRef  = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const initDone       = useRef(false);
  const [splitW, setSplitW]       = useState(340);
  const splitDragging              = useRef(false);
  const splitStartX                = useRef(0);
  const splitStartW                = useRef(340);

  // ─── PAGE: Auth & Init ─────────────────────────────────────────────────────

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event !== 'INITIAL_SESSION') return;
      if (!session?.user) { window.location.href = '/login'; return; }
      if (initDone.current) return;
      initDone.current = true;
      setAccessToken(session.access_token);

      try {
        const res = await fetch('/api/ko/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error ?? 'Session init failed');

        const { data: koUserData, error: koErr } = await supabase
          .from('ko_user')
          .select('id, email, display_name, implementation_type')
          .eq('id', session.user.id)
          .single();
        if (koErr) throw koErr;

        setKoUser(koUserData);

        // Load buckets — uses implementation_type from concept_registry (system table)
        await loadBuckets(koUserData.implementation_type);

        // Load contexts for filter
        await loadContexts(session.user.id);

        // Load task statuses for label lookup
        await loadStatuses(session.user.id);

        setSessionReady(true);

        setChat([{
          role: 'assistant',
          content: data.is_new_user
            ? `Welcome. I'm Karl.\n\nDrop anything here — tasks, notes, things on your mind. I'll help you sort it.\n\nWhat's on the board right now?`
            : `Back at it. What's changed?`,
          timestamp: new Date(),
        }]);

        await loadTasks(session.user.id);

      } catch (err: any) {
        console.error('[WorkspacePage init]', err);
        setSessionError(err.message ?? 'Failed to initialize');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ─── PAGE: Data loaders ────────────────────────────────────────────────────

  // Buckets now filtered by implementation_type — concept_registry is a system table
  const loadBuckets = async (implementationType: string) => {
    const { data } = await supabase
      .from('concept_registry')
      .select('concept_key, label, icon, display_order')
      .eq('implementation_type', implementationType)
      .eq('concept_type', 'bucket')
      .order('display_order');

    if (data) {
      setBuckets(data.map(c => {
        const key = c.concept_key.replace('bucket_', '');
        return {
          key,
          label: c.label,
          icon:  c.icon ?? '',
          ...BUCKET_COLORS[key] ?? { color: '#666', accent: '#999' },
        };
      }));
    }
  };

  const loadContexts = async (userId: string) => {
    const { data } = await supabase
      .from('context')
      .select('context_id, name')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('name');
    if (data) setContexts(data);
  };

  const loadStatuses = async (userId: string) => {
    const { data } = await supabase
      .from('task_status')
      .select('task_status_id, label')
      .eq('user_id', userId);
    if (data) {
      const map: Record<string, string> = {};
      for (const s of data) map[s.task_status_id] = s.label;
      setStatusMap(map);
    }
  };

  const loadTasks = async (userId: string) => {
    const { data: taskData } = await supabase
      .from('task')
      .select('task_id, title, bucket_key, tags, is_completed, is_archived, created_at, context_id, task_status_id, target_date')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (taskData) setTasks(taskData.map((t: any) => ({ ...t, id: t.task_id })));
  };

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat, thinking]);

  useEffect(() => {
    if (pending) setTimeout(() => inputRef.current?.focus(), 100);
  }, [pending]);

  // ─── Split resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!splitDragging.current) return;
      const delta = e.clientX - splitStartX.current;
      const newW = Math.max(220, Math.min(600, splitStartW.current + delta));
      setSplitW(newW);
    };
    const onMouseUp = () => { splitDragging.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // ─── PAGE: Handlers ────────────────────────────────────────────────────────

  const addMessage = (role: 'user' | 'assistant', content: string) => {
    setChat(prev => [...prev, { role, content, timestamp: new Date() }]);
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || !sessionReady) return;

    addMessage('user', text);
    setInput('');
    setThinking(true);

    try {
      if (pending) {
        const lower     = text.toLowerCase();
        const isConfirm = CONFIRM_WORDS.some(w => lower.includes(w));
        const isDeny    = DENY_WORDS.some(w => lower.includes(w));

        if (isConfirm) {
          const res = await fetch('/api/ko/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            body: JSON.stringify({ confirm: true, pending }),
          });
          const data = await res.json();
          setPending(null);
          addMessage('assistant', data.response ?? 'Done.');
          if (koUser) await loadTasks(koUser.id);
          return;
        }

        if (isDeny) {
          setPending(null);
          addMessage('assistant', 'Got it — cancelled.');
          return;
        }
      }

      const res = await fetch('/api/ko/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ input: text }),
      });
      const data = await res.json();

      if ((data.intent === 'capture_task' || data.intent === 'capture_tasks' || data.intent === 'capture_completion') && data.payload) {
        const summary = data.intent === 'capture_completion' ? `completion: ${data.payload.title}` : data.payload.summary ?? data.payload.title;
        setPending({ intent: data.intent, payload: data.payload, summary });
      } else {
        setPending(null);
      }

      addMessage('assistant', data.response ?? "I'm not sure what to do with that.");

    } catch (err: any) {
      addMessage('assistant', 'Something went wrong. Try again.');
    } finally {
      setThinking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  const handleModalCapture = async (titles: string[]) => {
    const res = await fetch('/api/ko/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ confirm: true, pending: { intent: 'capture_tasks', payload: { titles } } }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? 'Capture failed');
    if (koUser) await loadTasks(koUser.id);
    addMessage('assistant',
      titles.length === 1
        ? `Captured — **${titles[0]}** is in your capture bucket.`
        : `Captured ${titles.length} tasks into your capture bucket.`
    );
  };

  // ─── PAGE: Error state ─────────────────────────────────────────────────────

  if (sessionError) {
    return (
      <div style={centeredStyle}>
        <div style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: '0.8rem', textAlign: 'center' }}>
          <div style={{ marginBottom: '0.5rem' }}>Session error</div>
          <div style={{ color: '#aaa', fontSize: '0.75rem', marginBottom: '1rem' }}>{sessionError}</div>
          <button onClick={() => window.location.reload()} style={ghostBtn}>Retry</button>
        </div>
      </div>
    );
  }

  // ─── PAGE: Derived state ───────────────────────────────────────────────────

  const filteredTasks  = contextFilter ? tasks.filter(t => t.context_id === contextFilter) : tasks;
  const grouped        = groupTasksByBucket(filteredTasks);
  const totalOpen      = tasks.length;
  const totalFiltered  = filteredTasks.length;

  // ─── PAGE: Render ──────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', fontFamily: 'monospace', overflow: 'hidden' }}>

      {/* MODALS */}
      {showCapture && <CaptureModal onClose={() => setShowCapture(false)} onCapture={handleModalCapture} />}
      {selectedTask && koUser && (
        <TaskDetailModal
          taskId={selectedTask.id}
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setSelectedTask(null)}
          onSaved={() => { loadTasks(koUser.id); setSelectedTask(null); }}
        />
      )}

{/* RIGHT: FC buttons + status + user + admin */}
<div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
  
  {/* FC object buttons */}
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
    <button onClick={() => setShowCapture(true)}
      style={{ background: '#0d1a0d', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1a2a1a')}
      onMouseLeave={e => (e.currentTarget.style.background = '#0d1a0d')}
    >+capture</button>
    <button onClick={() => {/* setShowCompletions(true) */}}
      style={{ background: '#1a0e00', border: '1px solid #4a2a00', color: '#f97316', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#2a1800')}
      onMouseLeave={e => (e.currentTarget.style.background = '#1a0e00')}
    >+complete</button>
    <button onClick={() => {/* setShowMeetings(true) */}}
      style={{ background: '#0a0f1a', border: '1px solid #1a3060', color: '#3b82f6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#0f1a2a')}
      onMouseLeave={e => (e.currentTarget.style.background = '#0a0f1a')}
    >+meeting</button>
    <button onClick={() => {/* setShowReferences(true) */}}
      style={{ background: '#120a1a', border: '1px solid #3a1a5a', color: '#8b5cf6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1e1030')}
      onMouseLeave={e => (e.currentTarget.style.background = '#120a1a')}
    >+reference</button>
  </div>

  <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>

  <span>
    <span style={{ color: '#e5e5e5', fontSize: '0.7rem', fontWeight: 600 }}>{contextFilter ? totalFiltered : totalOpen}</span>
    <span style={{ color: '#444', fontSize: '0.7rem' }}> open</span>
    {contextFilter && totalOpen !== totalFiltered && (
      <span style={{ color: '#333', fontSize: '0.7rem' }}> / {totalOpen}</span>
    )}
  </span>

  <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>
  <span style={{ color: '#555', fontSize: '0.7rem' }}>{koUser?.display_name ?? '...'}</span>
  <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>

  <a href="/admin"
    style={{ color: '#555', fontSize: '0.7rem', textDecoration: 'none', fontFamily: 'monospace' }}
    onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
    onMouseLeave={e => (e.currentTarget.style.color = '#555')}
  >admin</a>

  <button onClick={handleLogout}
    style={{ background: 'none', border: 'none', color: '#555', fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer', padding: 0 }}
    onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
    onMouseLeave={e => (e.currentTarget.style.color = '#555')}
  >sign out</button>

</div>


      {/* MAIN SPLIT */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* LEFT: BUCKET VIEW */}
        <div style={{ width: splitW, flexShrink: 0, overflowY: 'auto', padding: '1rem', scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>
          {!sessionReady
            ? <div style={{ color: '#aaa', fontSize: '0.75rem', paddingTop: '1rem' }}>Initializing...</div>
            : (
              <>
                <ContextFilter
                  contexts={contexts}
                  selected={contextFilter}
                  onChange={setContextFilter}
                />
                {buckets.map(bucket => (
                  <BucketSection
                    key={bucket.key}
                    bucket={bucket}
                    tasks={grouped[bucket.key] ?? []}
                    statusMap={statusMap}
                    onTaskClick={task => setSelectedTask(task)}
                  />
                ))}
              </>
            )
          }
        </div>

        {/* SPLIT DIVIDER */}
        <div
          onMouseDown={e => { splitDragging.current = true; splitStartX.current = e.clientX; splitStartW.current = splitW; }}
          style={{ width: '4px', flexShrink: 0, background: '#1a1a1a', cursor: 'col-resize', transition: 'background 0.15s' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#333')}
          onMouseLeave={e => (e.currentTarget.style.background = '#1a1a1a')}
        />

        {/* RIGHT: CHAT */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Chat history */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.25rem 0.5rem', scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>
            {chat.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
            {thinking && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ padding: '0.6rem 0.9rem', borderRadius: '12px 12px 12px 2px', background: '#1a1a1a', border: '1px solid #252525', color: '#aaa', fontSize: '0.82rem' }}>···</div>
              </div>
            )}
            {pending && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ padding: '0.5rem 0.75rem', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '8px', fontSize: '0.75rem', color: '#4ade80' }}>
                  Pending: <strong>{pending.summary}</strong> — say <em>yes</em> to capture or <em>no</em> to cancel
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* INPUT BAR */}
          <div style={{ borderTop: '1px solid #1a1a1a', padding: '0.75rem 1.25rem', background: '#0d0d0d', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
                onKeyDown={handleKeyDown}
                placeholder={sessionReady ? (pending ? 'yes to confirm, no to cancel...' : 'Drop a task, ask something, or give an order...') : 'Starting up...'}
                disabled={!sessionReady || thinking}
                rows={1}
                style={{ flex: 1, background: '#111', border: '1px solid #222', borderRadius: '6px', color: '#e5e5e5', fontSize: '0.85rem', padding: '0.6rem 0.75rem', fontFamily: 'monospace', resize: 'none', outline: 'none', lineHeight: 1.5, minHeight: '36px', maxHeight: '120px', overflowY: 'auto', transition: 'border-color 0.15s' }}
                onFocus={e => (e.target.style.borderColor = '#555')}
                onBlur={e => (e.target.style.borderColor = '#222')}
              />
              <button
                onClick={handleSubmit}
                disabled={!input.trim() || !sessionReady || thinking}
                style={{ background: input.trim() && sessionReady && !thinking ? '#1a2a1a' : '#111', border: `1px solid ${input.trim() && sessionReady && !thinking ? '#2a4a2a' : '#1a1a1a'}`, color: input.trim() && sessionReady && !thinking ? '#4ade80' : '#555', borderRadius: '6px', padding: '0.5rem 1rem', fontSize: '0.8rem', fontFamily: 'monospace', cursor: input.trim() && sessionReady && !thinking ? 'pointer' : 'not-allowed', flexShrink: 0, height: '36px', transition: 'all 0.15s' }}
              >
                send
              </button>
            </div>
            <div style={{ color: '#555', fontSize: '0.65rem', marginTop: '0.4rem' }}>↵ send · shift+↵ newline</div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const centeredStyle: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a' };
const ghostBtn: React.CSSProperties = { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '0.3rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.7rem' };
