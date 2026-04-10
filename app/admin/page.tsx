'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

type Tab = 'tag_groups' | 'tags' | 'task_status' | 'defaults' | 'field_meta' | 'list_config' | 'concepts';
interface Row { [key: string]: any; }
interface FieldMeta {
  field: string;
  label: string;
  field_type: string;
  insert_behavior: 'required' | 'optional' | 'automatic';
  update_behavior: 'editable' | 'readonly' | 'automatic';
  display_order: number;
  fk_table: string | null;
  fk_label: string | null;
}
interface FKMap { [field: string]: { options: { value: string; label: string }[]; resolve: (v: any) => string } }

const TAB_CONFIG: Record<string, { table: string; label: string; idField: string; metaKey: string }> = {
  tag_groups:  { table: 'tag_group',           label: 'Tag Groups',    idField: 'tag_group_id',           metaKey: 'tag_group' },
  tags:        { table: 'tag',                 label: 'Tags',          idField: 'tag_id',                 metaKey: 'tag' },
  task_status: { table: 'task_status',         label: 'Task Status',   idField: 'task_status_id',         metaKey: 'task_status' },
  defaults:    { table: 'ko_default_registry', label: 'Defaults',      idField: 'ko_default_registry_id', metaKey: 'ko_default_registry' },
  field_meta:  { table: 'ko_field_metadata',   label: 'Field Metadata',idField: 'ko_field_metadata_id',   metaKey: 'ko_field_metadata' },
  list_config: { table: 'ko_list_view_config', label: 'List Config',   idField: 'ko_list_view_config_id', metaKey: 'ko_list_view_config' },
  concepts:    { table: 'concept_registry',    label: 'Concepts',      idField: 'concept_registry_id',    metaKey: 'concept_registry' },
};

const ALLOWED_TABLES = ['tag', 'tag_group', 'task_status', 'ko_default_registry', 'ko_field_metadata', 'ko_list_view_config', 'concept_registry', 'context', 'task_status'];

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

// ─── FK loader ────────────────────────────────────────────────────────────────

