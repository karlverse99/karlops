// lib/ko/commands/captureCompletion.ts
// KarlOps L — Inserts a standalone completion record (no task required)

import { createSupabaseAdmin } from '@/lib/supabase-server';

interface CompletionPayload {
  title: string;
  outcome?: string;
}

interface CaptureResult {
  success: boolean;
  completion?: Record<string, any>;
  error?: string;
}

export async function captureCompletion(
  user_id: string,
  payload: CompletionPayload
): Promise<CaptureResult> {
  const db = createSupabaseAdmin();

  try {
    const { data, error } = await db
      .from('completion')
      .insert({
        user_id,
        title:        payload.title.trim(),
        outcome:      payload.outcome?.trim() || null,
        completed_at: new Date().toISOString().slice(0, 10),
        task_id:      null, // standalone — not linked to a task
        tags:         [],
        context_id:   null,
      })
      .select()
      .single();

    if (error) throw error;

    return { success: true, completion: data };
  } catch (err: any) {
    console.error('[captureCompletion]', err);
    return { success: false, error: err.message };
  }
}