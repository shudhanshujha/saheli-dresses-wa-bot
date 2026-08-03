import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import db from '../db/init.mjs';

const RETENTION_DAYS = process.env.HISTORY_RETENTION_DAYS || 30;

async function purgeOldHistory() {
  const cutoff = `-${RETENTION_DAYS} days`;

  try {
    const oldMedia = db.prepare(`
      SELECT m.id, m.file_path FROM media_assets m
      JOIN message_history mh ON mh.media_id = m.id
      WHERE mh.created_at < datetime('now', ?)
    `).all(cutoff);

    for (const media of oldMedia) {
      try {
        await fs.unlink(path.join(process.cwd(), 'data', 'media', media.file_path));
      } catch (err) {
        console.warn(`Could not delete media file ${media.file_path}:`, err.message);
      }
    }

    const mediaIds = oldMedia.map(m => m.id);
    if (mediaIds.length) {
      db.prepare(`DELETE FROM media_assets WHERE id IN (${mediaIds.map(() => '?').join(',')})`).run(...mediaIds);
    }

    const deletedMsgs = db.prepare(`DELETE FROM message_history WHERE created_at < datetime('now', ?)`).run(cutoff);
    const deletedWaitlist = db.prepare(`DELETE FROM waitlist WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', ?)`).run(cutoff);

    console.log(`[purge] Ran history purge at ${new Date().toISOString()}, removed ${mediaIds.length} media files, ${deletedMsgs.changes} messages, ${deletedWaitlist.changes} waitlist entries.`);
  } catch (err) {
    console.error('[purge] Error during purge:', err);
  }
}

// Run daily at 3am
cron.schedule('0 3 * * *', purgeOldHistory);

// Also run once at startup in case the PC was off past a scheduled time
purgeOldHistory();

export { purgeOldHistory };
