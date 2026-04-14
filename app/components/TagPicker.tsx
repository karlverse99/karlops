'use client';

// app/components/TagPicker.tsx
// KarlOps L — Simplified tag picker
// v0.6.2 — no group filter, search + Karl suggest + inline new tag
//
// Props:
//   selected       — currently selected tag names
//   allTags        — full tag list from DB
//   tagGroups      — tag groups (used only for new tag group assignment, not shown)
//   onChange       — called with new tag array on any change
//   onTagCreated   — called when a new tag is created — parent should reload allTags
//   accentColor    — modal accent color
//   objectType     — FC object type for Karl context
//   contextText    — title + notes fed to Karl for suggestions
//   accessToken    — for Karl suggest API call
//   userId         — for creating new tags in DB
//   maxTags        — max tags allowed (default 5)
//   label          — field label (default 'Tags')

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Tag {
  tag_id: string;
  name: string;
  tag_group_id: string;
}

interface TagGroup {
  tag_group_id: string;
  name: string;
}

interface Suggestion {
  name: string;
  isNew: boolean;
  group_id?: string | null;
  description?: string;
}

interface TagPickerProps {
  selected: string[];
  allTags: Tag[];
  tagGroups: TagGroup[];
  onChange: (tags: string[]) => void;
  onTagCreated?: () => void;
  accentColor: string;
  objectType: string;
  contextText: string;
  accessToken: string;
  userId: string;
  maxTags?: number;
  label?: string;
}

