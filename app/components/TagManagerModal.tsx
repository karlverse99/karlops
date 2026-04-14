'use client';

// app/components/TagManagerModal.tsx
// KarlOps L — Lightweight tag manager
// Create tags and groups, Karl suggest for new tags
// Accessible from TagPicker ⚙ button and chat command

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

interface Tag { tag_id: string; name: string; tag_group_id: string; description: string | null; }
interface TagGroup { tag_group_id: string; name: string; description: string | null; display_order: number; }

interface Props {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onChanged?: () => void; // parent reloads tags after changes
}

const ACCENT        = '#6366f1'; // indigo — distinct from all FC modals
const ACCENT_BG     = '#eef2ff';
const ACCENT_BORDER = '#c7d2fe';

export default function TagManagerModal({ userId, accessToken, onClose, onChanged }: Props) {

  const [tags, setTags]             = useState<Tag[]>([]);
  const [groups, setGroups]         = useState<TagGroup[]>([]);
  const [loading, setLoading]       = useState(true);
  const [activeGroup, setActiveGroup] = useState<string>('');

  // ─── New tag form ─────────────────────────────────────────────────────────
  const [newTagName, setNewTagName]         = useState('');
  const [newTagGroup, setNewTagGroup]       = useState('');
  const [newTagDesc, setNewTagDesc]         = useState('');
  const [savingTag, setSavingTag]           = useState(false);
  const [tagErr, setTagErr]                 = useState('');

  // ─── New group form ───────────────────────────────────────────────────────
  const [showGroupForm, setShowGroupForm]   = useState(false);
  const [newGroupName, setNewGroupName]     = useState('');
  const [newGroupDesc, setNewGroupDesc]     = useState('');
  const [savingGroup, setSavingGroup]       = useState(false);
  const [groupErr, setGroupErr]             = useState('');

  // ─── Karl suggest ─────────────────────────────────────────────────────────
  const [karlContext, setKarlContext]       = useState('');
  const [suggesting, setSuggesting]         = useState(false);
  const [suggestions, setSuggestions]       = useState<{ name: string; group: string; group_id: string | null; description: string }[]>([]);
  const [suggestErr, setSuggestErr]         = useState('');
  const [showSuggest, setShowSuggest]       = useState(false);

  // ─── Drag/resize ─────────────────────────────────────────────────────────
  const initX = Math.max(20, Math.round(window.innerWidth  / 2 - 480));
  const initY = Math.max(20, Math.round(window.innerHeight / 2 - 360));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 680, h: 620 });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragStart       = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeStart     = useRef({ mx: 0, my: 0, w: 0, h: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.mx), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.my) });
      if (resizing.current) setSize({ w: Math.max(500, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)) });
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Load ─────────────────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    const [tagRes, groupRes] = await Promise.all([
      supabase.from('tag').select('tag_id, name, tag_group_id, description').eq('user_id', userId).eq('is_archived', false).order('name'),
      supabase.from('tag_group').select('tag_group_id, name, description, display_order').eq('user_id', userId).eq('is_archived', false).order('display_order'),
    ]);
    setTags(tagRes.data ?? []);
    setGroups(groupRes.data ?? []);
    if (!newTagGroup && groupRes.data?.length) setNewTagGroup(groupRes.data[0].tag_group_id);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // ─── Save tag ─────────────────────────────────────────────────────────────

  const handleSaveTag = async () => {
    if (!newTagName.trim()) { setTagErr('Name required'); return; }
    if (!newTagGroup) { setTagErr('Group required'); return; }
    setSavingTag(true); setTagErr('');
    const { error } = await supabase.from('tag').insert({
      user_id: userId, name: newTagName.trim(), tag_group_id: newTagGroup,
      description: newTagDesc.trim() || null, is_archived: false,
    });
    if (error) { setTagErr(error.message); setSavingTag(false); return; }
    setNewTagName(''); setNewTagDesc('');
    await load();
    onChanged?.();
    setSavingTag(false);
  };

  // ─── Save group ───────────────────────────────────────────────────────────

  const handleSaveGroup = async () => {
    if (!newGroupName.trim()) { setGroupErr('Name required'); return; }
    setSavingGroup(true); setGroupErr('');
    const maxOrder = Math.max(0, ...groups.map(g => g.display_order));
    const { error } = await supabase.from('tag_group').insert({
      user_id: userId, name: newGroupName.trim(),
      description: newGroupDesc.trim() || null, display_order: maxOrder + 1, is_archived: false,
    });
    if (error) { setGroupErr(error.message); setSavingGroup(false); return; }
    setNewGroupName(''); setNewGroupDesc(''); setShowGroupForm(false);
    await load();
    onChanged?.();
    setSavingGroup(false);
  };

  // ─── Karl suggest ─────────────────────────────────────────────────────────

  const handleSuggest = async () => {
    if (!karlContext.trim()) return;
    setSuggesting(true); setSuggestErr(''); setSuggestions([]);
    try {
      const res = await fetch('/api/ko/suggest-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ mode: 'admin', context_text: karlContext }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Filter out already existing tags
      const existingNames = new Set(tags.map(t => t.name.toLowerCase()));
      const fresh = (data.suggestions ?? []).filter((s: any) => !existingNames.has(s.name.toLowerCase()));
      setSuggestions(fresh);
    } catch (e: any) {
      setSuggestErr("Karl couldn't suggest right now.");
    } finally {
      setSuggesting(false);
    }
  };

  const acceptSuggestion = async (s: typeof suggestions[0]) => {
    // Resolve group
    const group = groups.find(g => g.name.toLowerCase() === s.group.toLowerCase());
    const groupId = group?.tag_group_id ?? groups.find(g => g.name === 'General')?.tag_group_id ?? groups[0]?.tag_group_id ?? null;
    if (!groupId) return;
    const { error } = await supabase.from('tag').insert({
      user_id: userId, name: s.name, tag_group_id: groupId,
      description: s.description || null, is_archived: false,
    });
    if (!error) {
      setSuggestions(prev => prev.filter(x => x.name !== s.name));
      await load();
      onChanged?.();
    }
  };

  // ─── Derived ─────────────────────────────────────────────────────────────

  const filteredTags = activeGroup
    ? tags.filter(t => t.tag_group_id === activeGroup)
    : tags;

  const groupMap: Record<string, string> = {};
  for (const g of groups) groupMap[g.tag_group_id] = g.name;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#fff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', overflow: 'hidden', pointerEvents: 'all' }}>

        {/* HEADER */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700 }}>Tag Manager</span>
            <span style={{ color: '#fff', fontSize: '0.72rem', opacity: 0.7 }}>{tags.length} tags · {groups.length} groups</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', opacity: 0.7 }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
          >✕</button>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* LEFT — tag list */}
          <div style={{ width: '260px', flexShrink: 0, borderRight: `1px solid ${ACCENT_BORDER}`, display: 'flex', flexDirection: 'column' }}>

            {/* Group filter */}
            <div style={{ padding: '0.65rem 0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}` }}>
              <select value={activeGroup} onChange={e => setActiveGroup(e.target.value)}
                style={{ ...inputStyle, fontSize: '0.72rem', padding: '0.35rem 0.5rem' }}>
                <option value="">All groups</option>
                {groups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
              </select>
            </div>

            {/* Tag list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading ? (
                <div style={{ color: '#aaa', fontSize: '0.75rem', padding: '1rem' }}>Loading...</div>
              ) : filteredTags.length === 0 ? (
                <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem' }}>No tags yet.</div>
              ) : (
                filteredTags.map(t => (
                  <div key={t.tag_id} style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f5f5f5' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.6rem', background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '2px', padding: '0.05rem 0.25rem', flexShrink: 0 }}>
                        {groupMap[t.tag_group_id] ?? '?'}
                      </span>
                      <span style={{ fontSize: '0.78rem', color: '#222', fontWeight: 500 }}>{t.name}</span>
                    </div>
                    {t.description && (
                      <div style={{ fontSize: '0.65rem', color: '#aaa', marginTop: '0.15rem', paddingLeft: '0.25rem' }}>{t.description}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* RIGHT — forms + suggest */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            {/* Add tag form */}
            <div>
              <div style={sectionLabel}>Add Tag</div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input value={newTagName} onChange={e => setNewTagName(e.target.value)}
                  placeholder="Tag name"
                  style={{ ...inputStyle, flex: 1 }}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveTag(); }}
                />
                <select value={newTagGroup} onChange={e => setNewTagGroup(e.target.value)}
                  style={{ ...inputStyle, flex: '0 0 130px' }}
                  onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                >
                  {groups.map(g => <option key={g.tag_group_id} value={g.tag_group_id}>{g.name}</option>)}
                </select>
              </div>
              <input value={newTagDesc} onChange={e => setNewTagDesc(e.target.value)}
                placeholder="Description (optional)"
                style={{ ...inputStyle, marginBottom: '0.5rem', fontSize: '0.78rem', color: '#666' }}
                onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveTag(); }}
              />
              {tagErr && <div style={{ color: '#ef4444', fontSize: '0.68rem', marginBottom: '0.4rem' }}>{tagErr}</div>}
              <button onClick={handleSaveTag} disabled={savingTag || !newTagName.trim()}
                style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: !newTagName.trim() ? 'not-allowed' : 'pointer', opacity: !newTagName.trim() ? 0.5 : 1, fontWeight: 600 }}
              >{savingTag ? 'saving...' : '+ add tag'}</button>
            </div>

            {/* Add group */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={sectionLabel}>Add Group</div>
                <button onClick={() => setShowGroupForm(v => !v)}
                  style={{ fontSize: '0.65rem', color: ACCENT, background: 'none', border: `1px solid ${ACCENT_BORDER}`, borderRadius: '3px', padding: '0.1rem 0.4rem', cursor: 'pointer', fontFamily: 'monospace' }}
                >{showGroupForm ? '▲ hide' : '▼ show'}</button>
              </div>
              {showGroupForm && (
                <>
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                    placeholder="Group name"
                    style={{ ...inputStyle, marginBottom: '0.5rem' }}
                    onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveGroup(); }}
                  />
                  <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)}
                    placeholder="Description (optional — Karl reads this)"
                    style={{ ...inputStyle, marginBottom: '0.5rem', fontSize: '0.78rem', color: '#666' }}
                    onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveGroup(); }}
                  />
                  {groupErr && <div style={{ color: '#ef4444', fontSize: '0.68rem', marginBottom: '0.4rem' }}>{groupErr}</div>}
                  <button onClick={handleSaveGroup} disabled={savingGroup || !newGroupName.trim()}
                    style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: !newGroupName.trim() ? 'not-allowed' : 'pointer', opacity: !newGroupName.trim() ? 0.5 : 1, fontWeight: 600 }}
                  >{savingGroup ? 'saving...' : '+ add group'}</button>
                </>
              )}
            </div>

            {/* Karl suggest */}
            <div style={{ borderTop: `1px solid ${ACCENT_BORDER}`, paddingTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={sectionLabel}>Karl Suggest</div>
                <button onClick={() => setShowSuggest(v => !v)}
                  style={{ fontSize: '0.65rem', color: ACCENT, background: 'none', border: `1px solid ${ACCENT_BORDER}`, borderRadius: '3px', padding: '0.1rem 0.4rem', cursor: 'pointer', fontFamily: 'monospace' }}
                >{showSuggest ? '▲ hide' : '▼ show'}</button>
              </div>
              {showSuggest && (
                <>
                  <div style={{ fontSize: '0.68rem', color: '#888', marginBottom: '0.5rem' }}>
                    Tell Karl what you're working on — he'll suggest new tags to add to your vocabulary.
                  </div>
                  <textarea value={karlContext} onChange={e => setKarlContext(e.target.value)}
                    placeholder="e.g. I'm starting a new client project for ABC Corp, doing social media analytics and content strategy..."
                    rows={3} style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.5rem', fontSize: '0.78rem' }}
                    onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}
                  />
                  <button onClick={handleSuggest} disabled={suggesting || !karlContext.trim()}
                    style={{ background: suggesting ? '#f5f5f5' : ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, padding: '0.4rem 0.9rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: suggesting || !karlContext.trim() ? 'not-allowed' : 'pointer', opacity: !karlContext.trim() ? 0.5 : 1 }}
                  >{suggesting ? '⟳ thinking...' : '✦ suggest tags'}</button>

                  {suggestErr && <div style={{ color: '#ef4444', fontSize: '0.68rem', marginTop: '0.5rem' }}>{suggestErr}</div>}

                  {suggestions.length > 0 && (
                    <div style={{ marginTop: '0.75rem', padding: '0.65rem', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '4px' }}>
                      <div style={{ fontSize: '0.62rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Karl suggests — click to add:</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {suggestions.map(s => (
                          <div key={s.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem', background: '#fff', border: '1px solid #e5e5e5', borderRadius: '4px' }}>
                            <div>
                              <span style={{ fontSize: '0.78rem', color: '#222', fontWeight: 500 }}>{s.name}</span>
                              <span style={{ fontSize: '0.65rem', color: '#888', marginLeft: '0.5rem' }}>[{s.group}]</span>
                              {s.description && <div style={{ fontSize: '0.65rem', color: '#aaa', marginTop: '0.1rem' }}>{s.description}</div>}
                            </div>
                            <button onClick={() => acceptSuggestion(s)}
                              style={{ background: ACCENT, border: 'none', color: '#fff', padding: '0.25rem 0.6rem', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.68rem', cursor: 'pointer', flexShrink: 0, marginLeft: '0.5rem' }}
                            >+ add</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>

        {/* RESIZE */}
        <div onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>

      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};

const sectionLabel: React.CSSProperties = {
  fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  fontWeight: 700, color: '#000', marginBottom: '0.5rem',
};
