'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'tags' | 'task_status' | 'defaults' | 'field_meta' | 'list_config' | 'concepts';

interface Row { [key: string]: any; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function adminFetch(token: string, table: string) {
  const res = await fetch(`/api/ko/admin?table=${table}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Fetch failed');
  return json.data as Row[];
}

async function adminPost(token: string, table: string, record: Row) {
  const res = await fetch('/api/ko/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ table, record }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Insert failed');
  return json.data;
}

async function adminPatch(token: string, table: string, id_field: string, id_value: any, updates: Row) {
  const res = await fetch('/api/ko/admin', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ table, id_field, id_value, updates }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Update failed');
  return json.data;
}

async function adminDelete(token: string, table: string, id_field: string, id_value: any) {
  const res = await fetch('/api/ko/admin', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ table, id_field, id_value }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Delete failed');
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Cell({ value, onSave }: { value: any; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));

  const commit = () => { setEditing(false); if (draft !== String(value ?? '')) onSave(draft); };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        style={{ background: '#1a1a1a', border: '1px solid #444', color: '#e5e5e5', padding: '0.2rem 0.4rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.78rem', width: '100%' }}
      />
    );
  }

  return (
    <div onClick={() => setEditing(true)} style={{ cursor: 'text', color: '#ccc', fontSize: '0.78rem', padding: '0.2rem 0.4rem', borderRadius: '3px', minHeight: '1.4rem' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1a1a1a')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {value === null || value === undefined || value === '' ? <span style={{ color: '#444' }}>—</span> : String(value)}
    </div>
  );
}

function TableView({
  rows, columns, idField, token, table, onRefresh, addForm,
}: {
  rows: Row[]; columns: { key: string; label: string; editable?: boolean }[];
  idField: string; token: string; table: string; onRefresh: () => void;
  addForm?: React.ReactNode;
}) {
  const [error, setError] = useState('');

  const handleSave = async (id: any, field: string, value: string) => {
    try {
      await adminPatch(token, table, idField, id, { [field]: value });
      onRefresh();
    } catch (e: any) { setError(e.message); }
  };

  const handleDelete = async (id: any) => {
    if (!confirm('Delete this record? This cannot be undone.')) return;
    try {
      await adminDelete(token, table, idField, id);
      onRefresh();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '0.75rem' }}>{error}</div>}
      {addForm && <div style={{ marginBottom: '1rem' }}>{addForm}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} style={{ textAlign: 'left', color: '#666', fontWeight: 600, padding: '0.4rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap' }}>{c.label}</th>
              ))}
              <th style={{ width: '40px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + 1} style={{ color: '#444', padding: '1rem 0.5rem', fontSize: '0.75rem' }}>No records</td></tr>
            )}
            {rows.map(row => (
              <tr key={row[idField]} style={{ borderBottom: '1px solid #111' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#0f0f0f')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {columns.map(c => (
                  <td key={c.key} style={{ padding: '0.25rem 0.5rem' }}>
                    {c.editable
                      ? <Cell value={row[c.key]} onSave={v => handleSave(row[idField], c.key, v)} />
                      : <span style={{ color: '#555', fontSize: '0.78rem' }}>{String(row[c.key] ?? '—')}</span>
                    }
                  </td>
                ))}
                <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                  <button onClick={() => handleDelete(row[idField])} style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer', fontSize: '0.75rem' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#333')}
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddRow({ fields, onAdd }: { fields: { key: string; label: string; placeholder?: string }[]; onAdd: (record: Row) => Promise<void> }) {
  const empty = Object.fromEntries(fields.map(f => [f.key, '']));
  const [draft, setDraft] = useState<Row>(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleAdd = async () => {
    setSaving(true); setError('');
    try { await onAdd(draft); setDraft(empty); }
    catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      {fields.map(f => (
        <div key={f.key}>
          <div style={{ color: '#555', fontSize: '0.65rem', marginBottom: '0.2rem' }}>{f.label}</div>
          <input
            value={draft[f.key]}
            onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
            placeholder={f.placeholder ?? f.label}
            style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.4rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.78rem', width: '160px' }}
          />
        </div>
      ))}
      <button onClick={handleAdd} disabled={saving} style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.78rem', cursor: 'pointer', height: '32px' }}>
        {saving ? '...' : '+ Add'}
      </button>
      {error && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{error}</span>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [tab, setTab] = useState<Tab>('tags');
  const [data, setData] = useState<Record<string, Row[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { window.location.href = '/login'; return; }
      setToken(session.access_token);
    });
  }, []);

  // Tab config
  const TAB_CONFIG: Record<Tab, { table: string; label: string }> = {
    tags:        { table: 'tag',                 label: 'Tags' },
    task_status: { table: 'task_status',          label: 'Task Status' },
    defaults:    { table: 'ko_default_registry',  label: 'Defaults' },
    field_meta:  { table: 'ko_field_metadata',    label: 'Field Metadata' },
    list_config: { table: 'ko_list_view_config',  label: 'List View Config' },
    concepts:    { table: 'concept_registry',     label: 'Concepts' },
  };

  const fetchTab = useCallback(async (t: Tab) => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const rows = await adminFetch(token, TAB_CONFIG[t].table);
      setData(d => ({ ...d, [t]: rows }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { if (token) fetchTab(tab); }, [token, tab]);

  const rows = data[tab] ?? [];

  // Per-tab column/add config
  const tabContent = () => {
    switch (tab) {
      case 'tags':
        return (
          <TableView
            rows={rows} token={token} table="tag" idField="tag_id" onRefresh={() => fetchTab('tags')}
            columns={[
              { key: 'name', label: 'Name', editable: true },
              { key: 'tag_group_id', label: 'Group ID', editable: false },
            ]}
            addForm={
              <AddRow
                fields={[{ key: 'name', label: 'Tag Name' }]}
                onAdd={r => adminPost(token, 'tag', r).then(() => fetchTab('tags'))}
              />
            }
          />
        );

      case 'task_status':
        return (
          <TableView
            rows={rows} token={token} table="task_status" idField="task_status_id" onRefresh={() => fetchTab('task_status')}
            columns={[
              { key: 'name', label: 'Name', editable: true },
              { key: 'label', label: 'Label', editable: true },
              { key: 'display_order', label: 'Order', editable: true },
              { key: 'is_default', label: 'Default', editable: false },
            ]}
            addForm={
              <AddRow
                fields={[
                  { key: 'name', label: 'Name', placeholder: 'inprogress' },
                  { key: 'label', label: 'Label', placeholder: 'In Progress' },
                  { key: 'display_order', label: 'Order', placeholder: '6' },
                ]}
                onAdd={r => adminPost(token, 'task_status', { ...r, is_default: false }).then(() => fetchTab('task_status'))}
              />
            }
          />
        );

      case 'defaults':
        return (
          <TableView
            rows={rows} token={token} table="ko_default_registry" idField="ko_default_registry_id" onRefresh={() => fetchTab('defaults')}
            columns={[
              { key: 'object_type', label: 'Object Type', editable: false },
              { key: 'field', label: 'Field', editable: false },
              { key: 'value', label: 'Value', editable: true },
            ]}
          />
        );

      case 'field_meta':
        return (
          <TableView
            rows={rows} token={token} table="ko_field_metadata" idField="ko_field_metadata_id" onRefresh={() => fetchTab('field_meta')}
            columns={[
              { key: 'object_type', label: 'Object', editable: false },
              { key: 'field', label: 'Field', editable: false },
              { key: 'field_type', label: 'Type', editable: true },
              { key: 'label', label: 'Label', editable: true },
              { key: 'required', label: 'Required', editable: true },
              { key: 'editable', label: 'Editable', editable: true },
              { key: 'display_order', label: 'Order', editable: true },
            ]}
          />
        );

      case 'list_config':
        return (
          <TableView
            rows={rows} token={token} table="ko_list_view_config" idField="ko_list_view_config_id" onRefresh={() => fetchTab('list_config')}
            columns={[
              { key: 'object_type', label: 'Object', editable: false },
              { key: 'id_field', label: 'ID Field', editable: true },
              { key: 'allow_delete', label: 'Allow Delete', editable: true },
            ]}
          />
        );

      case 'concepts':
        return (
          <TableView
            rows={rows} token={token} table="concept_registry" idField="concept_registry_id" onRefresh={() => fetchTab('concepts')}
            columns={[
              { key: 'concept_key', label: 'Key', editable: false },
              { key: 'concept_type', label: 'Type', editable: false },
              { key: 'label', label: 'Label', editable: true },
              { key: 'icon', label: 'Icon', editable: true },
              { key: 'display_order', label: 'Order', editable: true },
              { key: 'kbd_shortcut', label: 'KBD', editable: true },
            ]}
          />
        );
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'tags',        label: 'Tags' },
    { key: 'task_status', label: 'Task Status' },
    { key: 'defaults',    label: 'Defaults' },
    { key: 'field_meta',  label: 'Field Metadata' },
    { key: 'list_config', label: 'List Config' },
    { key: 'concepts',    label: 'Concepts' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', fontFamily: 'monospace', color: '#ccc' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.25rem', height: '44px', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <a href="/workspace" style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>KarlOps</a>
          <span style={{ color: '#444', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>Admin</span>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d', paddingLeft: '1.25rem' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ background: 'none', border: 'none', borderBottom: tab === t.key ? '2px solid #4ade80' : '2px solid transparent', color: tab === t.key ? '#4ade80' : '#555', padding: '0.6rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', transition: 'color 0.15s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: '1.5rem 1.25rem' }}>
        {loading && <div style={{ color: '#555', fontSize: '0.75rem' }}>Loading...</div>}
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem' }}>{error}</div>}
        {!loading && tabContent()}
      </div>
    </div>
  );
}