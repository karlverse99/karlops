'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import TaskDetailModal from '@/app/components/TaskDetailModal';
import TaskAddModal from '@/app/components/TaskAddModal';
import CompletionsModal from '@/app/components/CompletionsModal';
import MeetingsModal from '@/app/components/MeetingsModal';
import ExtractsModal from '@/app/components/ExtractsModal';
import TaskListModal from '@/app/components/TaskListModal';
import TemplatesModal from '@/app/components/TemplatesModal';
import ContactsModal from '@/app/components/ContactsModal';
import TagManagerModal from '@/app/components/TagManagerModal';
import DelegateModal from '@/app/components/DelegateModal';

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
  sort_order: number | null;
  delegated_to: string | null;
}
interface ChatMessage { role: 'user' | 'assistant'; content: string; timestamp: Date; }
interface BucketDef { key: string; label: string; icon: string; color: string; accent: string; }
interface Context { context_id: string; name: string; }
interface TaskStatus { task_status_id: string; name: string; label: string; }

interface PendingAction {
  intent: string;
  actions: any[];
  payload: any;
  summary: string;
}
interface QueuedFile { name: string; type: string; data: string; size: number; }

interface DelegateModalState {
  taskId: string;
  taskTitle: string;
  preselectedTagId?: string | null;
  preselectedName?: string | null;
  mode: 'drop' | 'update';
}

// ─── TOKEN TRACKING ──────────────────────────────────────────────────────────

interface TokenUsage {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

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

const SUPPORTED_FILE_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const EXT_TYPE_MAP: Record<string, string> = {
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function groupTasksByBucket(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  for (const key of Object.keys(BUCKET_COLORS)) grouped[key] = [];
  for (const task of tasks) {
    if (grouped[task.bucket_key]) grouped[task.bucket_key].push(task);
  }
  return grouped;
}

function buildPendingSummary(data: any): string {
  const p = data.payload ?? {};
  const action = p.action ?? data.intent ?? '';
  if (action === 'capture_completion') return `completion: ${p.title ?? '...'}`;
  if (action === 'update_object') {
    const ops = (p.operations ?? [])
      .map((op: any) => op.tag_op ? `${op.tag_op} tag ${op.value}` : `${op.field}=${op.value}`)
      .join(', ');
    return `update ${p.identifier}: ${ops}`;
  }
  if (action === 'capture_tasks') return `${p.tasks?.length ?? '?'} tasks`;
  if (action === 'process_document') return p.title ?? `process document: ${p.doc_action ?? p.content_type ?? '...'}`;
  return p.title ?? p.summary ?? 'pending action';
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
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

const DROPPABLE_BUCKETS = ['now', 'soon', 'realwork', 'later', 'delegate'];

function BucketSection({ bucket, tasks, statusMap, onTaskClick, onDragStart, onDrop, onReorder }: {
  bucket: BucketDef;
  tasks: Task[];
  statusMap: Record<string, string>;
  onTaskClick: (task: Task) => void;
  onDragStart: (task: Task) => void;
  onDrop: (bucketKey: string) => void;
  onReorder: (taskId: string, newIndex: number, bucketTasks: Task[]) => void;
}) {
  const defaultCollapsed = !['now', 'soon', 'realwork'].includes(bucket.key);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const isDroppable = DROPPABLE_BUCKETS.includes(bucket.key);

  return (
    <div
      style={{ marginBottom: '1.25rem' }}
      onDragOver={e => { if (isDroppable) { e.preventDefault(); setIsDragOver(true); } }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
          setDragOverIndex(null);
        }
      }}
      onDrop={e => {
        e.preventDefault();
        setIsDragOver(false);
        setDragOverIndex(null);
        if (isDroppable) onDrop(bucket.key);
      }}
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
                <div
                  key={task.id}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverIndex(idx); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverIndex(null);
                    setIsDragOver(false);
                    onReorder(task.id, idx, tasks);
                  }}
                  style={{ borderTop: dragOverIndex === idx ? `2px solid ${bucket.color}` : '2px solid transparent', transition: 'border-color 0.1s' }}
                >
                  <TaskPill
                    task={task}
                    bucket={bucket}
                    statusLabel={task.task_status_id ? statusMap[task.task_status_id] : undefined}
                    taskIndex={idx + 1}
                    onClick={() => onTaskClick(task)}
                    onDragStart={onDragStart}
                  />
                </div>
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
  const [showTaskAdd, setShowTaskAdd]         = useState(false);
  const [showCompletions, setShowCompletions] = useState(false);
  const [showMeetings, setShowMeetings]       = useState(false);
  const [showExtracts, setShowExtracts]       = useState(false);
  const [showTaskList, setShowTaskList]       = useState(false);
  const [showTemplates, setShowTemplates]     = useState(false);
  const [showContacts, setShowContacts]       = useState(false);
  const [showTagManager, setShowTagManager]   = useState(false);
  const [completionCount, setCompletionCount] = useState(0);
  const [meetingCount, setMeetingCount]       = useState(0);
  const [extractCount, setExtractCount]       = useState(0);
  const [templateCount, setTemplateCount]     = useState(0);
  const [contactCount, setContactCount]       = useState(0);
  const [selectedTask, setSelectedTask]       = useState<Task | null>(null);
  const [pendingPreviewTaskId, setPendingPreviewTaskId] = useState<string | null>(null);
  const [delegateModal, setDelegateModal]     = useState<DelegateModalState | null>(null);
  const [dragOverChat, setDragOverChat]       = useState(false);
  const [queuedFiles, setQueuedFiles]         = useState<QueuedFile[]>([]);

