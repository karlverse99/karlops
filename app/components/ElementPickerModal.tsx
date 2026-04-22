'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface FieldMeta {
  field_metadata_id: string;
  object_type: string;
  field: string;
  label: string;
  field_type: string;
  description: string | null;
  llm_notes: string | null;
  insert_behavior: string;
  update_behavior: string;
  display_order: number;
}

interface ElementPickerModalProps {
  userId: string;
  accessToken: string;
  templateId: string;
  currentElements: string[];           // "object_type.field" strings
  onSave: (elements: string[]) => void;
  onClose: () => void;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

// Object types that make sense as data sources for documents
const ALLOWED_OBJECT_TYPES = ['task', 'completion', 'meeting', 'contact', 'user_situation'];

// Fields that are not useful as user-facing selectors (internal, automatic, etc.)
const EXCLUDED_FIELDS = [
  'user_id', 'created_at', 'updated_at', 'is_archived', 'is_completed',
  'is_active', 'sort_order', 'task_status_id', 'context_id_raw',
];

// Human-readable object type labels
const OBJECT_TYPE_LABELS: Record<string, string> = {
  task:             'Tasks',
  completion:       'Completions',
  meeting:          'Meetings',
  contact:          'Contacts',
  user_situation:   'Situation',
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ElementPickerModal({
  userId, accessToken, templateId, currentElements, onSave, onClose,
}: ElementPickerModalProps) {

  const [fields, setFields]       = useState<FieldMeta[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [objFilter, setObjFilter] = useState<string>('all');
  const [selected, setSelected]   = useState<Set<string>>(new Set(currentElements));
  const [saving, setSaving]       = useState(false);
  const [saveErr, setSaveErr]     = useState('');

  // Modal drag
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 380));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 320));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const dragging        = useRef(false);
  const dragStart       = useRef({ x: 0, y: 0, px: 0, py: 0 });

  useEffect(() => {
    loadFields();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.x), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.y) });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  const loadFields = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('ko_field_metadata')
        .select('field_metadata_id, object_type, field, label, field_type, description, llm_notes, insert_behavior, update_behavior, display_order')
        .eq('user_id', userId)
        .in('object_type', ALLOWED_OBJECT_TYPES)
        .lt('display_order', 999)
        .order('object_type')
        .order('display_order');

      const filtered = (data ?? []).filter((f: FieldMeta) =>
        !EXCLUDED_FIELDS.includes(f.field) &&
        f.update_behavior !== 'automatic' // skip fields that are never user-settable
      );
      setFields(filtered as FieldMeta[]);
    } catch (err) {
      console.error('[ElementPickerModal] field load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleField = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true); setSaveErr('');
    try {
      const elements = Array.from(selected);
      const { error } = await supabase
        .from('document_template')
        .update({ selected_elements: elements, updated_at: new Date().toISOString() })
        .eq('document_template_id', templateId);
      if (error) throw error;
      onSave(elements);
    } catch (err: any) {
      setSaveErr(err.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Derived
  const objTypes = ['all', ...ALLOWED_OBJECT_TYPES.filter(t => fields.some(f => f.object_type === t))];

  const visibleFields = fields.filter(f => {
    const matchObj = objFilter === 'all' || f.object_type === objFilter;
    const matchSearch = !search ||
      f.label?.toLowerCase().includes(search.toLowerCase()) ||
      f.field.toLowerCase().includes(search.toLowerCase()) ||
      f.object_type.toLowerCase().includes(search.toLowerCase());
    return matchObj && matchSearch;
  });

  // Group by object_type for display
  const grouped: Record<string, FieldMeta[]> = {};
  for (const f of visibleFields) {
    if (!grouped[f.object_type]) grouped[f.object_type] = [];
    grouped[f.object_type].push(f);
  }

  const selectedCount = selected.size;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: 720, maxHeight: '80vh',
        background: '#fff', border: `2px solid ${ACCENT}`, borderRadius: 8,
        display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
        overflow: 'hidden', pointerEvents: 'all',
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
      }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>⚙ Data Elements</span>
            <span style={{ color: '#000', fontSize: '0.68rem', opacity: 0.6 }}>pick fields to resolve at run time</span>
          </div>
          <button onClick={onClose} onMouseDown={e => e.stopPropagation()}
            style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}>✕</button>
        </div>

        {/* Search + filter bar */}
        <div style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search fields..."
            style={{ flex: '1 1 180px', background: '#fff', border: '1px solid #e5e7eb', color: '#222', padding: '0.35rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {objTypes.map(t => (
              <button key={t} onClick={() => setObjFilter(t)}
                style={{
                  background: objFilter === t ? ACCENT : 'transparent',
                  border: `1px solid ${objFilter === t ? ACCENT : '#ddd'}`,
                  color: objFilter === t ? '#000' : '#888',
                  padding: '0.2rem 0.55rem', borderRadius: 3, fontSize: '0.65rem',
                  fontFamily: 'monospace', cursor: 'pointer',
                }}>
                {t === 'all' ? 'All' : (OBJECT_TYPE_LABELS[t] ?? t)}
              </button>
            ))}
          </div>
        </div>

        {/* Explainer */}
        <div style={{ padding: '0.4rem 0.75rem', background: ACCENT_BG, borderBottom: `1px solid ${ACCENT_BORDER}`, fontSize: '0.65rem', color: '#0f766e', flexShrink: 0 }}>
          Selected fields appear as pickers before each run — user fills in values, system uses them to filter data pulled for the document.
        </div>

        {/* Field list */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
          {loading
            ? <div style={{ padding: '1.5rem', color: '#888', fontSize: '0.75rem', textAlign: 'center' }}>Loading fields...</div>
            : Object.keys(grouped).length === 0
              ? <div style={{ padding: '1.5rem', color: '#aaa', fontSize: '0.75rem', textAlign: 'center' }}>No fields match</div>
              : Object.entries(grouped).map(([objType, objFields]) => (
                  <div key={objType}>
                    {/* Object type header */}
                    <div style={{ padding: '0.4rem 0.75rem', background: '#f9fafb', borderBottom: '1px solid #f0f0f0', borderTop: '1px solid #f0f0f0', fontSize: '0.6rem', color: ACCENT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      {OBJECT_TYPE_LABELS[objType] ?? objType}
                    </div>
                    {objFields.map(f => {
                      const key     = `${f.object_type}.${f.field}`;
                      const checked = selected.has(key);
                      return (
                        <div key={key}
                          onClick={() => toggleField(key)}
                          style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '0.6rem', background: checked ? ACCENT_BG : 'transparent', transition: 'background 0.1s' }}
                          onMouseEnter={e => { if (!checked) e.currentTarget.style.background = '#f9f9f9'; }}
                          onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}>
                          <input type="checkbox" checked={checked} onChange={() => {}} style={{ marginTop: 2, accentColor: ACCENT, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ color: checked ? ACCENT : '#333', fontSize: '0.78rem', fontWeight: checked ? 600 : 400 }}>
                                {f.label || f.field}
                              </span>
                              <span style={{ color: '#bbb', fontSize: '0.58rem', fontFamily: 'monospace' }}>{f.field}</span>
                              <span style={{ color: '#ddd', fontSize: '0.58rem' }}>·</span>
                              <span style={{ color: '#bbb', fontSize: '0.6rem' }}>{f.field_type ?? 'text'}</span>
                            </div>
                            {f.description && (
                              <div style={{ color: '#999', fontSize: '0.65rem', marginTop: '0.1rem', lineHeight: 1.4 }}>{f.description}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
          }
        </div>

        {/* Footer */}
        <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          {saveErr && <span style={{ color: '#ef4444', fontSize: '0.65rem', flex: 1 }}>{saveErr}</span>}
          {!saveErr && (
            <span style={{ color: selectedCount > 0 ? ACCENT : '#aaa', fontSize: '0.68rem', flex: 1 }}>
              {selectedCount > 0 ? `${selectedCount} field${selectedCount !== 1 ? 's' : ''} selected` : 'No fields selected — all runs will skip the resolver'}
            </span>
          )}
          {selectedCount > 0 && (
            <button onClick={() => setSelected(new Set())}
              style={{ background: 'none', border: '1px solid #e5e7eb', color: '#aaa', padding: '0.25rem 0.6rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
              clear all
            </button>
          )}
          <button onClick={onClose}
            style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
            cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.9rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
            {saving ? 'saving...' : 'Save Elements'}
          </button>
        </div>
      </div>
    </div>
  );
}
