'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { buildDocumentTemplateFilenameStub } from '@/lib/ko/documentTemplateFilenameStub';
import KarlSpinner from './KarlSpinner';
import ElementPickerModal from './ElementPickerModal';

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Template {
  document_template_id: string;
  name: string;
  description: string | null;
  prompt_template: string;
  output_format: string;
  filename_suffix_format: string | null;
  tags: string[];
  is_system: boolean;
  is_active: boolean;
  implementation_type: string | null;
  context_id: string | null;
  selected_elements: string[];
  element_filters: Record<string, any>;
  user_prompt_additions: string | null;
  template_mode: string;
  created_at: string;
}

interface AssistMessage { role: 'user' | 'assistant'; content: string; }

interface ConceptEntry {
  concept_key: string;
  concept_type: string;
  label: string;
  icon: string | null;
  description: string | null;
  display_order: number;
}

interface TemplatesModalProps {
  userId: string;
  accessToken: string;
  onClose: () => void;
  onCountChange?: (count: number) => void;
  onOpenExtracts?: (templateId: string) => void;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ACCENT        = '#14b8a6';
const ACCENT_BG     = '#f0fdfa';
const ACCENT_BORDER = '#99f6e4';

const SUFFIX_OPTIONS = [
  { value: 'datetime', label: 'Date + Time (04222026:1430)' },
  { value: 'date',     label: 'Date only (04222026)' },
  { value: 'version',  label: 'Version (v1, v2, v3…)' },
  { value: 'custom',   label: 'Custom suffix' },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getObjectIcon(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.icon ?? '';
}

function getObjectLabel(concepts: ConceptEntry[], key: string): string {
  return concepts.find(c => c.concept_type === 'object' && c.concept_key === key)?.label ?? key;
}

function stripEmoji(str: string): string {
  return str
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/[\uFE00-\uFEFF]/g, '')
    .replace(/[\u2000-\u206F]/g, '');
}

function buildSuffix(format: string | null, existingCount: number, customSuffix: string): string {
  const now = new Date();
  switch (format) {
    case 'date': {
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = now.getFullYear();
      return `${mm}${dd}${yyyy}`;
    }
    case 'version':
      return `v${existingCount + 1}`;
    case 'custom':
      return customSuffix.trim() || 'draft';
    case 'datetime':
    default: {
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      return `${mm}${dd}${yyyy}:${hh}${mi}`;
    }
  }
}

function formatExtension(outputFormat: string): string {
  switch (outputFormat) {
    case 'html':  return 'html';
    case 'txt':   return 'txt';
    case 'docx':  return 'docx';
    case 'pdf':   return 'pdf';
    default:      return 'md';
  }
}

// ─── TOOLTIP ──────────────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{
          position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
          background: '#1f2937', color: '#f9fafb', fontSize: '0.6rem', padding: '0.3rem 0.5rem',
          borderRadius: 4, whiteSpace: 'nowrap', zIndex: 9999, pointerEvents: 'none',
          maxWidth: 240, textAlign: 'center', lineHeight: 1.4,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          {text}
          <span style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '4px solid #1f2937' }} />
        </span>
      )}
    </span>
  );
}

/** Full `element_filters` JSON. Use `__scope` for per-object query params (merged with per-field keys in the API). */
function parseElementFiltersJson(text: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, value: {} };
  try {
    const v = JSON.parse(t);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, error: 'Data scope must be a single JSON object.' };
    }
    return { ok: true, value: v as Record<string, any> };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Invalid JSON' };
  }
}

