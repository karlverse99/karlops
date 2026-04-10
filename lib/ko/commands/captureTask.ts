// lib/ko/commands/captureTask.ts
// KarlOps L — Capture a task
// Minimum viable: title only. Everything else from defaults or explicit payload.

import { createSupabaseAdmin } from '@/lib/supabase-server';

export interface CaptureTaskPayload {
  title: string;
  bucket_key?: string;
  context_id?: string;
  task_status_id?: string;
  tags?: string[];
  description?: string;
  notes?: string;
  target_date?: string;
  is_delegated?: boolean;
  delegated_to?: string;
}

export interface CaptureTaskResult {
  success: boolean;
  task_id?: string;
  task?: Record<string, any>;
  error?: string;
}

export async function captureTask(
  user_id: string,
  payload: CaptureTaskPayload
): Promise<CaptureTaskResult> {
  const db = createSupabaseAdmin();

  try {
    // ── Load defaults ──────────────────────────────────────────────────────
    const { data: defaults, error: defaultsError } = await db
      .from('ko_default_registry')
      .select('field, value')
      .eq('user_id', user_id)
      .eq('object_type', 'task');

    if (defaultsError) throw defaultsError;

    const defaultMap: Record<string, string> = {};
    for (const d of defaults ?? []) {
      defaultMap[d.field] = d.value;
    }

    // ── Build insert record — payload wins over defaults ───────────────────
    const record = {
      user_id,
      title:          payload.title.trim(),
      bucket_key:     payload.bucket_key     ?? defaultMap['bucket_key']     ?? 'capture',
      context_id:     payload.context_id     ?? defaultMap['context_id']     ?? null,
      task_status_id: payload.task_status_id ?? defaultMap['task_status_id'] ?? null,
      tags:           payload.tags           ?? [],
      description:    payload.description    ?? null,
      notes:          payload.notes          ?? null,
      target_date:    payload.target_date    ?? null,
      is_delegated:   payload.is_delegated   ?? false,
      delegated_to:   payload.delegated_to   ?? null,
    };

    // ── Insert ─────────────────────────────────────────────────────────────
    const { data: task, error: insertError } = await db
      .from('task')
      .insert(record)
      .select('task_id, title, bucket_key, context_id, task_status_id, tags, created_at')
      .single();

    if (insertError) throw insertError;

    return {
      success: true,
      task_id: task.task_id,
      task,
    };

  } catch (err: any) {
    console.error('[captureTask]', err);
    return {
      success: false,
      error: err.message ?? 'Failed to capture task',
    };
  }
}