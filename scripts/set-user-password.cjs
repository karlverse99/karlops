/**
 * One-off: set a Supabase Auth user's password via Admin API.
 * Use when password recovery email does not arrive.
 *
 * From the `karlops` folder, set env then run:
 *
 *   PowerShell:
 *     $env:NEXT_PUBLIC_SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."   # or SUPABASE_SECRET_KEY
 *     $env:AUTH_USER_ID="uuid-from-dashboard"
 *     $env:NEW_PASSWORD="your-new-password"
 *     node scripts/set-user-password.cjs
 *
 * Do not commit real passwords. Remove this script after use if you prefer.
 */

const { createClient } = require('@supabase/supabase-js');

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  process.env.SUPABASE_URL?.trim();
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_SECRET_KEY?.trim();
const userId = process.env.AUTH_USER_ID?.trim();
const newPassword = process.env.NEW_PASSWORD;

if (!url || !serviceKey || !userId || !newPassword) {
  console.error(
    'Missing env. Need: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY), AUTH_USER_ID, NEW_PASSWORD',
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  const { data, error } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
  console.log('OK. Password updated for:', data.user?.email ?? userId);
})();
