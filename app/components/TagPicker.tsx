'use client';

// app/components/TagPicker.tsx
// KarlOps L — Three-layer tag picker
// v0.7.0 — search | Karl suggest | browse panel (fixed-position, group filter + create)

import { useState, useRef, useEffect } from 'react';
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

  // ─── Search ───────────────────────────────────────────────────────────────
  const [search, setSearch]     = useState('');
  const [showDrop, setShowDrop] = useState(false);

  // ─── Karl suggest ─────────────────────────────────────────────────────────
  const [suggestions, setSuggestions]   = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting]     = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [suggestOpen, setSuggestOpen]   = useState(false);
  const [creating, setCreating]         = useState(false);

  // ─── Browse panel ─────────────────────────────────────────────────────────
  const [browseOpen, setBrowseOpen]         = useState(false);
  const [browseGroup, setBrowseGroup]       = useState<string>('all');
  const [browseSearch, setBrowseSearch]     = useState('');
  const [newName, setNewName]               = useState('');
  const [newDesc, setNewDesc]               = useState('');
  const [newGroupId, setNewGroupId]         = useState('');
  const [createError, setCreateError]       = useState('');
  const [creating2, setCreating2]           = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const browseAnchorRef = useRef<HTMLDivElement>(null);
  const browseRef       = useRef<HTMLDivElement>(null);
  const [browsePos, setBrowsePos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);

  const atMax        = selected.length >= maxTags;
  const accentBg     = `${accentColor}12`;
  const accentBorder = `${accentColor}40`;

  const generalGroupId =
    tagGroups.find(g => g.name === 'General')?.tag_group_id ??
    tagGroups[0]?.tag_group_id ??
    null;

  // ─── Position browse panel ────────────────────────────────────────────────

  const PANEL_W = 380;
  const PANEL_H = 340;

  const openBrowse = () => {
    if (browseAnchorRef.current) {
      const rect        = browseAnchorRef.current.getBoundingClientRect();
      const vw          = window.innerWidth;
      const vh          = window.innerHeight;
      const spaceRight  = vw - rect.right - 8;
      const spaceLeft   = rect.left - 8;

      // Prefer right side of viewport; fall back to left, then best fit
      const left = spaceRight >= PANEL_W
        ? rect.right + 8
        : spaceLeft >= PANEL_W
          ? rect.left - PANEL_W - 8
          : Math.max(8, vw - PANEL_W - 8);

      // Open downward if room, otherwise flip up
      const pos: { top?: number; bottom?: number; left: number; width: number } = { left, width: PANEL_W };
      if (vh - rect.bottom - 8 >= PANEL_H) {
        pos.top = rect.bottom + 4;
      } else {
        pos.bottom = vh - rect.top + 4;
      }
      setBrowsePos(pos);
    }
    setBrowseGroup('all');
    setBrowseSearch('');
    setNewName('');
    setNewDesc('');
    setNewGroupId(generalGroupId ?? '');
    setCreateError('');
    setShowCreateForm(false);
    setBrowseOpen(true);
  };

  // Close browse on outside click
  useEffect(() => {
    if (!browseOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        browseRef.current && !browseRef.current.contains(e.target as Node) &&
        browseAnchorRef.current && !browseAnchorRef.current.contains(e.target as Node)
      ) {
        setBrowseOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [browseOpen]);

  // ─── Filtered search dropdown ─────────────────────────────────────────────

  const filtered = allTags.filter(t =>
    !selected.includes(t.name) &&
    (search ? t.name.toLowerCase().includes(search.toLowerCase()) : true)
  );

  // ─── Filtered browse tags ─────────────────────────────────────────────────

  const browseTags = allTags.filter(t => {
    const groupMatch = browseGroup === 'all' || t.tag_group_id === browseGroup;
    const searchMatch = browseSearch
      ? t.name.toLowerCase().includes(browseSearch.toLowerCase())
      : true;
    return groupMatch && searchMatch;
  });

  // ─── Add / remove ─────────────────────────────────────────────────────────

  const add = (name: string) => {
    if (atMax || selected.includes(name)) return;
    onChange([...selected, name]);
    setSuggestions(prev => prev.filter(s => s.name !== name));
    setSearch('');
    setShowDrop(false);
  };

  const remove = (name: string) => onChange(selected.filter(t => t !== name));

  const toggleBrowse = (name: string) => {
    if (selected.includes(name)) {
      remove(name);
    } else {
      add(name);
    }
  };

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

  // ─── Accept individual suggestion ─────────────────────────────────────────

  const acceptSuggestion = async (s: Suggestion) => {
    if (atMax) return;
    if (!s.isNew) { add(s.name); return; }
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
    } catch {
      setSuggestError(`Couldn't create "${s.name}"`);
    } finally {
      setCreating(false);
      setSuggestions(prev => prev.filter(x => x.name !== s.name));
    }
  };

  const acceptRemaining = () => {
    const toAdd = suggestions
      .filter(s => !s.isNew && !selected.includes(s.name))
      .map(s => s.name);
    if (toAdd.length > 0) onChange([...selected, ...toAdd].slice(0, maxTags));
    setSuggestions(prev => prev.filter(s => s.isNew));
  };

  const dismissSuggestion = (name: string) =>
    setSuggestions(prev => prev.filter(s => s.name !== name));

  // ─── Create new tag (from browse panel) ──────────────────────────────────

  const handleCreate = async () => {
    if (!newName.trim() || creating2) return;
    setCreating2(true);
    setCreateError('');
    try {
      const { error } = await supabase.from('tag').insert({
        user_id:      userId,
        tag_group_id: newGroupId || generalGroupId,
        name:         newName.trim(),
        description:  newDesc.trim() || null,
        is_archived:  false,
      });
      if (error) throw error;
      if (!atMax) onChange([...selected, newName.trim()]);
      onTagCreated?.();
      setNewName('');
      setNewDesc('');
      setShowCreateForm(false);
    } catch (e: any) {
      setCreateError(e.message ?? 'Could not create tag');
    } finally {
      setCreating2(false);
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

      {/* Search + action buttons */}
      {!atMax && (
        <div ref={browseAnchorRef} style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch' }}>

          {/* Search input */}
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
            {suggesting ? '⟳' : suggestOpen ? '↺ retry' : '✦ suggest'}
          </button>

          {/* Browse */}
          <button
            onClick={() => browseOpen ? setBrowseOpen(false) : openBrowse()}
            title="Browse all tags by group"
            style={{ flexShrink: 0, background: browseOpen ? '#f0f0f0' : '#fafafa', border: `1px solid ${browseOpen ? '#bbb' : '#ddd'}`, color: '#555', padding: '0 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >⊞ browse</button>

        </div>
      )}

      {/* At max */}
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
              {suggestions.length > 0 && (
                <button
                  onClick={acceptRemaining}
                  style={{ fontSize: '0.62rem', color: accentColor, background: 'none', border: `1px solid ${accentBorder}`, borderRadius: '3px', padding: '0.1rem 0.4rem', cursor: 'pointer', fontFamily: 'monospace' }}
                >accept</button>
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
                <span onClick={() => dismissSuggestion(s.name)} style={{ fontSize: '0.6rem', color: '#ccc', cursor: 'pointer' }}>✕</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Browse panel — fixed position, escapes modal clipping ── */}
      {browseOpen && browsePos && (
        <div
          ref={browseRef}
          style={{
            position: 'fixed',
            ...(browsePos.top    !== undefined ? { top:    browsePos.top    } : {}),
            ...(browsePos.bottom !== undefined ? { bottom: browsePos.bottom } : {}),
            left:     browsePos.left,
            width:    browsePos.width,
            zIndex:   99999,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '6px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '340px',
            overflow: 'hidden',
          }}
        >
          {/* Panel header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
            <span style={{ fontSize: '0.6rem', color: '#999', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Browse tags</span>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                value={browseSearch}
                onChange={e => setBrowseSearch(e.target.value)}
                placeholder="filter..."
                style={{ ...inputStyle, width: '110px', marginBottom: 0, fontSize: '0.72rem', padding: '0.2rem 0.4rem' }}
                onFocusCapture={e => (e.target.style.borderColor = accentColor)}
                onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
              />
              <span onClick={() => setBrowseOpen(false)} style={{ fontSize: '0.75rem', color: '#ccc', cursor: 'pointer', lineHeight: 1 }}>✕</span>
            </div>
          </div>

          {/* Body: group list + tag list */}
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

            {/* Group column */}
            <div style={{ width: '110px', flexShrink: 0, borderRight: '1px solid #f0f0f0', overflowY: 'auto', padding: '0.3rem 0' }}>
              {[{ tag_group_id: 'all', name: 'All' }, ...tagGroups].map(g => (
                <div
                  key={g.tag_group_id}
                  onClick={() => setBrowseGroup(g.tag_group_id)}
                  style={{
                    padding: '0.3rem 0.65rem',
                    fontSize: '0.72rem',
                    fontFamily: 'monospace',
                    cursor: 'pointer',
                    color: browseGroup === g.tag_group_id ? accentColor : '#555',
                    background: browseGroup === g.tag_group_id ? accentBg : 'transparent',
                    borderLeft: browseGroup === g.tag_group_id ? `2px solid ${accentColor}` : '2px solid transparent',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {g.name}
                </div>
              ))}
            </div>

            {/* Tag list column */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.3rem 0' }}>
              {browseTags.length === 0 ? (
                <div style={{ padding: '0.6rem 0.75rem', fontSize: '0.72rem', color: '#bbb', fontFamily: 'monospace', fontStyle: 'italic' }}>
                  no tags in this group
                </div>
              ) : (
                browseTags.map(tag => {
                  const isSelected = selected.includes(tag.name);
                  return (
                    <div
                      key={tag.tag_id}
                      onClick={() => toggleBrowse(tag.name)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.5rem',
                        padding: '0.3rem 0.75rem',
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        cursor: !isSelected && atMax ? 'not-allowed' : 'pointer',
                        color: isSelected ? accentColor : '#333',
                        background: isSelected ? accentBg : 'transparent',
                        opacity: !isSelected && atMax ? 0.4 : 1,
                      }}
                      onMouseEnter={e => { if (!isSelected && !atMax) e.currentTarget.style.background = '#f9f9f9'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Checkbox */}
                      <div style={{
                        width: '13px', height: '13px', flexShrink: 0,
                        border: `1.5px solid ${isSelected ? accentColor : '#ccc'}`,
                        borderRadius: '3px',
                        background: isSelected ? accentColor : '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {isSelected && <span style={{ fontSize: '0.55rem', color: '#fff', lineHeight: 1 }}>✓</span>}
                      </div>
                      {tag.name}
                    </div>
                  );
                })
              )}
            </div>

          </div>

          {/* Create new tag — collapsible footer */}
          <div style={{ borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
            <div
              onClick={() => setShowCreateForm(v => !v)}
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.68rem', color: '#888', fontFamily: 'monospace', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
            >
              <span style={{ fontSize: '0.75rem', color: accentColor }}>+</span>
              create new tag
              <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#ccc' }}>{showCreateForm ? '▲' : '▼'}</span>
            </div>

            {showCreateForm && (
              <div style={{ padding: '0 0.75rem 0.65rem' }}>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.35rem' }}>
                  <select
                    value={newGroupId}
                    onChange={e => setNewGroupId(e.target.value)}
                    style={{ ...inputStyle, marginBottom: 0, fontSize: '0.72rem', flex: '0 0 130px' }}
                  >
                    {tagGroups.map(g => (
                      <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>
                    ))}
                  </select>
                  <input
                    autoFocus
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Tag name"
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreateForm(false); }}
                    style={{ ...inputStyle, marginBottom: 0, fontSize: '0.72rem', flex: 1 }}
                    onFocusCapture={e => (e.target.style.borderColor = accentColor)}
                    onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
                  />
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <input
                    value={newDesc}
                    onChange={e => setNewDesc(e.target.value)}
                    placeholder="Description (optional)"
                    onKeyDown={e => { if (e.key === 'Escape') setShowCreateForm(false); }}
                    style={{ ...inputStyle, marginBottom: 0, fontSize: '0.72rem', flex: 1 }}
                    onFocusCapture={e => (e.target.style.borderColor = accentColor)}
                    onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
                  />
                  <button
                    onClick={handleCreate}
                    disabled={creating2 || !newName.trim()}
                    style={{ flexShrink: 0, background: accentColor, border: `1px solid ${accentColor}`, color: '#fff', padding: '0 0.75rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 600, cursor: creating2 || !newName.trim() ? 'not-allowed' : 'pointer', opacity: creating2 || !newName.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
                  >
                    {creating2 ? '...' : '+ add'}
                  </button>
                </div>
                {createError && (
                  <div style={{ fontSize: '0.65rem', color: '#ef4444', fontFamily: 'monospace', marginTop: '0.3rem' }}>{createError}</div>
                )}
              </div>
            )}
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
