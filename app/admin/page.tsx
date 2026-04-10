'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

type Tab = 'tag_groups' | 'tags' | 'task_status' | 'defaults' | 'field_meta' | 'list_config' | 'concepts';
interface Row { [key: string]: any; }

// ─── API Helpers ──────────────────────────────────────────────────────────────

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

// ─── Cell Components ──────────────────────────────────────────────────────────

function TextCell({ value, onSave }: { value: any; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const commit = () => { setEditing(false); if (draft !== String(value ?? '')) onSave(draft); };

  if (editing) {
    return (
      <input autoFocus value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        style={{ background: '#1a1a1a', border: '1px solid #444', color: '#e5e5e5', padding: '0.15rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.75rem', width: '100%', minWidth: '80px' }}
      />
    );
  }
  return (
    <div onClick={() => setEditing(true)}
      style={{ cursor: 'text', color: '#ccc', fontSize: '0.75rem', padding: '0.15rem 0.35rem', borderRadius: '3px', minHeight: '1.3rem', whiteSpace: 'nowrap' }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1a1a1a')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {value === null || value === undefined || value === '' ? <span style={{ color: '#333' }}>—</span> : String(value)}
    </div>
  );
}

function BoolCell({ value, onSave }: { value: any; onSave: (v: string) => void }) {
  return (
    <input type="checkbox" checked={!!value}
      onChange={e => onSave(String(e.target.checked))}
      style={{ cursor: 'pointer', accentColor: '#4ade80' }}
    />
  );
}

function ReadCell({ value }: { value: any }) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: '#333', fontSize: '0.75rem' }}>—</span>;
  }
  if (typeof value === 'boolean') {
    return <span style={{ color: value ? '#4ade80' : '#555', fontSize: '0.75rem' }}>{value ? 'yes' : 'no'}</span>;
  }
  return <span style={{ color: '#555', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{String(value)}</span>;
}

// ─── Column def ───────────────────────────────────────────────────────────────

interface ColDef {
  key: string;
  label: string;
  editable?: boolean;
  type?: 'text' | 'bool' | 'readonly';
}

// ─── Generic Table ────────────────────────────────────────────────────────────

function DataTable({ rows, cols, idField, token, table, onRefresh, addForm }: {
  rows: Row[]; cols: ColDef[]; idField: string;
  token: string; table: string; onRefresh: () => void;
  addForm?: React.ReactNode;
}) {
  const [err, setErr] = useState('');

  const handleSave = async (id: any, field: string, value: string) => {
    try { await adminPatch(token, table, idField, id, { [field]: value }); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  };

  const handleDelete = async (id: any) => {
    if (!confirm('Delete this record?')) return;
    try { await adminDelete(token, table, idField, id); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      {addForm && <div style={{ marginBottom: '1rem' }}>{addForm}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>
                  {c.label}
                </th>
              ))}
              <th style={{ width: '32px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 1} style={{ color: '#333', padding: '1rem 0.5rem', fontSize: '0.75rem' }}>No records</td></tr>
            )}
            {rows.map(row => (
              <tr key={row[idField]} style={{ borderBottom: '1px solid #0f0f0f' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {cols.map(c => {
                  const t = c.type ?? (c.editable ? 'text' : 'readonly');
                  return (
                    <td key={c.key} style={{ padding: '0.2rem 0.5rem' }}>
                      {t === 'bool'
                        ? <BoolCell value={row[c.key]} onSave={v => handleSave(row[idField], c.key, v)} />
                        : t === 'text'
                        ? <TextCell value={row[c.key]} onSave={v => handleSave(row[idField], c.key, v)} />
                        : <ReadCell value={row[c.key]} />
                      }
                    </td>
                  );
                })}
                <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right' }}>
                  <button onClick={() => handleDelete(row[idField])}
                    style={{ background: 'none', border: 'none', color: '#2a2a2a', cursor: 'pointer', fontSize: '0.72rem' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#2a2a2a')}
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

// ─── Add Form ─────────────────────────────────────────────────────────────────

function AddForm({ fields, onAdd }: {
  fields: { key: string; label: string; placeholder?: string; type?: 'text' | 'select'; options?: { value: string; label: string }[] }[];
  onAdd: (record: Row) => Promise<void>;
}) {
  const empty = Object.fromEntries(fields.map(f => [f.key, '']));
  const [draft, setDraft] = useState<Row>(empty);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleAdd = async () => {
    setSaving(true); setErr('');
    try { await onAdd(draft); setDraft(empty); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', padding: '0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '6px' }}>
      {fields.map(f => (
        <div key={f.key}>
          <div style={{ color: '#555', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</div>
          {f.type === 'select' ? (
            <select value={draft[f.key]} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
              style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '140px' }}
            >
              <option value="">— select —</option>
              {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input value={draft[f.key]} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
              placeholder={f.placeholder ?? f.label}
              style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', width: '140px' }}
            />
          )}
        </div>
      ))}
      <button onClick={handleAdd} disabled={saving}
        style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.35rem 0.75rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', height: '30px' }}
      >{saving ? '...' : '+ Add'}</button>
      {err && <span style={{ color: '#ef4444', fontSize: '0.72rem' }}>{err}</span>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [tab, setTab] = useState<Tab>('field_meta');
  const [data, setData] = useState<Record<string, Row[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldMetaFilter, setFieldMetaFilter] = useState('');
  const [tagGroups, setTagGroups] = useState<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { window.location.href = '/login'; return; }
      setToken(session.access_token);
    });
  }, []);

  const TAB_TABLE: Record<Tab, string> = {
    tag_groups:  'tag_group',
    tags:        'tag',
    task_status: 'task_status',
    defaults:    'ko_default_registry',
    field_meta:  'ko_field_metadata',
    list_config: 'ko_list_view_config',
    concepts:    'concept_registry',
  };

  const fetchTab = useCallback(async (t: Tab) => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const rows = await adminFetch(token, TAB_TABLE[t]);
      setData(d => ({ ...d, [t]: rows }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [token]);

  // Always keep tag groups loaded for FK resolution in Tags tab
  useEffect(() => {
    if (!token) return;
    adminFetch(token, 'tag_group').then(setTagGroups).catch(() => {});
  }, [token]);

  useEffect(() => { if (token) fetchTab(tab); }, [token, tab]);

  const rows = data[tab] ?? [];

  // Field metadata: get unique object_types for filter
  const fieldMetaRows = data['field_meta'] ?? [];
  const objectTypes = Array.from(new Set(fieldMetaRows.map(r => r.object_type))).sort();
  const filteredFieldMeta = fieldMetaFilter
    ? fieldMetaRows.filter(r => r.object_type === fieldMetaFilter)
    : fieldMetaRows;

  const tabContent = () => {
    switch (tab) {

      case 'tag_groups':
        return (
          <DataTable
            rows={rows} token={token} table="tag_group" idField="tag_group_id" onRefresh={() => fetchTab('tag_groups')}
            cols={[
              { key: 'name', label: 'Name', editable: true, type: 'text' },
              { key: 'display_order', label: 'Order', editable: true, type: 'text' },
            ]}
            addForm={
              <AddForm
                fields={[
                  { key: 'name', label: 'Group Name' },
                  { key: 'display_order', label: 'Order', placeholder: '5' },
                ]}
                onAdd={r => adminPost(token, 'tag_group', r).then(() => { fetchTab('tag_groups'); adminFetch(token, 'tag_group').then(setTagGroups); })}
              />
            }
          />
        );

      case 'tags':
        return (
          <DataTable
            rows={rows.map(r => ({
              ...r,
              group_name: tagGroups.find(g => g.tag_group_id === r.tag_group_id)?.name ?? r.tag_group_id,
            }))}
            token={token} table="tag" idField="tag_id" onRefresh={() => fetchTab('tags')}
            cols={[
              { key: 'name', label: 'Name', editable: true, type: 'text' },
              { key: 'group_name', label: 'Group', editable: false, type: 'readonly' },
            ]}
            addForm={
              <AddForm
                fields={[
                  { key: 'name', label: 'Tag Name' },
                  { key: 'tag_group_id', label: 'Group', type: 'select', options: tagGroups.map(g => ({ value: g.tag_group_id, label: g.name })) },
                ]}
                onAdd={r => {
                  if (!r.tag_group_id) throw new Error('Group is required');
                  return adminPost(token, 'tag', r).then(() => fetchTab('tags'));
                }}
              />
            }
          />
        );

      case 'task_status':
        return (
          <DataTable
            rows={rows} token={token} table="task_status" idField="task_status_id" onRefresh={() => fetchTab('task_status')}
            cols={[
              { key: 'name', label: 'Name', editable: true, type: 'text' },
              { key: 'label', label: 'Label', editable: true, type: 'text' },
              { key: 'display_order', label: 'Order', editable: true, type: 'text' },
              { key: 'is_default', label: 'Default', editable: true, type: 'bool' },
            ]}
            addForm={
              <AddForm
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
          <DataTable
            rows={rows} token={token} table="ko_default_registry" idField="ko_default_registry_id" onRefresh={() => fetchTab('defaults')}
            cols={[
              { key: 'object_type', label: 'Object Type', type: 'readonly' },
              { key: 'field', label: 'Field', type: 'readonly' },
              { key: 'value', label: 'Value', editable: true, type: 'text' },
            ]}
          />
        );

      case 'field_meta':
        return (
          <div>
            {/* Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ color: '#555', fontSize: '0.7rem' }}>Filter by object:</span>
              <select value={fieldMetaFilter} onChange={e => setFieldMetaFilter(e.target.value)}
                style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.3rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}
              >
                <option value="">All</option>
                {objectTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <span style={{ color: '#333', fontSize: '0.7rem' }}>{filteredFieldMeta.length} rows</span>
            </div>
            <DataTable
              rows={filteredFieldMeta} token={token} table="ko_field_metadata" idField="ko_field_metadata_id" onRefresh={() => fetchTab('field_meta')}
              cols={[
                { key: 'object_type', label: 'Object', type: 'readonly' },
                { key: 'field', label: 'Field', type: 'readonly' },
                { key: 'field_type', label: 'Field Type', editable: true, type: 'text' },
                { key: 'label', label: 'Label', editable: true, type: 'text' },
                { key: 'required', label: 'Req', editable: true, type: 'bool' },
                { key: 'editable', label: 'Edit', editable: true, type: 'bool' },
                { key: 'display_order', label: 'Order', editable: true, type: 'text' },
              ]}
            />
          </div>
        );

      case 'list_config':
        return (
          <DataTable
            rows={rows} token={token} table="ko_list_view_config" idField="ko_list_view_config_id" onRefresh={() => fetchTab('list_config')}
            cols={[
              { key: 'object_type', label: 'Object', type: 'readonly' },
              { key: 'id_field', label: 'ID Field', editable: true, type: 'text' },
              { key: 'allow_delete', label: 'Allow Delete', editable: true, type: 'bool' },
            ]}
          />
        );

      case 'concepts':
        return (
          <DataTable
            rows={rows} token={token} table="concept_registry" idField="concept_registry_id" onRefresh={() => fetchTab('concepts')}
            cols={[
              { key: 'concept_key', label: 'Key', type: 'readonly' },
              { key: 'concept_type', label: 'Type', type: 'readonly' },
              { key: 'label', label: 'Label', editable: true, type: 'text' },
              { key: 'icon', label: 'Icon', editable: true, type: 'text' },
              { key: 'display_order', label: 'Order', editable: true, type: 'text' },
              { key: 'kbd_shortcut', label: 'KBD', editable: true, type: 'text' },
              { key: 'is_foreign_key', label: 'FK', editable: true, type: 'bool' },
            ]}
          />
        );
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'tag_groups',  label: 'Tag Groups' },
    { key: 'tags',        label: 'Tags' },
    { key: 'task_status', label: 'Task Status' },
    { key: 'defaults',    label: 'Defaults' },
    { key: 'field_meta',  label: 'Field Metadata' },
    { key: 'list_config', label: 'List Config' },
    { key: 'concepts',    label: 'Concepts' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', fontFamily: 'monospace', color: '#ccc' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.25rem', height: '44px', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <a href="/workspace" style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>KarlOps</a>
          <span style={{ color: '#444', fontSize: '0.7rem' }}>|</span>
          <span style={{ color: '#aaa', fontSize: '0.7rem' }}>Admin</span>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d', paddingLeft: '1.25rem', overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ background: 'none', border: 'none', borderBottom: tab === t.key ? '2px solid #4ade80' : '2px solid transparent', color: tab === t.key ? '#4ade80' : '#555', padding: '0.6rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >{t.label}</button>
        ))}
      </div>

      <div style={{ padding: '1.25rem' }}>
        {loading && <div style={{ color: '#444', fontSize: '0.75rem' }}>Loading...</div>}
        {error && <div style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: '1rem' }}>{error}</div>}
        {!loading && tabContent()}
      </div>
    </div>
  );
}