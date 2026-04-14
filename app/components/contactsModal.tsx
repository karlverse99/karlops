'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface Contact {
  contact_id: string;
  name: string;
  email: string | null;
  primary_contact_method: string | null;
  contact_method_detail: string | null;
  role_tag_id: string | null;
  organization_tag_id: string | null;
  notes: string | null;
  tag_id: string | null;
  is_archived: boolean;
  created_at: string;
  role_tag?: { name: string; description: string | null } | null;
  org_tag?: { name: string; description: string | null } | null;
  people_tag?: { name: string } | null;
}

interface Tag {
  tag_id: string;
  name: string;
  tag_group_id: string;
  description: string | null;
}

interface TagGroup {
  tag_group_id: string;
  name: string;
}

interface ContactsModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange: (count: number) => void;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const ACCENT        = '#991b1b';
const ACCENT_BG     = '#fff5f5';
const ACCENT_BORDER = '#fecaca';

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function ContactsModal({ userId, accessToken, onClose, onCountChange }: ContactsModalProps) {

  const [mode, setMode]           = useState<'empty' | 'edit' | 'add'>('empty');
  const [contacts, setContacts]   = useState<Contact[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<Contact | null>(null);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const [search, setSearch]       = useState('');

  // ─── Tag data ──────────────────────────────────────────────────────────────
  const [allTags, setAllTags]         = useState<Tag[]>([]);
  const [tagGroups, setTagGroups]     = useState<TagGroup[]>([]);
  const [peopleGroupId, setPeopleGroupId]   = useState<string>('');
  const [rolesGroupId, setRolesGroupId]     = useState<string>('');
  const [orgsGroupId, setOrgsGroupId]       = useState<string>('');

  // ─── Form state ────────────────────────────────────────────────────────────
  const [formName, setFormName]                       = useState('');
  const [formEmail, setFormEmail]                     = useState('');
  const [formMethod, setFormMethod]                   = useState('');
  const [formMethodDetail, setFormMethodDetail]       = useState('');
  const [formRoleTagId, setFormRoleTagId]             = useState('');
  const [formOrgTagId, setFormOrgTagId]               = useState('');
  const [formNotes, setFormNotes]                     = useState('');
  const [editId, setEditId]                           = useState<string | null>(null);

  // ─── Drag/resize ───────────────────────────────────────────────────────────
  const initX = Math.max(20, Math.round(window.innerWidth  / 2 - 480));
  const initY = Math.max(20, Math.round(window.innerHeight / 2 - 340));
  const [pos, setPos]   = useState({ x: initX, y: initY });
  const [size, setSize] = useState({ w: 960, h: 680 });
  const dragging        = useRef(false);
  const resizing        = useRef(false);
  const dragStart       = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const resizeStart     = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const modalRef        = useRef<HTMLDivElement>(null);

  // ─── Load ──────────────────────────────────────────────────────────────────

  const loadContacts = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('contact')
      .select(`
        contact_id, name, email, primary_contact_method, contact_method_detail,
        role_tag_id, organization_tag_id, notes, tag_id, is_archived, created_at,
        role_tag:role_tag_id ( name, description ),
        org_tag:organization_tag_id ( name, description ),
        people_tag:tag_id ( name )
      `)
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('name');
    if (data) {
      setContacts(data as any);
      onCountChange(data.length);
    }
    setLoading(false);
  };

  const loadTags = async () => {
    const { data: groups } = await supabase
      .from('tag_group')
      .select('tag_group_id, name')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('display_order');
    if (groups) {
      setTagGroups(groups);
      setPeopleGroupId(groups.find(g => g.name === 'People')?.tag_group_id ?? '');
      setRolesGroupId(groups.find(g => g.name === 'Roles')?.tag_group_id ?? '');
      setOrgsGroupId(groups.find(g => g.name === 'Organizations')?.tag_group_id ?? '');
    }
    const { data: tags } = await supabase
      .from('tag')
      .select('tag_id, name, tag_group_id, description')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('name');
    if (tags) setAllTags(tags);
  };

  useEffect(() => { loadContacts(); loadTags(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.mx), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.my) });
      }
      if (resizing.current) {
        setSize({ w: Math.max(700, resizeStart.current.w + (e.clientX - resizeStart.current.mx)), h: Math.max(400, resizeStart.current.h + (e.clientY - resizeStart.current.my)) });
      }
    };
    const onUp = () => { dragging.current = false; resizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ─── Derived ───────────────────────────────────────────────────────────────

  const roleTags  = allTags.filter(t => t.tag_group_id === rolesGroupId);
  const orgTags   = allTags.filter(t => t.tag_group_id === orgsGroupId);

  const filtered = contacts.filter(c => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(s) ||
      (c.email ?? '').toLowerCase().includes(s) ||
      (c.notes ?? '').toLowerCase().includes(s)
    );
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const loadIntoForm = (c: Contact) => {
    setEditId(c.contact_id);
    setFormName(c.name);
    setFormEmail(c.email ?? '');
    setFormMethod(c.primary_contact_method ?? '');
    setFormMethodDetail(c.contact_method_detail ?? '');
    setFormRoleTagId(c.role_tag_id ?? '');
    setFormOrgTagId(c.organization_tag_id ?? '');
    setFormNotes(c.notes ?? '');
    setErr('');
    setConfirmDelete(false);
    setSelected(c);
    setMode('edit');
  };

  const openAdd = () => {
    setEditId(null);
    setFormName(''); setFormEmail(''); setFormMethod('');
    setFormMethodDetail(''); setFormRoleTagId('');
    setFormOrgTagId(''); setFormNotes('');
    setErr(''); setConfirmDelete(false);
    setSelected(null);
    setMode('add');
  };

  // Auto-create People tag for this contact
  const ensurePeopleTag = async (name: string): Promise<string | null> => {
    if (!peopleGroupId) return null;
    // Check if tag already exists
    const existing = allTags.find(t => t.name === name && t.tag_group_id === peopleGroupId);
    if (existing) return existing.tag_id;
    // Create it
    const { data, error } = await supabase
      .from('tag')
      .insert({ user_id: userId, tag_group_id: peopleGroupId, name, description: `Contact: ${name}`, is_archived: false })
      .select('tag_id')
      .single();
    if (error) { console.error('[ensurePeopleTag]', error); return null; }
    await loadTags(); // refresh tag list
    return data.tag_id;
  };

  const handleSave = async () => {
    if (!formName.trim()) { setErr('Name is required'); return; }
    setSaving(true); setErr('');

    try {
      if (mode === 'add') {
        const tag_id = await ensurePeopleTag(formName.trim());
        const { error } = await supabase.from('contact').insert({
          user_id: userId,
          name: formName.trim(),
          email: formEmail.trim() || null,
          primary_contact_method: formMethod.trim() || null,
          contact_method_detail: formMethodDetail.trim() || null,
          role_tag_id: formRoleTagId || null,
          organization_tag_id: formOrgTagId || null,
          notes: formNotes.trim() || null,
          tag_id,
        });
        if (error) throw error;
      } else if (mode === 'edit' && editId) {
        // If name changed, update the People tag too
        const contact = contacts.find(c => c.contact_id === editId);
        if (contact && contact.name !== formName.trim() && contact.tag_id) {
          await supabase.from('tag').update({ name: formName.trim(), description: `Contact: ${formName.trim()}` }).eq('tag_id', contact.tag_id);
        }
        const { error } = await supabase.from('contact').update({
          name: formName.trim(),
          email: formEmail.trim() || null,
          primary_contact_method: formMethod.trim() || null,
          contact_method_detail: formMethodDetail.trim() || null,
          role_tag_id: formRoleTagId || null,
          organization_tag_id: formOrgTagId || null,
          notes: formNotes.trim() || null,
        }).eq('contact_id', editId).eq('user_id', userId);
        if (error) throw error;
      }
      await loadContacts();
      setMode('empty'); setSelected(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editId) return;
    setDeleting(true); setErr('');
    try {
      const { error } = await supabase.from('contact').delete().eq('contact_id', editId).eq('user_id', userId);
      if (error) throw error;
      await loadContacts();
      setMode('empty'); setSelected(null); setConfirmDelete(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // ─── Render: left panel ────────────────────────────────────────────────────

  const renderLeft = () => (
    <div style={{ width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${ACCENT_BORDER}`, height: '100%' }}>

      {/* Search */}
      <div style={{ padding: '0.75rem', borderBottom: `1px solid ${ACCENT_BORDER}` }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search contacts..."
          style={{ ...inputStyle, fontSize: '0.75rem', padding: '0.4rem 0.6rem' }}
          onFocus={e => (e.target.style.borderColor = ACCENT)}
          onBlur={e => (e.target.style.borderColor = '#ddd')}
        />
        <div style={{ color: '#999', fontSize: '0.65rem', marginTop: '0.4rem', fontFamily: 'monospace' }}>
          {filtered.length} of {contacts.length}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#999', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: '0.75rem', padding: '1rem', fontFamily: 'monospace' }}>
            {contacts.length === 0 ? 'No contacts yet. Add your first contact.' : 'No matches.'}
          </div>
        ) : (
          filtered.map((c, idx) => {
            const isSelected = selected?.contact_id === c.contact_id;
            const identifier = `CT${contacts.indexOf(c) + 1}`;
            return (
              <div
                key={c.contact_id}
                onClick={() => loadIntoForm(c)}
                style={{ padding: '0.65rem 0.75rem', cursor: 'pointer', background: isSelected ? ACCENT_BG : 'transparent', borderLeft: `3px solid ${isSelected ? ACCENT : 'transparent'}`, borderBottom: '1px solid #f5f5f5', transition: 'all 0.1s' }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#fafafa'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                  <span style={{ color: ACCENT, fontSize: '0.62rem', fontWeight: 700, opacity: 0.5, fontFamily: 'monospace', flexShrink: 0 }}>{identifier}</span>
                  <span style={{ color: '#111', fontSize: '0.82rem', fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                </div>
                {(c.role_tag || c.org_tag) && (
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', paddingLeft: '1.5rem' }}>
                    {c.role_tag && (
                      <span style={{ fontSize: '0.65rem', color: ACCENT, fontFamily: 'monospace', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '3px', padding: '0.1rem 0.3rem' }}>
                        {(c.role_tag as any).name}
                      </span>
                    )}
                    {c.org_tag && (
                      <span style={{ fontSize: '0.65rem', color: '#666', fontFamily: 'monospace', background: '#f5f5f5', border: '1px solid #e5e5e5', borderRadius: '3px', padding: '0.1rem 0.3rem' }}>
                        {(c.org_tag as any).name}
                      </span>
                    )}
                  </div>
                )}
                {c.email && (
                  <div style={{ fontSize: '0.67rem', color: '#888', fontFamily: 'monospace', paddingLeft: '1.5rem', marginTop: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.email}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  // ─── Render: right panel ───────────────────────────────────────────────────

  const renderRight = () => {
    if (mode === 'empty') return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', fontSize: '0.8rem', fontFamily: 'monospace', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '2rem', opacity: 0.2 }}>👤</div>
        <div>Select a contact to edit or add a new one</div>
      </div>
    );

    const isAdd = mode === 'add';
    const identifier = !isAdd ? `CT${contacts.findIndex(c => c.contact_id === editId) + 1}` : 'New Contact';

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>

        <div style={{ color: '#888', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: '1.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {isAdd ? 'New Contact' : `Editing ${identifier}`}
        </div>

        {/* Name */}
        <div style={{ marginBottom: '0.85rem' }}>
          <div style={formLabelStyle}>Name <span style={{ color: '#ef4444' }}>*</span></div>
          <input value={formName} onChange={e => setFormName(e.target.value)} style={inputStyle}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        {/* Role */}
        <div style={{ marginBottom: '0.85rem' }}>
          <div style={formLabelStyle}>Role</div>
          <select value={formRoleTagId} onChange={e => setFormRoleTagId(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
            <option value="">— none —</option>
            {roleTags.map(t => (
              <option key={t.tag_id} value={t.tag_id}>{t.name}{t.description ? ` — ${t.description}` : ''}</option>
            ))}
          </select>
        </div>

        {/* Organization */}
        <div style={{ marginBottom: '0.85rem' }}>
          <div style={formLabelStyle}>Organization</div>
          <select value={formOrgTagId} onChange={e => setFormOrgTagId(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')}>
            <option value="">— none —</option>
            {orgTags.map(t => (
              <option key={t.tag_id} value={t.tag_id}>{t.name}{t.description ? ` — ${t.description}` : ''}</option>
            ))}
          </select>
        </div>

        {/* Email */}
        <div style={{ marginBottom: '0.85rem' }}>
          <div style={formLabelStyle}>Email</div>
          <input type="email" value={formEmail} onChange={e => setFormEmail(e.target.value)} style={inputStyle}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        {/* Primary contact method + detail — side by side */}
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.85rem' }}>
          <div style={{ flex: '0 0 160px' }}>
            <div style={formLabelStyle}>Primary Contact Method</div>
            <input value={formMethod} onChange={e => setFormMethod(e.target.value)}
              placeholder="e.g. Slack, Instagram, Zoom"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={formLabelStyle}>Contact Detail</div>
            <input value={formMethodDetail} onChange={e => setFormMethodDetail(e.target.value)}
              placeholder="handle, address, or location"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginBottom: '0.85rem' }}>
          <div style={formLabelStyle}>Notes</div>
          <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical', minHeight: '70px' }}
            onFocus={e => (e.target.style.borderColor = ACCENT)} onBlur={e => (e.target.style.borderColor = '#ddd')} />
        </div>

        {/* People tag info — readonly, for reference */}
        {mode === 'edit' && selected?.people_tag && (
          <div style={{ marginBottom: '0.85rem', padding: '0.5rem 0.65rem', background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, borderRadius: '4px', fontSize: '0.7rem', color: '#666', fontFamily: 'monospace' }}>
            People tag: <span style={{ color: ACCENT, fontWeight: 600 }}>#{(selected.people_tag as any).name}</span> — auto-managed
          </div>
        )}

        {err && <div style={{ color: '#ef4444', fontSize: '0.72rem', marginBottom: '0.75rem' }}>{err}</div>}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between', marginTop: 'auto', paddingTop: '1rem' }}>
          {mode === 'edit' && !confirmDelete && (
            <button onClick={() => setConfirmDelete(true)}
              style={{ background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>
              ✕ delete
            </button>
          )}
          {confirmDelete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
              <span style={{ fontSize: '0.72rem', color: '#ef4444', flex: 1 }}>Delete this contact?</span>
              <button onClick={() => setConfirmDelete(false)} style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>cancel</button>
              <button onClick={handleDelete} disabled={deleting} style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>
                {deleting ? '...' : 'confirm delete'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
              <button onClick={() => { setMode('empty'); setSelected(null); setConfirmDelete(false); }}
                style={{ background: 'none', border: '1px solid #ddd', color: '#666', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>
                cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                style={{ background: ACCENT, border: `1px solid ${ACCENT}`, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>
                {saving ? '...' : isAdd ? 'save contact' : 'save changes'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
      <div ref={modalRef} style={{ position: 'absolute', left: pos.x, top: pos.y, width: size.w, height: size.h, background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', fontFamily: 'monospace', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden', pointerEvents: 'all' }}>

        {/* Header */}
        <div
          onMouseDown={e => { dragging.current = true; dragStart.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y }; }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1.25rem', background: ACCENT, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700 }}>Contacts</span>
            <span style={{ color: '#fff', fontSize: '0.72rem', opacity: 0.6 }}>{contacts.length} total</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button onClick={openAdd}
              style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '0.25rem 0.65rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.4)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.25)')}
            >+ new</button>
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, opacity: 0.7 }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
            >✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {renderLeft()}
          {renderRight()}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={e => { resizing.current = true; resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h }; }}
          style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', cursor: 'se-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '4px' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 7L7 1M4 7L7 4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round"/></svg>
        </div>

      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────

const formLabelStyle: React.CSSProperties = {
  color: '#000', fontSize: '0.65rem', marginBottom: '0.35rem',
  textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#fafafa', border: '1px solid #ddd',
  color: '#222', padding: '0.5rem 0.65rem', borderRadius: '4px',
  fontFamily: 'monospace', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
};
