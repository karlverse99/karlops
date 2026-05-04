/**
 * One-off: set a Supabase Auth user's password via Admin API.
 *
 * Loads NEXT_PUBLIC_SUPABASE_URL + service role key from `.env.local` or `.env`
 * in the `karlops` folder (same as Next.js) so you don't have to paste them.
 *
 * From the `karlops` folder:
 *
 *   PowerShell (only email + new password):
 *     $env:AUTH_EMAIL="you@gmail.com"
 *     $env:NEW_PASSWORD="Your-New-Password"
 *     node scripts/set-user-password.cjs
 *
 *   Or with explicit user id:
 *     $env:AUTH_USER_ID="uuid"
 *     $env:NEW_PASSWORD="..."
 *     node scripts/set-user-password.cjs
 *
 * If you have no `.env.local` yet: copy URL + service_role from Vercel or
 * Supabase → Settings → API into `karlops/.env.local` once (never commit it).
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const root = path.join(__dirname, '..');

function loadEnvFile(name) {
  const p = path.join(root, name);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  process.env.SUPABASE_URL?.trim();
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_SECRET_KEY?.trim();
const newPassword = process.env.NEW_PASSWORD;
let userId = process.env.AUTH_USER_ID?.trim();
const authEmail = process.env.AUTH_EMAIL?.trim();

if (!url || !serviceKey) {
  console.error(
    'Missing Supabase URL or service role key.\n' +
      'Add to karlops/.env.local (not committed):\n' +
      '  NEXT_PUBLIC_SUPABASE_URL=https://....supabase.co\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=eyJ...   (or SUPABASE_SECRET_KEY)\n' +
      'Copy from Vercel env or Supabase → Settings → API.',
  );
  process.exit(1);
}

if (!newPassword) {
  console.error('Missing NEW_PASSWORD (set in PowerShell: $env:NEW_PASSWORD="..." )');
  process.exit(1);
}

if (!userId && !authEmail) {
  console.error(
    'Missing AUTH_USER_ID or AUTH_EMAIL.\n' +
      '  $env:AUTH_EMAIL="your-login-email"\n' +
      '  or $env:AUTH_USER_ID="uuid from Supabase → Authentication → Users"',
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  if (!userId && authEmail) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) {
      console.error('Could not list users:', error.message);
      process.exit(1);
    }
    const lower = authEmail.toLowerCase();
    const u = data.users.find((x) => (x.email ?? '').toLowerCase() === lower);
    if (!u) {
      console.error('No Auth user found with email:', authEmail);
      process.exit(1);
    }
    userId = u.id;
    console.log('Found user:', u.email, '→', userId);
  }

  const { data, error } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
  console.log('OK. Password updated for:', data.user?.email ?? userId);
})();