  // ─── Token tracking ────────────────────────────────────────────────────────
  const [sessionTokens, setSessionTokens]     = useState(0);
  const [lastCallTokens, setLastCallTokens]   = useState<TokenUsage | null>(null);

  const draggedTask                            = useRef<Task | null>(null);
  const chatBottomRef                          = useRef<HTMLDivElement>(null);
  const inputRef                               = useRef<HTMLTextAreaElement>(null);
  const initDone                               = useRef(false);
  const [splitW, setSplitW]                   = useState(340);
  const splitDragging                          = useRef(false);
  const splitStartX                            = useRef(0);
  const splitStartW                            = useRef(340);

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
        await loadTemplateCount(session.user.id);
        await loadContactCount(session.user.id);
        setSessionReady(true);

        setChat([{
          role: 'assistant',
          content: data.is_new_user
            ? `Welcome. I'm Karl.\n\nDrop anything here — tasks, notes, things on your mind. I'll help you sort it.\n\nWhat's on the board right now?`
            : (data.greeting ?? `Back at it. What's changed?`),
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
    const { data } = await supabase
      .from('context')
      .select('context_id, name')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .eq('is_visible', true)
      .order('name');
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
      .select('task_id, title, bucket_key, tags, is_completed, is_archived, created_at, context_id, task_status_id, target_date, sort_order, delegated_to')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (taskData) setTasks(taskData.map((t: any) => ({ ...t, id: t.task_id })));
  };

  const loadCompletionCount = async (userId: string) => {
    const { count } = await supabase.from('completion').select('completion_id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count !== null) setCompletionCount(count);
  };

  const loadMeetingCount = async (userId: string) => {
    const { count } = await supabase.from('meeting').select('meeting_id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_completed', false);
    if (count !== null) setMeetingCount(count);
  };

  const loadExtractCount = async (userId: string) => {
    const { count } = await supabase.from('external_reference').select('external_reference_id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count !== null) setExtractCount(count);
  };

  const loadTemplateCount = async (userId: string) => {
    const { count } = await supabase.from('document_template').select('document_template_id', { count: 'exact', head: true }).or(`user_id.eq.${userId},is_system.eq.true`).eq('is_active', true);
    if (count !== null) setTemplateCount(count);
  };

  const loadContactCount = async (userId: string) => {
    const { count } = await supabase.from('contact').select('contact_id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_archived', false);
    if (count !== null) setContactCount(count);
  };

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat, thinking]);

  useEffect(() => {
    if (pending) setTimeout(() => inputRef.current?.focus(), 100);
  }, [pending]);

  useEffect(() => {
    if (queuedFiles.length > 0) setTimeout(() => inputRef.current?.focus(), 100);
  }, [queuedFiles.length]);

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

  const refreshAfterUpdate = async () => {
    if (!koUser) return;
    await loadTasks(koUser.id);
    await loadCompletionCount(koUser.id);
    await loadMeetingCount(koUser.id);
    await loadExtractCount(koUser.id);
    await loadContactCount(koUser.id);
    await loadTemplateCount(koUser.id);
  };

   // ─── Unified command response handler ─────────────────────────────────────

  const handleCommandResponse = async (data: any) => {
    // Track tokens if present
    if (data.usage) {
      const u = data.usage;
      const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      setSessionTokens(prev => prev + total);
      setLastCallTokens({
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
      });
    }

    // Karl executed immediately (quick capture)
    if (data.intent === 'execute' || data.intent === 'capture_task') {
      setPending(null);
      addMessage('assistant', data.response ?? 'Done.');
      await refreshAfterUpdate();
      if (data.offer_preview && data.task_id) setPendingPreviewTaskId(data.task_id);
      return;
    }

    // Karl confirmed and executed the pending action
    if (data.intent === 'confirm_pending') {
      setPending(null);
      addMessage('assistant', data.response ?? 'Done.');
      await refreshAfterUpdate();
      if (data.offer_preview && data.task_id) setPendingPreviewTaskId(data.task_id);
      return;
    }

    // Successful write — route returned refresh:true
    if (data.success && data.refresh) {
      setPending(null);
      addMessage('assistant', data.response ?? 'Done.');
      await refreshAfterUpdate();
      if (data.offer_preview && data.task_id) setPendingPreviewTaskId(data.task_id);
      return;
    }

    // Karl cancelled
    if (data.intent === 'cancel_pending') {
      setPending(null);
      addMessage('assistant', data.response ?? 'Cancelled.');
      return;
    }

    // Karl modified pending — update payload, keep pending alive
    if (data.intent === 'modify_pending') {
      const summary = data.payload?.title
        ?? (data.payload?.tasks?.length ? `${data.payload.tasks.length} tasks` : 'modified action');
      const primaryAction = data.actions?.[0]?.action;
      setPending({
        intent: primaryAction ?? data.payload?.action ?? 'capture_task',
        actions: data.actions ?? [],
        payload: data.payload ?? {},
        summary,
      });
      addMessage('assistant', data.response ?? 'Updated.');
      return;
    }

    // Karl previewed — show response, keep pending alive
    if (data.intent === 'preview_pending') {
      addMessage('assistant', data.response ?? '...');
      return;
    }

    // Karl wants to open the form
    if (data.intent === 'open_form') {
      addMessage('assistant', data.response ?? 'Opening it up.');
      setShowTaskAdd(true);
      return;
    }

    // Karl proposes a new pending action
    if (data.intent === 'pending') {
      const summary = data.payload?.title
        ?? (data.payload?.tasks?.length ? `${data.payload.tasks.length} tasks` : 'pending action');
      const primaryAction = data.actions?.[0]?.action;
      setPending({
        intent: primaryAction ?? data.payload?.action ?? 'capture_task',
        actions: data.actions ?? [],
        payload: data.payload ?? {},
        summary,
      });
      addMessage('assistant', data.response ?? '...');
      return;
    }

    // System commands
    if (data.intent === 'command' && data.payload?.command_type === 'open_tag_manager') {
      setShowTagManager(true);
      addMessage('assistant', data.response ?? 'Opening tag manager.');
      return;
    }

    // Delegation pending — pop DelegateModal
    if (data.intent === 'question' && data.payload?.delegation_pending) {
      const taskId = resolveIdentifierToTaskId(data.payload.identifier);
      if (taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          setDelegateModal({
            taskId: task.id,
            taskTitle: task.title,
            preselectedTagId: data.payload.preselected_tag_id ?? null,
            preselectedName: data.payload.preselected_name ?? null,
            mode: 'update',
          });
        }
      }
      addMessage('assistant', data.response ?? 'Who is handling this?');
      return;
    }

    // Question / conversational — never touch pending
    if (data.intent === 'question' || data.intent === 'unclear') {
      addMessage('assistant', data.response ?? "I'm not sure what to do with that.");
      return;
    }

    // Fallback — any other actionable intent with payload
    const isActionable = ['capture_task', 'capture_tasks', 'capture_completion', 'update_object', 'process_document'].includes(data.intent);
    if (isActionable && data.payload) {
      setPending({ intent: data.intent, actions: data.actions ?? [], payload: data.payload, summary: buildPendingSummary(data) });
    }
    addMessage('assistant', data.response ?? "I'm not sure what to do with that.");
  };

  // ─── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    const text = input.trim();
    if ((!text && queuedFiles.length === 0) || !sessionReady) return;

    const pendingForKarl = pending
      ? { ...pending.payload, actions: pending.actions, action: pending.intent, intent: pending.intent }
      : null;

    // ── File path: queued files + user hint ──────────────────────────────────
    if (queuedFiles.length > 0) {
      const filesToSend = [...queuedFiles];
      setQueuedFiles([]);
      addMessage('user', text ? `[${filesToSend.map(f => f.name).join(', ')}] — ${text}` : `[${filesToSend.map(f => f.name).join(', ')}]`);
      setInput('');
      setThinking(true);
      try {
        const res = await fetch('/api/ko/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
          body: JSON.stringify({
            input: text || null,
            pending: pendingForKarl,
            context_filter: contextFilter,
            files: filesToSend,
          }),
        });
        await handleCommandResponse(await res.json());
      } catch (err: any) {
        console.error('[handleSubmit files]', err);
        addMessage('assistant', 'Something went wrong reading those files. Try again.');
      } finally {
        setThinking(false);
      }
      return;
    }

