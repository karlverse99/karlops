'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface KOUser {
  id: string;
  email: string;
  display_name: string;
  implementation_type: string;
}

interface Task {
  id: string;
  title: string;
  bucket_key: string;
  tags: string[];
  is_completed: boolean;
  is_archived: boolean;
  created_at: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface BucketDef {
  key: string;
  label: string;
  color: string;
  accent: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BUCKETS: BucketDef[] = [
  { key: 'now',       label: 'On Fire',      color: '#ef4444', accent: '#fca5a5' },
  { key: 'soon',      label: 'Up Next',      color: '#f97316', accent: '#fdba74' },
  { key: 'realwork',  label: 'Real Work',    color: '#3b82f6', accent: '#93c5fd' },
  { key: 'later',     label: 'Later',        color: '#6b7280', accent: '#9ca3af' },
  { key: 'delegate',  label: 'Delegated',    color: '#8b5cf6', accent: '#c4b5fd' },
  { key: 'capture',   label: 'Capture',      color: '#10b981', accent: '#6ee7b7' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function groupTasksByBucket(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  for (const b of BUCKETS) grouped[b.key] = [];
  for (const task of tasks) {
    if (grouped[task.bucket_key]) {
      grouped[task.bucket_key].push(task);
    }
  }
  return grouped;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function TaskPill({ task, bucket }: { task: Task; bucket: BucketDef }) {
  return (
    <div style={{
      padding: '0.5rem 0.75rem',
      background: '#161616',
      border: `1px solid #222`,
      borderLeft: `2px solid ${bucket.color}`,
      borderRadius: '4px',
      marginBottom: '0.375rem',
      cursor: 'pointer',
      transition: 'border-color 0.15s, background 0.15s',
    }}
    onMouseEnter={e => (e.currentTarget.style.background = '#1c1c1c')}
    onMouseLeave={e => (e.currentTarget.style.background = '#161616')}
    >
      <div style={{ color: '#e5e5e5', fontSize: '0.82rem', lineHeight: 1.4 }}>
        {task.title}
      </div>
      {task.tags?.length > 0 && (
        <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
          {task.tags.map(tag => (
            <span key={tag} style={{
              fontSize: '0.65rem',
              color: '#aaa',
              background: '#1e1e1e',
              border: '1px solid #2a2a2a',
              borderRadius: '3px',
              padding: '0.1rem 0.35rem',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BucketSection({ bucket, tasks }: { bucket: BucketDef; tasks: Task[] }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{
          width: '8px', height: '8px',
          borderRadius: '50%',
          background: bucket.color,
          flexShrink: 0,
          boxShadow: `0 0 6px ${bucket.color}66`,
        }} />
        {/* Bucket label — kept as designed */}
        <span style={{ color: bucket.accent, fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {bucket.label}
        </span>
        <span style={{ color: '#888', fontSize: '0.65rem', marginLeft: 'auto' }}>
          {tasks.length > 0 ? tasks.length : '—'}
        </span>
        <span style={{ color: '#888', fontSize: '0.65rem' }}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div>
          {tasks.length === 0 ? (
            <div style={{ color: '#444', fontSize: '0.75rem', paddingLeft: '1rem', paddingBottom: '0.25rem' }}>
              empty
            </div>
          ) : (
            tasks.map(task => (
              <TaskPill key={task.id} task={task} bucket={bucket} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '0.75rem',
    }}>
      <div style={{
        maxWidth: '80%',
        padding: '0.6rem 0.9rem',
        borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
        background: isUser ? '#1a2a1a' : '#1a1a1a',
        border: `1px solid ${isUser ? '#2a4a2a' : '#252525'}`,
        color: isUser ? '#86efac' : '#d4d4d4',
        fontSize: '0.82rem',
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
      }}>
        {msg.content}
      </div>
    </div>
  );
}

// ─── Main Shell ───────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  const [user, setUser] = useState<any>(null);
  const [koUser, setKoUser] = useState<KOUser | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [thinking, setThinking] = useState(false);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionInitiated = useRef(false);

  // ── Auth gate ──────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        window.location.href = '/login';
        return;
      }
      setUser(session.user);
      setLoading(false);
    });
  }, []);

  // ── Lazy session init — fires once user is known ───────────────────────────
  const initSession = useCallback(async (authUser: any) => {
    if (sessionInitiated.current) return;
    sessionInitiated.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('No access token');

      const res = await fetch('/api/ko/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Session init failed');

      // Fetch ko_user profile
      const { data: koUserData, error: koErr } = await supabase
        .from('ko_user')
        .select('id, email, display_name, implementation_type')
        .eq('id', authUser.id)
        .single();

      if (koErr) throw koErr;
      setKoUser(koUserData);
      setSessionReady(true);

      if (data.is_new_user) {
        setChat([{
          role: 'assistant',
          content: `Welcome. I'm Karl.\n\nDrop anything here — tasks, notes, things on your mind. I'll help you sort it.\n\nWhat's on the board right now?`,
          timestamp: new Date(),
        }]);
      } else {
        setChat([{
          role: 'assistant',
          content: `Back at it. What's changed?`,
          timestamp: new Date(),
        }]);
      }

      // Load tasks
      await loadTasks(authUser.id);
    } catch (err: any) {
      console.error('[initSession]', err);
      setSessionError(err.message ?? 'Failed to initialize session');
    }
  }, []);

useEffect(() => {
  if (user && !loading) {
    initSession(user);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [user, loading]);

  // ── Load tasks ─────────────────────────────────────────────────────────────
  const loadTasks = async (userId: string) => {
    const { data, error } = await supabase
      .from('task')
      .select('task_id, title, bucket_key, tags, is_completed, is_archived, created_at')
      .eq('user_id', userId)
      .eq('is_completed', false)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (!error && data) {
      // map task_id → id for consistency
      setTasks(data.map((t: any) => ({ ...t, id: t.task_id })));
    }
  };

  // ── Chat scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat, thinking]);

  // ── Submit input ───────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || !sessionReady) return;

    const userMsg: ChatMessage = { role: 'user', content: text, timestamp: new Date() };
    setChat(prev => [...prev, userMsg]);
    setInput('');
    setThinking(true);

    // TODO: route to commandEngine
    setTimeout(() => {
      setChat(prev => [...prev, {
        role: 'assistant',
        content: `Got it: "${text}"\n\nCommand routing coming next.`,
        timestamp: new Date(),
      }]);
      setThinking(false);
    }, 600);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  // ── Loading states ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={centeredStyle}>
        <span style={{ color: '#aaa', fontFamily: 'monospace', fontSize: '0.8rem' }}>...</span>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div style={centeredStyle}>
        <div style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: '0.8rem', textAlign: 'center' }}>
          <div style={{ marginBottom: '0.5rem' }}>Session error</div>
          <div style={{ color: '#aaa', fontSize: '0.75rem' }}>{sessionError}</div>
          <button onClick={() => window.location.reload()} style={ghostBtn}>Retry</button>
        </div>
      </div>
    );
  }

  const grouped = groupTasksByBucket(tasks);
  const totalOpen = tasks.length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#0a0a0a',
      fontFamily: 'monospace',
      overflow: 'hidden',
    }}>

      {/* ── HEADER ── */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 1.25rem',
        height: '44px',
        borderBottom: '1px solid #1a1a1a',
        flexShrink: 0,
        background: '#0d0d0d',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ color: '#ffffff', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.02em' }}>
            KarlOps
          </span>
          <span style={{ color: '#444', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>
            {koUser?.implementation_type ?? 'default'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>
            {totalOpen} open
          </span>
          <span style={{ color: '#444', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>
            {koUser?.display_name ?? user?.email}
          </span>
          <button onClick={handleLogout} style={ghostBtn}>
            sign out
          </button>
        </div>
      </header>

      {/* ── MAIN SPLIT ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── LEFT: BUCKET VIEW ── */}
        <div style={{
          width: '340px',
          flexShrink: 0,
          borderRight: '1px solid #1a1a1a',
          overflowY: 'auto',
          padding: '1rem',
          scrollbarWidth: 'thin',
          scrollbarColor: '#222 transparent',
        }}>
          {!sessionReady ? (
            <div style={{ color: '#aaa', fontSize: '0.75rem', paddingTop: '1rem' }}>
              Initializing...
            </div>
          ) : (
            BUCKETS.map(bucket => (
              <BucketSection
                key={bucket.key}
                bucket={bucket}
                tasks={grouped[bucket.key] ?? []}
              />
            ))
          )}
        </div>

        {/* ── RIGHT: CHAT ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Chat history */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1.25rem 1.25rem 0.5rem',
            scrollbarWidth: 'thin',
            scrollbarColor: '#222 transparent',
          }}>
            {chat.map((msg, i) => (
              <ChatBubble key={i} msg={msg} />
            ))}
            {thinking && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{
                  padding: '0.6rem 0.9rem',
                  borderRadius: '12px 12px 12px 2px',
                  background: '#1a1a1a',
                  border: '1px solid #252525',
                  color: '#aaa',
                  fontSize: '0.82rem',
                }}>
                  ···
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* ── INPUT BAR ── */}
          <div style={{
            borderTop: '1px solid #1a1a1a',
            padding: '0.75rem 1.25rem',
            background: '#0d0d0d',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
                onKeyDown={handleKeyDown}
                placeholder={sessionReady ? 'Drop a task, ask something, or give an order...' : 'Starting up...'}
                disabled={!sessionReady || thinking}
                rows={1}
                style={{
                  flex: 1,
                  background: '#111',
                  border: '1px solid #222',
                  borderRadius: '6px',
                  color: '#e5e5e5',
                  fontSize: '0.85rem',
                  padding: '0.6rem 0.75rem',
                  fontFamily: 'monospace',
                  resize: 'none',
                  outline: 'none',
                  lineHeight: 1.5,
                  minHeight: '36px',
                  maxHeight: '120px',
                  overflowY: 'auto',
                  transition: 'border-color 0.15s',
                }}
                onFocus={e => (e.target.style.borderColor = '#555')}
                onBlur={e => (e.target.style.borderColor = '#222')}
              />
              <button
                onClick={handleSubmit}
                disabled={!input.trim() || !sessionReady || thinking}
                style={{
                  background: input.trim() && sessionReady && !thinking ? '#1a2a1a' : '#111',
                  border: `1px solid ${input.trim() && sessionReady && !thinking ? '#2a4a2a' : '#1a1a1a'}`,
                  color: input.trim() && sessionReady && !thinking ? '#4ade80' : '#555',
                  borderRadius: '6px',
                  padding: '0.5rem 1rem',
                  fontSize: '0.8rem',
                  cursor: input.trim() && sessionReady && !thinking ? 'pointer' : 'not-allowed',
                  fontFamily: 'monospace',
                  flexShrink: 0,
                  height: '36px',
                  transition: 'all 0.15s',
                }}
              >
                send
              </button>
            </div>
            <div style={{ color: '#555', fontSize: '0.65rem', marginTop: '0.4rem', paddingLeft: '0.1rem' }}>
              ↵ send · shift+↵ newline
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const centeredStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0a0a0a',
};

const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #444',
  color: '#aaa',
  padding: '0.3rem 0.6rem',
  borderRadius: '4px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '0.7rem',
};
