'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface FieldRow {
  object_type: string;
  field: string;
  label: string | null;
  description: string | null;
  display_order: number;
}

export interface ElementFilters {
  [elementKey: string]: any; // reserved for future filter values — not used in this modal
}

interface ElementPickerModalProps {
  userId: string;
  templateId: string;
  currentElements: string[];   // "object_type.field" already saved on template
  onSave: (elements: string[]) => void;
  onClose: () => void;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

// Fields that are not meaningful for document data selection
const EXCLUDED_FIELDS = [
  'user_id', 'created_at', 'updated_at', 'is_archived', 'is_completed',
  'is_active', 'sort_order',
];

// Object types relevant as document data sources
const SOURCE_OBJECT_TYPES = [
  'task', 'completion', 'meeting', 'contact', 'user_situation', 'external_reference',
];

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ElementPickerModal({
  userId, templateId, currentElements, onSave, onClose,
}: ElementPickerModalProps) {

  // 'picker' = the field list with checkboxes
  // 'display' = the confirmed selected elements view
  const [view, setView]           = useState<'picker' | 'display'>('display');
  const [fields, setFields]       = useState<FieldRow[]>([]);
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [saveErr, setSaveErr]     = useState('');

  // Working selection while in picker — initialised from currentElements
  const [working, setWorking]     = useState<Set<string>>(new Set(currentElements));
  // Confirmed selection shown in display view
  const [confirmed, setConfirmed] = useState<string[]>(currentElements);

  const [search, setSearch]       = useState('');
  const [objFilter, setObjFilter] = useState('all');

  // Modal drag
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 400));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 300));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const dragging        = useRef(false);
  const dragStart       = useRef({ x: 0, y: 0, px: 0, py: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.x),
        y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.y),
      });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Load field metadata when switching to picker
  const openPicker = async () => {
    setView('picker');
    if (fields.length > 0) return; // already loaded
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('ko_field_metadata')
        .select('object_type, field, label, description, display_order')
        .eq('user_id', userId)
        .in('object_type', SOURCE_OBJECT_TYPES)
        .lt('display_order', 999)
        .order('object_type')
        .order('display_order');

      if (error) throw error;

      const filtered = (data ?? []).filter(
        (f: FieldRow) => !EXCLUDED_FIELDS.includes(f.field)
      );
      setFields(filtered as FieldRow[]);
    } catch (err) {
      console.error('[ElementPickerModal] field load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (key: string) => {
    setWorking(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Done — copy working set to confirmed, switch to display view
  const handleDone = () => {
    const elements = Array.from(working);
    setConfirmed(elements);
    setView('display');
  };

  // Back — discard working changes, return to display
  const handleBack = () => {
    setWorking(new Set(confirmed)); // reset working to last confirmed
    setSearch('');
    setView('display');
  };

  // Save confirmed selection to DB and notify parent
  const handleSave = async () => {
    setSaving(true); setSaveErr('');
    try {
      const { error } = await supabase
        .from('document_template')
        .update({
          selected_elements: confirmed,
          updated_at: new Date().toISOString(),
        })
        .eq('document_template_id', templateId);
      if (error) throw error;
      onSave(confirmed);
    } catch (err: any) {
      setSaveErr(err.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ── Derived for picker ─────────────────────────────────────────────────────

  // Available object types from loaded fields
  const objTypes = ['all', ...Array.from(new Set(fields.map(f => f.object_type)))];

  const visible = fields.filter(f => {
    const matchObj    = objFilter === 'all' || f.object_type === objFilter;
    const term        = search.toLowerCase();
    const matchSearch = !search ||
      (f.label ?? f.field).toLowerCase().includes(term) ||
      f.field.toLowerCase().includes(term) ||
      f.object_type.toLowerCase().includes(term) ||
      `${f.object_type}.${f.field}`.toLowerCase().includes(term);
    return matchObj && matchSearch;
  });

  // Group by object_type
  const grouped: Record<string, FieldRow[]> = {};
  for (const f of visible) {
    if (!grouped[f.object_type]) grouped[f.object_type] = [];
    grouped[f.object_type].push(f);
  }

  const workingCount = working.size;

  // ─── RENDER ────────────────────────────────────────────────────────────────

  const modalWidth = view === 'picker' ? 640 : 480;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: modalWidth, maxHeight: '80vh',
        background: '#fff', border: `2px solid ${ACCENT}`, borderRadius: 8,
        display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
        overflow: 'hidden', pointerEvents: 'all',
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
        transition: 'width 0.15s ease',
      }}>

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div
          onMouseDown={e => {
            dragging.current = true;
            dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
          }}
          style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>⚙ Data Elements</span>
            <span style={{ color: '#000', fontSize: '0.65rem', opacity: 0.6 }}>
              {view === 'picker' ? 'pick fields · Done to confirm' : 'selected fields for this template'}
            </span>
          </div>
          <button onClick={onClose} onMouseDown={e => e.stopPropagation()}
            style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}>✕</button>
        </div>

        {/* ════════════════════════════════════════════════════════════════ */}
        {view === 'display' && (
          <>
            {/* Display body */}
            <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent', padding: '0.75rem' }}>
              {confirmed.length === 0
                ? <div style={{ color: '#ccc', fontSize: '0.72rem', textAlign: 'center', paddingTop: '1.5rem' }}>
                    No elements selected.<br />
                    <span style={{ fontSize: '0.65rem' }}>Use the button below to pick fields from field metadata.</span>
                  </div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {confirmed.map(el => (
                      <div key={el} style={{
                        background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`,
                        borderRadius: 4, padding: '0.4rem 0.65rem',
                        display: 'flex', alignItems: 'center', gap: '0.5rem',
                      }}>
                        <span style={{ color: ACCENT, fontSize: '0.72rem', fontWeight: 600, flex: 1 }}>
                          {el}
                        </span>
                        <button
                          onClick={() => {
                            const next = confirmed.filter(e => e !== el);
                            setConfirmed(next);
                            setWorking(new Set(next));
                          }}
                          style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: '0.7rem', padding: '0 0.1rem', lineHeight: 1 }}
                          title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
              }
            </div>

            {/* Display footer */}
            <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
              {saveErr && <span style={{ color: '#ef4444', fontSize: '0.65rem', flex: 1 }}>{saveErr}</span>}
              {!saveErr && <span style={{ flex: 1 }} />}
              <button
                onClick={openPicker}
                style={{ background: 'transparent', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                {confirmed.length > 0 ? '⚙ Edit Fields' : '+ Pick Fields'}
              </button>
              <button onClick={onClose}
                style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.9rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                {saving ? 'saving...' : 'Save'}
              </button>
            </div>
          </>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {view === 'picker' && (
          <>
            {/* Search + object filter */}
            <div style={{ padding: '0.5rem 0.6rem', borderBottom: '1px solid #e5e7eb', background: '#fafafa', flexShrink: 0 }}>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search fields or type object.field..."
                autoFocus
                style={{ width: '100%', background: '#fff', border: '1px solid #e5e7eb', color: '#222', padding: '0.35rem 0.55rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.73rem', outline: 'none', boxSizing: 'border-box', marginBottom: '0.4rem' }}
              />
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {objTypes.map(t => (
                  <button key={t} onClick={() => setObjFilter(t)}
                    style={{
                      background: objFilter === t ? ACCENT : 'transparent',
                      border: `1px solid ${objFilter === t ? ACCENT : '#ddd'}`,
                      color: objFilter === t ? '#000' : '#999',
                      padding: '0.15rem 0.45rem', borderRadius: 3,
                      fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer',
                    }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Count bar */}
            <div style={{ padding: '0.3rem 0.75rem', background: working.size > 0 ? ACCENT_BG : '#fafafa', borderBottom: `1px solid ${working.size > 0 ? ACCENT_BORDER : '#f0f0f0'}`, fontSize: '0.62rem', color: working.size > 0 ? '#0f766e' : '#bbb', flexShrink: 0 }}>
              {working.size > 0 ? `${working.size} field${working.size !== 1 ? 's' : ''} selected` : 'No fields selected'}
            </div>

            {/* Field list */}
            <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
              {loading
                ? <div style={{ padding: '2rem', color: '#888', fontSize: '0.73rem', textAlign: 'center' }}>Loading field metadata...</div>
                : fields.length === 0
                  ? <div style={{ padding: '2rem', color: '#aaa', fontSize: '0.73rem', textAlign: 'center' }}>
                      No field metadata found.<br />
                      <span style={{ fontSize: '0.65rem', color: '#ccc' }}>Field metadata must exist in ko_field_metadata for {SOURCE_OBJECT_TYPES.join(', ')}.</span>
                    </div>
                  : Object.keys(grouped).length === 0
                    ? <div style={{ padding: '1.5rem', color: '#bbb', fontSize: '0.73rem', textAlign: 'center' }}>No fields match</div>
                    : Object.entries(grouped).map(([objType, rows]) => (
                        <div key={objType}>
                          {/* Object type header */}
                          <div style={{ padding: '0.3rem 0.75rem', background: '#f9fafb', borderBottom: '1px solid #f0f0f0', borderTop: '1px solid #f0f0f0', fontSize: '0.6rem', color: ACCENT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                            {objType}
                          </div>
                          {rows.map(f => {
                            const key     = `${f.object_type}.${f.field}`;
                            const checked = working.has(key);
                            return (
                              <div key={key} onClick={() => toggle(key)}
                                style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '0.6rem', background: checked ? ACCENT_BG : 'transparent' }}
                                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = '#f9f9f9'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = checked ? ACCENT_BG : 'transparent'; }}>
                                <input type="checkbox" checked={checked} onChange={() => {}} style={{ marginTop: 3, accentColor: ACCENT, flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                                    <span style={{ color: checked ? ACCENT : '#333', fontSize: '0.76rem', fontWeight: checked ? 600 : 400 }}>
                                      {f.label ?? f.field}
                                    </span>
                                    <span style={{ color: '#ccc', fontSize: '0.6rem', fontFamily: 'monospace' }}>
                                      {f.object_type}.{f.field}
                                    </span>
                                  </div>
                                  {f.description && (
                                    <div style={{ color: '#aaa', fontSize: '0.62rem', marginTop: '0.1rem', lineHeight: 1.4 }}>
                                      {f.description}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))
              }
            </div>

            {/* Picker footer */}
            <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
              {workingCount > 0 && (
                <button
                  onClick={() => setWorking(new Set())}
                  style={{ background: 'none', border: '1px solid #e5e7eb', color: '#aaa', padding: '0.25rem 0.6rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                  clear all
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={handleBack}
                style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                ← Back
              </button>
              <button onClick={handleDone}
                style={{ background: ACCENT, border: 'none', color: '#000', padding: '0.3rem 1rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>
                Done
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