    // ── Normal text path ─────────────────────────────────────────────────────
    if (!text) return;
    addMessage('user', text);
    setInput('');
    setThinking(true);
    try {
      const res = await fetch('/api/ko/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ input: text, pending: pendingForKarl, context_filter: contextFilter }),
      });
      await handleCommandResponse(await res.json());
    } catch (err: any) {
      console.error('[handleSubmit]', err);
      addMessage('assistant', 'Something went wrong. Try again.');
    } finally {
      setThinking(false);
    }
  };

  // ─── File drop handler ─────────────────────────────────────────────────────

  const handleFileDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOverChat(false);

    if (draggedTask.current) return;

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (!droppedFiles.length || !sessionReady) return;

    const newQueued: QueuedFile[] = [];
    const rejected: string[] = [];

    for (const file of droppedFiles) {
      if (file.size > 5 * 1024 * 1024) {
        rejected.push(`${file.name} (over 5MB)`);
        continue;
      }
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const resolvedType = SUPPORTED_FILE_TYPES.includes(file.type)
        ? file.type
        : (EXT_TYPE_MAP[ext] ?? file.type);

      if (!SUPPORTED_FILE_TYPES.includes(resolvedType)) {
        rejected.push(`${file.name} (unsupported type)`);
        continue;
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      newQueued.push({ name: file.name, type: resolvedType, data: base64, size: file.size });
    }

    if (rejected.length) {
      addMessage('assistant', `Skipped: ${rejected.join(', ')}. Drop PDF, DOCX, TXT, or MD files.`);
    }

    if (newQueued.length > 0) {
      setQueuedFiles(prev => [...prev, ...newQueued]);
    }
  };

  // ── Resolve identifier ─────────────────────────────────────────────────────

  const resolveIdentifierToTaskId = (identifier: string): string | null => {
    if (!identifier) return null;
    const upper = identifier.toUpperCase();
    const prefixMap: Record<string, string> = {
      N: 'now', S: 'soon', RW: 'realwork', L: 'later', D: 'delegate', CP: 'capture',
    };
    let bucketKey: string | null = null;
    let indexStr = '';
    for (const [prefix, bucket] of Object.entries(prefixMap)) {
      if (upper.startsWith(prefix)) { bucketKey = bucket; indexStr = upper.slice(prefix.length); break; }
    }
    if (!bucketKey || !indexStr) return null;
    const idx = parseInt(indexStr, 10) - 1;
    if (isNaN(idx) || idx < 0) return null;
    const bucketTasks = tasks
      .filter(t => t.bucket_key === bucketKey)
      .sort((a, b) => {
        if (a.sort_order !== null && b.sort_order !== null) return a.sort_order - b.sort_order;
        if (a.sort_order !== null) return -1;
        if (b.sort_order !== null) return 1;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
    return bucketTasks[idx]?.id ?? null;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  const handleDragStart = (task: Task) => {
    draggedTask.current = task;
  };

  const handleDrop = async (targetBucketKey: string) => {
    const task = draggedTask.current;
    draggedTask.current = null;
    if (!task || !koUser) return;
    if (task.bucket_key === targetBucketKey) return;

    if (targetBucketKey === 'delegate') {
      setDelegateModal({ taskId: task.id, taskTitle: task.title, mode: 'drop' });
      return;
    }

    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, bucket_key: targetBucketKey, delegated_to: null } : t));

    const { error } = await supabase
      .from('task')
      .update({ bucket_key: targetBucketKey, delegated_to: null, sort_order: null })
      .eq('task_id', task.id)
      .eq('user_id', koUser.id);

    if (error) {
      console.error('[handleDrop]', error);
      await loadTasks(koUser.id);
    }
  };

  const handleDelegateConfirm = async (tagId: string, tagName: string) => {
    if (!delegateModal || !koUser) return;

    const { taskId, mode } = delegateModal;
    setDelegateModal(null);

    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, bucket_key: 'delegate', delegated_to: tagId } : t
    ));

    const updatePayload: Record<string, any> = { delegated_to: tagId, sort_order: null };
    if (mode === 'drop') updatePayload.bucket_key = 'delegate';

    const { error } = await supabase
      .from('task')
      .update(updatePayload)
      .eq('task_id', taskId)
      .eq('user_id', koUser.id);

    if (error) {
      console.error('[handleDelegateConfirm]', error);
      await loadTasks(koUser.id);
    } else {
      addMessage('assistant', `Delegated to **${tagName}**. Task moved to Delegated bucket.`);
    }
  };

  const handleReorder = async (dropTargetId: string, dropIndex: number, bucketTasks: Task[]) => {
    const draggedId = draggedTask.current?.id;
    draggedTask.current = null;
    if (!draggedId || !koUser) return;
    if (draggedId === dropTargetId) return;

    const draggedIndex = bucketTasks.findIndex(t => t.id === draggedId);
    if (draggedIndex === -1) return;

    const reordered = [...bucketTasks];
    const [moved] = reordered.splice(draggedIndex, 1);
    const insertAt = draggedIndex < dropIndex ? dropIndex - 1 : dropIndex;
    reordered.splice(insertAt, 0, moved);

    setTasks(prev => {
      const otherTasks = prev.filter(t => t.bucket_key !== moved.bucket_key);
      return [...otherTasks, ...reordered];
    });

    await Promise.all(
      reordered.map((t, i) =>
        supabase.from('task')
          .update({ sort_order: i })
          .eq('task_id', t.id)
          .eq('user_id', koUser.id)
      )
    );
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
  const hasFiles      = queuedFiles.length > 0;
  const canSend       = (input.trim() || hasFiles) && sessionReady && !thinking;

  // Token counter color
  const tokenColor = sessionTokens < 100000 ? '#4ade80' : sessionTokens < 500000 ? '#fbbf24' : '#ef4444';

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
    <style>{`
      @keyframes karlPulse {
        0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
        40% { transform: scale(1); opacity: 1; }
      }
    `}</style>
    <div style={{ minHeight: '100vh', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', fontFamily: 'monospace', overflow: 'hidden' }}>

      {/* MODALS */}
      {showTaskAdd && koUser && (
        <TaskAddModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowTaskAdd(false)} onSaved={() => { loadTasks(koUser.id); setShowTaskAdd(false); }} />
      )}
      {showCompletions && koUser && (
        <CompletionsModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowCompletions(false)} onCountChange={setCompletionCount} />
      )}
      {showMeetings && koUser && (
        <MeetingsModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowMeetings(false)} onCountChange={setMeetingCount} />
      )}
      {showExtracts && koUser && (
        <ExtractsModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowExtracts(false)} onCountChange={setExtractCount} />
      )}
      {showTaskList && koUser && (
        <TaskListModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowTaskList(false)} onSaved={() => loadTasks(koUser.id)} />
      )}
      {showTemplates && koUser && (
        <TemplatesModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowTemplates(false)} onCountChange={setTemplateCount} />
      )}
      {showContacts && koUser && (
        <ContactsModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowContacts(false)} onCountChange={setContactCount} />
      )}
      {showTagManager && koUser && (
        <TagManagerModal userId={koUser.id} accessToken={accessToken} onClose={() => setShowTagManager(false)} onChanged={() => {}} />
      )}
      {selectedTask && koUser && (
        <TaskDetailModal taskId={selectedTask.id} userId={koUser.id} accessToken={accessToken} onClose={() => setSelectedTask(null)} onSaved={() => { loadTasks(koUser.id); setSelectedTask(null); }} />
      )}
      {delegateModal && koUser && (
        <DelegateModal
          taskId={delegateModal.taskId}
          taskTitle={delegateModal.taskTitle}
          userId={koUser.id}
          preselectedTagId={delegateModal.preselectedTagId}
          preselectedName={delegateModal.preselectedName}
          onConfirm={handleDelegateConfirm}
          onCancel={() => setDelegateModal(null)}
        />
      )}

      {/* HEADER */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.25rem', height: '44px', borderBottom: '1px solid #1a1a1a', flexShrink: 0, background: '#0d0d0d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src="/ko-icon.svg" alt="KO" style={{ width: '28px', height: '28px' }} />
          <span style={{ color: '#ffffff', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.02em' }}>KarlOps</span>
          <span style={{ color: '#555', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>{koUser?.implementation_type ?? '...'}</span>
          <span style={{ color: '#555', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>{koUser?.display_name ?? '...'}</span>
          
          {/* TOKEN COUNTER */}
          <span style={{ color: '#555', fontSize: '0.7rem' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.68rem' }}>
            <span style={{ color: '#666' }}>tokens:</span>
            <span style={{ color: tokenColor, fontWeight: 600 }}>{formatTokens(sessionTokens)}</span>
            {lastCallTokens && (
              <span style={{ color: '#444', fontSize: '0.62rem' }}>
                (last: {formatTokens(lastCallTokens.input + lastCallTokens.output)}
                {lastCallTokens.cache_read > 0 && <span style={{ color: '#4ade80' }}> ✓{formatTokens(lastCallTokens.cache_read)}</span>})
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button onClick={() => setShowTaskAdd(true)} style={{ background: '#0d1a14', border: '1px solid #10b981', color: '#10b981', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#0f2a20')} onMouseLeave={e => (e.currentTarget.style.background = '#0d1a14')}>+add task(s)</button>
            <button onClick={() => setShowCompletions(true)} style={{ background: '#1a0e00', border: '1px solid #4a2a00', color: '#f97316', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#2a1800')} onMouseLeave={e => (e.currentTarget.style.background = '#1a0e00')}><span style={{ color: '#f97316' }}>+complete</span><span style={{ color: '#ffffff' }}>({completionCount})</span></button>
            <button onClick={() => setShowMeetings(true)} style={{ background: '#0a0f1a', border: '1px solid #1a3060', color: '#3b82f6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#0f1a2a')} onMouseLeave={e => (e.currentTarget.style.background = '#0a0f1a')}><span style={{ color: '#3b82f6' }}>+meeting</span><span style={{ color: '#ffffff' }}>({meetingCount})</span></button>
            <button onClick={() => setShowExtracts(true)} style={{ background: '#120a1a', border: '1px solid #3a1a5a', color: '#8b5cf6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#1e1030')} onMouseLeave={e => (e.currentTarget.style.background = '#120a1a')}><span style={{ color: '#8b5cf6' }}>+extracts</span><span style={{ color: '#ffffff' }}>({extractCount})</span></button>
            <button onClick={() => setShowTemplates(true)} style={{ background: '#0a1f1d', border: '1px solid #0f3330', color: '#14b8a6', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#0f2a27')} onMouseLeave={e => (e.currentTarget.style.background = '#0a1f1d')}><span style={{ color: '#14b8a6' }}>+template</span><span style={{ color: '#ffffff' }}>({templateCount})</span></button>
            <button onClick={() => setShowContacts(true)} style={{ background: '#1a0a0a', border: '1px solid #4a1010', color: '#991b1b', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = '#2a1010')} onMouseLeave={e => (e.currentTarget.style.background = '#1a0a0a')}><span style={{ color: '#991b1b' }}>+contacts</span><span style={{ color: '#ffffff' }}>({contactCount})</span></button>
          </div>
          <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>
          <span onClick={() => setShowTaskList(true)} style={{ color: '#ffffff', fontSize: '0.7rem', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')} onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}>
            open(<span style={{ color: '#fbbf24', fontWeight: 600 }}>{contextFilter ? totalFiltered : totalOpen}</span>)
            {contextFilter && totalOpen !== totalFiltered && <span style={{ color: '#888' }}> / {totalOpen}</span>}
          </span>
          <span style={{ color: '#333', fontSize: '0.7rem' }}>|</span>
          <a href="/admin" style={{ color: '#ffffff', fontSize: '0.7rem', textDecoration: 'none', fontFamily: 'monospace' }} onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')} onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}>admin</a>
          <button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#ffffff', fontSize: '0.7rem', fontFamily: 'monospace', cursor: 'pointer', padding: 0 }} onMouseEnter={e => (e.currentTarget.style.color = '#fbbf24')} onMouseLeave={e => (e.currentTarget.style.color = '#ffffff')}>sign out</button>
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
                <ContextFilter contexts={contexts} selected={contextFilter} onChange={setContextFilter} />
                {buckets.map(bucket => (
                  <BucketSection
                    key={bucket.key}
                    bucket={bucket}
                    tasks={grouped[bucket.key] ?? []}
                    statusMap={statusMap}
                    onTaskClick={task => setSelectedTask(task)}
                    onDragStart={handleDragStart}
                    onDrop={handleDrop}
                    onReorder={handleReorder}
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
        <div
          style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', outline: dragOverChat ? '1px dashed #4ade80' : '1px solid transparent', transition: 'outline 0.15s' }}
          onDragOver={e => {
            if (!draggedTask.current && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOverChat(true);
            }
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverChat(false);
          }}
          onDrop={handleFileDrop}
        >

          {dragOverChat && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)', zIndex: 10, pointerEvents: 'none' }}>
              <div style={{ color: '#4ade80', fontFamily: 'monospace', textAlign: 'center' }}>
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⬇</div>
                <div style={{ fontSize: '0.9rem' }}>Drop file for Karl to analyze</div>
                <div style={{ fontSize: '0.7rem', color: '#555', marginTop: '0.35rem' }}>PDF · DOCX · TXT · MD</div>
              </div>
            </div>
          )}

          {/* CHAT MESSAGES */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.25rem 0.5rem', scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>
            {chat.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
            {thinking && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ padding: '0.6rem 0.9rem', borderRadius: '12px 12px 12px 2px', background: '#1a1a1a', border: '1px solid #252525', color: '#aaa', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ display: 'inline-flex', gap: '0.2rem', alignItems: 'center' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', display: 'inline-block', animation: 'karlPulse 1.2s ease-in-out infinite' }} />
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', display: 'inline-block', animation: 'karlPulse 1.2s ease-in-out 0.2s infinite' }} />
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', display: 'inline-block', animation: 'karlPulse 1.2s ease-in-out 0.4s infinite' }} />
                  </span>
                  <span style={{ fontSize: '0.72rem', color: '#555' }}>Karl is thinking...</span>
                </div>
              </div>
            )}
            {pending && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ padding: '0.5rem 0.75rem', background: '#0d1a0d', border: '1px solid #1a3a1a', borderRadius: '8px', fontSize: '0.75rem', color: '#4ade80' }}>
                  Pending: <strong>{pending.summary ?? pending.payload?.title ?? 'action'}</strong>
                </div>
              </div>
            )}
            {pendingPreviewTaskId && koUser && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ padding: '0.5rem 0.75rem', background: '#111', border: '1px solid #2a2a2a', borderRadius: '8px', fontSize: '0.75rem', color: '#888', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  <span>Want to take a look?</span>
                  <span
                    onClick={() => {
                      const t = tasks.find(t => t.id === pendingPreviewTaskId);
                      if (t) { setSelectedTask(t); setPendingPreviewTaskId(null); }
                      else { loadTasks(koUser.id).then(() => setPendingPreviewTaskId(null)); }
                    }}
                    style={{ color: '#fbbf24', cursor: 'pointer', textDecoration: 'underline' }}
                  >open it</span>
                  <span onClick={() => setPendingPreviewTaskId(null)} style={{ color: '#555', cursor: 'pointer' }}>✕</span>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {hasFiles && (
            <div style={{ padding: '0.5rem 1.25rem 0', display: 'flex', flexWrap: 'wrap', gap: '0.4rem', borderTop: '1px solid #1a1a1a', background: '#0d0d0d' }}>
              {queuedFiles.map((f, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#111', border: '1px solid #2a3a2a', borderRadius: '6px', padding: '0.25rem 0.5rem', fontSize: '0.72rem', color: '#4ade80' }}
                >
                  <span>📄</span>
                  <span style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ color: '#555', fontSize: '0.65rem' }}>{formatFileSize(f.size)}</span>
                  <span
                    onClick={() => setQueuedFiles(prev => prev.filter((_, idx) => idx !== i))}
                    style={{ color: '#555', cursor: 'pointer', marginLeft: '0.2rem', fontWeight: 700, fontSize: '0.8rem' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#555')}
                  >✕</span>
                </div>
              ))}
            </div>
          )}

          {/* INPUT BAR */}
          <div style={{ borderTop: '1px solid #1a1a1a', padding: '0.75rem 1.25rem', background: '#0d0d0d', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
                onKeyDown={handleKeyDown}
                placeholder={
                  hasFiles
                    ? `Tell Karl what to do with ${queuedFiles.length === 1 ? 'this file' : 'these files'}...`
                    : sessionReady
                    ? 'Drop a task, ask Karl anything, or drag a file here...'
                    : 'Starting up...'
                }
                disabled={!sessionReady || thinking}
                rows={1}
                style={{ flex: 1, background: '#111', border: `1px solid ${hasFiles ? '#2a3a2a' : '#222'}`, borderRadius: '6px', color: '#e5e5e5', fontSize: '0.85rem', padding: '0.6rem 0.75rem', fontFamily: 'monospace', resize: 'none', outline: 'none', lineHeight: 1.5, minHeight: '36px', maxHeight: '120px', overflowY: 'auto', transition: 'border-color 0.15s' }}
                onFocus={e => (e.target.style.borderColor = hasFiles ? '#4ade80' : '#555')}
                onBlur={e => (e.target.style.borderColor = hasFiles ? '#2a3a2a' : '#222')}
              />
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                style={{ background: canSend ? '#1a2a1a' : '#111', border: `1px solid ${canSend ? '#2a4a2a' : '#1a1a1a'}`, color: canSend ? '#4ade80' : '#555', borderRadius: '6px', padding: '0.5rem 1rem', fontSize: '0.8rem', fontFamily: 'monospace', cursor: canSend ? 'pointer' : 'not-allowed', flexShrink: 0, height: '36px', transition: 'all 0.15s' }}
              >send</button>
            </div>
            <div style={{ color: '#555', fontSize: '0.65rem', marginTop: '0.4rem' }}>
              {hasFiles
                ? `${queuedFiles.length} file${queuedFiles.length > 1 ? 's' : ''} queued — tell Karl what to do, then send`
                : '↵ send · shift+↵ newline · drag file to analyze'}
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const centeredStyle: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0a' };
const ghostBtn: React.CSSProperties = { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '0.3rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.7rem' };