async function loadFKMaps(token: string, fields: FieldMeta[]): Promise<FKMap> {
  const fkFields = fields.filter(f => f.fk_table && f.fk_label);
  const uniqueTables = Array.from(new Set(fkFields.map(f => f.fk_table!)));

  const tableData: Record<string, Row[]> = {};
  await Promise.all(
    uniqueTables.map(async t => {
      try {
        // FK tables may not be in ALLOWED_TABLES — fetch via supabase client directly
        const res = await fetch(`/api/ko/admin?table=${t}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (json.data) tableData[t] = json.data;
      } catch {}
    })
  );

  const fkMap: FKMap = {};
  for (const f of fkFields) {
    if (!f.fk_table || !f.fk_label) continue;
    const rows = tableData[f.fk_table] ?? [];
    // Find PK field — assume it ends with _id
    const pkField = Object.keys(rows[0] ?? {}).find(k => k.endsWith('_id') && k !== 'user_id') ?? 'id';
    const options = rows.map(r => ({ value: r[pkField], label: r[f.fk_label!] ?? r[pkField] }));
    fkMap[f.field] = {
      options,
      resolve: (v: any) => options.find(o => o.value === v)?.label ?? v ?? '—',
    };
  }
  return fkMap;
}

// ─── Cells ────────────────────────────────────────────────────────────────────

function EditCell({ value, fieldType, onSave }: { value: any; fieldType: string; onSave: (v: any) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const commit = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true); setErr('');
    try { await onSave(draft); setEditing(false); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const cancel = () => { setDraft(value); setEditing(false); setErr(''); };

  if (fieldType === 'boolean') {
    return (
      <input type="checkbox" checked={!!draft}
        onChange={async e => {
          setDraft(e.target.checked);
          try { await onSave(e.target.checked); }
          catch (e: any) { setErr(e.message); }
        }}
        style={{ cursor: 'pointer', accentColor: '#4ade80' }}
      />
    );
  }

  if (!editing) {
    return (
      <div onClick={() => setEditing(true)}
        style={{ cursor: 'text', color: '#ccc', fontSize: '0.75rem', padding: '0.15rem 0.4rem', borderRadius: '3px', minHeight: '1.3rem', wordBreak: 'break-word' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#1a1a1a')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {value === null || value === undefined || value === ''
          ? <span style={{ color: '#333' }}>—</span>
          : typeof value === 'boolean'
          ? <span style={{ color: value ? '#4ade80' : '#555' }}>{value ? 'yes' : 'no'}</span>
          : String(value)
        }
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <input autoFocus value={draft ?? ''}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
        style={{ background: '#1a1a1a', border: '1px solid #444', color: '#e5e5e5', padding: '0.2rem 0.4rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '100px' }}
      />
      <div style={{ display: 'flex', gap: '0.35rem' }}>
        <button onClick={commit} disabled={saving}
          style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.1rem 0.5rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer' }}
        >{saving ? '...' : '✓'}</button>
        <button onClick={cancel}
          style={{ background: 'none', border: '1px solid #333', color: '#666', padding: '0.1rem 0.5rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.65rem', cursor: 'pointer' }}
        >✕</button>
      </div>
      {err && <span style={{ color: '#ef4444', fontSize: '0.65rem' }}>{err}</span>}
    </div>
  );
}

function FKCell({ value, options, onSave }: { value: any; options: { value: string; label: string }[]; onSave: (v: any) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleChange = async (v: string) => {
    setSaving(true); setErr('');
    try { await onSave(v); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <select value={value ?? ''} onChange={e => handleChange(e.target.value)} disabled={saving}
        style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.2rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer' }}
      >
        <option value="">—</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {err && <div style={{ color: '#ef4444', fontSize: '0.65rem' }}>{err}</div>}
    </div>
  );
}

function SelectCell({ value, options, onSave }: { value: any; options: string[]; onSave: (v: any) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleChange = async (v: string) => {
    setSaving(true); setErr('');
    try { await onSave(v); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <select value={value ?? ''} onChange={e => handleChange(e.target.value)} disabled={saving}
        style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.2rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer' }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      {err && <div style={{ color: '#ef4444', fontSize: '0.65rem' }}>{err}</div>}
    </div>
  );
}

function ReadCell({ value, fieldType }: { value: any; fieldType: string }) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: '#333', fontSize: '0.75rem' }}>—</span>;
  }
  if (fieldType === 'boolean') {
    return <span style={{ color: value ? '#4ade80' : '#555', fontSize: '0.75rem' }}>{value ? 'yes' : 'no'}</span>;
  }
  if (fieldType === 'jsonb') {
    return <span style={{ color: '#666', fontSize: '0.7rem', fontFamily: 'monospace' }}>{JSON.stringify(value).substring(0, 60)}…</span>;
  }
  return <span style={{ color: '#555', fontSize: '0.75rem', wordBreak: 'break-word' }}>{String(value)}</span>;
}

// ─── Metadata-driven Table ────────────────────────────────────────────────────

function MetaTable({ rows, fields, idField, token, table, onRefresh, addForm, fkMap, filterNode }: {
  rows: Row[];
  fields: FieldMeta[];
  idField: string;
  token: string;
  table: string;
  onRefresh: () => void;
  addForm?: React.ReactNode;
  fkMap: FKMap;
  filterNode?: React.ReactNode;
}) {
  const [err, setErr] = useState('');
  const visibleFields = fields
    .filter(f => f.display_order < 999)
    .sort((a, b) => a.display_order - b.display_order);

  const handleSave = async (id: any, field: string, value: any) => {
    try { await adminPatch(token, table, idField, id, { [field]: value }); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  };

  const handleDelete = async (id: any) => {
    if (!confirm('Delete this record?')) return;
    try { await adminDelete(token, table, idField, id); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  };

  const behaviorBadge = (insert: string, update: string) => {
    const ibColor = insert === 'required' ? '#ef4444' : insert === 'optional' ? '#f97316' : '#333';
    const ubColor = update === 'editable' ? '#4ade80' : update === 'readonly' ? '#555' : '#333';
    return (
      <span style={{ display: 'inline-flex', gap: '0.2rem', marginLeft: '0.3rem' }}>
        <span style={{ fontSize: '0.55rem', color: ibColor, border: `1px solid ${ibColor}`, borderRadius: '2px', padding: '0 0.2rem' }}>{insert[0].toUpperCase()}</span>
        <span style={{ fontSize: '0.55rem', color: ubColor, border: `1px solid ${ubColor}`, borderRadius: '2px', padding: '0 0.2rem' }}>{update[0].toUpperCase()}</span>
      </span>
    );
  };

  const renderCell = (row: Row, f: FieldMeta) => {
    const rawVal = row[f.field];
    const fk = fkMap[f.field];

    if (f.update_behavior === 'editable') {
      if (fk) {
        return <FKCell value={rawVal} options={fk.options} onSave={v => handleSave(row[idField], f.field, v)} />;
      }
      return <EditCell value={rawVal} fieldType={f.field_type} onSave={v => handleSave(row[idField], f.field, v)} />;
    }

    // Readonly — resolve FK for display
    const displayVal = fk ? fk.resolve(rawVal) : rawVal;
    return <ReadCell value={displayVal} fieldType={f.field_type} />;
  };

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      {filterNode && <div style={{ marginBottom: '1rem' }}>{filterNode}</div>}
      {addForm && <div style={{ marginBottom: '1rem' }}>{addForm}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              {visibleFields.map(f => (
                <th key={f.field} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>
                  {f.label}
                  {behaviorBadge(f.insert_behavior, f.update_behavior)}
                </th>
              ))}
              <th style={{ width: '32px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={visibleFields.length + 1} style={{ color: '#333', padding: '1rem 0.5rem', fontSize: '0.75rem' }}>No records</td></tr>
            )}
            {rows.map(row => (
              <tr key={row[idField]} style={{ borderBottom: '1px solid #0f0f0f' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {visibleFields.map(f => (
                  <td key={f.field} style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                    {renderCell(row, f)}
                  </td>
                ))}
                <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right', verticalAlign: 'top' }}>
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

// ─── Metadata-driven Add Form ─────────────────────────────────────────────────

function MetaAddForm({ fields, onAdd, fkMap }: {
  fields: FieldMeta[];
  onAdd: (record: Row) => Promise<void>;
  fkMap: FKMap;
}) {
  const addFields = fields
    .filter(f => f.insert_behavior !== 'automatic' && f.display_order < 999)
    .sort((a, b) => a.display_order - b.display_order);

  const empty = Object.fromEntries(addFields.map(f => [f.field, f.field_type === 'boolean' ? false : '']));
  const [draft, setDraft] = useState<Row>(empty);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleAdd = async () => {
    const missing = addFields.filter(f => f.insert_behavior === 'required' && !draft[f.field] && draft[f.field] !== false);
    if (missing.length > 0) { setErr(`Required: ${missing.map(f => f.label).join(', ')}`); return; }
    setSaving(true); setErr('');
    try { await onAdd(draft); setDraft(empty); }
    catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const renderInput = (f: FieldMeta) => {
    const fk = fkMap[f.field];
    if (fk) {
      return (
        <select value={draft[f.field] ?? ''}
          onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
          style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '140px' }}
        >
          <option value="">— select —</option>
          {fk.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (f.field_type === 'boolean') {
      return (
        <input type="checkbox" checked={!!draft[f.field]}
          onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.checked }))}
          style={{ accentColor: '#4ade80' }}
        />
      );
    }
    return (
      <input value={draft[f.field] ?? ''}
        onChange={e => setDraft(d => ({ ...d, [f.field]: e.target.value }))}
        style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', width: '140px' }}
      />
    );
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', padding: '0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '6px' }}>
      {addFields.map(f => (
        <div key={f.field}>
          <div style={{ color: f.insert_behavior === 'required' ? '#aaa' : '#555', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {f.label}{f.insert_behavior === 'required' && <span style={{ color: '#ef4444' }}>*</span>}
          </div>
          {renderInput(f)}
        </div>
      ))}
      <button onClick={handleAdd} disabled={saving}
        style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.35rem 0.75rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', height: '30px' }}
      >{saving ? '...' : '+ Add'}</button>
      {err && <span style={{ color: '#ef4444', fontSize: '0.72rem' }}>{err}</span>}
    </div>
  );
}

// ─── Hardcoded Field Meta Tab ─────────────────────────────────────────────────

function FieldMetaTab({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try { setRows(await adminFetch(token, 'ko_field_metadata')); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const objectTypes = Array.from(new Set(rows.map(r => r.object_type))).sort();
  const filtered = filter ? rows.filter(r => r.object_type === filter) : rows;
  const sorted = [...filtered].sort((a, b) => a.display_order - b.display_order);

  const COLS: { key: string; label: string; editable: boolean; type: string; options: string[] }[] = [
    { key: 'object_type',     label: 'Object',  editable: false, type: 'text',   options: [] },
    { key: 'field',           label: 'Field',   editable: false, type: 'text',   options: [] },
    { key: 'field_type',      label: 'Type',    editable: true,  type: 'text',   options: [] },
    { key: 'label',           label: 'Label',   editable: true,  type: 'text',   options: [] },
    { key: 'insert_behavior', label: 'Insert',  editable: true,  type: 'select', options: ['required', 'optional', 'automatic'] },
    { key: 'update_behavior', label: 'Update',  editable: true,  type: 'select', options: ['editable', 'readonly', 'automatic'] },
    { key: 'fk_table',        label: 'FK Table',editable: true,  type: 'text',   options: [] },
    { key: 'fk_label',        label: 'FK Label',editable: true,  type: 'text',   options: [] },
    { key: 'display_order',   label: 'Order',   editable: true,  type: 'text',   options: [] },
  ];

  const handleSave = async (id: any, field: string, value: any) => {
    await adminPatch(token, 'ko_field_metadata', 'ko_field_metadata_id', id, { [field]: value });
    load();
  };

  const handleDelete = async (id: any) => {
    if (!confirm('Delete this field metadata?')) return;
    await adminDelete(token, 'ko_field_metadata', 'ko_field_metadata_id', id);
    load();
  };

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <span style={{ color: '#555', fontSize: '0.7rem' }}>Filter:</span>
        <select value={filter} onChange={e => setFilter(e.target.value)}
          style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.3rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}
        >
          <option value="">All</option>
          {objectTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: '#333', fontSize: '0.7rem' }}>{sorted.length} rows</span>
        <span style={{ color: '#444', fontSize: '0.65rem', marginLeft: 'auto' }}>
          insert: <span style={{ color: '#ef4444' }}>required</span> · <span style={{ color: '#f97316' }}>optional</span> · <span style={{ color: '#333' }}>automatic</span>
          &nbsp;&nbsp;update: <span style={{ color: '#4ade80' }}>editable</span> · <span style={{ color: '#555' }}>readonly</span> · <span style={{ color: '#333' }}>automatic</span>
        </span>
      </div>
      {loading ? <div style={{ color: '#444', fontSize: '0.75rem' }}>Loading...</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr>
                {COLS.map(c => (
                  <th key={c.key} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>{c.label}</th>
                ))}
                <th style={{ width: '32px' }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <tr key={row.ko_field_metadata_id} style={{ borderBottom: '1px solid #0f0f0f' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {COLS.map(c => (
                    <td key={c.key} style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                      {c.editable
                        ? c.type === 'select'
                          ? <SelectCell value={row[c.key]} options={c.options} onSave={v => handleSave(row.ko_field_metadata_id, c.key, v)} />
                          : <EditCell value={row[c.key]} fieldType={c.type} onSave={v => handleSave(row.ko_field_metadata_id, c.key, v)} />
                        : <ReadCell value={row[c.key]} fieldType={c.type} />
                      }
                    </td>
                  ))}
                  <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right', verticalAlign: 'top' }}>
                    <button onClick={() => handleDelete(row.ko_field_metadata_id)}
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
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [tab, setTab] = useState<Tab>('tags');
  const [rows, setRows] = useState<Row[]>([]);
  const [fields, setFields] = useState<FieldMeta[]>([]);
  const [fkMap, setFkMap] = useState<FKMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tagGroupFilter, setTagGroupFilter] = useState('');
  const [tagGroups, setTagGroups] = useState<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { window.location.href = '/login'; return; }
      setToken(session.access_token);
    });
  }, []);

  const loadTab = useCallback(async (t: Tab) => {
    if (!token || t === 'field_meta') return;
    setLoading(true); setError(''); setTagGroupFilter('');
    try {
      const cfg = TAB_CONFIG[t];
      const [rowData, allMeta] = await Promise.all([
        adminFetch(token, cfg.table),
        adminFetch(token, 'ko_field_metadata'),
      ]);
      const tabFields = (allMeta.filter(f => f.object_type === cfg.metaKey) as unknown as FieldMeta[])
        .sort((a, b) => a.display_order - b.display_order);

      const fks = await loadFKMaps(token, tabFields);

      setRows(rowData);
      setFields(tabFields);
      setFkMap(fks);

      // Keep tag groups handy for filter
      if (t === 'tags' && fks['tag_group_id']) {
        setTagGroups(fks['tag_group_id'].options.map(o => ({ tag_group_id: o.value, name: o.label })));
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { if (token) loadTab(tab); }, [token, tab]);

  const cfg = TAB_CONFIG[tab];

  const filteredRows = tab === 'tags' && tagGroupFilter
    ? rows.filter(r => r.tag_group_id === tagGroupFilter)
    : rows;

  const tabContent = () => {
    if (tab === 'field_meta') return <FieldMetaTab token={token} />;

    const filterNode = tab === 'tags' ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ color: '#555', fontSize: '0.7rem' }}>Group:</span>
        <select value={tagGroupFilter} onChange={e => setTagGroupFilter(e.target.value)}
          style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.3rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}
        >
          <option value="">All</option>
          {tagGroups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
        </select>
        <span style={{ color: '#333', fontSize: '0.7rem' }}>{filteredRows.length} tags</span>
      </div>
    ) : undefined;

    const canAdd = ['tag_groups', 'tags', 'task_status'].includes(tab);

    return (
      <MetaTable
        rows={filteredRows}
        fields={fields}
        idField={cfg.idField}
        token={token}
        table={cfg.table}
        onRefresh={() => loadTab(tab)}
        fkMap={fkMap}
        filterNode={filterNode}
        addForm={canAdd
          ? <MetaAddForm fields={fields} onAdd={r => adminPost(token, cfg.table, r).then(() => loadTab(tab))} fkMap={fkMap} />
          : undefined
        }
      />
    );
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

      <div style={{ display: 'flex', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d', paddingLeft: '1.25rem', overflowX: 'auto' }}>
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