'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ResolvedValues {
  [elementKey: string]: any; // "object_type.field" → value
}

interface ContextOption  { id: string; name: string; }
interface TagOption      { tag_id: string; name: string; group_name: string; }
interface BucketOption   { key: string; label: string; }

interface FieldMeta {
  object_type: string;
  field: string;
  label: string;
  field_type: string | null;
  description: string | null;
}

interface ValueResolverModalProps {
  userId: string;
  accessToken: string;
  selectedElements: string[];          // "object_type.field" strings from template
  runMode: 'preview_live' | 'generate';
  onConfirm: (values: ResolvedValues) => void;
  onCancel: () => void;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

const OBJECT_TYPE_LABELS: Record<string, string> = {
  task:           'Tasks',
  completion:     'Completions',
  meeting:        'Meetings',
  contact:        'Contacts',
  user_situation: 'Situation',
};

// Bucket keys in display order
const BUCKET_ORDER = ['now', 'soon', 'realwork', 'later', 'delegate', 'capture'];

// ─── FIELD TYPE CLASSIFIER ────────────────────────────────────────────────────
// Given an element key like "task.tags" or "meeting.attendee", determine the
// picker type to render.

type PickerType = 'context' | 'tags' | 'buckets' | 'window_days' | 'text' | 'boolean' | 'limit' | 'attendee';

function classifyPicker(objectType: string, field: string, fieldType: string | null): PickerType {
  if (field === 'context_id' || field === 'context') return 'context';
  if (field === 'tags' || field === 'attendees')      return 'tags';
  if (field === 'bucket_key' || field === 'buckets')  return 'buckets';
  if (field === 'window_days')                        return 'window_days';
  if (field === 'attendee')                           return 'attendee';
  if (field === 'limit')                              return 'limit';
  if (field === 'completed_only' || fieldType === 'boolean') return 'boolean';
  return 'text';
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ValueResolverModal({
  userId, accessToken, selectedElements, runMode, onConfirm, onCancel,
}: ValueResolverModalProps) {

  const [fieldMeta, setFieldMeta]     = useState<FieldMeta[]>([]);
  const [contexts, setContexts]       = useState<ContextOption[]>([]);
  const [tags, setTags]               = useState<TagOption[]>([]);
  const [buckets, setBuckets]         = useState<BucketOption[]>([]);
  const [loading, setLoading]         = useState(true);
  const [values, setValues]           = useState<ResolvedValues>({});

  // Modal drag
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 360));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 280));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const dragging        = useRef(false);
  const dragStart       = useRef({ x: 0, y: 0, px: 0, py: 0 });

  useEffect(() => {
    loadAll();
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

  const loadAll = async () => {
    setLoading(true);
    try {
      // Load field metadata for the selected elements
      const objectTypes = [...new Set(selectedElements.map(e => e.split('.')[0]))];
      const fieldNames  = selectedElements.map(e => e.split('.').slice(1).join('.'));

      const { data: meta } = await supabase
        .from('ko_field_metadata')
        .select('object_type, field, label, field_type, description')
        .eq('user_id', userId)
        .in('object_type', objectTypes);

      const relevantMeta = (meta ?? []).filter((m: FieldMeta) =>
        selectedElements.includes(`${m.object_type}.${m.field}`)
      );
      setFieldMeta(relevantMeta as FieldMeta[]);

      // Load pickers
      const needsContext = selectedElements.some(e => e.endsWith('.context_id') || e.endsWith('.context'));
      const needsTags    = selectedElements.some(e => e.endsWith('.tags') || e.endsWith('.attendees'));
      const needsBuckets = selectedElements.some(e => e.endsWith('.bucket_key') || e.endsWith('.buckets'));

      const [ctxRes, tagRes, bucketRes, koUserRes] = await Promise.all([
        needsContext ? supabase.from('context').select('context_id, name').eq('user_id', userId).eq('is_active', true).order('name') : Promise.resolve({ data: [] }),
        needsTags    ? supabase.from('tag').select('tag_id, name, tag_group:tag_group_id(name)').eq('user_id', userId).order('name') : Promise.resolve({ data: [] }),
        needsBuckets ? supabase.from('ko_user').select('implementation_type').eq('id', userId).maybeSingle() : Promise.resolve({ data: null }),
        needsBuckets ? supabase.from('ko_user').select('implementation_type').eq('id', userId).maybeSingle() : Promise.resolve({ data: null }),
      ]);

      if (needsContext) setContexts((ctxRes.data ?? []).map((c: any) => ({ id: c.context_id, name: c.name })));
      if (needsTags)    setTags((tagRes.data ?? []).map((t: any) => ({ tag_id: t.tag_id, name: t.name, group_name: t.tag_group?.name ?? 'General' })));

      if (needsBuckets) {
        const implType = (koUserRes as any).data?.implementation_type ?? 'personal';
        const { data: bConcepts } = await supabase
          .from('concept_registry')
          .select('concept_key, label')
          .eq('implementation_type', implType)
          .eq('concept_type', 'bucket')
          .eq('is_active', true);
        const bMap: Record<string, string> = {};
        for (const c of bConcepts ?? []) bMap[c.concept_key.replace(/^bucket_/, '')] = c.label;
        setBuckets(BUCKET_ORDER.filter(k => bMap[k]).map(k => ({ key: k, label: bMap[k] })));
      }

      // Seed default values — empty so user must explicitly fill
      const initVals: ResolvedValues = {};
      for (const el of selectedElements) {
        const [objType, ...fieldParts] = el.split('.');
        const field = fieldParts.join('.');
        const pickerType = classifyPicker(objType, field, null);
        if (pickerType === 'tags' || pickerType === 'buckets') initVals[el] = [];
        else if (pickerType === 'boolean') initVals[el] = false;
        else initVals[el] = '';
      }
      setValues(initVals);
    } catch (err) {
      console.error('[ValueResolverModal] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const setVal = (key: string, val: any) => setValues(prev => ({ ...prev, [key]: val }));

  const toggleArrayVal = (key: string, item: string) => {
    setValues(prev => {
      const arr: string[] = Array.isArray(prev[key]) ? [...prev[key]] : [];
      const idx = arr.indexOf(item);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(item);
      return { ...prev, [key]: arr };
    });
  };

  const handleConfirm = () => {
    // Strip empty values so they don't override section defaults
    const clean: ResolvedValues = {};
    for (const [k, v] of Object.entries(values)) {
      if (Array.isArray(v) && v.length > 0) clean[k] = v;
      else if (typeof v === 'boolean' && v)  clean[k] = v;
      else if (typeof v === 'number')        clean[k] = v;
      else if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
    }
    onConfirm(clean);
  };

  // Group elements by object type
  const grouped: Record<string, string[]> = {};
  for (const el of selectedElements) {
    const objType = el.split('.')[0];
    if (!grouped[objType]) grouped[objType] = [];
    grouped[objType].push(el);
  }

  if (selectedElements.length === 0) {
    // Nothing to resolve — caller should skip this modal
    onConfirm({});
    return null;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, pointerEvents: 'none' }}>
      {/* Backdrop */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.15)', pointerEvents: 'all' }} onClick={onCancel} />

      <div style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: 680, maxHeight: '80vh',
        background: '#fff', border: `2px solid ${ACCENT}`, borderRadius: 8,
        display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
        overflow: 'hidden', pointerEvents: 'all',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)', zIndex: 501,
      }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>
              {runMode === 'generate' ? '⚡' : '▶'} Set Run Values
            </span>
            <span style={{ color: '#000', fontSize: '0.65rem', opacity: 0.65 }}>
              {runMode === 'generate' ? 'values used for this extract' : 'values used for this preview'}
            </span>
          </div>
          <button onClick={onCancel} onMouseDown={e => e.stopPropagation()}
            style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}>✕</button>
        </div>

        {/* Explainer */}
        <div style={{ padding: '0.4rem 0.75rem', background: ACCENT_BG, borderBottom: `1px solid ${ACCENT_BORDER}`, fontSize: '0.65rem', color: '#0f766e', flexShrink: 0, lineHeight: 1.5 }}>
          Fill in the values you want for this run. Empty fields use the template defaults. Values save to the extract only — template is never changed.
        </div>

        {/* Fields */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent', padding: '0.5rem 0' }}>
          {loading
            ? <div style={{ padding: '2rem', color: '#888', fontSize: '0.75rem', textAlign: 'center' }}>Loading...</div>
            : Object.entries(grouped).map(([objType, elements]) => (
                <div key={objType} style={{ marginBottom: '0.25rem' }}>
                  {/* Object type label */}
                  <div style={{ padding: '0.35rem 0.75rem', background: '#f9fafb', borderBottom: '1px solid #f0f0f0', borderTop: '1px solid #f0f0f0', fontSize: '0.6rem', color: ACCENT, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {OBJECT_TYPE_LABELS[objType] ?? objType}
                  </div>

                  {elements.map(el => {
                    const [, ...fieldParts] = el.split('.');
                    const field = fieldParts.join('.');
                    const meta  = fieldMeta.find(m => m.object_type === objType && m.field === field);
                    const label = meta?.label || field;
                    const desc  = meta?.description;
                    const pickerType = classifyPicker(objType, field, meta?.field_type ?? null);
                    const val   = values[el];

                    return (
                      <div key={el} style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #f5f5f5' }}>
                        <div style={{ fontSize: '0.65rem', color: '#555', fontWeight: 600, marginBottom: '0.2rem' }}>
                          {label}
                          {desc && <span style={{ color: '#bbb', fontWeight: 400, marginLeft: '0.4rem' }}>{desc}</span>}
                        </div>

                        {/* CONTEXT picker */}
                        {pickerType === 'context' && (
                          <select
                            value={val ?? ''}
                            onChange={e => setVal(el, e.target.value || '')}
                            style={selectSt}>
                            <option value="">— use template default —</option>
                            {contexts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        )}

                        {/* TAGS / ATTENDEES multi-select */}
                        {pickerType === 'tags' && (
                          <div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.35rem' }}>
                              {(Array.isArray(val) ? val : []).map((t: string) => (
                                <span key={t} style={{ background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, fontSize: '0.65rem', padding: '0.1rem 0.45rem', borderRadius: 3, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                  {t}
                                  <button onClick={() => toggleArrayVal(el, t)} style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontSize: '0.65rem', padding: 0, lineHeight: 1 }}>✕</button>
                                </span>
                              ))}
                              {(!Array.isArray(val) || val.length === 0) && (
                                <span style={{ color: '#ccc', fontSize: '0.65rem', alignSelf: 'center' }}>none selected — use template default</span>
                              )}
                            </div>
                            <TagSearch
                              tags={tags}
                              selected={Array.isArray(val) ? val : []}
                              onToggle={name => toggleArrayVal(el, name)}
                            />
                          </div>
                        )}

                        {/* BUCKETS multi-select (chips) */}
                        {pickerType === 'buckets' && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                            {buckets.map(b => {
                              const active = Array.isArray(val) && val.includes(b.key);
                              return (
                                <button key={b.key} onClick={() => toggleArrayVal(el, b.key)}
                                  style={{ background: active ? ACCENT : 'transparent', border: `1px solid ${active ? ACCENT : '#ddd'}`, color: active ? '#000' : '#888', padding: '0.2rem 0.55rem', borderRadius: 3, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer', transition: 'all 0.1s' }}>
                                  {b.label}
                                </button>
                              );
                            })}
                            {(!Array.isArray(val) || val.length === 0) && (
                              <span style={{ color: '#ccc', fontSize: '0.62rem', alignSelf: 'center', marginLeft: '0.25rem' }}>none = use template default</span>
                            )}
                          </div>
                        )}

                        {/* WINDOW_DAYS / LIMIT number */}
                        {(pickerType === 'window_days' || pickerType === 'limit') && (
                          <input
                            type="number" min={1} max={pickerType === 'window_days' ? 365 : 100}
                            value={val ?? ''}
                            onChange={e => setVal(el, e.target.value ? Number(e.target.value) : '')}
                            placeholder={pickerType === 'window_days' ? 'days (blank = template default)' : 'limit (blank = template default)'}
                            style={inputSt}
                          />
                        )}

                        {/* ATTENDEE text */}
                        {pickerType === 'attendee' && (
                          <input
                            value={val ?? ''}
                            onChange={e => setVal(el, e.target.value)}
                            placeholder="Attendee name (blank = template default)"
                            style={inputSt}
                          />
                        )}

                        {/* BOOLEAN toggle */}
                        {pickerType === 'boolean' && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', color: '#555', cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!val} onChange={e => setVal(el, e.target.checked)} style={{ accentColor: ACCENT }} />
                            {label}
                          </label>
                        )}

                        {/* TEXT fallback */}
                        {pickerType === 'text' && (
                          <input
                            value={val ?? ''}
                            onChange={e => setVal(el, e.target.value)}
                            placeholder="Value (blank = template default)"
                            style={inputSt}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
          }
        </div>

        {/* Footer */}
        <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button onClick={onCancel}
            style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
            cancel
          </button>
          <button onClick={handleConfirm}
            style={{ background: runMode === 'generate' ? ACCENT : 'transparent', border: `1px solid ${ACCENT}`, color: runMode === 'generate' ? '#000' : ACCENT, padding: '0.3rem 1rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>
            {runMode === 'generate' ? '⚡ Run + Create Extract' : '▶ Preview with Data'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TAG SEARCH sub-component ─────────────────────────────────────────────────

function TagSearch({ tags, selected, onToggle }: { tags: TagOption[]; selected: string[]; onToggle: (name: string) => void }) {
  const [search, setSearch] = useState('');
  const visible = search
    ? tags.filter(t => t.name.toLowerCase().includes(search.toLowerCase())).slice(0, 12)
    : [];

  return (
    <div>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Type to search tags..."
        style={{ ...inputSt, marginBottom: visible.length > 0 ? '0.25rem' : 0 }}
      />
      {visible.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
          {visible.map(t => {
            const isSelected = selected.includes(t.name);
            return (
              <button key={t.tag_id} onClick={() => { onToggle(t.name); setSearch(''); }}
                style={{ background: isSelected ? ACCENT_BG : '#f5f5f5', border: `1px solid ${isSelected ? ACCENT_BORDER : '#e5e7eb'}`, color: isSelected ? ACCENT : '#555', padding: '0.15rem 0.45rem', borderRadius: 3, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                {isSelected ? '✓ ' : ''}{t.name}
                <span style={{ color: '#bbb', marginLeft: '0.25rem' }}>· {t.group_name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

const inputSt: React.CSSProperties = {
  width: '100%', background: '#fff', border: '1px solid #e5e7eb', color: '#222',
  padding: '0.4rem 0.55rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.78rem',
  outline: 'none', boxSizing: 'border-box',
};

const selectSt: React.CSSProperties = {
  width: '100%', background: '#fff', border: '1px solid #e5e7eb', color: '#222',
  padding: '0.4rem 0.55rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.78rem',
  outline: 'none', boxSizing: 'border-box', cursor: 'pointer',
};
