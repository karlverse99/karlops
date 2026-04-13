'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

type Tab = 'tag_groups' | 'tags' | 'task_status' | 'defaults' | 'field_meta' | 'list_config' | 'concepts' | 'contexts' | 'situations';
interface Row { [key: string]: any; }
interface FieldMeta {
  object_type: string;
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
  contexts:    { table: 'context',             label: 'Contexts',      idField: 'context_id',             metaKey: 'context' },
  situations:  { table: 'user_situation',      label: 'My Situation',  idField: 'user_situation_id',      metaKey: 'user_situation' },
};

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

  return (
    <div>
      <select value={value ?? ''} onChange={async e => {
        setSaving(true);
        try { await onSave(e.target.value); }
        catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
      }} disabled={saving}
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

  return (
    <div>
      <select value={value ?? ''} onChange={async e => {
        setSaving(true);
        try { await onSave(e.target.value); }
        catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
      }} disabled={saving}
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

// ─── Contexts Tab — custom, supports hide/show + delete ───────────────────────

function ContextsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Load ALL contexts (including hidden) so admin can see and restore them
      const data = await adminFetch(token, 'context');
      // Sort: visible first, then hidden, then archived; alpha within each group
      const sorted = [...data].sort((a, b) => {
        if (a.is_archived !== b.is_archived) return a.is_archived ? 1 : -1;
        if (a.is_visible !== b.is_visible) return a.is_visible ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setRows(sorted);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleToggleVisible = async (row: Row) => {
    try {
      await adminPatch(token, 'context', 'context_id', row.context_id, { is_visible: !row.is_visible });
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const handleDelete = async (row: Row) => {
    if (!confirm(`Delete context "${row.name}"? This cannot be undone.`)) return;
    try {
      await adminDelete(token, 'context', 'context_id', row.context_id);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const handleAdd = async () => {
    if (!newName.trim()) { setAddErr('Name is required'); return; }
    setAdding(true); setAddErr('');
    try {
      await adminPost(token, 'context', { name: newName.trim(), description: newDesc.trim() || null });
      setNewName(''); setNewDesc('');
      load();
    } catch (e: any) { setAddErr(e.message); }
    finally { setAdding(false); }
  };

  const handleNameSave = async (id: string, name: string) => {
    await adminPatch(token, 'context', 'context_id', id, { name });
    load();
  };

  const visibleCount  = rows.filter(r => !r.is_archived && r.is_visible).length;
  const hiddenCount   = rows.filter(r => !r.is_archived && !r.is_visible).length;
  const archivedCount = rows.filter(r => r.is_archived).length;

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}

      {/* Add form */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', padding: '0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '6px', marginBottom: '1rem' }}>
        <div>
          <div style={{ color: '#aaa', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name<span style={{ color: '#ef4444' }}>*</span></div>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Work, Personal..."
            style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', width: '160px' }}
          />
        </div>
        <div>
          <div style={{ color: '#555', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</div>
          <input
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Optional"
            style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', width: '200px' }}
          />
        </div>
        <button onClick={handleAdd} disabled={adding}
          style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.35rem 0.75rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', height: '30px' }}
        >{adding ? '...' : '+ Add'}</button>
        {addErr && <span style={{ color: '#ef4444', fontSize: '0.72rem' }}>{addErr}</span>}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem', fontSize: '0.65rem', color: '#444' }}>
        <span><span style={{ color: '#4ade80' }}>●</span> visible ({visibleCount})</span>
        <span><span style={{ color: '#555' }}>●</span> hidden ({hiddenCount})</span>
        {archivedCount > 0 && <span><span style={{ color: '#333' }}>●</span> archived ({archivedCount})</span>}
        <span style={{ marginLeft: 'auto', color: '#333' }}>👁 = toggle navbar visibility · ✕ = permanent delete</span>
      </div>

      {loading ? <div style={{ color: '#444', fontSize: '0.75rem' }}>Loading...</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              {['Name', 'Description', 'Visible', 'Archived', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ color: '#333', padding: '1rem 0.5rem' }}>No contexts</td></tr>
            )}
            {rows.map(row => {
              const isHidden   = !row.is_visible && !row.is_archived;
              const isArchived = row.is_archived;
              const rowOpacity = isArchived ? 0.35 : isHidden ? 0.6 : 1;

              return (
                <tr key={row.context_id}
                  style={{ borderBottom: '1px solid #0f0f0f', opacity: rowOpacity }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Name — editable */}
                  <td style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                    <EditCell
                      value={row.name}
                      fieldType="text"
                      onSave={v => handleNameSave(row.context_id, v)}
                    />
                  </td>

                  {/* Description — editable */}
                  <td style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                    <EditCell
                      value={row.description}
                      fieldType="text"
                      onSave={v => adminPatch(token, 'context', 'context_id', row.context_id, { description: v }).then(load)}
                    />
                  </td>

                  {/* is_visible badge + toggle */}
                  <td style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                    <button
                      onClick={() => !isArchived && handleToggleVisible(row)}
                      disabled={isArchived}
                      title={isArchived ? 'Archived — restore first' : row.is_visible ? 'Hide from navbar' : 'Show in navbar'}
                      style={{
                        background: 'none',
                        border: `1px solid ${row.is_visible && !isArchived ? '#2a4a2a' : '#2a2a2a'}`,
                        color: row.is_visible && !isArchived ? '#4ade80' : '#444',
                        padding: '0.15rem 0.5rem',
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                        fontSize: '0.65rem',
                        cursor: isArchived ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => { if (!isArchived) e.currentTarget.style.borderColor = '#555'; }}
                      onMouseLeave={e => { if (!isArchived) e.currentTarget.style.borderColor = row.is_visible ? '#2a4a2a' : '#2a2a2a'; }}
                    >
                      {row.is_visible ? '👁 shown' : '👁 hidden'}
                    </button>
                  </td>

                  {/* is_archived — read only display */}
                  <td style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>
                    <ReadCell value={row.is_archived} fieldType="boolean" />
                  </td>

                  {/* Actions: delete */}
                  <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right', verticalAlign: 'top' }}>
                    <button
                      onClick={() => handleDelete(row)}
                      title="Permanently delete"
                      style={{ background: 'none', border: 'none', color: '#2a2a2a', cursor: 'pointer', fontSize: '0.72rem' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#2a2a2a')}
                    >✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Metadata-driven Table ────────────────────────────────────────────────────

function MetaTable({ rows, fields, idField, token, table, onRefresh, addForm, fkMap, filterNode, readOnly }: {
  rows: Row[];
  fields: FieldMeta[];
  idField: string;
  token: string;
  table: string;
  onRefresh: () => void;
  addForm?: React.ReactNode;
  fkMap: FKMap;
  filterNode?: React.ReactNode;
  readOnly?: boolean;
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

    if (!readOnly && f.update_behavior === 'editable') {
      if (fk) return <FKCell value={rawVal} options={fk.options} onSave={v => handleSave(row[idField], f.field, v)} />;
      return <EditCell value={rawVal} fieldType={f.field_type} onSave={v => handleSave(row[idField], f.field, v)} />;
    }

    const displayVal = fk ? fk.resolve(rawVal) : rawVal;
    return <ReadCell value={displayVal} fieldType={f.field_type} />;
  };

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      {readOnly && (
        <div style={{ color: '#444', fontSize: '0.7rem', marginBottom: '0.75rem', padding: '0.4rem 0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '4px' }}>
          🔒 System table — read only. Managed by KarlOps admin.
        </div>
      )}
      {filterNode && <div style={{ marginBottom: '1rem' }}>{filterNode}</div>}
      {addForm && <div style={{ marginBottom: '1rem' }}>{addForm}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              {visibleFields.map(f => (
                <th key={f.field} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>
                  {f.label}
                  {!readOnly && behaviorBadge(f.insert_behavior, f.update_behavior)}
                </th>
              ))}
              {!readOnly && <th style={{ width: '32px' }} />}
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
                {!readOnly && (
                  <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right', verticalAlign: 'top' }}>
                    <button onClick={() => handleDelete(row[idField])}
                      style={{ background: 'none', border: 'none', color: '#2a2a2a', cursor: 'pointer', fontSize: '0.72rem' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#2a2a2a')}
                    >✕</button>
                  </td>
                )}
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

// ─── Defaults Add Form ────────────────────────────────────────────────────────

function DefaultsAddForm({ token, onRefresh }: { token: string; onRefresh: () => void }) {
  const [allMeta, setAllMeta] = useState<FieldMeta[]>([]);
  const [objectType, setObjectType] = useState('');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [fkOptions, setFkOptions] = useState<{ value: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminFetch(token, 'ko_field_metadata').then(d => setAllMeta(d as unknown as FieldMeta[])).catch(() => {});
  }, [token]);

  const objectTypes = Array.from(new Set(allMeta.map(f => f.object_type))).sort();
  const fieldOptions = allMeta
    .filter(f => f.object_type === objectType && f.insert_behavior !== 'automatic')
    .sort((a, b) => a.display_order - b.display_order);

  const selectedField = allMeta.find(f => f.object_type === objectType && f.field === field);

  useEffect(() => {
    setValue('');
    setFkOptions([]);
    if (!selectedField?.fk_table || !selectedField?.fk_label) return;
    adminFetch(token, selectedField.fk_table).then(rows => {
      const pkField = Object.keys(rows[0] ?? {}).find(k => k.endsWith('_id') && k !== 'user_id') ?? 'id';
      setFkOptions(rows.map(r => ({ value: r[pkField], label: r[selectedField.fk_label!] })));
    }).catch(() => {});
  }, [field, objectType]);

  const handleAdd = async () => {
    if (!objectType || !field || !value) { setErr('All fields required'); return; }
    setSaving(true); setErr('');
    try {
      await adminPost(token, 'ko_default_registry', { object_type: objectType, field, value });
      setObjectType(''); setField(''); setValue('');
      onRefresh();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', padding: '0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '6px' }}>
      <div>
        <div style={{ color: '#aaa', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Object<span style={{ color: '#ef4444' }}>*</span></div>
        <select value={objectType} onChange={e => { setObjectType(e.target.value); setField(''); setValue(''); }}
          style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '140px' }}
        >
          <option value="">— select —</option>
          {objectTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: '#aaa', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Field<span style={{ color: '#ef4444' }}>*</span></div>
        <select value={field} onChange={e => setField(e.target.value)} disabled={!objectType}
          style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '140px' }}
        >
          <option value="">— select —</option>
          {fieldOptions.map(f => <option key={f.field} value={f.field}>{f.label}</option>)}
        </select>
      </div>
      <div>
        <div style={{ color: '#aaa', fontSize: '0.63rem', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Value<span style={{ color: '#ef4444' }}>*</span></div>
        {fkOptions.length > 0 ? (
          <select value={value} onChange={e => setValue(e.target.value)}
            style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', minWidth: '140px' }}
          >
            <option value="">— select —</option>
            {fkOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input value={value} onChange={e => setValue(e.target.value)} disabled={!field}
            style={{ background: '#111', border: '1px solid #222', color: '#e5e5e5', padding: '0.35rem 0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', width: '140px' }}
          />
        )}
      </div>
      <button onClick={handleAdd} disabled={saving}
        style={{ background: '#1a2a1a', border: '1px solid #2a4a2a', color: '#4ade80', padding: '0.35rem 0.75rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', height: '30px' }}
      >{saving ? '...' : '+ Add'}</button>
      {err && <span style={{ color: '#ef4444', fontSize: '0.72rem' }}>{err}</span>}
    </div>
  );
}

// ─── Defaults Table ───────────────────────────────────────────────────────────

function DefaultsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [allMeta, setAllMeta] = useState<FieldMeta[]>([]);
  const [fkCache, setFkCache] = useState<Record<string, { value: string; label: string }[]>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meta] = await Promise.all([
        adminFetch(token, 'ko_default_registry'),
        adminFetch(token, 'ko_field_metadata'),
      ]);
      setRows(data);
      setAllMeta(meta as unknown as FieldMeta[]);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const fkFields = allMeta.filter(f => f.fk_table && f.fk_label);
    const uniqueTables = Array.from(new Set(fkFields.map(f => f.fk_table!)));
    uniqueTables.forEach(async t => {
      if (fkCache[t]) return;
      try {
        const data = await adminFetch(token, t);
        const pkField = Object.keys(data[0] ?? {}).find(k => k.endsWith('_id') && k !== 'user_id') ?? 'id';
        const fkMeta = fkFields.find(f => f.fk_table === t);
        if (!fkMeta?.fk_label) return;
        setFkCache(c => ({ ...c, [t]: data.map(r => ({ value: r[pkField], label: r[fkMeta.fk_label!] })) }));
      } catch {}
    });
  }, [allMeta]);

  const resolveValue = (row: Row) => {
    const meta = allMeta.find(f => f.object_type === row.object_type && f.field === row.field);
    if (!meta?.fk_table) return row.value;
    const options = fkCache[meta.fk_table] ?? [];
    return options.find(o => o.value === row.value)?.label ?? row.value;
  };

  const handleDelete = async (id: any) => {
    if (!confirm('Delete this default?')) return;
    try { await adminDelete(token, 'ko_default_registry', 'ko_default_registry_id', id); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const handleValueSave = async (row: Row, newVal: string) => {
    await adminPatch(token, 'ko_default_registry', 'ko_default_registry_id', row.ko_default_registry_id, { value: newVal });
    load();
  };

  const getValueEditor = (row: Row) => {
    const meta = allMeta.find(f => f.object_type === row.object_type && f.field === row.field);
    if (meta?.fk_table) {
      const options = fkCache[meta.fk_table] ?? [];
      return <FKCell value={row.value} options={options} onSave={v => handleValueSave(row, v)} />;
    }
    return <EditCell value={row.value} fieldType="text" onSave={v => handleValueSave(row, v)} />;
  };

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      <div style={{ marginBottom: '1rem' }}>
        <DefaultsAddForm token={token} onRefresh={load} />
      </div>
      {loading ? <div style={{ color: '#444', fontSize: '0.75rem' }}>Loading...</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr>
                {['Object Type', 'Field', 'Value'].map(h => (
                  <th key={h} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', fontSize: '0.7rem' }}>{h}</th>
                ))}
                <th style={{ width: '32px' }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} style={{ color: '#333', padding: '1rem 0.5rem', fontSize: '0.75rem' }}>No records</td></tr>
              )}
              {rows.map(row => (
                <tr key={row.ko_default_registry_id} style={{ borderBottom: '1px solid #0f0f0f' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '0.2rem 0.5rem' }}><ReadCell value={row.object_type} fieldType="text" /></td>
                  <td style={{ padding: '0.2rem 0.5rem' }}><ReadCell value={row.field} fieldType="text" /></td>
                  <td style={{ padding: '0.2rem 0.5rem', verticalAlign: 'top' }}>{getValueEditor(row)}</td>
                  <td style={{ padding: '0.2rem 0.5rem', textAlign: 'right' }}>
                    <button onClick={() => handleDelete(row.ko_default_registry_id)}
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
    { key: 'object_type',     label: 'Object',   editable: false, type: 'text',   options: [] },
    { key: 'field',           label: 'Field',    editable: false, type: 'text',   options: [] },
    { key: 'field_type',      label: 'Type',     editable: true,  type: 'text',   options: [] },
    { key: 'label',           label: 'Label',    editable: true,  type: 'text',   options: [] },
    { key: 'insert_behavior', label: 'Insert',   editable: true,  type: 'select', options: ['required', 'optional', 'automatic'] },
    { key: 'update_behavior', label: 'Update',   editable: true,  type: 'select', options: ['editable', 'readonly', 'automatic'] },
    { key: 'fk_table',        label: 'FK Table', editable: true,  type: 'text',   options: [] },
    { key: 'fk_label',        label: 'FK Label', editable: true,  type: 'text',   options: [] },
    { key: 'display_order',   label: 'Order',    editable: true,  type: 'text',   options: [] },
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

// ─── Concepts Tab — read-only system table ────────────────────────────────────

function ConceptsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try { setRows(await adminFetch(token, 'concept_registry')); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const COLS = ['concept_key', 'concept_type', 'implementation_type', 'label', 'icon', 'display_order', 'kbd_shortcut'];

  return (
    <div>
      {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{err}</div>}
      <div style={{ color: '#444', fontSize: '0.7rem', marginBottom: '0.75rem', padding: '0.4rem 0.75rem', background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '4px' }}>
        🔒 System table — read only. Managed by KarlOps admin via SQL.
      </div>
      {loading ? <div style={{ color: '#444', fontSize: '0.75rem' }}>Loading...</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr>
                {COLS.map(c => (
                  <th key={c} style={{ textAlign: 'left', color: '#555', fontWeight: 600, padding: '0.3rem 0.5rem', borderBottom: '1px solid #1a1a1a', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.concept_registry_id} style={{ borderBottom: '1px solid #0f0f0f' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0d0d0d')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {COLS.map(c => (
                    <td key={c} style={{ padding: '0.2rem 0.5rem' }}>
                      <ReadCell value={row[c]} fieldType="text" />
                    </td>
                  ))}
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
    if (!token || t === 'field_meta' || t === 'defaults' || t === 'concepts' || t === 'contexts') return;
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
    if (tab === 'defaults')   return <DefaultsTab token={token} />;
    if (tab === 'concepts')   return <ConceptsTab token={token} />;
    if (tab === 'contexts')   return <ContextsTab token={token} />;

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

    const canAdd = ['tag_groups', 'tags', 'task_status', 'situations'].includes(tab);

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
    { key: 'contexts',    label: 'Contexts' },
    { key: 'task_status', label: 'Task Status' },
    { key: 'situations',  label: 'My Situation' },
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