function summarizeScopeHuman(filters: Record<string, any>): string {
  const scope =
    filters && typeof filters.__scope === 'object' && filters.__scope && !Array.isArray(filters.__scope)
      ? (filters.__scope as Record<string, any>)
      : null;
  if (!scope || Object.keys(scope).length === 0) return 'No data scope set (all matching rows).';
  const parts: string[] = [];
  for (const [objType, confRaw] of Object.entries(scope)) {
    if (!confRaw || typeof confRaw !== 'object' || Array.isArray(confRaw)) continue;
    const conf = confRaw as Record<string, any>;
    const bits: string[] = [];
    if (conf.window_days != null) bits.push(`last ${conf.window_days} days`);
    if (conf.context_id != null) {
      const v = Array.isArray(conf.context_id) ? conf.context_id.join(', ') : String(conf.context_id);
      bits.push(`contexts: ${v}`);
    }
    if (conf.tags && Array.isArray(conf.tags) && conf.tags.length > 0) bits.push(`tags: ${conf.tags.join(', ')}`);
    if (conf.bucket_key != null && conf.bucket_key !== '') {
      const bk = Array.isArray(conf.bucket_key) ? conf.bucket_key.join(', ') : String(conf.bucket_key);
      bits.push(`buckets: ${bk}`);
    }
    const extra = Object.keys(conf).filter(k => !['window_days', 'context_id', 'tags', 'bucket_key'].includes(k));
    if (extra.length > 0) bits.push(`custom: ${extra.join(', ')}`);
    parts.push(`${objType} → ${bits.join(' | ') || 'default scope'}`);
  }
  return parts.length > 0 ? parts.join(' ; ') : 'No data scope set (all matching rows).';
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function TemplatesModal({ userId, accessToken, onClose, onCountChange, onOpenExtracts }: TemplatesModalProps) {

  // ── State ──────────────────────────────────────────────────────────────────
  const [templates, setTemplates]         = useState<Template[]>([]);
  const [loading, setLoading]             = useState(true);
  const [selected, setSelected]           = useState<Template | null>(null);
  const [isNew, setIsNew]                 = useState(false);
  const [search, setSearch]               = useState('');
  const [concepts, setConcepts]           = useState<ConceptEntry[]>([]);
  const [extractCounts, setExtractCounts] = useState<Record<string, number>>({});
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isMaximized, setIsMaximized]     = useState(false);

  // Edit state
  const [editName, setEditName]                       = useState('');
  const [editDesc, setEditDesc]                       = useState('');
  const [editFormat, setEditFormat]                   = useState('md');
  const [editKarlPrompt, setEditKarlPrompt]           = useState('');   // prompt_template — Karl-generated
  const [editTemplateMode, setEditTemplateMode]       = useState('karl');
  const [editSuffixFormat, setEditSuffixFormat]       = useState<string>('datetime');
  const [editCustomSuffix, setEditCustomSuffix]       = useState('');
  const [editElements, setEditElements]               = useState<string[]>([]);
  /** Pretty-printed JSON for entire `element_filters` row (includes `__scope` for WHERE-style params). */
  const [filterJsonText, setFilterJsonText]           = useState('{}');
  const [filterJsonError, setFilterJsonError]         = useState('');
  const [saving, setSaving]                           = useState(false);
  const [saveErr, setSaveErr]                         = useState('');
  const [savedFlash, setSavedFlash]                   = useState(false);

  // Run state
  const [running, setRunning]               = useState(false);
  const [runOutput, setRunOutput]           = useState<string | null>(null);
  const [runErr, setRunErr]                 = useState('');
  const [runMode, setRunMode]               = useState<'preview' | 'preview_live' | 'generate'>('preview_live');
  const [copied, setCopied]                 = useState(false);
  const [savedToExtracts, setSavedToExtracts] = useState(false);

  // Element Picker modal
  const [pickerOpen, setPickerOpen]         = useState(false);

  // Karl Assist
  const [assistOpen, setAssistOpen]         = useState(false);
  const [assistInput, setAssistInput]       = useState('');
  const [assistHistory, setAssistHistory]   = useState<AssistMessage[]>([]);
  const [assistLoading, setAssistLoading]   = useState(false);

  // New-template intent step → bootstrap recipe (elements, filters, Karl prompt)
  const [goalInput, setGoalInput]           = useState('');
  const [recipeReady, setRecipeReady]       = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapErr, setBootstrapErr]       = useState('');

  // Modal drag/resize
  const initX = Math.max(0, Math.round(window.innerWidth  / 2 - 580));
  const initY = Math.max(0, Math.round(window.innerHeight / 2 - 400));
  const [pos, setPos]     = useState({ x: initX, y: initY });
  const [size, setSize]   = useState({ w: 1160, h: 800 });
  const [leftW, setLeftW] = useState(260);

  const preMaxSnap    = useRef<{ pos: { x: number; y: number }; size: { w: number; h: number } } | null>(null);
  const leftDragging  = useRef(false);
  const leftDragStart = useRef({ mx: 0, w: 0 });
  const dragging      = useRef(false);
  const resizing      = useRef(false);
  const dragStart     = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const resizeStart   = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const assistBottom  = useRef<HTMLDivElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadTemplates();
    loadConceptRegistry();
    loadExtractCounts();
  }, []);

  useEffect(() => {
    assistBottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [assistHistory, assistLoading]);

  const loadTemplates = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('document_template')
      .select('*')
      .or(`user_id.eq.${userId},is_system.eq.true`)
      .eq('is_active', true)
      .order('is_system', { ascending: false })
      .order('name');
    if (data) { setTemplates(data as Template[]); onCountChange?.(data.length); }
    setLoading(false);
  };

  const loadConceptRegistry = async () => {
    try {
      const { data: koUser } = await supabase.from('ko_user').select('implementation_type').eq('id', userId).maybeSingle();
      const implType = koUser?.implementation_type ?? 'personal';
      const { data } = await supabase
        .from('concept_registry')
        .select('concept_key, concept_type, label, icon, description, display_order')
        .eq('implementation_type', implType)
        .eq('is_active', true)
        .order('concept_type')
        .order('display_order');
      if (data) setConcepts(data as ConceptEntry[]);
    } catch (err) {
      console.error('[TemplatesModal] concept registry load failed:', err);
    }
  };

  const loadExtractCounts = async () => {
    try {
      const { data } = await supabase
        .from('external_reference')
        .select('document_template_id')
        .eq('user_id', userId)
        .not('document_template_id', 'is', null);
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        if (row.document_template_id) {
          counts[row.document_template_id] = (counts[row.document_template_id] ?? 0) + 1;
        }
      }
      setExtractCounts(counts);
    } catch (err) {
      console.error('[TemplatesModal] extract counts load failed:', err);
    }
  };

  // ── Maximize / Minimize ────────────────────────────────────────────────────

  const handleMaximize = () => {
    if (!isMaximized) {
      preMaxSnap.current = { pos: { ...pos }, size: { ...size } };
      const navbarH = 56;
      setPos({ x: 0, y: navbarH });
      setSize({ w: window.innerWidth, h: window.innerHeight - navbarH });
    } else {
      if (preMaxSnap.current) { setPos(preMaxSnap.current.pos); setSize(preMaxSnap.current.size); }
    }
    setIsMaximized(v => !v);
  };

  // ── Drag / Resize ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current && !isMaximized)
        setPos({ x: Math.max(0, dragStart.current.px + e.clientX - dragStart.current.x), y: Math.max(0, dragStart.current.py + e.clientY - dragStart.current.y) });
      if (resizing.current && !isMaximized)
        setSize({ w: Math.max(900, resizeStart.current.w + e.clientX - resizeStart.current.x), h: Math.max(560, resizeStart.current.h + e.clientY - resizeStart.current.y) });
      if (leftDragging.current)
        setLeftW(Math.max(200, Math.min(420, leftDragStart.current.w + e.clientX - leftDragStart.current.mx)));
    };
    const onUp = () => { dragging.current = false; resizing.current = false; leftDragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isMaximized]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const selectTemplate = (t: Template) => {
    setSelected(t); setIsNew(false); setDeleteConfirm(false); setRecipeReady(false);
    setEditName(t.name);
    setEditDesc(t.description ?? '');
    setEditFormat(t.output_format === 'markdown' ? 'md' : (t.output_format ?? 'md'));
    setEditKarlPrompt(t.prompt_template ?? '');
    setEditTemplateMode(t.template_mode ?? 'karl');
    setEditSuffixFormat(t.filename_suffix_format ?? 'datetime');
    setEditCustomSuffix('');
    setEditElements(Array.isArray(t.selected_elements) ? t.selected_elements : []);
    const rawF = t.element_filters && typeof t.element_filters === 'object' ? t.element_filters : {};
    setFilterJsonText(JSON.stringify(rawF, null, 2));
    setFilterJsonError('');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
    setSavedToExtracts(false); setSavedFlash(false);
    setGoalInput(''); setRecipeReady(false); setBootstrapErr('');
  };

  const startNew = () => {
    setSelected(null); setIsNew(true); setDeleteConfirm(false);
    setEditName(''); setEditDesc(''); setEditFormat('md');
    setEditKarlPrompt(''); setEditTemplateMode('karl');
    setEditSuffixFormat('datetime'); setEditCustomSuffix('');
    setEditElements([]); setFilterJsonText('{}'); setFilterJsonError('');
    setRunOutput(null); setRunErr(''); setSaveErr('');
    setAssistHistory([]); setAssistOpen(false); setAssistInput('');
    setSavedToExtracts(false); setSavedFlash(false);
    setGoalInput(''); setRecipeReady(false); setBootstrapErr('');
  };

  const handleSave = async () => {
    if (!editName.trim()) { setSaveErr('Name is required'); return; }
    const parsedFilters = parseElementFiltersJson(filterJsonText);
    if (!parsedFilters.ok) { setSaveErr(parsedFilters.error); return; }
    setSaving(true); setSaveErr('');
    try {
      const payload = {
        name:                  editName.trim(),
        filename_stub:         buildDocumentTemplateFilenameStub(editName.trim(), editDesc.trim() || null),
        description:           editDesc.trim() || null,
        output_format:         editFormat,
        prompt_template:       editKarlPrompt.trim() || '',
        user_prompt_additions: null,
        template_mode:         editTemplateMode,
        filename_suffix_format: editSuffixFormat,
        selected_elements:     editElements,
        element_filters:       parsedFilters.value,
      };
      if (isNew) {
        const { data: inserted, error } = await supabase.from('document_template').insert({
          user_id: userId,
          ...payload,
          sections: [],
          tags: [],
          is_system: false,
          is_active: true,
        }).select('*').single();
        if (error) throw error;
        if (inserted) selectTemplate(inserted as Template);
      } else if (selected && !selected.is_system) {
        const { error } = await supabase.from('document_template').update({
          ...payload, updated_at: new Date().toISOString(),
        }).eq('document_template_id', selected.document_template_id);
        if (error) throw error;
        const { data: fresh, error: fetchErr } = await supabase
          .from('document_template')
          .select('*')
          .eq('document_template_id', selected.document_template_id)
          .single();
        if (!fetchErr && fresh) selectTemplate(fresh as Template);
      }
      await loadTemplates();
      setIsNew(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err: any) { setSaveErr(err.message ?? 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || selected.is_system) return;
    await supabase.from('document_template').update({ is_active: false }).eq('document_template_id', selected.document_template_id);
    setSelected(null); setIsNew(false); setDeleteConfirm(false);
    await loadTemplates();
  };

  // ── Run flow ───────────────────────────────────────────────────────────────
  // Preview (stub) — always immediate.
  // Preview with Data / Generate — element_filters JSON (incl. __scope) is parsed from the Data scope textarea.

  const initiateRun = (mode: 'preview' | 'preview_live' | 'generate') => {
    executeRun(mode);
  };

  const executeRun = async (mode: 'preview' | 'preview_live' | 'generate') => {
    const templateId = selected?.document_template_id ?? null;
    const parsedFilters = parseElementFiltersJson(filterJsonText);
    if (!parsedFilters.ok) {
      setRunErr(`Data scope JSON: ${parsedFilters.error}`);
      return;
    }
    const inlineDraft =
      !templateId && isNew && recipeReady
        ? {
            name:                   editName.trim() || 'Draft template',
            description:            editDesc.trim() || null,
            prompt_template:        editKarlPrompt.trim(),
            template_mode:          editTemplateMode,
            output_format:          editFormat,
            filename_suffix_format: editSuffixFormat,
            selected_elements:      editElements,
            element_filters:        parsedFilters.value,
          }
        : null;
    if (!templateId && !inlineDraft) return;

    setRunMode(mode);
    setRunning(true); setRunErr(''); setSavedToExtracts(false);

    const existingCount = templateId ? (extractCounts[templateId] ?? 0) : 0;
    const suffix   = buildSuffix(editSuffixFormat, existingCount, editCustomSuffix);
    const ext      = formatExtension(editFormat);
    const filename = `${editName.trim() || 'document'} · ${suffix}.${ext}`;

    try {
      const body: Record<string, unknown> = {
        run_mode:          mode,
        karl_prompt:       editKarlPrompt.trim() || undefined,
        output_format:     editFormat,
        selected_elements: editElements,
        element_filters:   parsedFilters.value,
        filename,
        suffix,
      };
      if (templateId) body.template_id = templateId;
      else if (inlineDraft) body.inline_template = inlineDraft;

      const res = await fetch('/api/ko/template/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Run failed');
      setRunOutput(data.output ?? data.output_text ?? '');
      if (mode === 'generate' && data.saved) {
        setSavedToExtracts(true);
        loadExtractCounts();
      }
    } catch (err: any) { setRunErr(err.message ?? 'Run failed'); }
    finally { setRunning(false); }
  };

  const handleCopy = async () => {
    if (!runOutput) return;
    await navigator.clipboard.writeText(runOutput);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!runOutput) return;
    const ext  = formatExtension(editFormat);
    const existingCount = extractCounts[selected?.document_template_id ?? ''] ?? 0;
    const suffix = buildSuffix(editSuffixFormat, existingCount, editCustomSuffix);
    const blob = new Blob([runOutput], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${editName || 'document'} · ${suffix}.${ext}`; a.click();
    URL.revokeObjectURL(url);
  };

  const filtersForAssist = (): Record<string, any> => {
    const p = parseElementFiltersJson(filterJsonText);
    return p.ok ? p.value : {};
  };

  const mergeSuggestedDataScope = (suggested: unknown) => {
    if (!suggested || typeof suggested !== 'object' || Array.isArray(suggested)) return;
    const parsed = parseElementFiltersJson(filterJsonText);
    const cur = parsed.ok ? parsed.value : {};
    const next = {
      ...cur,
      __scope: {
        ...(typeof cur.__scope === 'object' && cur.__scope && !Array.isArray(cur.__scope) ? cur.__scope : {}),
        ...(suggested as Record<string, any>),
      },
    };
    setFilterJsonText(JSON.stringify(next, null, 2));
    setFilterJsonError('');
  };

  const handleAssist = async () => {
    const msg = assistInput.trim();
    if (!msg || assistLoading) return;
    setAssistInput(''); setAssistLoading(true);
    setAssistHistory(h => [...h, { role: 'user', content: msg }]);
    try {
      const res = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: msg,
          history: assistHistory,
          current_instructions: editKarlPrompt,
          selected_elements: editElements,
          element_filters: filtersForAssist(),
        }),
      });
      const data = await res.json();
      const assistResponse = data.response ?? '';
      setAssistHistory(h => [...h, { role: 'assistant', content: assistResponse }]);
      if (data.suggested_instructions) setEditKarlPrompt(stripEmoji(data.suggested_instructions));
      if (data.suggested_data_scope) mergeSuggestedDataScope(data.suggested_data_scope);
    } catch {
      setAssistHistory(h => [...h, { role: 'assistant', content: 'Something went wrong. Try again.' }]);
    } finally { setAssistLoading(false); }
  };

  const handleBootstrapFromGoal = async () => {
    const g = goalInput.trim();
    if (!g || bootstrapLoading) return;
    setBootstrapLoading(true); setBootstrapErr('');
    try {
      const res = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({ message: g, bootstrap_from_goal: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Bootstrap failed');
      const hasPrompt =
        typeof data.suggested_instructions === 'string' && data.suggested_instructions.trim().length > 0;
      const hasElements = Array.isArray(data.suggested_elements) && data.suggested_elements.length > 0;
      if (!hasPrompt && !hasElements) {
        setBootstrapErr(typeof data.response === 'string' && data.response.trim()
          ? data.response.trim()
          : 'Could not infer a template — add a bit more detail and try again.');
        return;
      }
      if (typeof data.suggested_instructions === 'string' && data.suggested_instructions.trim())
        setEditKarlPrompt(stripEmoji(data.suggested_instructions.trim()));
      if (typeof data.suggested_name === 'string' && data.suggested_name.trim())
        setEditName(data.suggested_name.trim());
      if (data.suggested_description != null && String(data.suggested_description).trim())
        setEditDesc(String(data.suggested_description).trim());
      if (Array.isArray(data.suggested_elements) && data.suggested_elements.length > 0)
        setEditElements(data.suggested_elements.filter((x: unknown) => typeof x === 'string'));
      const scope = data.suggested_element_filters;
      if (scope && typeof scope === 'object' && !Array.isArray(scope))
        setFilterJsonText(JSON.stringify(scope, null, 2));
      setFilterJsonError('');
      setRecipeReady(true);
      setAssistOpen(false);
      setRunOutput(null); setRunErr('');
    } catch (err: any) {
      setBootstrapErr(err?.message ?? 'Something went wrong. Try again.');
    } finally {
      setBootstrapLoading(false);
    }
  };

  const handleRegeneratePrompt = async () => {
    if (assistLoading || assistHistory.length === 0) return;
    setAssistLoading(true);
    try {
      const res = await fetch('/api/ko/template/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: 'Regenerate',
          history: assistHistory,
          current_instructions: editKarlPrompt,
          selected_elements: editElements,
          element_filters: filtersForAssist(),
          regenerate_prompt: true,
        }),
      });
      const data = await res.json();
      const assistResponse = data.response ?? '';
      setAssistHistory(h => [...h, { role: 'assistant', content: assistResponse || 'Prompt updated.' }]);
      if (data.suggested_instructions) setEditKarlPrompt(stripEmoji(data.suggested_instructions));
      if (data.suggested_data_scope) mergeSuggestedDataScope(data.suggested_data_scope);
    } catch {
      setAssistHistory(h => [...h, { role: 'assistant', content: 'Something went wrong. Try again.' }]);
    } finally { setAssistLoading(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = templates.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.description ?? '').toLowerCase().includes(search.toLowerCase())
  );
  const parsedFiltersForView = parseElementFiltersJson(filterJsonText);
  const scopeSummary = parsedFiltersForView.ok ? summarizeScopeHuman(parsedFiltersForView.value) : 'Invalid JSON.';
  const isEditing     = isNew || !!selected;
  const isSystem      = selected?.is_system ?? false;
  const templateIcon  = getObjectIcon(concepts, 'document_template') || '📄';
  const previewFilename =
    selected || (isNew && recipeReady)
      ? `${editName.trim() || 'document'} · ${buildSuffix(editSuffixFormat, selected ? (extractCounts[selected.document_template_id] ?? 0) : 0, editCustomSuffix)}.${formatExtension(editFormat)}`
      : '';

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute',
          left: pos.x, top: pos.y, width: size.w, height: size.h,
          background: '#ffffff', border: `2px solid ${ACCENT}`, borderRadius: isMaximized ? 0 : 8,
          display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
          overflow: 'hidden', pointerEvents: 'all', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          transition: isMaximized ? 'none' : undefined,
        }}>

          {/* ── HEADER ─────────────────────────────────────────────────────── */}
          <div
            onMouseDown={e => {
              if (isMaximized) return;
              dragging.current = true;
              dragStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
            }}
            style={{ background: ACCENT, padding: '0 1rem', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: isMaximized ? 'default' : 'grab', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ color: '#000', fontWeight: 700, fontSize: '0.85rem' }}>
                {templateIcon} {getObjectLabel(concepts, 'document_template') || 'Document Template'}
              </span>
              <span style={{ color: '#000', fontSize: '0.7rem', opacity: 0.5 }}>TM · {templates.length} template{templates.length !== 1 ? 's' : ''}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onMouseDown={e => e.stopPropagation()}>
              <button onClick={handleMaximize} title={isMaximized ? 'Restore' : 'Maximize'}
                style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '0.85rem', opacity: 0.6, padding: '0 0.2rem', lineHeight: 1 }}>
                {isMaximized ? '⊡' : '⊞'}
              </button>
              <button onClick={onClose}
                style={{ background: 'none', border: 'none', color: '#000', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}>✕</button>
            </div>
          </div>

          {/* ── BODY ───────────────────────────────────────────────────────── */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

            {/* ── LEFT: template list ───────────────────────────────────── */}
            <div style={{ width: leftW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #e5e7eb' }}>
              <div style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..."
                  style={{ width: '100%', background: '#fafafa', border: '1px solid #e5e7eb', color: '#222', padding: '0.4rem 0.6rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <button onClick={startNew}
                  style={{ width: '100%', background: isNew ? ACCENT_BG : 'transparent', border: `1px solid ${isNew ? ACCENT : '#ddd'}`, color: isNew ? ACCENT : '#888', padding: '0.4rem', borderRadius: 4, fontSize: '0.75rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                  + new template
                </button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                {loading
                  ? <div style={{ padding: '1rem', color: '#666', fontSize: '0.75rem' }}>Loading...</div>
                  : filtered.length === 0
                    ? <div style={{ padding: '1rem', color: '#888', fontSize: '0.75rem' }}>No templates found</div>
                    : filtered.map((t, idx) => {
                        const isActive = selected?.document_template_id === t.document_template_id;
                        const runCount = extractCounts[t.document_template_id] ?? 0;
                        return (
                          <div key={t.document_template_id} onClick={() => selectTemplate(t)}
                            style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', background: isActive ? ACCENT_BG : 'transparent', borderLeft: isActive ? `3px solid ${ACCENT}` : '3px solid transparent', transition: 'background 0.1s' }}
                            onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f9f9f9'; }}
                            onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ color: ACCENT, fontSize: '0.58rem', opacity: 0.6, fontWeight: 600, flexShrink: 0 }}>TM{idx + 1}</span>
                              <span style={{ color: '#222', fontSize: '0.78rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                              {runCount > 0 && (
                                <span style={{ fontSize: '0.58rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', padding: '0.02rem 0.3rem', borderRadius: 2, flexShrink: 0 }}>
                                  {runCount}×
                                </span>
                              )}
                            </div>
                            {t.description && (
                              <div style={{ color: '#888', fontSize: '0.65rem', marginTop: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</div>
                            )}
                          </div>
                        );
                      })
                }
              </div>
            </div>

            {/* ── RESIZABLE DIVIDER ─────────────────────────────────────── */}
            <div
              onMouseDown={e => { leftDragging.current = true; leftDragStart.current = { mx: e.clientX, w: leftW }; }}
              style={{ width: 4, flexShrink: 0, background: '#e5e5e5', cursor: 'col-resize' }}
              onMouseEnter={e => (e.currentTarget.style.background = ACCENT_BORDER)}
              onMouseLeave={e => (e.currentTarget.style.background = '#e5e5e5')}
            />

            {/* ── RIGHT: WORK AREA ─────────────────────────────────────── */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

              {/* Empty state */}
              {!isEditing && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: '0.8rem', flexDirection: 'column', gap: '0.5rem' }}>
                  <span style={{ fontSize: '1.5rem', opacity: 0.2 }}>{templateIcon}</span>
                  <span>Select a template or create a new one</span>
                </div>
              )}

              {isEditing && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                  {isNew && !recipeReady ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1.25rem 1.5rem', gap: '1rem', minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ color: '#111827', fontWeight: 700, fontSize: '0.9rem' }}>What do you want me to do?</div>
                    <p style={{ margin: 0, color: '#6b7280', fontSize: '0.72rem', lineHeight: 1.55, maxWidth: 640 }}>
                      Describe the output you need (or paste your own formatting instructions). Karl picks data fields and scope, then drafts the Karl Prompt. Preview format-only or with live data, edit anything, then save.
                    </p>
                    <textarea
                      value={goalInput}
                      onChange={e => setGoalInput(e.target.value)}
                      placeholder="Example: Weekly status — open tasks by bucket, meetings last 14 days, completions tagged “client”."
                      disabled={bootstrapLoading}
                      style={{
                        flex: 1, minHeight: 260, width: '100%', boxSizing: 'border-box',
                        padding: '0.85rem', borderRadius: 6, border: '1px solid #e5e7eb', fontFamily: 'monospace',
                        fontSize: '0.78rem', lineHeight: 1.55, color: '#111827', resize: 'none', outline: 'none',
                      }}
                    />
                    {bootstrapErr ? <div style={{ color: '#ef4444', fontSize: '0.72rem', flexShrink: 0 }}>{bootstrapErr}</div> : null}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={handleBootstrapFromGoal}
                        disabled={!goalInput.trim() || bootstrapLoading}
                        style={{
                          background: goalInput.trim() && !bootstrapLoading ? ACCENT : '#e5e7eb',
                          border: 'none', color: goalInput.trim() && !bootstrapLoading ? '#000' : '#9ca3af',
                          padding: '0.5rem 1.35rem', borderRadius: 6, fontFamily: 'monospace', fontWeight: 700,
                          fontSize: '0.78rem', cursor: goalInput.trim() && !bootstrapLoading ? 'pointer' : 'not-allowed',
                        }}
                      >
                        {bootstrapLoading ? 'Working…' : 'Do it'}
                      </button>
                      {bootstrapLoading ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#6b7280', fontSize: '0.72rem' }}>
                          <KarlSpinner size="sm" color={ACCENT} /> Wiring data selection and filters…
                        </span>
                      ) : null}
                    </div>
                  </div>
                  ) : (
                  <>
                  {/* ── TOP STRIP: name / desc / format ─────────────────── */}
                  <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #e5e7eb', background: '#fafafa', flexShrink: 0, display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    {isSystem && (
                      <div style={{ width: '100%', padding: '0.3rem 0.6rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, color: '#92400e', fontSize: '0.68rem', marginBottom: '0.25rem' }}>
                        System template — read only
                      </div>
                    )}
                    <div style={{ flex: '2 1 200px' }}>
                      <div style={labelSt}>Name {!isSystem && <span style={{ color: '#ef4444' }}>*</span>}</div>
                      <input value={editName} onChange={e => setEditName(e.target.value)} disabled={isSystem} placeholder="Template name" style={inputSt(isSystem)} />
                    </div>
                    <div style={{ flex: '3 1 280px' }}>
                      <div style={labelSt}>Description</div>
                      <input value={editDesc} onChange={e => setEditDesc(e.target.value)} disabled={isSystem} placeholder="What this produces..." style={inputSt(isSystem)} />
                    </div>
                    <div style={{ flex: '0 0 140px' }}>
                      <div style={labelSt}>Format</div>
                      <select value={editFormat} onChange={e => setEditFormat(e.target.value)} disabled={isSystem}
                        style={{ ...inputSt(isSystem), cursor: isSystem ? 'not-allowed' : 'pointer' } as any}>
                        <option value="md">Markdown (.md)</option>
                        <option value="html">HTML (.html)</option>
                        <option value="txt">Plain text (.txt)</option>
                        <option value="docx">Word (.docx)</option>
                      </select>
                    </div>
                    {!isSystem && (
                      <div style={{ flex: '0 0 180px' }}>
                        <div style={labelSt}>Extract Filename</div>
                        <select value={editSuffixFormat} onChange={e => { setEditSuffixFormat(e.target.value); setEditCustomSuffix(''); }} disabled={isSystem}
                          style={{ ...inputSt(isSystem), cursor: isSystem ? 'not-allowed' : 'pointer' } as any}>
                          {SUFFIX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    )}
                    {!isSystem && editSuffixFormat === 'custom' && (
                      <div style={{ flex: '0 0 140px' }}>
                        <div style={labelSt}>Custom Suffix</div>
                        <input value={editCustomSuffix} onChange={e => setEditCustomSuffix(e.target.value)} placeholder="e.g. final" style={inputSt(false)} />
                      </div>
                    )}
                    {previewFilename && (recipeReady || !isNew) && (
                      <div style={{ width: '100%', fontSize: '0.6rem', color: '#aaa', marginTop: '0.1rem' }}>
                        Next extract: <span style={{ color: '#666', fontFamily: 'monospace' }}>{previewFilename}</span>
                      </div>
                    )}
                  </div>

                  {/* ── DATA CONFIG: elements + scope side-by-side ───────────────── */}
                  {(recipeReady || !isNew) && !isSystem && (
                    <div style={{ flexShrink: 0, borderBottom: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', gap: '0.75rem', padding: '0.45rem 0.75rem', minHeight: 104 }}>
                      <div style={{ flex: '1 1 45%', minWidth: 220, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden', background: '#fff' }}>
                        <div style={{ padding: '0.3rem 0.5rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.6rem', color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Data Elements</span>
                          <span style={{ flex: 1 }} />
                          <button onClick={() => setPickerOpen(true)}
                            style={{ background: 'transparent', border: `1px solid ${editElements.length > 0 ? ACCENT : '#ddd'}`, color: editElements.length > 0 ? ACCENT : '#aaa', padding: '0.12rem 0.45rem', borderRadius: 3, fontSize: '0.6rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                            {editElements.length > 0 ? 'edit' : '+ add'}
                          </button>
                        </div>
                        <div style={{ padding: '0.35rem 0.45rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem', maxHeight: 74, overflowY: 'auto' }}>
                          {editElements.length === 0
                            ? <span style={{ fontSize: '0.65rem', color: '#ccc', fontStyle: 'italic' }}>none</span>
                            : editElements.map(el => (
                                <span key={el} style={{ background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}`, color: '#0f766e', fontSize: '0.62rem', padding: '0.08rem 0.35rem', borderRadius: 3, fontFamily: 'monospace' }}>{el}</span>
                              ))
                          }
                        </div>
                      </div>
                      <div style={{ flex: '1 1 55%', minWidth: 320, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden', background: '#fff' }}>
                        <div style={{ padding: '0.3rem 0.5rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.6rem', color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Data Scope (JSON)</span>
                          <span style={{ fontSize: '0.58rem', color: '#999' }}>use <span style={{ fontFamily: 'monospace' }}>__scope</span> by object type</span>
                        </div>
                        <div style={{ padding: '0.2rem 0.55rem', borderBottom: '1px solid #f6f6f6', background: '#fcfcfc', color: '#6b7280', fontSize: '0.6rem', lineHeight: 1.35 }}>
                          {scopeSummary}
                        </div>
                        <textarea
                          value={filterJsonText}
                          onChange={e => {
                            const v = e.target.value;
                            setFilterJsonText(v);
                            const p = parseElementFiltersJson(v);
                            setFilterJsonError(p.ok ? '' : p.error);
                          }}
                          spellCheck={false}
                          rows={4}
                          style={{
                            width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: filterJsonError ? '2px solid #ef4444' : undefined,
                            background: '#fff', color: '#222', padding: '0.45rem 0.55rem', fontFamily: 'monospace', fontSize: '0.7rem',
                            outline: 'none', resize: 'none', minHeight: 74, lineHeight: 1.4,
                          }}
                        />
                        {filterJsonError && (
                          <div style={{ padding: '0.2rem 0.55rem 0.3rem', fontSize: '0.62rem', color: '#ef4444' }}>{filterJsonError}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── MAIN WORK AREA: prompt left, output right ────── */}
                  <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

                    {/* ── PROMPT COLUMN ───────────────────────────────── */}
                    <div style={{ flex: '1 1 40%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #e5e7eb', minWidth: 0 }}>
                      <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, background: '#fafafa' }}>
                        <span style={{ ...labelSt, marginBottom: 0 }}>Karl Prompt</span>
                        {!isSystem && (
                          <button onClick={() => setAssistOpen(v => !v)}
                            style={{ marginLeft: 'auto', background: assistOpen ? ACCENT_BG : 'transparent', border: `1px solid ${assistOpen ? ACCENT : '#ddd'}`, color: assistOpen ? ACCENT : '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                            ✦ Karl Assist
                          </button>
                        )}
                      </div>

                      {/* Karl Assist panel */}
                      {!isSystem && assistOpen && (
                        <div style={{ borderBottom: `1px solid ${ACCENT_BORDER}`, background: '#f8fffe', flexShrink: 0 }}>
                          {assistHistory.length > 0 && (
                            <div style={{ maxHeight: 200, overflowY: 'auto', padding: '0.5rem 0.75rem', scrollbarWidth: 'thin' }}>
                              {assistHistory.map((m, i) => (
                                <div key={i} style={{ marginBottom: '0.35rem', fontSize: '0.7rem', color: m.role === 'user' ? '#0f766e' : '#374151', paddingLeft: m.role === 'user' ? '0.4rem' : 0, borderLeft: m.role === 'user' ? `2px solid ${ACCENT_BORDER}` : 'none', lineHeight: 1.5 }}>
                                  {m.content}
                                </div>
                              ))}
                              {assistLoading && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.15rem 0' }}>
                                  <KarlSpinner size="sm" color={ACCENT} />
                                  <span style={{ color: '#666', fontSize: '0.65rem' }}>thinking...</span>
                                </div>
                              )}
                              <div ref={assistBottom} />
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: '0.4rem', padding: '0.4rem 0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <textarea
                              value={assistInput}
                              onChange={e => setAssistInput(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAssist(); } }}
                              placeholder={editKarlPrompt ? 'Describe a change to the prompt...' : 'Describe what you want this template to produce...'}
                              rows={5}
                              style={{ flex: 1, minWidth: 200, background: '#fff', border: '1px solid #ddd', color: '#222', padding: '0.45rem 0.55rem', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.72rem', outline: 'none', resize: 'vertical', minHeight: 100 }}
                            />
                            <Tooltip text="Rewrite the full Karl prompt from this thread and apply it to the prompt field.">
                              <button type="button" onClick={handleRegeneratePrompt} disabled={assistLoading || assistHistory.length === 0}
                                style={{ background: assistHistory.length > 0 ? '#fff' : 'transparent', border: '1px solid #ddd', color: assistHistory.length > 0 ? '#0f766e' : '#ccc', padding: '0.3rem 0.55rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: assistHistory.length > 0 && !assistLoading ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
                                retry prompt
                              </button>
                            </Tooltip>
                            <button onClick={handleAssist} disabled={!assistInput.trim() || assistLoading}
                              style={{ background: assistInput.trim() ? ACCENT_BG : 'transparent', border: `1px solid ${assistInput.trim() ? ACCENT : '#ddd'}`, color: assistInput.trim() ? ACCENT : '#aaa', padding: '0.3rem 0.6rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: assistInput.trim() ? 'pointer' : 'not-allowed' }}>
                              ask
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Karl Prompt textarea */}
                      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <textarea
                          value={editKarlPrompt}
                          onChange={e => setEditKarlPrompt(e.target.value)}
                          disabled={isSystem}
                          placeholder={isSystem ? '' : 'Karl generates this from your elements, filters, and Karl Assist conversation.\n\nOr type directly — describe what sections to show, what fields per section, how to format.'}
                          style={{ flex: 1, width: '100%', background: isSystem ? '#f5f5f5' : '#fff', border: 'none', borderTop: '1px solid #f0f0f0', color: isSystem ? '#aaa' : '#222', padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.78rem', outline: 'none', resize: 'none', lineHeight: 1.6, boxSizing: 'border-box' } as any}
                        />
                      </div>

                      {/* Left footer */}
                      {!isSystem && (
                        <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                          {saveErr && <span style={{ color: '#ef4444', fontSize: '0.65rem', flex: 1 }}>{saveErr}</span>}
                          {savedFlash && !saveErr && <span style={{ color: ACCENT, fontSize: '0.65rem', flex: 1 }}>✓ Template saved</span>}
                          {!saveErr && !savedFlash && <span style={{ flex: 1 }} />}

                          {selected && !deleteConfirm && (
                            <Tooltip text="Deletes this template. Existing extracts will be orphaned but not deleted.">
                              <button onClick={() => setDeleteConfirm(true)}
                                style={{ background: 'transparent', border: '1px solid #fca5a5', color: '#ef4444', padding: '0.3rem 0.65rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                                Delete Template
                              </button>
                            </Tooltip>
                          )}
                          {selected && deleteConfirm && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.65rem', color: '#ef4444' }}>Delete "{selected.name}"? Extracts will be orphaned.</span>
                              <button onClick={() => setDeleteConfirm(false)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#666', padding: '0.25rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>cancel</button>
                              <button onClick={handleDelete} style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '0.25rem 0.6rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer', fontWeight: 700 }}>yes, delete</button>
                            </div>
                          )}

                          <Tooltip text="Saves formatting instructions, filename format, element config, and section criteria to this template.">
                            <button onClick={handleSave} disabled={saving}
                              style={{ background: '#0a1f1d', border: `1px solid ${ACCENT}`, color: ACCENT, padding: '0.3rem 0.85rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                              {saving ? 'saving...' : 'Save Template'}
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>

                    {/* ── OUTPUT COLUMN ────────────────────────────────── */}
                    <div style={{ flex: '1 1 60%', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                      {/* Output header */}
                      <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, background: '#fafafa' }}>
                        {runOutput
                          ? <>
                              <span style={{ color: ACCENT, fontSize: '0.65rem', fontWeight: 600 }}>
                                {runMode === 'preview' ? '🔍 PREVIEW' : runMode === 'preview_live' ? '🔍 PREVIEW · LIVE DATA' : '✓ EXTRACT CREATED'}
                              </span>
                              {runMode === 'preview' && <span style={{ color: '#999', fontSize: '0.6rem' }}>· stub data · not saved</span>}
                              {runMode === 'preview_live' && <span style={{ color: '#999', fontSize: '0.6rem' }}>· live data · not saved</span>}
                              {runMode === 'generate' && savedToExtracts && <span style={{ color: '#999', fontSize: '0.6rem' }}>· {previewFilename}</span>}
                              <span style={{ flex: 1 }} />
                              <button onClick={handleCopy}
                                style={{ background: copied ? ACCENT_BG : 'transparent', border: `1px solid ${copied ? ACCENT : '#ddd'}`, color: copied ? ACCENT : '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                                {copied ? '✓ copied' : 'copy'}
                              </button>
                              <button onClick={handleDownload}
                                style={{ background: 'transparent', border: '1px solid #ddd', color: '#888', padding: '0.15rem 0.5rem', borderRadius: 3, fontSize: '0.62rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                                ↓ .{formatExtension(editFormat)}
                              </button>
                            </>
                          : <span style={{ color: '#bbb', fontSize: '0.65rem' }}>Output will appear here</span>
                        }
                      </div>

                      {/* Output body */}
                      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                        {running && (
                          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', background: '#fff' }}>
                            <KarlSpinner size="lg" color={ACCENT} />
                            <span style={{ color: '#888', fontSize: '0.78rem' }}>
                              {runMode === 'preview' ? 'Previewing...' : runMode === 'preview_live' ? 'Previewing with live data...' : 'Generating extract...'}
                            </span>
                          </div>
                        )}
                        {!running && runErr && (
                          <div style={{ padding: '1rem', color: '#ef4444', fontSize: '0.75rem' }}>
                            {runErr}
                            <button onClick={() => setRunErr('')} style={{ marginLeft: '0.75rem', background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '0.7rem' }}>dismiss</button>
                          </div>
                        )}
                        {!running && !runErr && runOutput && (
                          <div style={{ height: '100%', overflowY: 'auto', padding: '0.75rem 1rem', scrollbarWidth: 'thin', scrollbarColor: '#ddd transparent' }}>
                            <pre style={{ color: '#333', fontSize: '0.78rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'monospace', margin: 0 }}>{runOutput}</pre>
                          </div>
                        )}
                        {!running && !runErr && !runOutput && (
                          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.5rem', color: '#ccc' }}>
                            <span style={{ fontSize: '1.5rem' }}>▶</span>
                            <span style={{ fontSize: '0.75rem' }}>Use Preview with Data for live tasks</span>
                            <span style={{ fontSize: '0.65rem', color: '#ddd' }}>Matches Report Builder runs · Stub preview only checks layout</span>
                          </div>
                        )}
                      </div>

                      {/* Extracts link */}
                      {runOutput && runMode === 'generate' && savedToExtracts && selected && onOpenExtracts && (
                        <div style={{ padding: '0.4rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#f0fdfa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                          <span style={{ color: ACCENT, fontSize: '0.7rem', flex: 1 }}>✓ Extract saved</span>
                          <button
                            onClick={() => { onOpenExtracts(selected.document_template_id); onClose(); }}
                            style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, padding: '0.2rem 0.6rem', borderRadius: 4, fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer' }}>
                            {extractCounts[selected.document_template_id] ?? 1}× extracts →
                          </button>
                        </div>
                      )}

                      {/* Right footer: preview (draft-friendly); generate only after template row exists */}
                      {(selected || (isNew && recipeReady)) && (
                        <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb', background: '#fafafa', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, justifyContent: 'flex-end', flexWrap: 'wrap' }}>

                          <Tooltip text={editElements.length > 0 ? 'Same engine as Report Builder — live tasks from DB. Nothing is saved.' : 'Live workspace data. Nothing is saved.'}>
                            <button onClick={() => initiateRun('preview_live')} disabled={running}
                              style={{ background: ACCENT_BG, border: `1px solid ${ACCENT}`, color: '#0f766e', padding: '0.3rem 0.85rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: running ? 'not-allowed' : 'pointer', fontWeight: 700, opacity: running && runMode !== 'preview_live' ? 0.5 : 1 }}>
                              {running && runMode === 'preview_live' ? '...' : '▶ Preview with Data'}
                            </button>
                          </Tooltip>

                          <Tooltip text="Stub sample rows — layout only, not your tasks.">
                            <button onClick={() => initiateRun('preview')} disabled={running}
                              style={{ background: 'transparent', border: `1px solid ${ACCENT_BORDER}`, color: '#64748b', padding: '0.3rem 0.75rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace', cursor: running ? 'not-allowed' : 'pointer', opacity: running && runMode !== 'preview' ? 0.5 : 1 }}>
                              {running && runMode === 'preview' ? '...' : 'Preview (no data)'}
                            </button>
                          </Tooltip>

                          <Tooltip text={selected ? 'Runs with live data and saves a versioned extract.' : 'Save the template first — then you can create a saved extract.'}>
                            <button onClick={() => initiateRun('generate')} disabled={running || !selected}
                              style={{
                                background: running && runMode === 'generate' ? '#0f2a27' : ACCENT,
                                border: 'none', color: '#000', padding: '0.3rem 1rem', borderRadius: 4, fontSize: '0.68rem', fontFamily: 'monospace',
                                cursor: running || !selected ? 'not-allowed' : 'pointer', fontWeight: 700,
                                opacity: (!selected || (running && runMode !== 'generate')) ? 0.45 : 1,
                              }}>
                              {running && runMode === 'generate' ? '...' : 'Run + Create Extract'}
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  </div>
                  </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Resize handle */}
          {!isMaximized && (
            <div
              onMouseDown={e => { resizing.current = true; resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }; }}
              style={{ position: 'absolute', bottom: 0, right: 0, width: 16, height: 16, cursor: 'nwse-resize' }}
            />
          )}
        </div>
      </div>

      {/* ── ELEMENT PICKER MODAL ───────────────────────────────────────────── */}
      {pickerOpen && (selected || (isNew && recipeReady)) && (
        <ElementPickerModal
          userId={userId}
          templateId={selected?.document_template_id}
          currentElements={editElements}
          onSave={elements => {
            setEditElements(elements);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const labelSt: React.CSSProperties = {
  color: '#888', fontSize: '0.6rem', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: '0.25rem',
};

const inputSt = (disabled: boolean): React.CSSProperties => ({
  width: '100%', background: disabled ? '#f5f5f5' : '#fff', border: '1px solid #e5e7eb',
  color: disabled ? '#aaa' : '#222', padding: '0.4rem 0.55rem', borderRadius: 4,
  fontFamily: 'monospace', fontSize: '0.78rem', outline: 'none',
  boxSizing: 'border-box', cursor: disabled ? 'not-allowed' : 'text',
});

