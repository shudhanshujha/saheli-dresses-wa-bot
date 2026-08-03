import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import db from '../db/init.mjs';

dotenv.config();

async function migrate() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log('[Migration] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in environment — skipping migration.');
    process.exit(0);
  }

  console.log('[Migration] Connecting to Supabase...');
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key);

  const mediaDir = path.join(process.cwd(), 'data', 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  // 1. Contacts
  const { data: contacts, error: cErr } = await supabase.from('contacts').select('*');
  if (cErr) console.error('[Migration] Failed to fetch contacts:', cErr.message);
  else {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO contacts (id, wa_id, name, tags, label, notes, last_message_at, last_reply_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of contacts || []) {
      insert.run(c.id, c.wa_id, c.name, typeof c.tags === 'string' ? c.tags : JSON.stringify(c.tags || []), c.label, c.notes, c.last_message_at, c.last_reply_at, c.status, c.created_at);
    }
    console.log(`[Migration] Contacts migrated: ${contacts?.length || 0}`);
  }

  // 2. Broadcast Campaigns
  const { data: campaigns } = await supabase.from('broadcast_campaigns').select('*');
  if (campaigns) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO broadcast_campaigns (id, name, template_id, target_type, total_targets, sent_count, failed_count, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cmp of campaigns) {
      insert.run(cmp.id, cmp.name, cmp.template_id, cmp.target_type, cmp.total_targets, cmp.sent_count, cmp.failed_count, cmp.status, cmp.created_at, cmp.completed_at);
    }
    console.log(`[Migration] Campaigns migrated: ${campaigns.length}`);
  }

  // 3. Media Assets
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'broadcast-media';
  const { data: media } = await supabase.from('media_assets').select('*');
  if (media) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO media_assets (id, file_path, mime_type, file_name, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const m of media) {
      const fileName = m.file_path || `${m.id}.png`;
      const localPath = path.join(mediaDir, fileName);
      if (!existsSync(localPath)) {
        try {
          const { data: fileData, error: dlErr } = await supabase.storage.from(bucket).download(fileName);
          if (fileData && !dlErr) {
            const buffer = Buffer.from(await fileData.arrayBuffer());
            await fs.writeFile(localPath, buffer);
          }
        } catch (err) {
          console.warn(`[Migration] Could not download storage media ${fileName}:`, err.message);
        }
      }
      insert.run(m.id, fileName, m.mime_type, m.file_name, m.size_bytes, m.created_at);
    }
    console.log(`[Migration] Media assets migrated: ${media.length}`);
  }

  // 4. Message History
  const { data: messages } = await supabase.from('message_history').select('*');
  if (messages) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO message_history (id, contact_id, wa_id, campaign_id, source, direction, body, media_id, status, wa_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const msg of messages) {
      insert.run(msg.id, msg.contact_id, msg.wa_id, msg.campaign_id, msg.source, msg.direction, msg.body, msg.media_id, msg.status, msg.wa_message_id, msg.created_at);
    }
    console.log(`[Migration] Messages migrated: ${messages.length}`);
  }

  // 5. Waitlist
  const { data: waitlist } = await supabase.from('waitlist').select('*');
  if (waitlist) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO waitlist (id, contact_id, reason, message_id, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const w of waitlist) {
      insert.run(w.id, w.contact_id, w.reason, w.message_id, w.created_at, w.resolved_at);
    }
    console.log(`[Migration] Waitlist entries migrated: ${waitlist.length}`);
  }

  console.log('[Migration] All Supabase data successfully migrated to SQLite at data/bot.db!');
}

migrate().catch(console.error);
