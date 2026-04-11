// lib/ko/initializeUserWorkspace.ts
// KarlOps L — Full workspace initialization
// Runs once on first login. Idempotent — safe to call on every login.

import { createSupabaseAdmin } from '@/lib/supabase-server';
import { randomUUID } from 'crypto';

interface InitResult {
  success: boolean;
  ko_user_id?: string;
  session_id?: string;
  is_new_user?: boolean;
  error?: string;
}

export async function initializeUserWorkspace(
  auth_user_id: string,
  email: string,
  display_name?: string
): Promise<InitResult> {
  const db = createSupabaseAdmin();

  try {
    // =========================================================
    // 1. CHECK IF USER EXISTS
    // =========================================================

    const { data: existingUser } = await db
      .from('ko_user')
      .select('id')
      .eq('id', auth_user_id)
      .maybeSingle();

    // =========================================================
    // 2. UPSERT SESSION (every login — refresh expiry, clear messages)
    // =========================================================

    const sessionToken = randomUUID();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 12);

    await db.from('ko_session').delete().eq('user_id', auth_user_id);

    const { data: newSession, error: sessionError } = await db
      .from('ko_session')
      .insert({
        user_id: auth_user_id,
        session_token: sessionToken,
        expires_at: expiresAt.toISOString(),
        messages: [],
      })
      .select('ko_session_id')
      .single();

    if (sessionError) throw sessionError;

    // =========================================================
    // 3. IF EXISTING USER — DONE
    // =========================================================

    if (existingUser) {
      return {
        success: true,
        ko_user_id: existingUser.id,
        session_id: newSession.ko_session_id,
        is_new_user: false,
      };
    }

    // =========================================================
    // 4. NEW USER — SEED EVERYTHING
    // =========================================================

    // ── ko_user ──────────────────────────────────────────────
    const { error: userError } = await db.from('ko_user').insert({
      id: auth_user_id,
      email,
      display_name: display_name ?? email.split('@')[0],
      implementation_type: 'default',
    });
    if (userError) throw userError;

    // ── task_status ───────────────────────────────────────────
    const statuses = [
      { name: 'open',       label: 'Open',        display_order: 1, is_default: true  },
      { name: 'inprogress', label: 'In Progress', display_order: 2, is_default: false },
      { name: 'blocked',    label: 'Blocked',     display_order: 3, is_default: false },
      { name: 'waiting',    label: 'Waiting',     display_order: 4, is_default: false },
      { name: 'done',       label: 'Done',        display_order: 5, is_default: false },
    ];

    const { data: seededStatuses, error: statusError } = await db
      .from('task_status')
      .insert(statuses.map(s => ({ ...s, user_id: auth_user_id })))
      .select('task_status_id, name, is_default');
    if (statusError) throw statusError;

    const defaultStatus = seededStatuses?.find(s => s.is_default);

    // ── tag_group ─────────────────────────────────────────────
    const tagGroups = [
      { name: 'People',  display_order: 1 },
      { name: 'Domain',  display_order: 2 },
      { name: 'Project', display_order: 3 },
      { name: 'Skills',  display_order: 4 },
      { name: 'General', display_order: 5 },
    ];

    const { data: seededGroups, error: groupError } = await db
      .from('tag_group')
      .insert(tagGroups.map(g => ({ ...g, user_id: auth_user_id })))
      .select('tag_group_id, name');
    if (groupError) throw groupError;

    const domainGroup  = seededGroups?.find(g => g.name === 'Domain');
    const skillsGroup  = seededGroups?.find(g => g.name === 'Skills');
    const generalGroup = seededGroups?.find(g => g.name === 'General');

    // ── tags (starter set) ────────────────────────────────────
    const starterTags = [
      { name: 'Operations', tag_group_id: domainGroup?.tag_group_id },
      { name: 'Finance',    tag_group_id: domainGroup?.tag_group_id },
      { name: 'Marketing',  tag_group_id: domainGroup?.tag_group_id },
      { name: 'Legal',      tag_group_id: domainGroup?.tag_group_id },
      { name: 'CISSP',      tag_group_id: skillsGroup?.tag_group_id },
      { name: 'PMP',        tag_group_id: skillsGroup?.tag_group_id },
      { name: 'Cyber',      tag_group_id: skillsGroup?.tag_group_id },
      { name: 'General',    tag_group_id: generalGroup?.tag_group_id },
    ];

    const { error: tagError } = await db
      .from('tag')
      .insert(starterTags.map(t => ({ ...t, user_id: auth_user_id })));
    if (tagError) throw tagError;

    // ── context (four defaults) ───────────────────────────────
    const contexts = [
      { name: 'The Unobsolete', description: 'COO work — business operations' },
      { name: 'Job Hunt',       description: 'Job search and career management' },
      { name: 'Personal',       description: 'Personal finances and life management' },
      { name: 'Work',           description: 'Current role' },
    ];

    const { error: contextError } = await db
      .from('context')
      .insert(contexts.map(c => ({ ...c, user_id: auth_user_id })));
    if (contextError) throw contextError;

    // ── concept_registry ──────────────────────────────────────
    const concepts = [
      { concept_key: 'bucket_now',          concept_type: 'bucket', label: 'On Fire',          icon: '🔥', display_order: 1,  kbd_shortcut: 'N',  is_foreign_key: false },
      { concept_key: 'bucket_soon',         concept_type: 'bucket', label: 'Up Next',          icon: '⚡', display_order: 2,  kbd_shortcut: 'S',  is_foreign_key: false },
      { concept_key: 'bucket_realwork',     concept_type: 'bucket', label: 'Real Work',        icon: '🔧', display_order: 3,  kbd_shortcut: 'R',  is_foreign_key: false },
      { concept_key: 'bucket_later',        concept_type: 'bucket', label: 'Later',            icon: '🕐', display_order: 4,  kbd_shortcut: 'L',  is_foreign_key: false },
      { concept_key: 'bucket_delegate',     concept_type: 'bucket', label: 'Delegated',        icon: '👋', display_order: 5,  kbd_shortcut: 'D',  is_foreign_key: false },
      { concept_key: 'bucket_capture',      concept_type: 'bucket', label: 'Capture',          icon: '📥', display_order: 6,  kbd_shortcut: 'C',  is_foreign_key: false },
      { concept_key: 'task',                concept_type: 'object', label: 'Task',              icon: '✅', display_order: 10, kbd_shortcut: 'T',  is_foreign_key: false },
      { concept_key: 'meeting',             concept_type: 'object', label: 'Meeting',           icon: '📅', display_order: 11, kbd_shortcut: 'M',  is_foreign_key: false },
      { concept_key: 'completion',          concept_type: 'object', label: 'Completion',        icon: '🏆', display_order: 12, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'external_reference',  concept_type: 'object', label: 'Reference',         icon: '🔗', display_order: 13, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'document_template',   concept_type: 'object', label: 'Document Template', icon: '📄', display_order: 14, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'user_situation',      concept_type: 'object', label: 'My Situation',      icon: '🧭', display_order: 15, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'context',             concept_type: 'object', label: 'Context',           icon: '🏷️', display_order: 16, kbd_shortcut: null, is_foreign_key: true  },
      { concept_key: 'task_status',         concept_type: 'object', label: 'Status',            icon: '🚦', display_order: 17, kbd_shortcut: null, is_foreign_key: true  },
      { concept_key: 'tag',                 concept_type: 'object', label: 'Tag',               icon: '🔖', display_order: 18, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'tag_group',           concept_type: 'object', label: 'Tag Group',         icon: '🗂️', display_order: 19, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'action_complete',     concept_type: 'action', label: 'Complete',          icon: '✓',  display_order: 20, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'action_delegate',     concept_type: 'action', label: 'Delegate',          icon: '👋', display_order: 21, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'action_capture',      concept_type: 'action', label: 'Capture',           icon: '📥', display_order: 22, kbd_shortcut: null, is_foreign_key: false },
      { concept_key: 'action_archive',      concept_type: 'action', label: 'Archive',           icon: '📦', display_order: 23, kbd_shortcut: null, is_foreign_key: false },
    ];

    const { error: conceptError } = await db
      .from('concept_registry')
      .insert(concepts.map(c => ({ ...c, user_id: auth_user_id })));
    if (conceptError) throw conceptError;

    // ── ko_default_registry ───────────────────────────────────
    const defaults = [
      { object_type: 'task', field: 'bucket_key',     value: 'capture'                           },
      { object_type: 'task', field: 'task_status_id', value: defaultStatus?.task_status_id ?? '' },
      { object_type: 'tag',  field: 'tag_group_id',   value: generalGroup?.tag_group_id ?? ''    },
    ];

    const { error: defaultError } = await db
      .from('ko_default_registry')
      .insert(defaults.map(d => ({ ...d, user_id: auth_user_id })));
    if (defaultError) throw defaultError;

    // ── ko_list_view_config ───────────────────────────────────
    const listConfigs = [
      {
        object_type: 'task',
        id_field: 'task_id',
        allow_delete: true,
        list_fields: [
          { field: 'title',          label: 'Task',    field_order: 1 },
          { field: 'bucket_key',     label: 'Bucket',  field_order: 2 },
          { field: 'context_id',     label: 'Context', field_order: 3 },
          { field: 'task_status_id', label: 'Status',  field_order: 4 },
          { field: 'target_date',    label: 'Due',     field_order: 5 },
          { field: 'tags',           label: 'Tags',    field_order: 6 },
        ],
      },
      {
        object_type: 'meeting',
        id_field: 'meeting_id',
        allow_delete: true,
        list_fields: [
          { field: 'title',        label: 'Meeting',   field_order: 1 },
          { field: 'meeting_date', label: 'Date',      field_order: 2 },
          { field: 'context_id',   label: 'Context',   field_order: 3 },
          { field: 'attendees',    label: 'Attendees', field_order: 4 },
          { field: 'outcome',      label: 'Outcome',   field_order: 5 },
        ],
      },
      {
        object_type: 'completion',
        id_field: 'completion_id',
        allow_delete: false,
        list_fields: [
          { field: 'title',        label: 'What',    field_order: 1 },
          { field: 'context_id',   label: 'Context', field_order: 2 },
          { field: 'outcome',      label: 'Outcome', field_order: 3 },
          { field: 'completed_at', label: 'When',    field_order: 4 },
          { field: 'tags',         label: 'Tags',    field_order: 5 },
        ],
      },
      {
        object_type: 'external_reference',
        id_field: 'external_reference_id',
        allow_delete: true,
        list_fields: [
          { field: 'title',      label: 'Title',   field_order: 1 },
          { field: 'ref_type',   label: 'Type',    field_order: 2 },
          { field: 'context_id', label: 'Context', field_order: 3 },
          { field: 'url',        label: 'URL',     field_order: 4 },
        ],
      },
      {
        object_type: 'document_template',
        id_field: 'document_template_id',
        allow_delete: true,
        list_fields: [
          { field: 'name',          label: 'Template', field_order: 1 },
          { field: 'doc_type',      label: 'Type',     field_order: 2 },
          { field: 'output_format', label: 'Output',   field_order: 3 },
          { field: 'is_active',     label: 'Active',   field_order: 4 },
        ],
      },
      {
        object_type: 'context',
        id_field: 'context_id',
        allow_delete: true,
        list_fields: [
          { field: 'name',        label: 'Context',     field_order: 1 },
          { field: 'description', label: 'Description', field_order: 2 },
        ],
      },
      {
        object_type: 'user_situation',
        id_field: 'user_situation_id',
        allow_delete: true,
        list_fields: [
          { field: 'name',      label: 'Situation', field_order: 1 },
          { field: 'is_active', label: 'Active',    field_order: 2 },
          { field: 'brief',     label: 'Brief',     field_order: 3 },
        ],
      },
    ];

    const { error: listConfigError } = await db
      .from('ko_list_view_config')
      .insert(listConfigs.map(c => ({ ...c, user_id: auth_user_id })));
    if (listConfigError) throw listConfigError;

    // ── ko_field_metadata ─────────────────────────────────────
    // insert_behavior: 'required' | 'optional' | 'automatic'
    // update_behavior: 'editable' | 'readonly' | 'automatic'
    // display_order 999 = hidden
    const fieldMeta = [
      // task
      { object_type: 'task', field: 'title',          field_type: 'text',     label: 'Title',        insert_behavior: 'required',  update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'task', field: 'description',    field_type: 'textarea', label: 'Description',  insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'task', field: 'notes',          field_type: 'textarea', label: 'Notes',        insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 3,   options: null },
      { object_type: 'task', field: 'bucket_key',     field_type: 'text',     label: 'Bucket',       insert_behavior: 'automatic', update_behavior: 'editable',  display_order: 4,   options: { input: 'select', display_mode: 'value', fk_table: 'concept_registry', fk_filter: 'bucket' } },
      { object_type: 'task', field: 'context_id',     field_type: 'uuid',     label: 'Context',      insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 5,   options: { input: 'select', display_mode: 'value', fk_table: 'context', fk_label: 'name' } },
      { object_type: 'task', field: 'task_status_id', field_type: 'uuid',     label: 'Status',       insert_behavior: 'automatic', update_behavior: 'editable',  display_order: 6,   options: { input: 'select', display_mode: 'value', fk_table: 'task_status', fk_label: 'label' } },
      { object_type: 'task', field: 'tags',           field_type: 'text[]',   label: 'Tags',         insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 7,   options: { input: 'tag_picker' } },
      { object_type: 'task', field: 'target_date',    field_type: 'date',     label: 'Target Date',  insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 8,   options: null },
      { object_type: 'task', field: 'is_delegated',   field_type: 'boolean',  label: 'Delegated',    insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 9,   options: { icon_if_true: '👋' } },
      { object_type: 'task', field: 'delegated_to',   field_type: 'text',     label: 'Delegated To', insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 10,  options: null },
      { object_type: 'task', field: 'user_id',        field_type: 'uuid',     label: 'User',         insert_behavior: 'automatic', update_behavior: 'readonly',  display_order: 999, options: null },

      // meeting
      { object_type: 'meeting', field: 'title',        field_type: 'text',     label: 'Title',       insert_behavior: 'required', update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'meeting', field: 'description',  field_type: 'textarea', label: 'Description', insert_behavior: 'optional', update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'meeting', field: 'meeting_date', field_type: 'date',     label: 'Date',        insert_behavior: 'optional', update_behavior: 'editable',  display_order: 3,   options: null },
      { object_type: 'meeting', field: 'context_id',   field_type: 'uuid',     label: 'Context',     insert_behavior: 'optional', update_behavior: 'editable',  display_order: 4,   options: { input: 'select', display_mode: 'value', fk_table: 'context', fk_label: 'name' } },
      { object_type: 'meeting', field: 'attendees',    field_type: 'text[]',   label: 'Attendees',   insert_behavior: 'optional', update_behavior: 'editable',  display_order: 5,   options: { input: 'tag_picker', group: 'People' } },
      { object_type: 'meeting', field: 'notes',        field_type: 'textarea', label: 'Notes',       insert_behavior: 'optional', update_behavior: 'editable',  display_order: 6,   options: null },
      { object_type: 'meeting', field: 'outcome',      field_type: 'textarea', label: 'Outcome',     insert_behavior: 'optional', update_behavior: 'editable',  display_order: 7,   options: null },
      { object_type: 'meeting', field: 'tags',         field_type: 'text[]',   label: 'Tags',        insert_behavior: 'optional', update_behavior: 'editable',  display_order: 8,   options: { input: 'tag_picker' } },
      { object_type: 'meeting', field: 'user_id',      field_type: 'uuid',     label: 'User',        insert_behavior: 'automatic', update_behavior: 'readonly', display_order: 999, options: null },

      // completion
      { object_type: 'completion', field: 'title',        field_type: 'text',     label: 'Title',       insert_behavior: 'required',  update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'completion', field: 'description',  field_type: 'textarea', label: 'Description', insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'completion', field: 'outcome',      field_type: 'textarea', label: 'Outcome',     insert_behavior: 'required',  update_behavior: 'editable',  display_order: 3,   options: null },
      { object_type: 'completion', field: 'context_id',   field_type: 'uuid',     label: 'Context',     insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 4,   options: { input: 'select', display_mode: 'value', fk_table: 'context', fk_label: 'name' } },
      { object_type: 'completion', field: 'completed_at', field_type: 'date',     label: 'When',        insert_behavior: 'required',  update_behavior: 'editable',  display_order: 5,   options: null },
      { object_type: 'completion', field: 'tags',         field_type: 'text[]',   label: 'Tags',        insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 6,   options: { input: 'tag_picker' } },
      { object_type: 'completion', field: 'task_id',      field_type: 'uuid',     label: 'Linked Task', insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 7,   options: { input: 'select', display_mode: 'value', fk_table: 'task', fk_label: 'title' } },
      { object_type: 'completion', field: 'user_id',      field_type: 'uuid',     label: 'User',        insert_behavior: 'automatic', update_behavior: 'readonly',  display_order: 999, options: null },

      // external_reference
      { object_type: 'external_reference', field: 'title',       field_type: 'text',     label: 'Title',       insert_behavior: 'required',  update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'external_reference', field: 'description', field_type: 'textarea', label: 'Description', insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'external_reference', field: 'ref_type',    field_type: 'text',     label: 'Type',        insert_behavior: 'required',  update_behavior: 'editable',  display_order: 3,   options: { input: 'select', options: ['url','file','report','media_kit','proposal','resume','other'] } },
      { object_type: 'external_reference', field: 'url',         field_type: 'text',     label: 'URL',         insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 4,   options: null },
      { object_type: 'external_reference', field: 'context_id',  field_type: 'uuid',     label: 'Context',     insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 5,   options: { input: 'select', display_mode: 'value', fk_table: 'context', fk_label: 'name' } },
      { object_type: 'external_reference', field: 'notes',       field_type: 'textarea', label: 'Notes',       insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 6,   options: null },
      { object_type: 'external_reference', field: 'tags',        field_type: 'text[]',   label: 'Tags',        insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 7,   options: { input: 'tag_picker' } },
      { object_type: 'external_reference', field: 'user_id',     field_type: 'uuid',     label: 'User',        insert_behavior: 'automatic', update_behavior: 'readonly',  display_order: 999, options: null },

      // document_template
      { object_type: 'document_template', field: 'name',            field_type: 'text',     label: 'Name',          insert_behavior: 'required',  update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'document_template', field: 'description',     field_type: 'textarea', label: 'Description',   insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'document_template', field: 'doc_type',        field_type: 'text',     label: 'Type',          insert_behavior: 'required',  update_behavior: 'editable',  display_order: 3,   options: { input: 'select', options: ['resume','cover_letter','status_report','pip_response','media_kit','proposal','other'] } },
      { object_type: 'document_template', field: 'prompt_template', field_type: 'textarea', label: 'Prompt',        insert_behavior: 'required',  update_behavior: 'editable',  display_order: 4,   options: null },
      { object_type: 'document_template', field: 'data_sources',    field_type: 'text[]',   label: 'Data Sources',  insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 5,   options: null },
      { object_type: 'document_template', field: 'output_format',   field_type: 'text',     label: 'Output Format', insert_behavior: 'required',  update_behavior: 'editable',  display_order: 6,   options: { input: 'select', options: ['markdown','html','pdf'] } },
      { object_type: 'document_template', field: 'is_active',       field_type: 'boolean',  label: 'Active',        insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 7,   options: null },
      { object_type: 'document_template', field: 'user_id',         field_type: 'uuid',     label: 'User',          insert_behavior: 'automatic', update_behavior: 'readonly',  display_order: 999, options: null },

      // context
      { object_type: 'context', field: 'name',        field_type: 'text',     label: 'Name',        insert_behavior: 'required', update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'context', field: 'description', field_type: 'textarea', label: 'Description', insert_behavior: 'optional', update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'context', field: 'user_id',     field_type: 'uuid',     label: 'User',        insert_behavior: 'automatic', update_behavior: 'readonly', display_order: 999, options: null },

      // user_situation
      { object_type: 'user_situation', field: 'name',                   field_type: 'text',    label: 'Name',              insert_behavior: 'required',  update_behavior: 'editable',  display_order: 1,   options: null },
      { object_type: 'user_situation', field: 'brief',                  field_type: 'textarea', label: 'My Situation',     insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 2,   options: null },
      { object_type: 'user_situation', field: 'is_active',              field_type: 'boolean',  label: 'Active',           insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 3,   options: null },
      { object_type: 'user_situation', field: 'chat_history_depth',     field_type: 'number',   label: 'Chat History',     insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 4,   options: { suffix: 'messages' } },
      { object_type: 'user_situation', field: 'completion_window_days', field_type: 'number',   label: 'Completion Window',insert_behavior: 'optional',  update_behavior: 'editable',  display_order: 5,   options: { suffix: 'days' } },
      { object_type: 'user_situation', field: 'user_id',                field_type: 'uuid',     label: 'User',             insert_behavior: 'automatic', update_behavior: 'readonly',  display_order: 999, options: null },
    ];

    const { error: fieldMetaError } = await db
      .from('ko_field_metadata')
      .insert(fieldMeta.map(f => ({ ...f, user_id: auth_user_id })));
    if (fieldMetaError) throw fieldMetaError;

    // ── user_situation (starter — prompts user to fill in) ────
    const { error: situationError } = await db
      .from('user_situation')
      .insert({
        user_id: auth_user_id,
        name: 'My Situation',
        brief: '',
        is_active: true,
        chat_history_depth: 15,
        completion_window_days: 7,
      });
    if (situationError) throw situationError;

    // =========================================================
    // 5. DONE
    // =========================================================

    return {
      success: true,
      ko_user_id: auth_user_id,
      session_id: newSession.ko_session_id,
      is_new_user: true,
    };

  } catch (err: any) {
    console.error('[initializeUserWorkspace]', err);
    return {
      success: false,
      error: err.message ?? 'Unknown error during workspace initialization',
    };
  }
}