import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'broadcast-media';
const retentionDays = parseInt(process.env.HISTORY_RETENTION_DAYS || '30', 10);

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const supabase = createClient(url, key);

async function purgeOldMessages() {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Purge] Deleting messages older than ${retentionDays} days (before ${cutoff})`);

  const { data: oldMessages, error: msgErr } = await supabase
    .from('message_history')
    .select('id, media_id')
    .lt('created_at', cutoff);

  if (msgErr) {
    console.error('[Purge] Error fetching old messages:', msgErr.message);
    return;
  }

  if (!oldMessages || oldMessages.length === 0) {
    console.log('[Purge] No old messages to delete');
    return;
  }

  console.log(`[Purge] Found ${oldMessages.length} old messages`);

  const mediaIds = oldMessages.map(m => m.media_id).filter(Boolean);
  const messageIds = oldMessages.map(m => m.id);

  if (mediaIds.length > 0) {
    const { data: mediaAssets, error: mediaErr } = await supabase
      .from('media_assets')
      .select('id, storage_path')
      .in('id', mediaIds);

    if (mediaErr) console.error('[Purge] Error fetching media assets:', mediaErr.message);
    else if (mediaAssets) {
      for (const asset of mediaAssets) {
        try {
          await supabase.storage.from(bucket).remove([asset.storage_path]);
        } catch (e) {
          console.error(`[Purge] Error deleting storage file ${asset.storage_path}:`, e.message);
        }
      }
      const { error: delMediaErr } = await supabase
        .from('media_assets')
        .delete()
        .in('id', mediaIds);
      if (delMediaErr) console.error('[Purge] Error deleting media assets:', delMediaErr.message);
    }
  }

  const { error: delErr } = await supabase
    .from('message_history')
    .delete()
    .in('id', messageIds);

  if (delErr) console.error('[Purge] Error deleting messages:', delErr.message);
  else console.log(`[Purge] Deleted ${messageIds.length} messages and associated media`);
}

async function purgeOldWaitlist() {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('waitlist')
    .delete()
    .lt('created_at', cutoff)
    .not('resolved_at', 'is', null);

  if (error) console.error('[Purge] Error deleting old waitlist:', error.message);
  else console.log('[Purge] Old waitlist entries cleaned');
}

cron.schedule('0 3 * * *', () => {
  console.log('[Purge] Running scheduled purge...');
  purgeOldMessages().catch(e => console.error('[Purge] Error:', e.message));
  purgeOldWaitlist().catch(e => console.error('[Purge] Waitlist purge error:', e.message));
});

console.log(`[Purge] Scheduled daily purge at 3:00 AM (retention: ${retentionDays} days)`);
purgeOldMessages().catch(e => console.error('[Purge] Initial run error:', e.message));
purgeOldWaitlist().catch(e => console.error('[Purge] Initial waitlist purge error:', e.message));