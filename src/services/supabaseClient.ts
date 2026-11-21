import { createClient } from '@supabase/supabase-js';

// Rank Rush backend: Supabase project "Rank Rush" (Mumbai, ap-south-1).
// The publishable anon key is public by design; all data access is enforced
// server-side by Postgres Row Level Security and RPCs (see supabase/schema.sql).
export const SUPABASE_URL = 'https://mmhtdzmamzqoazgbkmdg.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_8-DehxwKB3GhCbNs-BrvHw_FFrbDkUe';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});
