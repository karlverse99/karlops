'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';

export type TuoQueueRow = {
  id: string;
  created_at: string;
  submitted_by: string | null;
  input_mode: string;
  raw_text: string;
  status: string;
  notes: string | null;
};

function splitCapture(raw: string): { headline: string; body: string } {
  const t = raw.trim();
  if (!t) return { headline: 'TUO capture', body: '' };
  const nl = t.indexOf('\n');
  if (nl === -1) {
    if (t.length <= 100) return { headline: t, body: t };
    return { headline: `${t.slice(0, 100).trim()}…`, body: t };
  }
  const head = t.slice(0, nl).trim();
  const body = t.slice(nl + 1).trim();
  return { headline: head.slice(0, 200) || 'TUO capture', body };
}

type Props = {
  accessToken: string;
  tuoAdminUrl?: string;
  onClose: () => void;
  onProcessed: () => void;
  onOpenTask: (rawText: string) => void;
  onOpenMeeting: (draft: { title: string; description?: string; notes?: string }) => void;
  onOpenCompletion: (draft: { title: string; outcome: string; description?: string }) => void;
};

export default function TuoCaptureQueueModal({
  accessToken,
  tuoAdminUrl,
  onClose,
  onProcessed,
  onOpenTask,
  onOpenMeeting,
  onOpenCompletion,
}: Props) {
  const [rows, setRows] = useState<TuoQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch('/api/ko/tuo-capture-queue?limit=40', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Load failed');
      if (data.configured === false) {
        setRows([]);
        setErr('TUO Supabase is not configured on this KarlOps deployment.');
        return;
      }
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Load failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const patchStatus = async (id: string, status: string) => {
    setBusy(id);
    setErr(null);
    try {
      const res = await fetch('/api/ko/tuo-capture-queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Update failed');
      await load();
      onProcessed();
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const actTask = () => {
    if (!selected) return;
    onOpenTask(selected.raw_text);
    onClose();
  };

  const actMeeting = () => {
    if (!selected) return;
    const { headline, body } = splitCapture(selected.raw_text);
    onOpenMeeting({
      title: headline,
      description: body,
      notes: selected.notes?.trim() ? selected.notes : undefined,
    });
    onClose();
  };

  const actCompletion = () => {
    if (!selected) return;
    const { headline, body } = splitCapture(selected.raw_text);
    onOpenCompletion({
      title: headline,
      outcome: body || headline,
      description: selected.notes?.trim() ? selected.notes : undefined,
    });
    onClose();
  };

  const actMarkProcessed = () => {
    if (!selected) return;
    void patchStatus(selected.id, 'processed');
  };

  const overlay: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    fontFamily: 'monospace',
  };

  const panel: CSSProperties = {
    width: 'min(640px, 100%)',
    maxHeight: '90vh',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
  };

  return (
    <div style={overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div
          style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid #222',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 700 }}>TUO Capture queue</div>
            <div style={{ color: '#888', fontSize: '0.65rem', marginTop: '0.2rem' }}>
              Choose what to file in KarlOps, or mark processed if you handled it already.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {tuoAdminUrl ? (
              <a
                href={tuoAdminUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#93c5fd', fontSize: '0.65rem' }}
              >
                Open TUO admin
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void load()}
              style={{
                background: '#1a1a1a',
                border: '1px solid #333',
                color: '#ccc',
                fontSize: '0.65rem',
                padding: '0.25rem 0.5rem',
                borderRadius: '4px',
                cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '1.1rem',
                lineHeight: 1,
                opacity: 0.6,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0.75rem 1rem' }}>
          {loading && <p style={{ color: '#888', fontSize: '0.75rem' }}>Loading…</p>}
          {err && <p style={{ color: '#f87171', fontSize: '0.75rem' }}>{err}</p>}
          {!loading && !err && rows.length === 0 && (
            <p style={{ color: '#888', fontSize: '0.75rem' }}>Work queue is empty (no new / seen items).</p>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: selectedId === r.id ? '#1a2520' : '#141414',
                    border: `1px solid ${selectedId === r.id ? '#10b981' : '#2a2a2a'}`,
                    borderRadius: '6px',
                    padding: '0.5rem 0.73rem',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  <div style={{ color: '#94a3b8', fontSize: '0.62rem' }}>
                    {(r.submitted_by?.trim() || 'Anonymous') +
                      ' · ' +
                      new Date(r.created_at).toLocaleString() +
                      ' · ' +
                      r.status}
                  </div>
                  <div style={{ color: '#e5e5e5', fontSize: '0.72rem', marginTop: '0.35rem', whiteSpace: 'pre-wrap' }}>
                    {r.raw_text.length > 220 ? `${r.raw_text.slice(0, 220)}…` : r.raw_text}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {selected && (
          <div
            style={{
              borderTop: '1px solid #222',
              padding: '0.75rem 1rem',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            <div style={{ color: '#aaa', fontSize: '0.62rem' }}>File this capture in KarlOps</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              <button type="button" disabled={!!busy} onClick={actTask} style={btn('#10b981', '#052e16')}>
                + Task
              </button>
              <button type="button" disabled={!!busy} onClick={actMeeting} style={btn('#3b82f6', '#172554')}>
                + Meeting
              </button>
              <button type="button" disabled={!!busy} onClick={actCompletion} style={btn('#f97316', '#431407')}>
                + Completion
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={actMarkProcessed}
                style={btn('#6b7280', '#111827')}
              >
                Mark processed (TUO only)
              </button>
            </div>
            <p style={{ color: '#666', fontSize: '0.6rem', margin: 0 }}>
              “Mark processed” does not create a KO row — it clears the TUO work queue for everyone. Use after you’ve filed or if it was noise.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function btn(fg: string, bg: string): CSSProperties {
  return {
    background: bg,
    border: `1px solid ${fg}`,
    color: fg,
    fontSize: '0.68rem',
    fontWeight: 600,
    padding: '0.35rem 0.65rem',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: 'monospace',
  };
}
