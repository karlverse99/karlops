'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import TaskDetailModal from '@/app/components/TaskDetailModal';
import CompletionsModal from '@/app/components/CompletionsModal';
import MeetingsModal from '@/app/components/MeetingsModal';
import ExtractsModal from '@/app/components/ExtractsModal';
import TaskListModal from '@/app/components/TaskListModal';
import TemplatesModal from '@/app/components/TemplatesModal';

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

const BUCKET_COLORS: Record<string, { color: string; accent: string }> = {
  now:      { color: '#ef4444', accent: '#fca5a5' },
  soon:     { color: '#f97316', accent: '#fdba74' },
  realwork: { color: '#3b82f6', accent: '#93c5fd' },
  later:    { color: '#6b7280', accent: '#9ca3af' },
  delegate: { color: '#8b5cf6', accent: '#c4b5fd' },
  capture:  { color: '#10b981', accent: '#6ee7b7' },
};

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

function TaskPill({ task, bucket, statusLabel, taskIndex, onClick, onDragStart }: {
  task: Task;
  bucket: BucketDef;
  statusLabel?: string;
  taskIndex: number;
  onClick: () => void;
  onDragStart: (task: Task) => void;
}) {
  const isCaptured = task.bucket_key === 'capture';

  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(task); }}
      onClick={onClick}
      style={{ padding: '0.5rem 0.75rem', background: '#161616', border: '1px solid #222', borderLeft: `2px solid ${bucket.color}`, borderRadius: '4px', marginBottom: '0.375rem', cursor: 'grab', transition: 'background 0.15s', userSelect: 'none' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1c1c1c')}
      onMouseLeave={e => (e.currentTarget.style.background = '#161616')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden' }}>
        <span style={{ color: bucket.accent, fontSize: '0.62rem', fontWeight: 600, flexShrink: 0, opacity: 0.5 }}>{BUCKET_ID[task.bucket_key] ?? task.bucket_key}{taskIndex}</span>
        <span style={{ color: '#e5e5e5', fontSize: '0.82rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.title}</span>
        {!isCaptured && statusLabel && statusLabel !== 'Open' && (
          <span style={{ fontSize: '0.62rem', color: '#888', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '3px', padding: '0.1rem 0.35rem', flexShrink: 0 }}>{statusLabel}</span>
        )}
        {!isCaptured && task.target_date && (
          <span style={{ fontSize: '0.62rem', color: '#666', flexShrink: 0 }}>{formatDate(task.target_date)}</span>
        )}
      </div>
    </div>
  );
}

// ─── COMPONENTS: BucketSection ───────────────────────────────────────────────

const DROPPABLE_BUCKETS = ['now', 'soon', 'realwork', 'later'];

function BucketSection({ bucket, tasks, statusMap, onTaskClick, onDragStart, onDrop }: {
  bucket: BucketDef;
  tasks: Task[];
  statusMap: Record<string, string>;
  onTaskClick: (task: Task) => void;
  onDragStart: (task: Task) => void;
  onDrop: (bucketKey: string) => void;
}) {
  const defaultCollapsed = !['now', 'soon', 'realwork'].includes(bucket.key);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [isDragOver, setIsDragOver] = useState(false);
  const isDroppable = DROPPABLE_BUCKETS.includes(bucket.key);

  return (
    <div
      style={{ marginBottom: '1.25rem' }}
      onDragOver={e => { if (isDroppable) { e.preventDefault(); setIsDragOver(true); } }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { e.preventDefault(); setIsDragOver(false); if (isDroppable) onDrop(bucket.key); }}
    >
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', cursor: 'pointer', userSelect: 'none', padding: '0.2rem 0.4rem', borderRadius: '4px', background: isDragOver ? `${bucket.color}22` : 'transparent', border: isDragOver ? `1px dashed ${bucket.color}` : '1px solid transparent', transition: 'all 0.15s' }}
      >
        <span style={{ fontSize: '0.75rem' }}>{bucket.icon}</span>
        <span style={{ color: bucket.accent, fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{bucket.label}</span>
        {isDragOver && <span style={{ color: bucket.color, fontSize: '0.62rem', marginLeft: '0.25rem' }}>drop here</span>}
        <span style={{ color: bucket.accent, fontSize: '0.72rem', fontWeight: 600, marginLeft: 'auto' }}>{tasks.length > 0 ? tasks.length : '—'}</span>
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
                  onDragStart={onDragStart}
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
        style={{ background: selected === null ? '#1a1a1a' : 'none', border: `1px solid ${selected === null ? '#f97316' : '#333'}`, color: selected === null ? '#f97316' : '#ffffff', padding: '0.2rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer', transition: 'all 0.15s' }}
        onMouseEnter={e => { if (selected !== null) { e.currentTarget.style.color = '#f97316'; e.currentTarget.style.borderColor = '#f97316'; } }}
        onMouseLeave={e => { if (selected !== null) { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = '#333'; } }}
      >all</button>
      {contexts.map(c => (
        <button
          key={c.context_id}
          onClick={() => onChange(c.context_id)}
          style={{ background: selected === c.context_id ? '#1a1a1a' : 'none', border: `1px solid ${selected === c.context_id ? '#f97316' : '#333'}`, color: selected === c.context_id ? '#f97316' : '#ffffff', padding: '0.2rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer', transition: 'all 0.15s' }}
          onMouseEnter={e => { if (selected !== c.context_id) { e.currentTarget.style.color = '#f97316'; e.currentTarget.style.borderColor = '#f97316'; } }}
          onMouseLeave={e => { if (selected !== c.context_id) { e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = '#333'; } }}
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

  // ─── State ─────────────────────────────────────────────────────────────────

  const [koUser, setKoUser]                   = useState<KOUser | null>(null);
  const [tasks, setTasks]                     = useState<Task[]>([]);
  const [buckets, setBuckets]                 = useState<BucketDef[]>([]);
  const [contexts, setContexts]               = useState<Context[]>([]);
  const [statusMap, setStatusMap]             = useState<Record<string, string>>({});
  const [contextFilter, setContextFilter]     = useState<string | null>(null);
  const [chat, setChat]                       = useState<ChatMessage[]>([]);
  const [input, setInput]                     = useState('');
  const [sessionReady, setSessionReady]       = useState(false);
  const [sessionError, setSessionError]       = useState('');
  const [thinking, setThinking]               = useState(false);
  const [pending, setPending]                 = useState<PendingAction | null>(null);
  const [accessToken, setAccessToken]         = useState('');
  const [showCapture, setShowCapture]         = useState(false);
  const [showCompletions, setShowCompletions] = useState(false);
  const [showMeetings, setShowMeetings]       = useState(false);
  const [showExtracts, setShowExtracts]   = useState(false);
  const [showTaskList, setShowTaskList]       = useState(false);
  const [showTemplates, setShowTemplates]     = useState(false);   // ← NEW
  const [completionCount, setCompletionCount] = useState(0);
  const [meetingCount, setMeetingCount]       = useState(0);
  const [extractCount, setExtractCount]   = useState(0);
  const [templateCount, setTemplateCount]     = useState(0);       // ← NEW
  const [selectedTask, setSelectedTask]       = useState<Task | null>(null);
  const draggedTask                            = useRef<Task | null>(null);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);
  const initDone      = useRef(false);
  const [splitW, setSplitW]   = useState(340);
  const splitDragging          = useRef(false);
  const splitStartX            = useRef(0);
  const splitStartW            = useRef(340);

  // ─── Auth & Init ───────────────────────────────────────────────────────────

  useEffect(() => {
    const init = async (session: any) => {
      if (!session?.user) { await supabase.auth.signOut(); window.location.href = '/login'; return; }
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
        await loadBuckets(koUserData.implementation_type);
        await loadContexts(session.user.id);
        await loadStatuses(session.user.id);
        await loadCompletionCount(session.user.id);
        await loadMeetingCount(session.user.id);
        await loadExtractCount(session.user.id);
        await loadTemplateCount(session.user.id);   // ← NEW
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
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        init(session);
      } else {
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
            init(session);
          }
        });
        return () => subscription.unsubscribe();
      }
    });
  }, []);

  // ─── Data loaders ──────────────────────────────────────────────────────────

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
        return { key, label: c.label, icon: c.icon ?? '', ...BUCKET_COLORS[key] ?? { color: '#666', accent: '#999' } };
      }));
    }
  };

  const loadContexts = async (userId: string) => {
    
    if (data) setContexts(data);
  };

  const loadStatuses = async (userId: string) => {
    const { data } = await supabase.from('task_status').select('task_status_id, label').eq('user_id', userId);
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

  const loadCompletionCount = async (userId: string) => {
    const { count } = await supabase
      .from('completion')
      .select('completion_id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (count !== null) setCompletionCount(count);
  };

  const loadMeetingCount = async (userId: string) => {
    const { count } = await supabase
      .from('meeting')
      .select('meeting_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_completed', false);
    if (count !== null) setMeetingCount(count);
  };

  const loadExtractCount = async (userId: string) => {
    const { count } = await supabase
      .from('external_reference')
      .select('external_reference_id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (count !== null) setExtractCount(count);
  };

  // ← NEW
  const loadTemplateCount = async (userId: string) => {
    const { count } = await supabase
      .from('document_template')
      .select('document_template_id', { count: 'exact', head: true })
      .or(`user_id.eq.${userId},is_system.eq.true`)
      .eq('is_active', true);
    if (count !== null) setTemplateCount(count);
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

  // ─── Handlers ──────────────────────────────────────────────────────────────

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
          if (koUser) {
            await loadTasks(koUser.id);
            await loadCompletionCount(koUser.id);
            await loadMeetingCount(koUser.id);
            await loadExtractCount(koUser.id);
          }
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

  const handleDragStart = (task: Task) => {
    draggedTask.current = task;
  };

  const handleDrop = async (targetBucketKey: string) => {
    const task = draggedTask.current;
    draggedTask.current = null;
    if (!task || !koUser) return;
    if (task.bucket_key === targetBucketKey) return; // no-op same bucket

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, bucket_key: targetBucketKey } : t));

    const { error } = await supabase
      .from('task')
      .update({ bucket_key: targetBucketKey })
      .eq('task_id', task.id)
      .eq('user_id', koUser.id);

    if (error) {
      console.error('[handleDrop]', error);
      await loadTasks(koUser.id); // revert on error
    }
  };

  // ─── Error state ───────────────────────────────────────────────────────────

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

  // ─── Derived state ─────────────────────────────────────────────────────────

  const filteredTasks = contextFilter ? tasks.filter(t => t.context_id === contextFilter) : tasks;
  const grouped       = groupTasksByBucket(filteredTasks);
  const totalOpen     = tasks.length;
  const totalFiltered = filteredTasks.length;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', fontFamily: 'monospace', overflow: 'hidden' }}>

      {/* MODALS */}
      {showCapture && <CaptureModal onClose={() => setShowCapture(false)} onCapture={handleModalCapture} />}
      {showCompletions && koUser && (
        <CompletionsModal
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setShowCompletions(false)}
          onCountChange={setCompletionCount}
        />
      )}
      {showMeetings && koUser && (
        <MeetingsModal
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setShowMeetings(false)}
          onCountChange={setMeetingCount}
        />
      )}
      {showExtracts && koUser && (
        <ExtractsModal
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setShowExtracts(false)}
          onCountChange={setExtractCount}
        />
      )}
      {showTaskList && koUser && (
        <TaskListModal
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setShowTaskList(false)}
          onSaved={() => loadTasks(koUser.id)}
        />
      )}
      {showTemplates && koUser && (                          /* ← NEW */
        <TemplatesModal
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setShowTemplates(false)}
          onCountChange={setTemplateCount}
        />
      )}
      {selectedTask && koUser && (
        <TaskDetailModal
          taskId={selectedTask.id}
          userId={koUser.id}
          accessToken={accessToken}
          onClose={() => setSelectedTask(null)}
          onSaved={() => { loadTasks(koUser.id); setSelectedTask(null); }}
        />
      )}

      {/* HEADER */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.25rem', height: '44px', borderBottom: '1px solid #1a1a1a', flexShrink: 0, background: '#0d0d0d' }}>

        {/* LEFT: brand + user */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src="/ko-icon.svg" alt="KO" style={{ width: '28px', height: '28px' }} />
          <span style={{ color: '#ffffff', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.02em' }}>KarlOps</span>
          <span style={{ color: '#555', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>{koUser?.implementation_type ?? '...'}</span>
          <span style={{ color: '#555', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>{koUser?.display_name ?? '...'}</span>
        </div>

        {/* RIGHT: FC buttons + counts + admin */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>

            {/* +capture */}
            <button onClick={() => setShowCapture(true)}
              style={{ background: '#0d1a0d', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1a2a1a')}
              onMouseLeave={e => (e.currentTarget.style.background = '#0d1a0d')}
            >+capture</button>

            {/* +complete(n) */}
            <button onClick={() => setShowCompletions(true)}
              style={{ background: '#1a0e00', border: '1px solid #4a2a00', color: '#f97316', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2a1800')}
              onMouseLeave={e => (e.currentTarget.style.background = '#1a0e00')}
            ><span style={{ color: '#f97316' }}>+complete</span><span style={{ color: '#ffffff' }}>({completionCount})</span></button>

            {/* +meeting(n) */}
            <button onClick={() => setShowMeetings(true)}
              style={{ background: '#0a0f1a', border: '1px solid #1a3060', color: '#3b82f6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#0f1a2a')}
              onMouseLeave={e => (e.currentTarget.style.background = '#0a0f1a')}
            ><span style={{ color: '#3b82f6' }}>+meeting</span><span style={{ color: '#ffffff' }}>({meetingCount})</span></button>

            {/* +extracts(n) */}
            <button onClick={() => setShowExtracts(true)}
              style={{ background: '#120a1a', border: '1px solid #3a1a5a', color: '#8b5cf6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1e1030')}
              onMouseLeave={e => (e.currentTarget.style.background = '#120a1a')}
            ><span style={{ color: '#8b5cf6' }}>+extracts</span><span style={{ color: '#ffffff' }}>({extractCount})</span></button>

            {/* +template(n) — NEW */}
            <button onClick={() => setShowTemplates(true)}
              style={{ background: '#0a1f1d', border: '1px solid #0f3330', color: '#14b8a6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#0f2a27')}
              onMouseLeave={e => (e.currentTarget.style.background = '#0a1f1d')}
            ><span style={{ color: '#14b8a6' }}>+template</span><span style={{ color: '#ffffff' }}>({templateCount})</span></button>

          </div>

          <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>

          {/* open(n) — clickable → TaskListModal */}
          <span
            onClick={() => setShowTaskList(true)}
            style={{ color: '#ffffff', fontSize: '0.7rem', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')}
            onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}
          >
            open(<span style={{ color: '#fbbf24', fontWeight: 600 }}>{contextFilter ? totalFiltered : totalOpen}</span>)
            {contextFilter && totalOpen !== totalFiltered && (
              <span style={{ color: '#888' }}> / {totalOpen}</span>
            )}
          </span>

          <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>

          <a href="/admin"
            style={{ color: '#ffffff', fontSize: '0.7rem', textDecoration: 'none', fontFamily: 'monospace' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')}
            onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}
          >admin</a>

          <button onClick={handleLogout}
            style={{ background: 'none', border: 'none', color: '#ffffff', fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer', padding: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')}
            onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}
          >sign out</button>

        </div>
      </header>

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
                    onDragStart={handleDragStart}
                    onDrop={handleDrop}
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
