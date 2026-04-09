import { createServerClient } from '@/lib/supabase-server';

interface InitResult {
  success: boolean;
  ko_user_id?: string;
  session_id?: string;
  error?: string;
  is_new_user?: boolean;
}

export async function initializeUserWorkspace(
  auth_user_id: string,
  email: string,
  display_name?: string
): Promise<InitResult> {
  const db = createServerClient();

  try {
    // --- 1. Upsert ko_user ---
    // Check if user already exists
    const { data: existingUser, error: lookupError } = await db
      .from('ko_user')
      .select('id, implementation_type')
      .eq('id', auth_user_id)
      .maybeSingle();

    if (lookupError) throw lookupError;

    let ko_user_id: string;
    let is_new_user = false;

    if (!existingUser) {
      // New user — insert
      const { data: newUser, error: insertError } = await db
        .from('ko_user')
        .insert({
          id: auth_user_id,
          email,
          display_name: display_name ?? email.split('@')[0],
          implementation_type: 'business', // first vignette default
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertError) throw insertError;
      ko_user_id = newUser.id;
      is_new_user = true;
    } else {
      ko_user_id = existingUser.id;
    }

    // --- 2. Upsert ko_session ---
    // Check if session exists for this user
    const { data: existingSession, error: sessionLookupError } = await db
      .from('ko_session')
      .select('ko_session_id')
      .eq('user_id', ko_user_id)
      .maybeSingle();

    if (sessionLookupError) throw sessionLookupError;

    let session_id: string;

    if (!existingSession) {
      // Create new session row
      const { data: newSession, error: sessionInsertError } = await db
        .from('ko_session')
        .insert({
          user_id: ko_user_id,
          session_data: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('ko_session_id')
        .single();

      if (sessionInsertError) throw sessionInsertError;
      session_id = newSession.ko_session_id;
    } else {
      // Update last active timestamp
      const { error: sessionUpdateError } = await db
        .from('ko_session')
        .update({ updated_at: new Date().toISOString() })
        .eq('ko_session_id', existingSession.ko_session_id);

      if (sessionUpdateError) throw sessionUpdateError;
      session_id = existingSession.ko_session_id;
    }

    return {
      success: true,
      ko_user_id,
      session_id,
      is_new_user,
    };
  } catch (err: any) {
    console.error('[initializeUserWorkspace] error:', err);
    return {
      success: false,
      error: err.message ?? 'Unknown error during workspace initialization',
    };
  }
}