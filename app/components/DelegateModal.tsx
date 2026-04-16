'use client';

// app/components/DelegateModal.tsx
// KarlOps L — Lightweight delegee picker modal
// Used by: drag-drop to delegate bucket, chat confirmation, task detail
// Always shows who the task is being delegated to before confirming.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface PeopleTag {
  tag_id: string;
  name: string;
  description: string | null;
}

interface Props {
  taskId: string;
  taskTitle: string;
  userId: string;
  preselectedTagId?: string | null;
  preselectedName?: string | null;
  onConfirm: (tagId: string, tagName: string) => void;
  onCancel: () => void;
}

const PURPLE        = '#8b5cf6';
const PURPLE_LIGHT  = '#f5f3ff';
const PURPLE_BORDER = '#ede9fe';

export default function DelegateModal({
  taskId,
  taskTitle,
  userId,
  preselectedTagId,
  preselectedName,
  onConfirm,
  onCancel,
}: Props) {
  const [peopleTags, setPeopleTags]       = useState<PeopleTag[]>([]);
  const [peopleGroupId, setPeopleGroupId] = useState<string | null>(null);
  const [selected, setSelected]           = useState<string | null>(preselectedTagId ?? null);
  const [selectedName, setSelectedName]   = useState<string | null>(preselectedName ?? null);
  const [search, setSearch]               = useState('');
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [err, setErr]                     = useState('');

  // Add person inline form
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [newName, setNewName]             = useState('');
  const [newDesc, setNewDesc]             = useState('');
  const [addingSaving, setAddingSaving]   = useState(false);
  const [addErr, setAddErr]               = useState('');

  // ESC: close add form first, then modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAddPerson) { setShowAddPerson(false); return; }
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, showAddPerson]);

  // Load People tags
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data: group } = await supabase
          .from('tag_group')
          .select('tag_group_id')
          .eq('user_id', userId)
          .eq('name', 'People')
          .maybeSingle();

        if (!group) { setLoading(false); return; }
        setPeopleGroupId(group.tag_group_id);

        const { data: tags } = await supabase
          .from('tag')
          .select('tag_id, name, description')
          .eq('user_id', userId)
          .eq('tag_group_id', group.tag_group_id)
          .eq('is_archived', false)
          .order('name');

        setPeopleTags(tags ?? []);

        if (preselectedTagId && !preselectedName) {
          const found = (tags ?? []).find(t => t.tag_id === preselectedTagId);
          if (found) setSelectedName(found.name);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [userId, preselectedTagId, preselectedName]);

  const handleSelect = (tag: PeopleTag) => {
    setSelected(tag.tag_id);
    setSelectedName(tag.name);
    setErr('');
    setShowAddPerson(false);
  };

  const handleConfirm = () => {
    if (!selected || !selectedName) { setErr('Select a delegee first.'); return; }
    setSaving(true);
    onConfirm(selected, selectedName);
  };

  // Add Person inline
  const handleAddPerson = async () => {
    if (!newName.trim()) { setAddErr('Name is required.'); return; }
    if (!peopleGroupId)  { setAddErr('People group not found.'); return; }

    setAddingSaving(true); setAddErr('');
    try {
      const { data: newTag, error } = await supabase
        .from('tag')
        .insert({
          user_id:      userId,
          tag_group_id: peopleGroupId,
          name:         newName.trim(),
          description:  newDesc.trim() || null,
          is_archived:  false,
        })
        .select('tag_id, name, description')
        .single();

      if (error) throw error;

      // Add to list, auto-select, close form
      setPeopleTags(prev => [...prev, newTag]);
      setSelected(newTag.tag_id);
      setSelectedName(newTag.name);
      setShowAddPerson(false);
      setNewName('');
      setNewDesc('');
      setErr('');
    } catch (e: any) {
      setAddErr(e.message ?? 'Failed to create person.');
    } finally {
      setAddingSaving(false);
    }
  };

  // Sort: Other first, then alpha, filter by search
  const filtered = [
    ...peopleTags.filter(t => t.name === 'Other'),
    ...peopleTags.filter(t => t.name !== 'Other').sort((a, b) => a.name.localeCompare(b.name)),
  ].filter(t =>
    !search ||
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.description ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div style={{ background: '#fff', border: `2px solid ${PURPLE}`, borderRadius: '10px', width: '380px', maxWidth: '90vw', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

        {/* HEADER */}
        <div style={{ background: PURPLE, padding: '0.85rem 1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: '0.85rem' }}>Delegate Task</div>
            <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.7rem', marginTop: '0.15rem', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle}</div>
          </div>
          <button onClick={onCancel}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
          >✕</button>
        </div>

        {/* BODY */}
        <div style={{ padding: '1rem 1.1rem' }}>

          {/* Selected confirmation strip */}
          <div style={{ background: selected ? PURPLE_LIGHT : '#fafafa', border: `1px solid ${selected ? PURPLE_BORDER : '#eee'}`, borderRadius: '6px', padding: '0.5rem 0.75rem', marginBottom: '0.85rem', minHeight: '36px', display: 'flex', alignItems: 'center', transition: 'all 0.15s' }}>
            {selected ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <span style={{ color: PURPLE, fontSize: '0.75rem' }}>→</span>
                <span style={{ color: PURPLE, fontWeight: 700, fontSize: '0.82rem' }}>{selectedName}</span>
                <span style={{ color: '#a78bfa', fontSize: '0.68rem' }}>selected</span>
                <span
                  onClick={() => { setSelected(null); setSelectedName(null); }}
                  style={{ marginLeft: 'auto', fontSize: '0.62rem', color: '#ccc', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#ccc')}
                >✕ clear</span>
              </div>
            ) : (
              <span style={{ color: '#bbb', fontSize: '0.72rem' }}>No delegee selected yet</span>
            )}
          </div>

          {/* Search — only when list is long */}
          {peopleTags.length > 5 && (
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search people..."
              style={{ width: '100%', background: '#fafafa', border: '1px solid #ddd', borderRadius: '4px', padding: '0.4rem 0.6rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#333', outline: 'none', boxSizing: 'border-box', marginBottom: '0.6rem' }}
              onFocus={e => (e.target.style.borderColor = PURPLE)}
              onBlur={e => (e.target.style.borderColor = '#ddd')}
            />
          )}

          {/* People pills */}
          {loading ? (
            <div style={{ color: '#aaa', fontSize: '0.75rem', padding: '0.5rem 0' }}>Loading...</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '150px', overflowY: 'auto', paddingBottom: '0.25rem' }}>
              {filtered.length === 0 && (
                <div style={{ color: '#aaa', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                  {search ? 'No match.' : 'No people yet — add one below.'}
                </div>
              )}
              {filtered.map(tag => {
                const isSelected = selected === tag.tag_id;
                const isOther    = tag.name === 'Other';
                return (
                  <div
                    key={tag.tag_id}
                    onClick={() => handleSelect(tag)}
                    title={tag.description ?? undefined}
                    style={{
                      padding: '0.3rem 0.7rem',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontFamily: 'monospace',
                      transition: 'all 0.15s',
                      border: `1px solid ${isSelected ? PURPLE : '#ddd'}`,
                      background: isSelected ? `${PURPLE}18` : isOther ? '#f9f9f9' : '#fafafa',
                      color: isSelected ? PURPLE : isOther ? '#999' : '#444',
                      fontWeight: isSelected ? 700 : 400,
                      fontStyle: isOther ? 'italic' : 'normal',
                    }}
                    onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.borderColor = PURPLE; e.currentTarget.style.color = PURPLE; } }}
                    onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.color = isOther ? '#999' : '#444'; } }}
                  >
                    {tag.name}
                  </div>
                );
              })}
            </div>
          )}

          {/* + add person toggle */}
          {!showAddPerson && (
            <div
              onClick={() => { setShowAddPerson(true); setAddErr(''); }}
              style={{ marginTop: '0.65rem', fontSize: '0.7rem', color: '#a78bfa', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', userSelect: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.color = PURPLE)}
              onMouseLeave={e => (e.currentTarget.style.color = '#a78bfa')}
            >
              + add person
            </div>
          )}

          {/* Inline add person form */}
          {showAddPerson && (
            <div style={{ marginTop: '0.65rem', background: PURPLE_LIGHT, border: `1px solid ${PURPLE_BORDER}`, borderRadius: '6px', padding: '0.75rem' }}>
              <div style={{ fontSize: '0.65rem', color: PURPLE, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>New Person</div>

              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddPerson(); if (e.key === 'Escape') { setShowAddPerson(false); setNewName(''); setNewDesc(''); } }}
                placeholder="Name *"
                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '4px', padding: '0.35rem 0.55rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#333', outline: 'none', boxSizing: 'border-box', marginBottom: '0.4rem' }}
                onFocus={e => (e.target.style.borderColor = PURPLE)}
                onBlur={e => (e.target.style.borderColor = '#ddd')}
              />

              <input
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddPerson(); if (e.key === 'Escape') { setShowAddPerson(false); setNewName(''); setNewDesc(''); } }}
                placeholder="Description — helps Karl find them later"
                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '4px', padding: '0.35rem 0.55rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#333', outline: 'none', boxSizing: 'border-box', marginBottom: '0.5rem' }}
                onFocus={e => (e.target.style.borderColor = PURPLE)}
                onBlur={e => (e.target.style.borderColor = '#ddd')}
              />

              {addErr && <div style={{ color: '#ef4444', fontSize: '0.68rem', marginBottom: '0.4rem' }}>{addErr}</div>}

              <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { setShowAddPerson(false); setNewName(''); setNewDesc(''); setAddErr(''); }}
                  style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer' }}
                >cancel</button>
                <button
                  onClick={handleAddPerson}
                  disabled={!newName.trim() || addingSaving}
                  style={{ background: newName.trim() ? PURPLE : '#eee', border: `1px solid ${newName.trim() ? PURPLE : '#ddd'}`, color: newName.trim() ? '#fff' : '#aaa', padding: '0.25rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', fontWeight: 700, cursor: newName.trim() ? 'pointer' : 'not-allowed', transition: 'all 0.15s', opacity: addingSaving ? 0.6 : 1 }}
                >
                  {addingSaving ? 'saving...' : '+ add'}
                </button>
              </div>
            </div>
          )}

          {err && <div style={{ color: '#ef4444', fontSize: '0.7rem', marginTop: '0.5rem' }}>{err}</div>}
        </div>

        {/* FOOTER */}
        <div style={{ padding: '0.75rem 1.1rem', borderTop: '1px solid #f0f0f0', background: '#fafafa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onCancel}
            style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.35rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.73rem', cursor: 'pointer' }}
          >cancel</button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {selected && selectedName && (
              <span style={{ fontSize: '0.68rem', color: '#a78bfa' }}>→ {selectedName}</span>
            )}
            <button
              onClick={handleConfirm}
              disabled={!selected || saving}
              style={{ background: selected ? PURPLE : '#eee', border: `1px solid ${selected ? PURPLE : '#ddd'}`, color: selected ? '#fff' : '#aaa', padding: '0.35rem 1rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.73rem', fontWeight: 700, cursor: selected ? 'pointer' : 'not-allowed', transition: 'all 0.15s', opacity: saving ? 0.6 : 1 }}
            >
              {saving ? 'delegating...' : 'delegate →'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
