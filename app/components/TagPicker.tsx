'use client';

// app/components/TagPicker.tsx
// KarlOps L — Shared tag picker with Karl inline suggestion
// Used across all FC objects that have tags
//
// Props:
//   selected       — currently selected tag names
//   allTags        — full tag list from DB
//   tagGroups      — tag groups from DB
//   onChange       — called with new tag array on any change
//   onTagCreated   — called when a new tag is created in DB — parent should reload allTags
//   accentColor    — modal accent color for focus/highlight states
//   objectType     — FC object type ('task' | 'meeting' | 'completion' | 'external_reference' | 'document_template')
//   contextText    — title + description text for Karl to suggest from
//   accessToken    — for Karl suggest API call
//   userId         — for creating new tags in DB
//   maxTags        — max tags allowed (default 5)
//   label          — field label (default 'Tags')

import { useState, useRef } from 'react';
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

interface KarlSuggestion {
  name: string;
  isNew: boolean;
  group?: string;
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
  onSuggestInvoked?: () => void;
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
  onSuggestInvoked,
}: TagPickerProps) {

  const [search, setSearch]                         = useState('');
  const [groupId, setGroupId]                       = useState('');
  const [showDrop, setShowDrop]                     = useState(false);
  const [karlSuggestions, setKarlSuggestions]       = useState<KarlSuggestion[]>([]);
  const [suggesting, setSuggesting]                 = useState(false);
  const [creatingTag, setCreatingTag]               = useState<string | null>(null);
  const [suggestError, setSuggestError]             = useState('');
  const [hasAutoSuggested, setHasAutoSuggested]     = useState(false);
  const [showSuggestions, setShowSuggestions]       = useState(false);
  const autoSuggestTimer                            = useRef<ReturnType<typeof setTimeout> | null>(null);

  const atMax = selected.length >= maxTags;

  // ─── Filtered tag list for dropdown ──────────────────────────────────────

  const filtered = allTags.filter(t =>
    (groupId ? t.tag_group_id === groupId : true) &&
    (search ? t.name.toLowerCase().includes(search.toLowerCase()) : true) &&
    !selected.includes(t.name)
  );

  // ─── Toggle existing tag ──────────────────────────────────────────────────

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter(t => t !== name));
    } else {
      if (atMax) return;
      onChange([...selected, name]);
    }
    setKarlSuggestions(prev => prev.filter(s => s.name !== name));
  };

  // ─── Accept a Karl suggestion ─────────────────────────────────────────────

  const acceptSuggestion = async (s: KarlSuggestion) => {
    if (atMax) return;

    if (!s.isNew) {
      // Existing tag — just add it
      onChange([...selected, s.name]);
      setKarlSuggestions(prev => prev.filter(x => x.name !== s.name));
      return;
    }

    // New tag — create in DB first
    setCreatingTag(s.name);
    try {
      // Resolve group_id — fall back to General group if not found
      let targetGroupId = s.group_id ?? null;
      if (!targetGroupId) {
        const generalGroup = tagGroups.find(g => g.name === 'General');
        targetGroupId = generalGroup?.tag_group_id ?? tagGroups[0]?.tag_group_id ?? null;
      }

      const { error } = await supabase.from('tag').insert({
        user_id:      userId,
        tag_group_id: targetGroupId,
        name:         s.name,
        description:  s.description ?? null,
        is_archived:  false,
      });

      if (error) throw error;

      // Add to selected
      onChange([...selected, s.name]);

      // Notify parent to reload allTags
      onTagCreated?.();

    } catch (e: any) {
      setSuggestError(`Couldn't create tag "${s.name}" — ${e.message}`);
    } finally {
      setCreatingTag(null);
      setKarlSuggestions(prev => prev.filter(x => x.name !== s.name));
    }
  };

  const dismissSuggestion = (name: string) => {
    setKarlSuggestions(prev => prev.filter(s => s.name !== name));
  };

  // ─── Auto-suggest on blur (existing tags only) ────────────────────────────

  const autoSuggest = () => {
    // Runs silently in background — results only shown when user hits suggest
    if (hasAutoSuggested) return;
    if (!contextText.trim() || contextText.trim().length < 10) return;
    if (autoSuggestTimer.current) clearTimeout(autoSuggestTimer.current);
    autoSuggestTimer.current = setTimeout(() => {
      setHasAutoSuggested(true);
      // Don't call runSuggest here — wait for manual trigger
    }, 600);
  };

  // ─── Manual suggest (can propose new tags) ────────────────────────────────

  const manualSuggest = () => {
    setHasAutoSuggested(true);
    setShowSuggestions(true);
    onSuggestInvoked?.();
    runSuggest(true);
  };

  // ─── Core suggest call ────────────────────────────────────────────────────

  const runSuggest = async (isManual: boolean) => {
    if (suggesting) return;
    setSuggesting(true);
    setSuggestError('');
    setKarlSuggestions([]);

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

      const suggestions: KarlSuggestion[] = [];

      // Existing tag suggestions
      for (const name of (data.suggested ?? [])) {
        if (!selected.includes(name) && allTags.find(t => t.name === name)) {
          suggestions.push({ name, isNew: false });
        }
      }

      // New tag ideas — manual only
      if (isManual) {
        for (const idea of (data.new_tag_ideas ?? [])) {
          if (!selected.includes(idea.name) && !allTags.find(t => t.name === idea.name)) {
            suggestions.push({
              name:        idea.name,
              isNew:       true,
              group:       idea.group,
              group_id:    idea.group_id,
              description: idea.description,
            });
          }
        }
      }

      setKarlSuggestions(suggestions);
    } catch (e: any) {
      setSuggestError("Karl couldn't suggest tags right now.");
    } finally {
      setSuggesting(false);
    }
  };

  // ─── Accent helpers ───────────────────────────────────────────────────────

  const accentBg     = `${accentColor}15`;
  const accentBorder = `${accentColor}40`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ marginBottom: '0.85rem' }}>

      {/* Label + count */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
        <div style={{ color: '#000', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          {label}
        </div>
        <div style={{ fontSize: '0.62rem', color: atMax ? accentColor : '#aaa', fontFamily: 'monospace' }}>
          {selected.length}/{maxTags}
        </div>
      </div>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
          {selected.map(name => (
            <span key={name} onClick={() => toggle(name)}
              style={{ fontSize: '0.72rem', color: '#fff', background: accentColor, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
            >
              {name} <span style={{ opacity: 0.8 }}>✕</span>
            </span>
          ))}
        </div>
      )}

      {/* Picker row */}
      {!atMax && (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select value={groupId} onChange={e => setGroupId(e.target.value)}
            style={{ ...inputStyle, flex: '0 0 120px', fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}
          >
            <option value="">All groups</option>
            {tagGroups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
          </select>

          <div style={{ position: 'relative', flex: 1 }}>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              onBlur={() => { setTimeout(() => setShowDrop(false), 150); autoSuggest(); }}
              placeholder="Search tags..."
              style={{ ...inputStyle, marginBottom: 0 }}
              onFocusCapture={e => (e.target.style.borderColor = accentColor)}
              onBlurCapture={e => (e.target.style.borderColor = '#ddd')}
            />
            {showDrop && filtered.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: '4px', zIndex: 9999, maxHeight: '160px', overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
                {filtered.map(tag => (
                  <div key={tag.tag_id} onMouseDown={() => { toggle(tag.name); setSearch(''); }}
                    style={{ padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#333', cursor: 'pointer', borderBottom: '1px solid #f5f5f5', fontFamily: 'monospace' }}
                    onMouseEnter={e => (e.currentTarget.style.background = accentBg)}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    {tag.name}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Suggest button */}
          <button onClick={manualSuggest} disabled={suggesting || !contextText.trim()}
            title="Ask Karl to suggest tags"
            style={{ flexShrink: 0, background: suggesting ? accentBg : accentBg, border: `2px solid ${suggesting ? accentColor : accentBorder}`, color: accentColor, padding: '0.35rem 0.6rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: suggesting || !contextText.trim() ? 'not-allowed' : 'pointer', opacity: !contextText.trim() ? 0.4 : 1, transition: 'all 0.2s', whiteSpace: 'nowrap', fontWeight: suggesting ? 700 : 400 }}
          >
            {suggesting ? '⟳ thinking...' : '✦ suggest'}
          </button>
        </div>
      )}

      {/* At max */}
      {atMax && (
        <div style={{ fontSize: '0.68rem', color: accentColor, fontFamily: 'monospace', marginTop: '0.25rem' }}>
          Max {maxTags} tags — remove one to add another
        </div>
      )}

      {/* Karl suggestions strip */}
      {showSuggestions && karlSuggestions.length > 0 && (
        <div style={{ marginTop: '0.6rem', padding: '0.5rem 0.65rem', background: accentBg, border: `1px solid ${accentBorder}`, borderRadius: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <div style={{ fontSize: '0.62rem', color: '#888', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Karl suggests:</div>
            {karlSuggestions.filter(s => !s.isNew).length > 1 && (
              <button
                onClick={() => {
                  const toAdd = karlSuggestions.filter(s => !s.isNew && !selected.includes(s.name)).map(s => s.name);
                  const newSelected = [...selected, ...toAdd].slice(0, maxTags);
                  onChange(newSelected);
                  setKarlSuggestions(prev => prev.filter(s => s.isNew));
                }}
                style={{ fontSize: '0.62rem', color: accentColor, background: 'none', border: `1px solid ${accentBorder}`, borderRadius: '3px', padding: '0.1rem 0.4rem', cursor: 'pointer', fontFamily: 'monospace' }}
              >accept all</button>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {karlSuggestions.map(s => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <span
                  onClick={() => acceptSuggestion(s)}
                  title={s.isNew ? `Create new tag in ${s.group ?? 'General'} — ${s.description ?? ''}` : 'Click to add'}
                  style={{ fontSize: '0.72rem', color: s.isNew ? '#fff' : accentColor, background: s.isNew ? accentColor : '#fff', border: `1px solid ${accentColor}`, borderRadius: '3px', padding: '0.15rem 0.4rem', cursor: atMax || creatingTag === s.name ? 'not-allowed' : 'pointer', fontFamily: 'monospace', opacity: atMax ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                >
                  {creatingTag === s.name ? (
                    <span style={{ fontSize: '0.65rem' }}>creating...</span>
                  ) : (
                    <>
                      {s.isNew && (
                        <span style={{ fontSize: '0.58rem', opacity: 0.85, background: 'rgba(255,255,255,0.2)', borderRadius: '2px', padding: '0.05rem 0.2rem' }}>
                          +new {s.group ? `[${s.group}]` : ''}
                        </span>
                      )}
                      {s.name}
                    </>
                  )}
                </span>
                {creatingTag !== s.name && (
                  <span onClick={() => dismissSuggestion(s.name)}
                    style={{ fontSize: '0.65rem', color: '#aaa', cursor: 'pointer', lineHeight: 1 }}
                    title="Dismiss"
                  >✕</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {suggestError && (
        <div style={{ fontSize: '0.68rem', color: '#ef4444', fontFamily: 'monospace', marginTop: '0.35rem' }}>
          {suggestError}
        </div>
      )}

    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
