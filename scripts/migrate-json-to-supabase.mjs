import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'data');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'broadcast-media';

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const supabase = createClient(url, key);

async function migrateContacts() {
  const contacts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'contacts.json'), 'utf8').catch(() => '[]'));
  if (!contacts.length) { console.log('[Migrate] No contacts to migrate'); return; }
  console.log(`[Migrate] Migrating ${contacts.length} contacts...`);
  let migrated = 0;
  for (const c of contacts) {
    try {
      const { error } = await supabase.from('contacts').upsert({
        wa_id: c.id,
        name: null,
        tags: c.tags || [],
        label: c.label || null,
        notes: c.notes || null,
      }, { onConflict: 'wa_id' });
      if (!error) migrated++;
    } catch (e) { console.error(`[Migrate] Contact error for ${c.id}:`, e.message); }
  }
  console.log(`[Migrate] Migrated ${migrated}/${contacts.length} contacts`);
}

async function migrateCampaigns() {
  const campaigns = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'campaigns.json'), 'utf8').catch(() => '[]'));
  if (!campaigns.length) { console.log('[Migrate] No campaigns to migrate'); return; }
  console.log(`[Migrate] Migrating ${campaigns.length} campaigns...`);
  let migrated = 0;
  for (const c of campaigns) {
    try {
      const { data, error } = await supabase.from('broadcast_campaigns').upsert({
        name: c.name,
        total_targets: c.progress?.total || c.contacts?.length || 0,
        sent_count: c.progress?.sent || 0,
        failed_count: c.progress?.failed || 0,
        status: c.status || 'pending',
      }, { onConflict: 'id' });
      if (!error) migrated++;
    } catch (e) { console.error(`[Migrate] Campaign error for ${c.id}:`, e.message); }
  }
  console.log(`[Migrate] Migrated ${migrated}/${campaigns.length} campaigns`);
}

async function migrateScheduled() {
  const scheduled = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scheduled.json'), 'utf8').catch(() => '[]'));
  if (!scheduled.length) { console.log('[Migrate] No scheduled items to migrate'); return; }
  console.log(`[Migrate] NOTE: ${scheduled.length} scheduled items exist in JSON but no scheduled table in schema. Skipping migration of scheduled items.`);
}

async function main() {
  console.log('[Migrate] Starting JSON-to-Supabase migration...');
  await migrateContacts();
  await migrateCampaigns();
  await migrateScheduled();
  console.log('[Migrate] Migration complete');
}

main().catch(e => { console.error('[Migrate] Fatal error:', e.message); process.exit(1); });