export default function TagPicker({
  selected,
  allTags,
  tagGroups,
  onChange,
  onTagCreated,
  accentColor,
  objectType,
  contextText,
  accessToken,
  userId,
  maxTags = 5,
  label = 'Tags',
}: TagPickerProps) {

  const [search, setSearch]             = useState('');
  const [showDrop, setShowDrop]         = useState(false);

  // Suggest state
  const [suggestions, setSuggestions]   = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting]     = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [suggestOpen, setSuggestOpen]   = useState(false);

  // New tag inline form
  const [showNew, setShowNew]           = useState(false);
  const [newName, setNewName]           = useState('');
  const [newDesc, setNewDesc]           = useState('');
  const [creating, setCreating]         = useState(false);
  const [createError, setCreateError]   = useState('');

  const atMax = selected.length >= maxTags;

  const accentBg     = `${accentColor}12`;
  const accentBorder = `${accentColor}40`;

  // General group for new tags (silent — not shown to user)
  const generalGroupId =
    tagGroups.find(g => g.name === 'General')?.tag_group_id ??
    tagGroups[0]?.tag_group_id ??
    null;

  // ─── Filtered dropdown ────────────────────────────────────────────────────

  const filtered = allTags.filter(t =>
    !selected.includes(t.name) &&
    (search ? t.name.toLowerCase().includes(search.toLowerCase()) : true)
  );

  // ─── Add / remove ─────────────────────────────────────────────────────────

  const add = (name: string) => {
    if (atMax || selected.includes(name)) return;
    onChange([...selected, name]);
    setSuggestions(prev => prev.filter(s => s.name !== name));
    setSearch('');
    setShowDrop(false);
  };

  const remove = (name: string) => onChange(selected.filter(t => t !== name));

  // ─── Karl suggest ─────────────────────────────────────────────────────────

  const runSuggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    setSuggestError('');
    setSuggestions([]);
    setSuggestOpen(true);

    try {
      const res = await fetch('/api/ko/suggest-tags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          mode:          'inline',
          object_type:   objectType,
          context_text:  contextText,
          selected_tags: selected,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Suggestion failed');

      const results: Suggestion[] = [];

      for (const name of (data.suggested ?? [])) {
        if (!selected.includes(name) && allTags.find(t => t.name === name)) {
          results.push({ name, isNew: false });
        }
      }
      for (const idea of (data.new_tag_ideas ?? [])) {
        if (!selected.includes(idea.name) && !allTags.find(t => t.name === idea.name)) {
          results.push({ name: idea.name, isNew: true, group_id: idea.group_id, description: idea.description });
        }
      }

      setSuggestions(results);
      if (results.length === 0) setSuggestError('No suggestions — try adding more task detail.');
    } catch {
      setSuggestError("Karl couldn't suggest tags right now.");
    } finally {
      setSuggesting(false);
    }
  };

  const acceptSuggestion = async (s: Suggestion) => {
    if (atMax) return;
    if (!s.isNew) { add(s.name); return; }

    // New tag — create in General group silently
    setCreating(true);
    try {
      const { error } = await supabase.from('tag').insert({
        user_id:      userId,
        tag_group_id: s.group_id ?? generalGroupId,
        name:         s.name,
        description:  s.description ?? null,
        is_archived:  false,
      });
      if (error) throw error;
      onChange([...selected, s.name]);
      onTagCreated?.();
    } catch (e: any) {
      setSuggestError(`Couldn't create "${s.name}"`);
    } finally {
      setCreating(false);
      setSuggestions(prev => prev.filter(x => x.name !== s.name));
    }
  };

  // ─── Create new tag ───────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const { error } = await supabase.from('tag').insert({
        user_id:      userId,
        tag_group_id: generalGroupId,
        name:         newName.trim(),
        description:  newDesc.trim() || null,
        is_archived:  false,
      });
      if (error) throw error;
      if (!atMax) onChange([...selected, newName.trim()]);
      onTagCreated?.();
      setShowNew(false);
      setNewName('');
      setNewDesc('');
    } catch (e: any) {
      setCreateError(e.message ?? 'Could not create tag');
    } finally {
      setCreating(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ marginBottom: '0.85rem' }}>

      {/* Label + count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <div style={{ color: '#000', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          {label}
        </div>
        <div style={{ fontSize: '0.62rem', color: atMax ? accentColor : '#bbb', fontFamily: 'monospace' }}>
          {selected.length}/{maxTags}
        </div>
      </div>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
          {selected.map(name => (
            <span key={name} style={{ fontSize: '0.72rem', color: '#fff', background: accentColor, borderRadius: '3px', padding: '0.15rem 0.45rem', display: 'flex', alignItems: 'center', gap: '0.3rem', fontFamily: 'monospace' }}>
              {name}
              <span onClick={() => remove(name)} style={{ opacity: 0.7, cursor: 'pointer', fontSize: '0.65rem' }}>✕</span>
            </span>
          ))}
        </div>
      )}

      {/* Search + buttons */}
      {!atMax && (
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch' }}>

          {/* Search */}
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              onBlur={() => setTimeout(() => setShowDrop(false), 150)}
              placeholder="Search tags..."
              style={{ ...inputStyle, marginBottom: 0 }}
              onFocusCapture={e => (e.target.style.borderColor = accentColor)}
              onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
            />
            {showDrop && search.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 9999, maxHeight: '180px', overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
                {filtered.length > 0 ? filtered.map(tag => (
                  <div key={tag.tag_id}
                    onMouseDown={() => add(tag.name)}
                    style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }}
                    onMouseEnter={e => (e.currentTarget.style.background = accentBg)}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    {tag.name}
                  </div>
                )) : (
                  <div style={{ padding: '0.5rem 0.65rem', fontSize: '0.75rem', color: '#aaa', fontFamily: 'monospace', fontStyle: 'italic' }}>
                    no match
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Karl suggest */}
          <button
            onClick={runSuggest}
            disabled={suggesting || !contextText.trim()}
            title="Ask Karl to suggest tags"
            style={{ flexShrink: 0, background: accentBg, border: `1.5px solid ${accentBorder}`, color: accentColor, padding: '0 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: suggesting || !contextText.trim() ? 'not-allowed' : 'pointer', opacity: !contextText.trim() ? 0.4 : 1, whiteSpace: 'nowrap' }}
          >
            {suggesting ? '⟳' : '✦ suggest'}
          </button>

          {/* New tag toggle */}
          <button
            onClick={() => { setShowNew(v => !v); setNewName(''); setNewDesc(''); setCreateError(''); }}
            title="Create a new tag"
            style={{ flexShrink: 0, background: showNew ? '#f0f0f0' : '#fafafa', border: '1px solid #ddd', color: '#555', padding: '0 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#bbb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#ddd'; }}
          >
            + new
          </button>

        </div>
      )}

      {/* At max message */}
      {atMax && (
        <div style={{ fontSize: '0.68rem', color: accentColor, fontFamily: 'monospace', marginTop: '0.25rem' }}>
          Max {maxTags} tags — remove one to add another
        </div>
      )}

      {/* Karl suggestions strip */}
      {suggestOpen && (suggestions.length > 0 || suggestError) && (
        <div style={{ marginTop: '0.55rem', padding: '0.55rem 0.65rem', background: accentBg, border: `1px solid ${accentBorder}`, borderRadius: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <div style={{ fontSize: '0.6rem', color: '#999', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Karl suggests</div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {suggestions.filter(s => !s.isNew).length > 1 && (
                <button
                  onClick={() => {
                    const toAdd = suggestions.filter(s => !s.isNew && !selected.includes(s.name)).map(s => s.name);
                    onChange([...selected, ...toAdd].slice(0, maxTags));
                    setSuggestions(prev => prev.filter(s => s.isNew));
                  }}
                  style={{ fontSize: '0.62rem', color: accentColor, background: 'none', border: `1px solid ${accentBorder}`, borderRadius: '3px', padding: '0.1rem 0.4rem', cursor: 'pointer', fontFamily: 'monospace' }}
                >accept all</button>
              )}
              <button onClick={runSuggest} disabled={suggesting}
                style={{ fontSize: '0.62rem', color: '#aaa', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace' }}
              >{suggesting ? '⟳' : '↺ retry'}</button>
              <span onClick={() => setSuggestOpen(false)} style={{ fontSize: '0.65rem', color: '#ccc', cursor: 'pointer' }}>✕</span>
            </div>
          </div>

          {suggestError && (
            <div style={{ fontSize: '0.68rem', color: '#ef4444', fontFamily: 'monospace' }}>{suggestError}</div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {suggestions.map(s => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <span
                  onClick={() => acceptSuggestion(s)}
                  title={s.isNew ? 'New tag — click to create and add' : 'Click to add'}
                  style={{ fontSize: '0.72rem', color: s.isNew ? '#fff' : accentColor, background: s.isNew ? accentColor : '#fff', border: `1px solid ${accentColor}`, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: atMax ? 'not-allowed' : 'pointer', fontFamily: 'monospace', opacity: atMax ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                >
                  {s.isNew && <span style={{ fontSize: '0.58rem', opacity: 0.8 }}>+new</span>}
                  {s.name}
                </span>
                <span onClick={() => setSuggestions(prev => prev.filter(x => x.name !== s.name))}
                  style={{ fontSize: '0.6rem', color: '#ccc', cursor: 'pointer' }}>✕</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline new tag form */}
      {showNew && (
        <div style={{ marginTop: '0.55rem', padding: '0.65rem 0.75rem', background: '#fafafa', border: '1px solid #e5e5e5', borderRadius: '4px' }}>
          <div style={{ fontSize: '0.6rem', color: '#aaa', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
            New tag
          </div>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Tag name"
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNew(false); }}
            style={{ ...inputStyle, marginBottom: '0.4rem', fontSize: '0.78rem' }}
            onFocusCapture={e => (e.target.style.borderColor = accentColor)}
            onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
          />
          <input
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            onKeyDown={e => { if (e.key === 'Escape') setShowNew(false); }}
            style={{ ...inputStyle, marginBottom: '0.5rem', fontSize: '0.78rem' }}
            onFocusCapture={e => (e.target.style.borderColor = accentColor)}
            onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
          />
          {createError && (
            <div style={{ fontSize: '0.68rem', color: '#ef4444', fontFamily: 'monospace', marginBottom: '0.4rem' }}>{createError}</div>
          )}
          <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowNew(false)}
              style={{ background: 'none', border: '1px solid #ddd', color: '#888', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer' }}
            >cancel</button>
            <button onClick={handleCreate} disabled={creating || !newName.trim()}
              style={{ background: accentColor, border: `1px solid ${accentColor}`, color: '#000', padding: '0.3rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 600, cursor: creating || !newName.trim() ? 'not-allowed' : 'pointer', opacity: creating || !newName.trim() ? 0.5 : 1 }}
            >
              {creating ? 'creating...' : '+ create & add'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fff', border: '1px solid #ddd',
  color: '#222', padding: '0.45rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
