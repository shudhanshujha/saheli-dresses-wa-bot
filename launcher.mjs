import { create, ev } from '@open-wa/wa-automate';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8')); }
  catch { return []; }
}
function writeJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

let clientInstance = null;
let currentQR = null;
let lastError = null;
let launchAttempts = 0;
let waReady = false;

let supabase = null;
let supabaseEnabled = false;
let encryptionKey = null;

function initEncryption() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.log('[Security] ENCRYPTION_KEY not set — sensitive fields will be stored in plaintext');
    return;
  }
  const keyBuf = Buffer.from(key.length >= 32 ? key.slice(0, 32) : key.padEnd(32, '0'), 'utf8');
  encryptionKey = keyBuf;
  console.log('[Security] Encryption enabled');
}

function encryptText(plainText) {
  if (!encryptionKey || !plainText) return plainText;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptText(encryptedText) {
  if (!encryptionKey || !encryptedText) return encryptedText;
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch { return encryptedText; }
}

function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('[Supabase] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set — Supabase features disabled');
    return;
  }
  try {
    supabase = createClient(url, key);
    supabaseEnabled = true;
    initEncryption();
    console.log('[Supabase] Client initialized');
    ensureDefaultUser();
  } catch (e) {
    console.error('[Supabase] Init failed:', e.message);
  }
}

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = 'sha256';

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
  return salt + ':' + key.toString('hex');
}

function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
  return key.toString('hex') === parts[1];
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function ensureDefaultUser() {
  if (!supabaseEnabled) return;
  try {
    const { data, error } = await supabase.from('users').select('*').limit(1);
    if (error) { console.error('[Supabase] ensureDefaultUser select error:', error.message); return; }
    if (data && data.length > 0) return;
    const password = process.env.DASHBOARD_PASSWORD || 'admin';
    if (!process.env.DASHBOARD_PASSWORD) {
      console.warn('[Auth] WARNING: Using default password "admin". Set DASHBOARD_PASSWORD env var to change.');
    }
    const hash = hashPassword(password);
    const { error: insErr } = await supabase.from('users').insert({ username: 'admin', password_hash: hash });
    if (insErr) console.error('[Supabase] ensureDefaultUser insert error:', insErr.message);
    else console.log('[Auth] Default user created');
  } catch (e) { console.error('[Supabase] ensureDefaultUser exception:', e.message); }
}

async function validateSession(token) {
  if (!supabaseEnabled || !token) return null;
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*, users(username)')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

async function supabaseUpsertContact(waId, name, number, tags, label, notes) {
  if (!supabaseEnabled) return null;
  try {
    const encryptedNotes = encryptText(notes || null);
    const { data, error } = await supabase
      .from('contacts')
      .upsert({ wa_id: waId, name: name || null, tags: tags || [], label: label || null, notes: encryptedNotes }, { onConflict: 'wa_id' })
      .select()
      .single();
    if (error) console.error('[Supabase] upsertContact error:', error.message);
    return data;
  } catch (e) {
    console.error('[Supabase] upsertContact exception:', e.message);
    return null;
  }
}

async function supabaseInsertMessage(waId, body, source, direction, campaignId, mediaId, status, waMessageId) {
  if (!supabaseEnabled) return null;
  try {
    const encryptedBody = encryptText(body || null);
    const { data, error } = await supabase
      .from('message_history')
      .insert({ wa_id: waId, body: encryptedBody, source, direction, campaign_id: campaignId || null, media_id: mediaId || null, status: status || 'sent', wa_message_id: waMessageId || null })
      .select()
      .single();
    if (error) console.error('[Supabase] insertMessage error:', error.message);
    return data;
  } catch (e) {
    console.error('[Supabase] insertMessage exception:', e.message);
    return null;
  }
}

async function supabaseUploadMedia(buffer, filename, mimeType) {
  if (!supabaseEnabled) return null;
  try {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'broadcast-media';
    const filePath = `media/${Date.now()}-${filename}`;
    const { data, error } = await supabase.storage.from(bucket).upload(filePath, buffer, { contentType: mimeType, upsert: false });
    if (error) { console.error('[Supabase] uploadMedia error:', error.message); return null; }
    const { data: asset, error: assetErr } = await supabase
      .from('media_assets')
      .insert({ storage_path: filePath, mime_type: mimeType, file_name: filename, size_bytes: buffer.length })
      .select()
      .single();
    if (assetErr) console.error('[Supabase] insertMediaAsset error:', assetErr.message);
    return asset;
  } catch (e) {
    console.error('[Supabase] uploadMedia exception:', e.message);
    return null;
  }
}

async function supabaseResolveWaitlist(waId) {
  if (!supabaseEnabled) return;
  try {
    const { error } = await supabase
      .from('waitlist')
      .update({ resolved_at: new Date().toISOString() })
      .eq('wa_id', waId)
      .is('resolved_at', null);
    if (error) console.error('[Supabase] resolveWaitlist error:', error.message);
  } catch (e) {
    console.error('[Supabase] resolveWaitlist exception:', e.message);
  }
}

async function supabaseInsertWaitlist(contactId, waId, reason, messageId) {
  if (!supabaseEnabled) return;
  try {
    const { error } = await supabase
      .from('waitlist')
      .insert({ contact_id: contactId, wa_id: waId, reason, message_id: messageId || null });
    if (error) console.error('[Supabase] insertWaitlist error:', error.message);
  } catch (e) {
    console.error('[Supabase] insertWaitlist exception:', e.message);
  }
}

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@7545';
const activeTokens = new Set();

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'authentication required' });
  const token = auth.slice(7);
  if (!activeTokens.has(token)) return res.status(401).json({ error: 'invalid or expired session' });
  req.session = { users: { username: ADMIN_USERNAME } };
  next();
}

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- AUTH ---------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  const token = generateToken();
  activeTokens.add(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  res.json({ token, expires_at: expiresAt });
});

app.get('/api/session', authMiddleware, (req, res) => {
  res.json({ authenticated: true, user: req.session?.users?.username || 'admin', expires_at: null });
});

app.post('/api/logout', authMiddleware, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) activeTokens.delete(token);
  if (clientInstance) {
    try { await clientInstance.kill(); } catch {}
    clientInstance = null;
  }
  waReady = false;
  res.json({ success: true, message: 'Logged out' });
  setTimeout(initClient, 1000);
});

/* ---------- MESSAGE HISTORY ---------- */
app.get('/api/history', authMiddleware, async (req, res) => {
  if (!supabaseEnabled) return res.status(503).json({ error: 'supabase not configured' });
  const { page = '1', pageSize = '50', source, wa_id } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
  try {
    let query = supabase.from('message_history').select('*, contacts(wa_id, name), media_assets(file_name, mime_type)').order('created_at', { ascending: false });
    if (source) query = query.eq('source', source);
    if (wa_id) query = query.eq('wa_id', wa_id);
    const { data, error, count } = await query.range((p - 1) * ps, p * ps - 1);
    if (error) return res.status(500).json({ error: error.message });
    const messages = (data || []).map(m => ({ ...m, body: decryptText(m.body) }));
    res.json({ messages, total: count || 0, page: p, pageSize: ps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/media/:id', authMiddleware, async (req, res) => {
  if (!supabaseEnabled) return res.status(503).json({ error: 'supabase not configured' });
  try {
    const { data, error } = await supabase.from('media_assets').select('storage_path, mime_type, file_name').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'media not found' });
    const { data: fileData, error: dlErr } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'broadcast-media').download(data.storage_path);
    if (dlErr) return res.status(404).json({ error: 'file not found' });
    res.set('Content-Type', data.mime_type);
    res.set('Content-Disposition', `attachment; filename="${esc(data.file_name || 'media')}"`);
    res.end(Buffer.from(await fileData.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- WAITLIST ---------- */
app.get('/api/waitlist', authMiddleware, async (req, res) => {
  if (!supabaseEnabled) return res.status(503).json({ error: 'supabase not configured' });
  try {
    const { data, error } = await supabase.from('waitlist').select('*, contacts(wa_id, name), message_history(body, source)').eq('resolved_at', null).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const waitlist = (data || []).map(w => {
      if (w.message_history?.body) w.message_history.body = decryptText(w.message_history.body);
      return w;
    });
    res.json({ waitlist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/waitlist/:id/resolve', authMiddleware, async (req, res) => {
  if (!supabaseEnabled) return res.status(503).json({ error: 'supabase not configured' });
  try {
    const { error } = await supabase.from('waitlist').update({ resolved_at: new Date().toISOString() }).eq('id', req.params.id).is('resolved_at', null);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function escapeXml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

async function withRetry(fn, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- DAILY SEND LIMIT ---------- */
const DAILY_SEND_LIMIT = 50;
const DAILY_LOG_PATH = path.join(DATA_DIR, 'daily-send-log.json');

function getDailySendLog() {
  try { return JSON.parse(fs.readFileSync(DAILY_LOG_PATH, 'utf8')); }
  catch { return {}; }
}

function getTodaySendCount() {
  const log = getDailySendLog();
  const today = new Date().toISOString().slice(0, 10);
  return log[today] || 0;
}

function incrementDailySendCount(amount = 1) {
  const log = getDailySendLog();
  const today = new Date().toISOString().slice(0, 10);
  log[today] = (log[today] || 0) + amount;
  fs.writeFileSync(DAILY_LOG_PATH, JSON.stringify(log, null, 2));
}

function getDailySendRemaining() {
  return Math.max(0, DAILY_SEND_LIMIT - getTodaySendCount());
}

function cleanupDailyLog() {
  const log = getDailySendLog();
  const keys = Object.keys(log);
  if (keys.length > 30) {
    const sorted = keys.sort();
    const trimmed = {};
    for (const k of sorted.slice(-30)) trimmed[k] = log[k];
    fs.writeFileSync(DAILY_LOG_PATH, JSON.stringify(trimmed, null, 2));
  }
}

// periodic check to resume daily-paused campaigns
setInterval(() => {
  const remaining = getDailySendRemaining();
  if (remaining > 0) {
    resumeDailyPausedCampaigns();
    flushBroadcastQueue();
  }
}, 60000);

/* ---------- STATUS ---------- */
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!clientInstance && waReady,
    host: clientInstance?.hostAccountNumber || null,
    qr: currentQR || null,
    chatsCount: 0,
    contactsCount: 0,
    uptime: clientInstance?._startTime || null,
    lastError: lastError || null,
    launchAttempts,
  });
});

/* ---------- PROFILE PICTURES ---------- */
app.get('/api/profile-pic/:contactId', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const url = await withRetry(() => clientInstance.getProfilePicFromServer(req.params.contactId));
    if (url) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        res.end(buf);
        return;
      }
    }
  } catch {}
  const id = req.params.contactId;
  let name = '?';
  try {
    const c = await clientInstance.getContact(id);
    if (c) name = c.name || c.formattedName || c.pushname || c.id || '?';
  } catch {}
  let h = 0; for (const c of id) h = ((h << 5) - h) + c.charCodeAt(0);
  const colors = ['#00a884','#5b61b9','#a069c3','#f15a6a','#f19e38','#4ad2a6','#6f8c9f','#cb6d62','#4eacd6','#d9a460','#79c577','#e379b3'];
  const bg = colors[Math.abs(h) % colors.length];
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  const init = parts.length > 1 ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase() : name.slice(0,2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <rect width="96" height="96" rx="48" fill="${bg}"/>
    <text x="48" y="54" text-anchor="middle" fill="white" font-size="36" font-weight="600" font-family="sans-serif">${escapeXml(init)}</text>
  </svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.end(Buffer.from(svg));
});

/* ---------- PERSISTENT MESSAGE STORE ---------- */
const msgStore = {};
const msgStoreDirty = new Set();
let msgStoreTimer = null;
function loadMsgStore(chatId) {
  try {
    const key = chatId.replace(/[^a-zA-Z0-9@._-]/g, '_');
    if (!msgStore[chatId]) {
      const p = path.join(DATA_DIR, 'msgs', key + '.json');
      msgStore[chatId] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    }
    return msgStore[chatId];
  } catch { return []; }
}
function saveMsg(chatId, msg) {
  const msgs = loadMsgStore(chatId);
  if (msgs.some(m => m.id === msg.id)) return;
  msgs.push(msg);
  msgStoreDirty.add(chatId);
  if (!msgStoreTimer) {
    msgStoreTimer = setImmediate(() => {
      msgStoreTimer = null;
      const pending = [...msgStoreDirty];
      msgStoreDirty.clear();
      for (const cid of pending) {
        try {
          const key = cid.replace(/[^a-zA-Z0-9@._-]/g, '_');
          const p = path.join(DATA_DIR, 'msgs', key + '.json');
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify(msgStore[cid] || []));
        } catch {}
      }
    });
  }
}

/* ---------- CHATS / INBOX ---------- */
app.get('/api/chats', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const chats = (await withRetry(() => clientInstance.getAllChats())) || [];
    res.json(chats.map(c => ({
      id: c.id._serialized || c.id,
      name: c.name || c.formattedTitle || c.id,
      unreadCount: c.unreadCount || 0,
      lastMessage: c.lastMessage?.body || null,
      timestamp: c.t || null,
      isGroup: !!c.isGroup,
      contact: c.contact ? { name: c.contact.name || c.contact.pushname || null, number: c.contact.number || null } : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/:chatId', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const chatId = req.params.chatId;
  try {
    const page = clientInstance.getPage();
    if (!page || page.isClosed()) return res.status(503).json({ error: 'page closed' });
    try {
      const page = clientInstance.getPage();
      if (page && !page.isClosed()) {
        await page.evaluate(async function(id) {
          try {
            await WAPI.loadAllEarlierMessages(id);
          } catch(e) {}
        }, chatId).catch(() => {});
      }
    } catch {}
    let waMsgs = await withRetry(() => clientInstance.getAllMessagesInChat(chatId, true, false)).catch(() => []);
    const stored = loadMsgStore(chatId);
    const seen = new Set();
    const all = [];
    for (const m of [...(waMsgs || []), ...stored]) {
      const id = m.id?._serialized || m.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(m);
    }
    all.sort((a, b) => (a.t || 0) - (b.t || 0));
    res.json(all.slice(-100).reverse().map(m => ({
      id: m.id?._serialized || m.id,
      from: m.from,
      fromMe: m.fromMe || (m.id ? !!m.id.fromMe : false),
      body: m.body || m.caption || '',
      timestamp: m.t,
      type: m.type || 'text',
      isMedia: !!m.mimetype,
      mimetype: m.mimetype || null,
      senderName: m.sender?.pushname || m.sender?.formattedName || m.author || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'query param required' });
  try {
    const results = await withRetry(() => clientInstance.searchMessages(query));
    res.json((results || []).slice(0, 50).map(m => ({
      id: m.id, chatId: m.chatId, body: m.body, fromMe: m.fromMe, timestamp: m.t,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:chatId', async (req, res) => {
  const chatId = req.params.chatId;
  try {
    const key = chatId.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const p = path.join(DATA_DIR, 'msgs', key + '.json');
    delete msgStore[chatId];
    msgStoreDirty.delete(chatId);
    try { fs.unlinkSync(p); } catch {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- SEND ---------- */
app.post('/api/send', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' });
  try {
    const result = await withRetry(() => clientInstance.sendText(chatId, text));
    saveMsg(chatId, { id: result?.id || Date.now().toString(), from: chatId, fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000), type: 'text' });
    supabaseInsertMessage(chatId, text, 'manual', 'outbound', null, null, 'sent', result?.id || null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send/bulk', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { chatIds, text, delayMs = 2000 } = req.body;
  if (!chatIds?.length || !text) return res.status(400).json({ error: 'chatIds and text required' });
  const results = [];
  for (let i = 0; i < chatIds.length; i++) {
    try {
      const r = await withRetry(() => clientInstance.sendText(chatIds[i], text));
      saveMsg(chatIds[i], { id: r?.id || Date.now().toString() + i, from: chatIds[i], fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000), type: 'text' });
      supabaseInsertMessage(chatIds[i], text, 'manual', 'outbound', null, null, 'sent', r?.id || null);
      results.push({ chatId: chatIds[i], status: 'sent' });
    } catch (e) { results.push({ chatId: chatIds[i], status: 'failed', error: e.message }); }
    if (i < chatIds.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  res.json({ results, sent: results.filter(r => r.status === 'sent').length, failed: results.filter(r => r.status === 'failed').length });
});

app.post('/api/send/media', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { chatId, base64, filename, caption } = req.body;
  if (!chatId || !base64) return res.status(400).json({ error: 'chatId and base64 required' });
  try {
    const mime = base64.split(';')[0].split(':')[1] || 'image/png';
    const cleanData = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(cleanData, 'base64');
    let mediaId = null;
    const mediaAsset = await supabaseUploadMedia(buffer, filename || 'attachment', mime);
    if (mediaAsset) mediaId = mediaAsset.id;
    if (mime.startsWith('image')) await withRetry(() => clientInstance.sendImage(chatId, base64, filename || 'image.png', caption || ''));
    else await withRetry(() => clientInstance.sendFile(chatId, base64, filename || 'file', caption || ''));
    supabaseInsertMessage(chatId, caption || '', 'manual', 'outbound', null, mediaId, 'sent', null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- BROADCAST ---------- */
const BROADCAST_QUEUE_PATH = path.join(DATA_DIR, 'broadcast-queue.json');
let broadcastQueue = [];
try { broadcastQueue = JSON.parse(fs.readFileSync(BROADCAST_QUEUE_PATH, 'utf8')); } catch {}

function saveBroadcastQueue() {
  fs.writeFileSync(BROADCAST_QUEUE_PATH, JSON.stringify(broadcastQueue, null, 2));
}

async function sendToChat(chatId, payload) {
  if (!clientInstance) throw new Error('not connected');
  if (payload.mimetype && payload.data) {
    if (payload.mimetype.startsWith('image')) {
      await withRetry(() => clientInstance.sendImage(chatId, payload.data, payload.filename || 'image.png', payload.message || ''));
    } else {
      await withRetry(() => clientInstance.sendFile(chatId, payload.data, payload.filename || 'file', payload.message || ''));
    }
  } else {
    await withRetry(() => clientInstance.sendText(chatId, payload.message));
  }
  incrementDailySendCount();
  saveMsg(chatId, { id: Date.now().toString(), from: chatId, fromMe: true, body: payload.message || '', timestamp: Math.floor(Date.now() / 1000), type: 'text' });
  supabaseInsertMessage(chatId, payload.message || '', 'broadcast', 'outbound', null, null, 'sent', null);
}

app.post('/api/broadcast', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { chatIds: rawIds, message, templateId, mimetype, data, filename } = req.body;
  if (!rawIds?.length) return res.status(400).json({ error: 'chatIds[] required' });
  const chatIds = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String).map(s => s.trim()).filter(Boolean))];
  if (!chatIds.length) return res.status(400).json({ error: 'chatIds[] must contain valid recipient IDs' });

  let msg = message;
  if (templateId && !msg) {
    const templates = readJSON('templates');
    const tpl = templates.find(t => t.id === templateId);
    if (tpl) msg = tpl.body;
  }
  if (!msg && !data) return res.status(400).json({ error: 'message or templateId or media required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const emit = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ } };

  const payload = { message: msg, mimetype: mimetype || null, data: data || null, filename: filename || null };
  const results = [];
  let failed = 0;
  let queued = 0;
  let done = 0;

  for (let i = 0; i < chatIds.length; i++) {
    const chatId = chatIds[i];
    if (getDailySendRemaining() <= 0) {
      broadcastQueue.push({ chatIds: chatIds.slice(i), payload, createdAt: new Date().toISOString() });
      queued = chatIds.length - i;
      saveBroadcastQueue();
      break;
    }
    emit({ type: 'progress', done, total: chatIds.length, current: chatId });
    try {
      await sendToChat(chatId, payload);
      results.push({ chatId, success: true });
      done++;
    } catch (e) {
      failed++;
      results.push({ chatId, success: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  emit({ type: 'done', results, failed, queued, quota: { used: getTodaySendCount(), limit: DAILY_SEND_LIMIT, remaining: getDailySendRemaining() } });
  res.end();
});

async function flushBroadcastQueue() {
  if (!clientInstance || !broadcastQueue.length) return;
  const retries = {};
  while (broadcastQueue.length && getDailySendRemaining() > 0) {
    const batch = broadcastQueue[0];
    const chatId = batch.chatIds.shift();
    if (chatId) {
      retries[chatId] = (retries[chatId] || 0) + 1;
      try { await sendToChat(chatId, batch.payload); }
      catch (e) {
        console.error('[Broadcast queue] send failed:', chatId, e.message);
        if (retries[chatId] < 3) {
          batch.chatIds.push(chatId);
          batch.retries = retries[chatId];
        } else {
          console.error('[Broadcast queue] giving up on', chatId);
        }
      }
      if (broadcastQueue.length > 1) await new Promise(r => setTimeout(r, 2000));
    }
    if (!batch.chatIds.length) broadcastQueue.shift();
    saveBroadcastQueue();
  }
}

/* ---------- CONTACTS ---------- */
app.post('/api/contacts/import', (req, res) => {
  const { csv, contacts: jsonContacts } = req.body;
  const enrichment = readJSON('contacts');
  let imported = 0;

  if (jsonContacts && Array.isArray(jsonContacts)) {
    for (const c of jsonContacts) {
      if (!c.id && !c.phone) continue;
      const id = c.id || c.phone + '@c.us';
      const existing = enrichment.findIndex(x => x.id === id);
      const entry = { id, tags: c.tags || [], notes: c.notes || '', label: c.label || '' };
      if (existing >= 0) enrichment[existing] = { ...enrichment[existing], ...entry };
      else enrichment.push(entry);
      imported++;
    }
  }

  if (csv) {
    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const header = lines[0].toLowerCase().split(',').map(h => h.trim());
      const phoneIdx = header.findIndex(h => h === 'phone' || h === 'number' || h === 'whatsapp');
      const nameIdx = header.findIndex(h => h === 'name');
      const tagsIdx = header.findIndex(h => h === 'tags' || h === 'tag');
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        const phone = phoneIdx >= 0 ? parts[phoneIdx] : null;
        if (!phone) continue;
        const id = phone.includes('@') ? phone : phone + '@c.us';
        const existing = enrichment.findIndex(x => x.id === id);
        const entry = { id, tags: [], notes: '', label: '' };
        if (tagsIdx >= 0) entry.tags = parts[tagsIdx] ? parts[tagsIdx].split(';').map(t => t.trim()).filter(Boolean) : [];
        if (existing >= 0) enrichment[existing] = { ...enrichment[existing], ...entry };
        else enrichment.push(entry);
        imported++;
      }
    }
  }

  writeJSON('contacts', enrichment);
  res.json({ success: true, imported });
});
let contactCache = null;
let contactCacheTime = 0;
const CONTACT_CACHE_TTL = 60000;

async function getContactList() {
  if (contactCache && Date.now() - contactCacheTime < CONTACT_CACHE_TTL) return contactCache;
  const raw = await withRetry(() => clientInstance.getAllContacts());
  const enrichment = readJSON('contacts');
  const seen = new Set();
  const enriched = [];
  raw.forEach(c => {
    const id = c.id._serialized || c.id;
    if (seen.has(id)) return;
    seen.add(id);
    const e = enrichment.find(x => x.id === id) || {};
    const number = c.number || (id.includes('@') ? id.split('@')[0] : id);
    enriched.push({
      id, name: c.name || c.formattedName || c.pushname || number,
      number, isBusiness: !!c.isBusiness,
      tags: e.tags || [], notes: e.notes || '', label: e.label || '',
    });
  });
  contactCache = enriched;
  contactCacheTime = Date.now();
  return enriched;
}

app.get('/api/contacts', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const enriched = await getContactList();
    const { search, tag, page = '1', pageSize = '50' } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
    const filtered = search
      ? enriched.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()) || (c.number || '').includes(search))
      : tag ? enriched.filter(c => c.tags.includes(tag)) : enriched;
    const total = enriched.length;
    const start = (p - 1) * ps;
    const paged = filtered.slice(start, start + ps);
    res.json({ contacts: paged, total, filtered: filtered.length, page: p, pageSize: ps, totalPages: Math.ceil(filtered.length / ps) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts/refresh', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    contactCache = null;
    await getContactList();
    res.json({ success: true, total: contactCache.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/contacts/:id', async (req, res) => {
  const enrichment = readJSON('contacts');
  const idx = enrichment.findIndex(x => x.id === req.params.id);
  const entry = { id: req.params.id, ...req.body };
  if (idx >= 0) enrichment[idx] = { ...enrichment[idx], ...entry };
  else enrichment.push(entry);
  writeJSON('contacts', enrichment);
  res.json({ success: true });
});

app.get('/api/contacts/:id', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const contact = await withRetry(() => clientInstance.getContact(req.params.id));
    const enrichment = readJSON('contacts');
    const e = enrichment.find(x => x.id === req.params.id) || {};
    res.json({
      id: req.params.id, name: contact?.name || contact?.pushname || req.params.id,
      number: contact?.number || null, isBusiness: contact?.isBusiness || false,
      tags: e.tags || [], notes: e.notes || '', label: e.label || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contacts/:id/tags/:tag', (req, res) => {
  const enrichment = readJSON('contacts');
  const e = enrichment.find(x => x.id === req.params.id);
  if (e) { e.tags = (e.tags || []).filter(t => t !== req.params.tag); writeJSON('contacts', enrichment); }
  res.json({ success: true });
});

/* ---------- TEMPLATES ---------- */
app.get('/api/templates', (req, res) => res.json(readJSON('templates')));
app.post('/api/templates', (req, res) => {
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body required' });
  const templates = readJSON('templates');
  const t = { id: Date.now().toString(), name, body, variables: (body.match(/\{\{(\w+)\}\}/g) || []).map(v => v.replace(/[{}]/g, '')), createdAt: new Date().toISOString() };
  templates.push(t); writeJSON('templates', templates); res.json(t);
});
app.put('/api/templates/:id', (req, res) => {
  const templates = readJSON('templates');
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  templates[idx] = { ...templates[idx], ...req.body, id: req.params.id };
  writeJSON('templates', templates); res.json(templates[idx]);
});
app.delete('/api/templates/:id', (req, res) => {
  let templates = readJSON('templates');
  templates = templates.filter(t => t.id !== req.params.id);
  writeJSON('templates', templates); res.json({ success: true });
});
app.post('/api/templates/preview', (req, res) => {
  const { body, variables } = req.body;
  let preview = body;
  if (variables) for (const [k, v] of Object.entries(variables)) preview = preview.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  res.json({ preview });
});

/* ---------- AUTO-REPLY RULES ---------- */
app.get('/api/auto-reply', (req, res) => res.json(readJSON('autoreply')));
app.post('/api/auto-reply', (req, res) => {
  const { name, keywords, matchType, reply, active } = req.body;
  if (!name || !reply) return res.status(400).json({ error: 'name and reply required' });
  const rules = readJSON('autoreply');
  rules.push({ id: Date.now().toString(), name, keywords: keywords || [], matchType: matchType || 'exact', reply, active: active !== false, createdAt: new Date().toISOString() });
  writeJSON('autoreply', rules); res.json({ success: true });
});
app.put('/api/auto-reply/:id', (req, res) => {
  const rules = readJSON('autoreply');
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  rules[idx] = { ...rules[idx], ...req.body, id: req.params.id };
  writeJSON('autoreply', rules); res.json(rules[idx]);
});
app.delete('/api/auto-reply/:id', (req, res) => {
  let rules = readJSON('autoreply');
  rules = rules.filter(r => r.id !== req.params.id);
  writeJSON('autoreply', rules); res.json({ success: true });
});

/* ---------- FLOWS (multi-step conversational) ---------- */
app.get('/api/flows', (req, res) => res.json(readJSON('flows')));

app.post('/api/flows', (req, res) => {
  const { name, trigger } = req.body;
  if (!name || !trigger) return res.status(400).json({ error: 'name and trigger required' });
  const flows = readJSON('flows');
  const flow = {
    id: Date.now().toString(),
    name, trigger: trigger.toLowerCase(),
    active: true,
    createdAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'send', message: `Hi! You triggered "${trigger}". Customize this flow.` },
      { id: 's2', type: 'wait' },
      { id: 's3', type: 'send', message: 'Thanks for your response!' },
      { id: 's4', type: 'end' },
    ],
  };
  flows.push(flow); writeJSON('flows', flows); res.json(flow);
});

app.put('/api/flows/:id', (req, res) => {
  const flows = readJSON('flows');
  const idx = flows.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  flows[idx] = { ...flows[idx], ...req.body, id: req.params.id };
  writeJSON('flows', flows); res.json(flows[idx]);
});

app.delete('/api/flows/:id', (req, res) => {
  let flows = readJSON('flows');
  flows = flows.filter(f => f.id !== req.params.id);
  writeJSON('flows', flows);
  for (const k of Object.keys(flowSessions)) {
    if (flowSessions[k].flowId === req.params.id) delete flowSessions[k];
  }
  res.json({ success: true });
});

app.post('/api/flows/:id/toggle', (req, res) => {
  const flows = readJSON('flows');
  const idx = flows.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  flows[idx].active = !flows[idx].active;
  writeJSON('flows', flows); res.json(flows[idx]);
});

/* ---------- FLOW EXECUTION ENGINE ---------- */
const flowSessions = {};

async function handleFlowTrigger(chatId, msgBody) {
  if (!clientInstance) return false;
  const flows = readJSON('flows');
  const body = (msgBody || '').toLowerCase();

  // Check active session first
  let session = flowSessions[chatId];
  if (session) {
    const flow = flows.find(f => f.id === session.flowId);
    if (!flow || !flow.active) { delete flowSessions[chatId]; return false; }
    if (session.currentStepId) {
      const step = flow.steps.find(s => s.id === session.currentStepId);
      if (step && step.type === 'wait') {
        return executeFlowStep(chatId, flow, session, body);
      }
    }
    return false;
  }

  // Check if message triggers a flow
  for (const flow of flows) {
    if (!flow.active || !flow.trigger) continue;
    if (body.includes(flow.trigger)) {
      flowSessions[chatId] = { flowId: flow.id, stepIndex: 0, currentStepId: null };
      return executeFlowFromIndex(chatId, flow, 0);
    }
    const escapedTrigger = flow.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      if (new RegExp('\\b' + escapedTrigger + '\\b', 'i').test(body)) {
        flowSessions[chatId] = { flowId: flow.id, stepIndex: 0, currentStepId: null };
        return executeFlowFromIndex(chatId, flow, 0);
      }
    } catch {}
  }
  return false;
}

async function executeFlowStep(chatId, flow, session, userInput) {
  const step = flow.steps.find(s => s.id === session.currentStepId);
  if (!step) { delete flowSessions[chatId]; return false; }
  const stepIdx = flow.steps.findIndex(s => s.id === step.id);
  session.currentStepId = null;

  // Check attached condition
  if (step.conditions?.length) {
    for (const cond of step.conditions) {
      if (userInput === cond.match || (cond.matchType === 'contains' && userInput.includes(cond.match))) {
        const targetIdx = flow.steps.findIndex(s => s.id === cond.thenStep);
        if (targetIdx >= 0) return executeFlowFromIndex(chatId, flow, targetIdx);
        break;
      }
    }
    // No condition matched — go to next step
    return executeFlowFromIndex(chatId, flow, stepIdx + 1);
  }

  // No conditions — go to next step
  return executeFlowFromIndex(chatId, flow, stepIdx + 1);
}

async function executeFlowFromIndex(chatId, flow, idx) {
  if (idx >= flow.steps.length) { delete flowSessions[chatId]; return false; }
  const step = flow.steps[idx];
  if (!step) { delete flowSessions[chatId]; return false; }

  if (step.type === 'send') {
    try { await withRetry(() => clientInstance.sendText(chatId, step.message)); } catch {}
    // If next step is wait, create session; otherwise continue
    const nextStep = flow.steps[idx + 1];
    if (nextStep && nextStep.type === 'wait') {
      flowSessions[chatId] = { flowId: flow.id, stepIndex: idx, currentStepId: nextStep.id };
    } else if (nextStep && nextStep.type === 'end') {
      delete flowSessions[chatId];
    } else if (nextStep) {
      flowSessions[chatId] = { flowId: flow.id, stepIndex: idx + 1, currentStepId: null };
      setTimeout(() => executeFlowFromIndex(chatId, flow, idx + 1), 1000);
    } else {
      delete flowSessions[chatId];
    }
  } else if (step.type === 'wait') {
    flowSessions[chatId] = { flowId: flow.id, stepIndex: idx, currentStepId: step.id };
  } else if (step.type === 'end') {
    delete flowSessions[chatId];
  } else {
    delete flowSessions[chatId];
  }
  return true;
}

/* ---------- CAMPAIGN TEMPLATES ---------- */
app.get('/api/campaign-templates', (req, res) => res.json(readJSON('campaign-templates')));
function extractVariables(text) {
  const vars = text.match(/\{\{(\w+)\}\}/g);
  if (!vars) return [];
  return [...new Set(vars.map(v => v.replace(/\{\{|\}\}/g, '')))];
}

app.post('/api/campaign-templates', (req, res) => {
  const { name, message, targetType, targetFilter } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const ct = readJSON('campaign-templates');
  const variables = extractVariables(message);
  ct.push({ id: Date.now().toString(), name, message, variables, targetType: targetType || 'all', targetFilter: targetFilter || '', createdAt: new Date().toISOString() });
  writeJSON('campaign-templates', ct); res.json({ success: true });
});
app.delete('/api/campaign-templates/:id', (req, res) => {
  let ct = readJSON('campaign-templates');
  ct = ct.filter(c => c.id !== req.params.id);
  writeJSON('campaign-templates', ct); res.json({ success: true });
});
app.get('/api/campaigns', (req, res) => res.json(readJSON('campaigns')));
app.post('/api/campaigns', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { name, message, targetType, targetFilter, scheduleAt } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  try {
    let contacts;
    if (targetType === 'all') { const c = await withRetry(() => clientInstance.getAllContacts()); contacts = (c || []).map(x => x.id._serialized || x.id); }
    else if (targetType === 'tag') { const enrichment = readJSON('contacts'); contacts = enrichment.filter(e => (e.tags || []).includes(targetFilter)).map(e => e.id); }
    else contacts = targetFilter || [];
    const campaign = {
      id: Date.now().toString(), name, message, targetType, targetFilter, contacts,
      status: scheduleAt ? 'scheduled' : 'draft', progress: { sent: 0, failed: 0, total: contacts.length },
      createdAt: new Date().toISOString(), scheduleAt: scheduleAt || null,
    };
    const campaigns = readJSON('campaigns');
    campaigns.push(campaign); writeJSON('campaigns', campaigns);
    if (scheduleAt) scheduleCampaign(campaign);
    else executeCampaign(campaign.id);
    res.json(campaign);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns/:id/start', (req, res) => {
  executeCampaign(req.params.id);
  res.json({ success: true });
});

app.delete('/api/campaigns/:id', (req, res) => {
  let campaigns = readJSON('campaigns');
  campaigns = campaigns.filter(c => c.id !== req.params.id);
  writeJSON('campaigns', campaigns);
  if (campaignTimers[req.params.id]) { clearTimeout(campaignTimers[req.params.id]); delete campaignTimers[req.params.id]; }
  res.json({ success: true });
});

const campaignTimers = {};
function scheduleCampaign(c) {
  if (campaignTimers[c.id]) { clearTimeout(campaignTimers[c.id]); delete campaignTimers[c.id]; }
  if (c.status !== 'scheduled' || !c.scheduleAt) return;
  const delay = new Date(c.scheduleAt).getTime() - Date.now();
  if (delay <= 0) {
    const campaigns = readJSON('campaigns');
    const found = campaigns.find(x => x.id === c.id);
    if (found) { found.status = 'running'; writeJSON('campaigns', campaigns); }
    executeCampaign(c.id);
    return;
  }
  campaignTimers[c.id] = setTimeout(() => {
    const campaigns = readJSON('campaigns');
    const found = campaigns.find(x => x.id === c.id);
    if (found) { found.status = 'running'; writeJSON('campaigns', campaigns); }
    executeCampaign(c.id);
    delete campaignTimers[c.id];
  }, delay);
}
function resumeScheduledCampaigns() {
  const campaigns = readJSON('campaigns');
  campaigns.filter(c => c.status === 'scheduled' && c.scheduleAt).forEach(c => scheduleCampaign(c));
}

async function executeCampaign(id) {
  const campaigns = readJSON('campaigns');
  const c = campaigns.find(x => x.id === id);
  if (!c || !clientInstance) return;

  // resume from last sent index if was daily-paused
  const contacts = c.contacts || [];
  let startIdx = 0;
  if (c.status === 'daily_paused' && c._resumeIndex != null) {
    startIdx = c._resumeIndex;
    c.progress.sent = c.progress.sent || 0;
    c.progress.failed = c.progress.failed || 0;
  }

  c.status = 'running';
  c._resumeIndex = null;
  writeJSON('campaigns', campaigns);

  const today = new Date().toISOString().slice(0, 10);

  for (let i = startIdx; i < contacts.length; i++) {
    if (!clientInstance) { c.status = 'cancelled'; writeJSON('campaigns', campaigns); return; }

    // daily limit check before each send
    if (getTodaySendCount() >= DAILY_SEND_LIMIT) {
      c.status = 'daily_paused';
      c._resumeIndex = i;
      c.progress.total = contacts.length;
      writeJSON('campaigns', campaigns);
      return;
    }

    try {
      await withRetry(() => clientInstance.sendText(contacts[i], c.message));
      c.progress.sent++;
      incrementDailySendCount();
      supabaseInsertMessage(contacts[i], c.message, 'campaign', 'outbound', c.id, null, 'sent', null);
      supabaseUpsertContact(contacts[i], null, null, null, null, null);
    } catch (e) { c.progress.failed++; }
    c.progress.total = contacts.length;
    writeJSON('campaigns', campaigns);
    if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 2000));
  }
  c.status = 'completed'; writeJSON('campaigns', campaigns);
}

function resumeDailyPausedCampaigns() {
  if (!clientInstance) return;
  const campaigns = readJSON('campaigns');
  const today = new Date().toISOString().slice(0, 10);
  for (const c of campaigns) {
    if (c.status === 'daily_paused' && getTodaySendCount() < DAILY_SEND_LIMIT) {
      executeCampaign(c.id);
    }
  }
}

/* ---------- GROUPS ---------- */
app.get('/api/groups', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const chats = (await withRetry(() => clientInstance.getAllChats())) || [];
    const groups = chats.filter(c => c.isGroup);
    const result = [];
    for (const g of groups.slice(0, 50)) {
      try {
        const info = await withRetry(() => clientInstance.getGroupInfo(g.id._serialized || g.id));
        result.push({
          id: g.id._serialized || g.id, name: g.name || g.formattedTitle || g.id,
          participants: info?.participants?.length || 0, description: info?.description || '',
          createdAt: info?.creation || null,
        });
      } catch { result.push({ id: g.id._serialized || g.id, name: g.name || g.formattedTitle || g.id }); }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:id', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  try {
    const info = await withRetry(() => clientInstance.getGroupInfo(req.params.id));
    const participants = (info?.participants || []).map(p => ({
      id: p.id._serialized || p.id, isAdmin: p.isAdmin || p.isSuperAdmin || false,
      name: p.name || null,
    }));
    res.json({ id: req.params.id, name: info.name, description: info.description || '', participants, createdAt: info.creation || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/create', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { name, participants } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const group = await withRetry(() => clientInstance.createGroup(name, participants || []));
    res.json({ id: group.gid._serialized || group.gid, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/add', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { participants } = req.body;
  if (!participants?.length) return res.status(400).json({ error: 'participants required' });
  try {
    await withRetry(() => clientInstance.addParticipant(req.params.id, participants));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/remove', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { participantId } = req.body;
  if (!participantId) return res.status(400).json({ error: 'participantId required' });
  try {
    await withRetry(() => clientInstance.removeParticipant(req.params.id, participantId));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/set-title', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { title } = req.body;
  try { await withRetry(() => clientInstance.setGroupTitle(req.params.id, title)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/set-description', async (req, res) => {
  if (!clientInstance) return res.status(503).json({ error: 'not connected' });
  const { description } = req.body;
  try { await withRetry(() => clientInstance.setGroupDescription(req.params.id, description)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- SCHEDULED MESSAGES ---------- */
const scheduleTimers = {};
const HISTORY_MAX = 500;

function readHistory() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'schedule-history.json'), 'utf8')); }
  catch { return []; }
}
function writeHistory(h) {
  fs.writeFileSync(path.join(DATA_DIR, 'schedule-history.json'), JSON.stringify(h.slice(-HISTORY_MAX), null, 2));
}

function computeNextRun(scheduleAt, recurrence) {
  if (!recurrence || recurrence.type === 'once') return scheduleAt;
  const now = Date.now();
  let next = new Date(scheduleAt);
  const interval = recurrence.interval || 1;
  const maxIterations = 1200;
  let iterations = 0;
  while (next.getTime() <= now) {
    const prev = next.getTime();
    switch (recurrence.type) {
      case 'daily': next.setDate(next.getDate() + interval); break;
      case 'weekly': next.setDate(next.getDate() + 7 * interval); break;
      case 'monthly': next.setMonth(next.getMonth() + interval); break;
      default: return null;
    }
    if (next.getTime() === prev || ++iterations > maxIterations) return null;
  }
  return next.toISOString();
}

async function executeScheduleItem(item) {
  if (!clientInstance) return { sent: 0, failed: 0 };
  const targets = [];
  if (item.sendToAll) {
    try {
      const chats = (await withRetry(() => clientInstance.getAllChats())) || [];
      targets.push(...chats.filter(c => !c.isGroup).map(c => c.id._serialized || c.id));
    } catch {}
  } else {
    if (item.chatId) targets.push(item.chatId);
    if (item.groupIds?.length) targets.push(...item.groupIds);
  }
  let sent = 0, failed = 0;
  for (const target of targets) {
    try {
      let text = item.text;
      let mediaId = null;
      if (item.templateId && item.templateVars) {
        const templates = readJSON('templates');
        const tpl = templates.find(t => t.id === item.templateId);
        if (tpl) {
          text = tpl.body;
          for (const [k, v] of Object.entries(item.templateVars || {})) {
            text = text.replace(new RegExp('{{' + k + '}}', 'g'), v);
          }
        }
      }
      if (item.media?.type === 'image' && item.media.data) {
        const buffer = Buffer.from(item.media.data, 'base64');
        const mediaAsset = await supabaseUploadMedia(buffer, item.media.filename || 'image.png', 'image/png');
        if (mediaAsset) mediaId = mediaAsset.id;
        await withRetry(() => clientInstance.sendImage(target, buffer, item.media.filename || 'image.png', text || ''));
      } else if (item.media?.type === 'document' && item.media.data) {
        const buffer = Buffer.from(item.media.data, 'base64');
        const mediaAsset = await supabaseUploadMedia(buffer, item.media.filename || 'file', 'application/octet-stream');
        if (mediaAsset) mediaId = mediaAsset.id;
        await withRetry(() => clientInstance.sendFile(target, buffer, item.media.filename || 'file', text || ''));
      } else {
        await withRetry(() => clientInstance.sendText(target, text));
      }
      sent++;
      supabaseInsertMessage(target, text, 'scheduled', 'outbound', null, mediaId, 'sent', null);
      supabaseUpsertContact(target, null, null, null, null, null);
    } catch { failed++; }
  }
  const history = readHistory();
  history.push({
    id: Date.now().toString(),
    scheduleId: item.id,
    title: item.title,
    targets: targets.length,
    sent, failed, text: (item.text || '').slice(0, 100),
    executedAt: new Date().toISOString(),
  });
  writeHistory(history);
  return { sent, failed };
}

async function processRecurring(item) {
  const result = await executeScheduleItem(item);
  item.sentCount = (item.sentCount || 0) + result.sent;
  item.failCount = (item.failCount || 0) + result.failed;
  item.lastSentAt = new Date().toISOString();
  const nextRun = computeNextRun(item.scheduleAt, item.recurrence);
  if (nextRun) {
    item.nextRunAt = nextRun;
    item.scheduleAt = nextRun;
    item.status = 'active';
    scheduleTimers[item.id] = setTimeout(() => processRecurring(item), new Date(nextRun).getTime() - Date.now());
  } else {
    item.status = 'completed';
    item.nextRunAt = null;
  }
  saveScheduledItem(item);
}

function saveScheduledItem(item) {
  const all = readJSON('scheduled');
  const idx = all.findIndex(s => s.id === item.id);
  if (idx >= 0) all[idx] = item;
  else all.push(item);
  writeJSON('scheduled', all);
}

function scheduleMessage(item) {
  if (scheduleTimers[item.id]) { clearTimeout(scheduleTimers[item.id]); }
  if (item.status === 'paused' || item.status === 'completed' || item.status === 'failed') return;
  const targetTime = new Date(item.nextRunAt || item.scheduleAt).getTime();
  const delay = targetTime - Date.now();
  if (delay <= 0) {
    if (item.recurrence && item.recurrence.type !== 'once') {
      processRecurring(item);
    } else {
      executeScheduleItem(item).then(result => {
        item.sentCount = (item.sentCount || 0) + result.sent;
        item.failCount = (item.failCount || 0) + result.failed;
        item.lastSentAt = new Date().toISOString();
        item.status = result.failed > 0 && result.sent === 0 ? 'failed' : 'completed';
        saveScheduledItem(item);
      });
    }
    return;
  }
  item.status = 'active';
  saveScheduledItem(item);
  scheduleTimers[item.id] = setTimeout(async () => {
    if (item.recurrence && item.recurrence.type !== 'once') {
      await processRecurring(item);
    } else {
      const result = await executeScheduleItem(item);
      item.sentCount = (item.sentCount || 0) + result.sent;
      item.failCount = (item.failCount || 0) + result.failed;
      item.lastSentAt = new Date().toISOString();
      item.status = result.failed > 0 && result.sent === 0 ? 'failed' : 'completed';
      saveScheduledItem(item);
    }
    delete scheduleTimers[item.id];
  }, delay);
}

app.get('/api/scheduled', (req, res) => {
  const { status, search, tab = 'upcoming' } = req.query;
  let list = readJSON('scheduled');
  if (tab === 'history') return res.json({ items: readHistory(), tab: 'history' });
  if (status) list = list.filter(s => s.status === status);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(s => (s.title || '').toLowerCase().includes(q) || (s.text || '').toLowerCase().includes(q) || (s.chatId || '').includes(q));
  }
  const stats = { total: 0, active: 0, paused: 0, completed: 0, failed: 0, sentToday: 0 };
  const today = new Date().toDateString();
  const history = readHistory();
  stats.sentToday = history.filter(h => new Date(h.executedAt).toDateString() === today).reduce((a, h) => a + h.sent, 0);
  list.forEach(s => {
    stats.total++;
    if (s.status === 'active' || s.status === 'pending') stats.active++;
    else if (s.status === 'paused') stats.paused++;
    else if (s.status === 'completed') stats.completed++;
    else if (s.status === 'failed') stats.failed++;
  });
  list.sort((a, b) => new Date(a.scheduleAt || a.createdAt) - new Date(b.scheduleAt || b.createdAt));
  res.json({ items: list, stats, tab: 'upcoming' });
});

app.post('/api/scheduled', (req, res) => {
  const { title, chatId, groupIds, sendToAll, text, templateId, templateVars, media, scheduleAt, recurrence } = req.body;
  if (!text && !templateId) return res.status(400).json({ error: 'text or templateId required' });
  if (!scheduleAt) return res.status(400).json({ error: 'scheduleAt required' });
  if (!chatId && !groupIds?.length && !sendToAll) return res.status(400).json({ error: 'chatId, groupIds, or sendToAll required' });
  const item = {
    id: Date.now().toString(),
    title: title || 'Untitled Schedule',
    chatId: chatId || null,
    groupIds: groupIds || [],
    sendToAll: !!sendToAll,
    text: text || '',
    templateId: templateId || null,
    templateVars: templateVars || {},
    media: media || null,
    scheduleAt,
    recurrence: recurrence || null,
    status: 'pending',
    sentCount: 0, failCount: 0,
    lastSentAt: null,
    nextRunAt: recurrence && recurrence.type !== 'once' ? computeNextRun(scheduleAt, recurrence) : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveScheduledItem(item);
  scheduleMessage(item);
  res.json({ success: true, item });
});

app.put('/api/scheduled/:id', (req, res) => {
  const all = readJSON('scheduled');
  const idx = all.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const existing = all[idx];
  const updates = req.body;
  delete updates.id; delete updates.createdAt;
  Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
  if (updates.recurrence && updates.recurrence.type !== 'once') {
    existing.nextRunAt = computeNextRun(existing.scheduleAt, existing.recurrence);
  } else if (!updates.recurrence || updates.recurrence.type === 'once') {
    existing.nextRunAt = null;
    existing.recurrence = null;
  }
  all[idx] = existing;
  writeJSON('scheduled', all);
  if (existing.status !== 'paused') scheduleMessage(existing);
  res.json({ success: true, item: existing });
});

app.delete('/api/scheduled/:id', (req, res) => {
  let all = readJSON('scheduled');
  all = all.filter(s => s.id !== req.params.id);
  writeJSON('scheduled', all);
  if (scheduleTimers[req.params.id]) { clearTimeout(scheduleTimers[req.params.id]); delete scheduleTimers[req.params.id]; }
  res.json({ success: true });
});

app.post('/api/scheduled/:id/pause', (req, res) => {
  const all = readJSON('scheduled');
  const item = all.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  item.status = 'paused';
  if (scheduleTimers[item.id]) { clearTimeout(scheduleTimers[item.id]); delete scheduleTimers[item.id]; }
  writeJSON('scheduled', all);
  res.json({ success: true });
});

app.post('/api/scheduled/:id/resume', (req, res) => {
  const all = readJSON('scheduled');
  const item = all.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  item.status = 'pending';
  writeJSON('scheduled', all);
  scheduleMessage(item);
  res.json({ success: true });
});

app.post('/api/scheduled/:id/duplicate', (req, res) => {
  const all = readJSON('scheduled');
  const item = all.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const copy = { ...item, id: Date.now().toString(), title: item.title + ' (copy)', status: 'pending', sentCount: 0, failCount: 0, lastSentAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  all.push(copy);
  writeJSON('scheduled', all);
  scheduleMessage(copy);
  res.json({ success: true, item: copy });
});

app.post('/api/scheduled/batch/delete', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  let all = readJSON('scheduled');
  ids.forEach(id => { if (scheduleTimers[id]) { clearTimeout(scheduleTimers[id]); delete scheduleTimers[id]; } });
  all = all.filter(s => !ids.includes(s.id));
  writeJSON('scheduled', all);
  res.json({ success: true, deleted: ids.length });
});

app.delete('/api/scheduled/history/clear', (req, res) => {
  writeHistory([]);
  res.json({ success: true });
});

/* ---------- ANALYTICS ---------- */
app.get('/api/analytics', async (req, res) => {
  try {
    const base = {
      chats: 0, contacts: 0, groups: 0,
      messages: 0, unread: 0, totalUnread: 0,
      campaigns: { total: 0, running: 0, completed: 0, dailyPaused: 0 },
      templates: 0, autoReplyRules: 0,
      scheduled: { total: 0, active: 0, completed: 0, failed: 0 },
      msgsSentToday: 0, topChats: [], msgStoreCount: 0,
      dailySendQuota: { used: 0, limit: DAILY_SEND_LIMIT, remaining: DAILY_SEND_LIMIT },
    };
    if (!clientInstance) {
      if (supabaseEnabled) {
        try {
          const { count: msgCount } = await supabase.from('message_history').select('*', { count: 'exact', head: true });
          base.messages = msgCount || 0;
          base.supabaseMessages = msgCount || 0;
          const { count: campCount } = await supabase.from('broadcast_campaigns').select('*', { count: 'exact', head: true });
          base.campaigns.total = campCount || 0;
          const { count: completedCount } = await supabase.from('broadcast_campaigns').select('*', { count: 'exact', head: true }).eq('status', 'completed');
          base.campaigns.completed = completedCount || 0;
          const { count: runningCount } = await supabase.from('broadcast_campaigns').select('*', { count: 'exact', head: true }).eq('status', 'running');
          base.campaigns.running = runningCount || 0;
          const { count: pausedCount } = await supabase.from('broadcast_campaigns').select('*', { count: 'exact', head: true }).eq('status', 'daily_paused');
          base.campaigns.dailyPaused = pausedCount || 0;
          const { count: waitCount } = await supabase.from('waitlist').select('*', { count: 'exact', head: true }).is('resolved_at', null);
          base.waitlistPending = waitCount || 0;
        } catch (e) { console.error('[Analytics] Supabase error:', e.message); }
      }
      return res.json(base);
    }
    const chats = (await withRetry(() => clientInstance.getAllChats())) || [];
    const contacts = (await withRetry(() => clientInstance.getAllContacts())) || [];
    base.chats = chats.length; base.contacts = contacts.length; base.groups = chats.filter(c => c.isGroup).length;
    base.messages = chats.reduce((sum, c) => sum + (c.messageCount || 0), 0);
    base.unread = chats.filter(c => c.unreadCount > 0).length;
    base.totalUnread = chats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    base.topChats = chats.filter(c => !c.isGroup && c.messageCount > 0).sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0)).slice(0, 10).map(c => ({ id: c.id._serialized || c.id, name: c.name || c.formattedName || c.id, msgCount: c.messageCount || 0 }));
    base.msgStoreCount = Object.values(msgStore).reduce((a, m) => a + m.length, 0);
    base.dailySendQuota = { used: getTodaySendCount(), limit: DAILY_SEND_LIMIT, remaining: getDailySendRemaining() };
    const campaigns = readJSON('campaigns');
    const templates = readJSON('templates');
    const rules = readJSON('autoreply');
    const scheduled = readJSON('scheduled');
    const history = readHistory();
    const today = new Date().toDateString();
    base.msgsSentToday = history.filter(h => new Date(h.executedAt).toDateString() === today).reduce((a, h) => a + h.sent, 0);
    base.campaigns = { total: campaigns.length, running: campaigns.filter(c => c.status === 'running').length, completed: campaigns.filter(c => c.status === 'completed').length, dailyPaused: campaigns.filter(c => c.status === 'daily_paused').length };
    base.templates = templates.length; base.autoReplyRules = rules.length;
    base.scheduled = { total: scheduled.length, active: scheduled.filter(s => s.status === 'active' || s.status === 'pending').length, completed: scheduled.filter(s => s.status === 'completed').length, failed: scheduled.filter(s => s.status === 'failed').length };
    if (supabaseEnabled) {
      try {
        const { count: msgCount } = await supabase.from('message_history').select('*', { count: 'exact', head: true });
        base.supabaseMessages = msgCount || 0;
        const { count: waitCount } = await supabase.from('waitlist').select('*', { count: 'exact', head: true }).is('resolved_at', null);
        base.waitlistPending = waitCount || 0;
      } catch (e) { console.error('[Analytics] Supabase error:', e.message); }
    }
    res.json(base);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- AUTO-REPLY + FLOWS LISTENER ---------- */
async function handleIncomingMessage(msg) {
  if (!clientInstance) return;
  const body = (msg.body || '').toLowerCase();
  // Check auto-reply rules first
  const rules = readJSON('autoreply');
  const activeRules = rules.filter(r => r.active !== false && r.keywords?.length > 0);
  for (const rule of activeRules) {
    let match = false;
    if (rule.matchType === 'exact') match = rule.keywords.some(k => body === k.toLowerCase());
    else if (rule.matchType === 'contains') match = rule.keywords.some(k => body.includes(k.toLowerCase()));
    else if (rule.matchType === 'startsWith') match = rule.keywords.some(k => body.startsWith(k.toLowerCase()));
    else if (rule.matchType === 'regex') {
        match = rule.keywords.some(k => { try { return new RegExp(k, 'i').test(body); } catch { return false; } });
      }
    if (match) {
      try { const r = await withRetry(() => clientInstance.sendText(msg.from, rule.reply)); saveMsg(msg.from, { id: r?.id || Date.now().toString(), from: msg.from, fromMe: true, body: rule.reply, timestamp: Math.floor(Date.now() / 1000), type: 'text' }); supabaseInsertMessage(msg.from, rule.reply, 'auto_reply', 'outbound', null, null, 'sent', r?.id || null); supabaseUpsertContact(msg.from, null, null, null, null, null); } catch {}
      return;
    }
  }
  // Then check flows
  await handleFlowTrigger(msg.from, msg.body);
}

/* ---------- SEED DEFAULT DATA ---------- */
function seedData() {
  if (!readJSON('templates').length) {
    writeJSON('templates', [
      /* ===== ECOMMERCE ===== */
      { id: 'ecom-abandoned-cart', name: '🛒 Ecom — Abandoned Cart', body: 'Hey {{name}}! 👋\nYou left something behind... 👀\n🛒 {{product}} is still waiting in your cart.\n⚠️ Only {{stock}} units left in stock.\n👉 Complete your order before it is gone: {{link}}\nThis deal won\'t last long! ⏳', variables: ['name', 'product', 'stock', 'link'], createdAt: new Date().toISOString() },
      { id: 'ecom-order-confirm', name: '📦 Ecom — Order Confirmed', body: '✅ Order Confirmed!\nHi {{name}}, your order is on its way to you! 🎉\n📦 Order ID: #{{orderId}}\n🛍️ Items: {{items}}\n📅 Estimated Delivery: {{deliveryDate}}\nTrack your order here 👇\n{{trackLink}}', variables: ['name', 'orderId', 'items', 'deliveryDate', 'trackLink'], createdAt: new Date().toISOString() },
      { id: 'ecom-shipping', name: '🚚 Ecom — Shipping Update', body: '🚚 Your order is on the move, {{name}}!\n📦 Order #{{orderId}} has been shipped.\n🔍 Tracking ID: {{trackingId}}\n📅 Expected by: {{deliveryDate}}\nTrack live here 👇\n{{trackLink}}', variables: ['name', 'orderId', 'trackingId', 'deliveryDate', 'trackLink'], createdAt: new Date().toISOString() },
      { id: 'ecom-flash-sale', name: '🔥 Ecom — Flash Sale', body: '🔥 FLASH SALE ALERT 🔥\nHi {{name}}!\n✨ {{discount}}% OFF on {{product}} — only for the next {{hours}} hours!\n🏷️ Original price: ₹{{originalPrice}}\n💥 Sale price: ₹{{salePrice}}\nShop now before it ends 👇\n{{link}}\nOffer valid while stocks last ✅', variables: ['name', 'discount', 'product', 'hours', 'originalPrice', 'salePrice', 'link'], createdAt: new Date().toISOString() },
      { id: 'ecom-new-arrival', name: '🆕 Ecom — New Arrival', body: '🆕 Just dropped for you, {{name}}!\nWe just added {{product}} to our store and thought of you immediately. 🎯\n⭐ Why you will love it:\n→ {{feature1}}\n→ {{feature2}}\n→ {{feature3}}\n🎁 Use code {{code}} for {{discount}}% off — first 50 orders only!\nGrab yours here 👇\n{{link}}', variables: ['name', 'product', 'feature1', 'feature2', 'feature3', 'code', 'discount', 'link'], createdAt: new Date().toISOString() },
      { id: 'ecom-back-in-stock', name: '📬 Ecom — Back in Stock', body: '🎉 Great news, {{name}}!\n{{product}} is finally back in stock! 💥\nWe know you have been waiting — so we are telling you first before it sells out again.\n📦 Limited stock available\n💰 Price: ₹{{price}}\nOrder now before it runs out 👇\n{{link}}', variables: ['name', 'product', 'price', 'link'], createdAt: new Date().toISOString() },
      { id: 'ecom-review', name: '⭐ Ecom — Review Request', body: 'Hi {{name}}!\nThank you for purchasing {{product}}. 🙏\nWe would love to hear your thoughts!\n📸 Share a photo of your product and tag us.\n⭐ Leave a review here: {{reviewLink}}\nYour feedback helps us improve! 💙', variables: ['name', 'product', 'reviewLink'], createdAt: new Date().toISOString() },
      { id: 'ecom-order-ready', name: '✅ Ecom — Order Ready for Pickup', body: '✅ Your order is ready for pickup, {{name}}!\n📦 Order #{{orderId}} is packed and waiting for you.\n📍 Pickup from: {{storeAddress}}\n⏰ We are open till: {{storeHours}}\nPlease carry your order ID. See you soon! 😊', variables: ['name', 'orderId', 'storeAddress', 'storeHours'], createdAt: new Date().toISOString() },

      /* ===== EDUCATION ===== */
      { id: 'edu-course-launch', name: '🎓 Edu — Course Launch', body: '🎓 {{name}}, the course you have been waiting for is HERE!\n📚 {{courseName}}\nBy {{instructor}}\n✅ What you will learn:\n→ {{point1}}\n→ {{point2}}\n→ {{point3}}\n🏆 Certificate included\n⏰ Batch starts: {{startDate}}\n💰 Early bird price: ₹{{price}} (Ends {{offerEnds}})\nEnroll now 👇\n{{enrollLink}}', variables: ['name', 'courseName', 'instructor', 'point1', 'point2', 'point3', 'startDate', 'price', 'offerEnds', 'enrollLink'], createdAt: new Date().toISOString() },
      { id: 'edu-free-workshop', name: '🆓 Edu — Free Workshop', body: '🆓 Free workshop alert, {{name}}!\n🎯 {{workshopTopic}}\nA {{duration}}-hour live session with {{speaker}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Platform: {{platform}}\nWhat you will walk away with:\n→ {{takeaway1}}\n→ {{takeaway2}}\n🎟️ Only {{seats}} seats available — it is free!\nRegister now 👇\n{{registerLink}}', variables: ['name', 'workshopTopic', 'duration', 'speaker', 'date', 'time', 'platform', 'takeaway1', 'takeaway2', 'seats', 'registerLink'], createdAt: new Date().toISOString() },
      { id: 'edu-enrollment', name: '📝 Edu — Enrollment Confirmed', body: '🎉 Welcome aboard, {{name}}!\nYou are now enrolled in {{courseName}}!\n📅 Start date: {{startDate}}\n⏰ Timing: {{timing}}\n📍 Mode: {{mode}}\nAccess your materials here 👇\n{{accessLink}}\nWe are excited to have you. Let\'s get started! 🚀', variables: ['name', 'courseName', 'startDate', 'timing', 'mode', 'accessLink'], createdAt: new Date().toISOString() },
      { id: 'edu-fee-reminder', name: '💳 Edu — Fee Reminder', body: '📋 Fee reminder, {{name}}\n💰 Amount due: ₹{{amount}}\n📚 For: {{courseName}}\n📅 Due date: {{dueDate}}\nPay before the due date to avoid a late fee.\nPay now 👇\n{{paymentLink}}\nFor any queries, reply to this message 💬', variables: ['name', 'amount', 'courseName', 'dueDate', 'paymentLink'], createdAt: new Date().toISOString() },
      { id: 'edu-result', name: '🏆 Edu — Result & Upgrade', body: '🏆 Congratulations on your results, {{name}}!\nYou scored {{percentage}}% — you are in the top {{rank}}% of your batch! 🎉\nReady to go further? 💪\n🚀 {{nextCourse}} — the next level programme\n→ {{feature1}}\n→ {{feature2}}\n→ Placement support included ✅\n💰 Special upgrade price: ₹{{price}} (Only for existing students)\nUpgrade now 👇\n{{link}}', variables: ['name', 'percentage', 'rank', 'nextCourse', 'feature1', 'feature2', 'price', 'link'], createdAt: new Date().toISOString() },
      { id: 'edu-assignment', name: '📚 Edu — Assignment Reminder', body: '📚 Assignment reminder, {{name}}!\n📝 {{assignmentTitle}} is due on {{dueDate}}.\n📋 Submission instructions: {{instructions}}\nSubmit here 👇\n{{submitLink}}\nLate submissions will incur a penalty. ⏰', variables: ['name', 'assignmentTitle', 'dueDate', 'instructions', 'submitLink'], createdAt: new Date().toISOString() },

      /* ===== FINANCE & INSURANCE ===== */
      { id: 'fin-payment-confirm', name: '✅ Finance — Payment Received', body: '✅ Payment Received!\nHi {{name}},\nYour payment of ₹{{amount}} has been received successfully. 🎉\n📋 Reference: {{reference}}\n📅 Date: {{date}}\n📄 Download receipt: {{receiptLink}}\nThank you for your trust! 🙏', variables: ['name', 'amount', 'reference', 'date', 'receiptLink'], createdAt: new Date().toISOString() },
      { id: 'fin-loan-approval', name: '🏦 Finance — Loan Approved', body: '🎉 Congratulations, {{name}}!\nYour {{loanType}} loan of ₹{{amount}} has been approved! ✅\n📊 Interest rate: {{interestRate}}% p.a.\n📅 Tenure: {{tenure}} months\n💰 EMI: ₹{{emi}}/month\n⚡ Funds will be disbursed within {{disbursalTime}} hours.\nContact your relationship manager {{managerName}} ({{managerPhone}}) for next steps. 📞', variables: ['name', 'loanType', 'amount', 'interestRate', 'tenure', 'emi', 'disbursalTime', 'managerName', 'managerPhone'], createdAt: new Date().toISOString() },
      { id: 'fin-otp', name: '🔐 Finance — OTP Verification', body: '🔐 Security Alert\n{{otp}} is your one-time password for {{purpose}}.\n⏳ Valid for {{validity}} minutes only.\n⚠️ Do NOT share this OTP with anyone — not even our team.\nIf you didn\'t request this, please contact us immediately. 🚨', variables: ['otp', 'purpose', 'validity'], createdAt: new Date().toISOString() },
      { id: 'fin-policy-renewal', name: '🛡️ Insurance — Policy Renewal', body: '⚠️ Action required, {{name}}!\nYour {{policyName}} policy expires on {{expiryDate}}.\n🛡️ Policy #: {{policyNumber}}\n💰 Renewal premium: ₹{{premium}}\nRenew now to stay covered without a break 👇\n{{renewLink}}\nCoverage gap can affect your future claims ⚠️', variables: ['name', 'policyName', 'expiryDate', 'policyNumber', 'premium', 'renewLink'], createdAt: new Date().toISOString() },
      { id: 'fin-investment', name: '📈 Finance — Investment Opportunity', body: '📈 {{name}}, your money could be working harder.\n💡 {{schemeName}} — a {{returns}}% p.a. return plan designed for people like you.\n✅ Why {{company}}:\n→ {{point1}}\n→ {{point2}}\n→ SEBI registered ✅\n→ Starting at just ₹{{minAmount}}/month\n🎯 Free consultation — no commitment.\nTalk to our advisor 👇\n{{advisorLink}}', variables: ['name', 'schemeName', 'returns', 'company', 'point1', 'point2', 'minAmount', 'advisorLink'], createdAt: new Date().toISOString() },
      { id: 'fin-insurance-claim', name: '📋 Insurance — Claim Update', body: '📋 Claim Update, {{name}}!\n🆔 Claim ID: {{claimId}}\n📌 Status: {{status}}\n📅 Last updated: {{date}}\n💰 Approved amount: ₹{{amount}}\n📄 Download claim documents: {{docLink}}\nFor queries, reply to this message or call {{supportPhone}}.', variables: ['name', 'claimId', 'status', 'date', 'amount', 'docLink', 'supportPhone'], createdAt: new Date().toISOString() },

      /* ===== HEALTHCARE ===== */
      { id: 'health-appointment', name: '🩺 Health — Appointment Confirmed', body: '✅ Appointment Confirmed!\nHi {{name}}! 👋\n🩺 Doctor: Dr. {{doctorName}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Location: {{location}}\nReply YES to confirm or NO to reschedule.\nPlease arrive 10 minutes early 🙏', variables: ['name', 'doctorName', 'date', 'time', 'location'], createdAt: new Date().toISOString() },
      { id: 'health-lab-report', name: '🔬 Health — Lab Report Ready', body: '🔬 Your reports are ready, {{name}}!\nYour {{testType}} lab report is now available.\n📋 Report Date: {{reportDate}}\nDownload securely here 👇\n{{downloadLink}}\nFor any queries, reply to this message 💬', variables: ['name', 'testType', 'reportDate', 'downloadLink'], createdAt: new Date().toISOString() },
      { id: 'health-checkup-offer', name: '💊 Health — Checkup Offer', body: '💊 Your health can\'t wait, {{name}}!\nDon\'t put off what matters most. 🩺\n🏥 {{packageName}} Full Body Checkup is now available at\n₹{{originalPrice}} ➡️ ₹{{offerPrice}} only!\n✅ Includes:\n→ {{test1}}\n→ {{test2}}\n→ {{test3}}\n📅 Only {{slots}} slots left this week.\nBook now 👇\n{{bookLink}}', variables: ['name', 'packageName', 'originalPrice', 'offerPrice', 'test1', 'test2', 'test3', 'slots', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'health-prescription', name: '💊 Health — Prescription Ready', body: '✅ Your prescription is ready, {{name}}!\n💊 Prescription #{{prescriptionId}} is packed and waiting for you.\n📍 Pickup from: {{pharmacy}}\n⏰ Store hours: {{storeHours}}\nPlease carry a valid ID for pickup 🪪', variables: ['name', 'prescriptionId', 'pharmacy', 'storeHours'], createdAt: new Date().toISOString() },
      { id: 'health-refill', name: '⏰ Health — Refill Reminder', body: '⏰ Refill reminder, {{name}}!\nYour {{medication}} prescription is due for refill on {{refillDate}}.\nDon\'t miss a dose! 💊\nReply REFILL to reorder in one tap ✅\nYour health is our priority 🌿', variables: ['name', 'medication', 'refillDate'], createdAt: new Date().toISOString() },
      { id: 'health-seasonal', name: '⚠️ Health — Seasonal Alert', body: '⚠️ {{season}} season is here, {{name}}!\nDon\'t wait for symptoms to appear. 🤒\n🛡️ Protect yourself with:\n→ {{precaution1}}\n→ {{precaution2}}\n→ {{precaution3}}\n📍 Available at {{clinicName}}\n💊 Consult our doctors today — no waiting!\nBook a free consultation 👇\n{{bookLink}}', variables: ['name', 'season', 'precaution1', 'precaution2', 'precaution3', 'clinicName', 'bookLink'], createdAt: new Date().toISOString() },

      /* ===== REAL ESTATE ===== */
      { id: 're-new-listing', name: '🏠 Realty — New Listing', body: '🏠 {{name}}, this one just listed — and it won\'t last!\n📍 {{bhk}} BHK in {{location}}\n💰 Starting at ₹{{price}}\n✨ Highlights:\n→ Corner unit with {{view}}\n→ Ready to move in\n→ {{sqft}} sq ft | {{floor}} floor\n→ {{facing}}\n⚠️ Only {{units}} units available at this price.\nBook a site visit today 👇\n{{visitLink}}', variables: ['name', 'bhk', 'location', 'price', 'view', 'sqft', 'floor', 'facing', 'units', 'visitLink'], createdAt: new Date().toISOString() },
      { id: 're-price-drop', name: '📉 Realty — Price Drop', body: '🔥 Price drop alert, {{name}}!\nThe property you were eyeing just got more affordable. 👀\n🏡 {{propertyName}}\n📍 {{location}}\n₹{{oldPrice}} ➡️ ₹{{newPrice}}\n💰 You save ₹{{savings}}!\n⏳ This revised price is valid only till {{validTill}}.\nSchedule your visit now 👇\n{{visitLink}}', variables: ['name', 'propertyName', 'location', 'oldPrice', 'newPrice', 'savings', 'validTill', 'visitLink'], createdAt: new Date().toISOString() },
      { id: 're-site-visit', name: '✅ Realty — Site Visit Confirmed', body: '✅ Site visit confirmed, {{name}}!\n🏠 Property: {{propertyName}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Address: {{address}}\nOur representative {{agentName}} ({{agentPhone}}) will be there to assist you.\nReply if you need to reschedule 📞', variables: ['name', 'propertyName', 'date', 'time', 'address', 'agentName', 'agentPhone'], createdAt: new Date().toISOString() },
      { id: 're-payment-reminder', name: '📋 Realty — Payment Reminder', body: '📋 Payment reminder, {{name}}\nYour instalment for {{propertyName}} is due on {{dueDate}}.\n💰 Amount: ₹{{amount}}\n🏦 Reference: {{reference}}\nPay now to avoid late charges 👇\n{{paymentLink}}\nFor payment queries, reply to this message 💬', variables: ['name', 'propertyName', 'dueDate', 'amount', 'reference', 'paymentLink'], createdAt: new Date().toISOString() },
      { id: 're-investment', name: '📈 Realty — Investment Opportunity', body: '📈 {{name}}, smart investors are already moving on this.\n🏢 {{projectName}} — a pre-launch opportunity in {{location}}\n💰 Pre-launch price: ₹{{price}} per sq ft\n(Expected post-launch: ₹{{expectedPrice}})\n📊 Why now:\n→ {{roi}}% appreciation in last 2 years\n→ {{connectivity}} connectivity coming by {{year}}\n→ RERA approved ✅\n🎯 Limited units. No brokerage.\nTalk to our advisor 👇\n{{advisorLink}}', variables: ['name', 'projectName', 'location', 'price', 'expectedPrice', 'roi', 'connectivity', 'year', 'advisorLink'], createdAt: new Date().toISOString() },

      /* ===== TRAVEL & HOSPITALITY ===== */
      { id: 'travel-booking', name: '✈️ Travel — Booking Confirmed', body: '✅ Booking confirmed, {{name}}!\nYour trip is officially on! 🎉\n✈️ Destination: {{destination}}\n📅 Travel dates: {{startDate}} → {{endDate}}\n🏨 Hotel: {{hotelName}}\n🔖 Booking ID: {{bookingId}}\nView full itinerary 👇\n{{itineraryLink}}\nHave a wonderful trip! 🌟', variables: ['name', 'destination', 'startDate', 'endDate', 'hotelName', 'bookingId', 'itineraryLink'], createdAt: new Date().toISOString() },
      { id: 'travel-flight-reminder', name: '✈️ Travel — Flight Reminder', body: '✈️ Flight reminder, {{name}}!\nYour flight is tomorrow — here is what you need:\n🛫 Flight: {{flightNumber}}\n⏰ Departure: {{departureTime}}\n📍 From: {{from}} | Terminal {{terminal}}\n🎫 PNR: {{pnr}}\nCheck in online now 👇\n{{checkinLink}}\nReach the airport at least 2 hours early ⏰', variables: ['name', 'flightNumber', 'departureTime', 'from', 'terminal', 'pnr', 'checkinLink'], createdAt: new Date().toISOString() },
      { id: 'travel-exclusive-deal', name: '🌴 Travel — Exclusive Deal', body: '✈️ {{name}}, picture this...\nYou. {{destination}}. This {{season}}. 🌅\n🏨 {{nights}} nights at {{hotelName}}\n✈️ Flights included\n🍽️ Breakfast included\n💰 Starting at just ₹{{price}} per person (Regular price: ₹{{regularPrice}})\n⚠️ Only {{packagesLeft}} packages left at this price.\nBook before it\'s gone 👇\n{{bookLink}}', variables: ['name', 'destination', 'season', 'nights', 'hotelName', 'price', 'regularPrice', 'packagesLeft', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'travel-hotel-checkin', name: '🏨 Travel — Hotel Check-in Info', body: '🏨 Check-in info, {{name}}!\nYour stay at {{hotelName}} starts tomorrow.\n📍 Address: {{address}}\n⏰ Check-in: {{checkInTime}} | Check-out: {{checkOutTime}}\n🔑 Booking ID: {{bookingId}}\n📞 Hotel Contact: {{hotelPhone}}\nAmenities: {{amenities}}\nHave a relaxing stay! 🌟', variables: ['name', 'hotelName', 'address', 'checkInTime', 'checkOutTime', 'bookingId', 'hotelPhone', 'amenities'], createdAt: new Date().toISOString() },
      { id: 'travel-group-deal', name: '👨‍👩‍👧‍👦 Travel — Group Offer', body: '👨‍👩‍👧‍👦 Planning a trip with your people, {{name}}?\nBook {{minTravellers}} or more travellers and get:\n✅ {{groupDiscount}}% group discount\n✅ Free airport transfers\n✅ Dedicated trip coordinator\n✅ Flexible cancellation\n🌍 Destination: {{destination}}\n📅 Available dates: {{dates}}\nGet a custom quote 👇\n{{quoteLink}}', variables: ['name', 'minTravellers', 'groupDiscount', 'destination', 'dates', 'quoteLink'], createdAt: new Date().toISOString() },

      /* ===== AUTOMOTIVE ===== */
      { id: 'auto-test-drive', name: '🚘 Auto — Test Drive Confirmed', body: '✅ Test drive confirmed, {{name}}!\n🚘 Car: {{carModel}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Showroom: {{showroomName}}\nOur executive {{executiveName}} will have it ready for you.\nCarry your driving licence 🪪\nReply if you need to reschedule 📞', variables: ['name', 'carModel', 'date', 'time', 'showroomName', 'executiveName'], createdAt: new Date().toISOString() },
      { id: 'auto-new-model', name: '🚘 Auto — New Model Launch', body: '🚘 {{name}}, the wait is over.\nThe all-new {{carModel}} has arrived at {{showroom}} — and it drives unlike anything you\'ve felt before. 🔥\n⚡ What\'s new:\n→ {{feature1}}\n→ {{feature2}}\n→ {{feature3}}\n🎯 Book a free test drive and feel the difference yourself.\n📅 Slots available from {{availableDate}}\nReserve your slot 👇\n{{bookLink}}', variables: ['name', 'carModel', 'showroom', 'feature1', 'feature2', 'feature3', 'availableDate', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'auto-service', name: '🔧 Auto — Service Reminder', body: '🔧 Service reminder, {{name}}!\nYour {{carModel}} is due for a service. 🚗\n📅 Recommended by: {{recommendedDate}}\n🔢 Current KMs: {{currentKm}}\nBook your service slot now to avoid longer wait times 👇\n{{bookLink}}\nRegular service keeps your car running better, longer ✅', variables: ['name', 'carModel', 'recommendedDate', 'currentKm', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'auto-exchange', name: '🔄 Auto — Exchange Offer', body: '🔄 Time to upgrade, {{name}}!\nExchange your old car and drive home in a {{carModel}} today! 🚗✨\n💰 Exchange bonus: up to ₹{{bonus}}\n➕ Additional discount: ₹{{discount}}\n🏦 EMI starting at ₹{{emi}}/month\n📍 Visit us at {{showroom}} for a free car evaluation.\n⏳ Offer valid till {{validTill}}\nBook evaluation 👇\n{{bookLink}}', variables: ['name', 'carModel', 'bonus', 'discount', 'emi', 'showroom', 'validTill', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'auto-festival', name: '🎊 Auto — Festival Offer', body: '🎊 Happy {{festival}}, {{name}}!\nDrive into the season with our {{offerName}} Offer 🚗\n💰 Benefits worth ₹{{benefitsValue}}:\n→ ₹{{cashDiscount}} cash discount\n→ Free {{freebie}}\n→ {{emiReduction}}% lower EMI for {{emiMonths}} months\n→ Free {{extras}}\n⏳ Valid till {{validTill}} only\nBook now 👇\n{{bookLink}}', variables: ['name', 'festival', 'offerName', 'benefitsValue', 'cashDiscount', 'freebie', 'emiReduction', 'emiMonths', 'extras', 'validTill', 'bookLink'], createdAt: new Date().toISOString() },

      /* ===== BEAUTY & WELLNESS ===== */
      { id: 'beauty-appointment', name: '💅 Beauty — Appointment Confirmed', body: '✅ Appointment confirmed, {{name}}!\n💅 Service: {{serviceName}}\n👩‍💼 Stylist: {{stylistName}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 At: {{salonName}}\nPlease arrive 5 minutes early ✨\nReply CANCEL if plans change 📞', variables: ['name', 'serviceName', 'stylistName', 'date', 'time', 'salonName'], createdAt: new Date().toISOString() },
      { id: 'beauty-membership', name: '👑 Beauty — Membership Offer', body: '👑 Become a VIP member, {{name}}!\nJoin {{salonName}} Membership and unlock:\n✅ {{discount}}% off on every visit\n✅ Priority booking always\n✅ Free birthday treatment 🎂\n✅ Exclusive member-only offers\n💰 Just ₹{{price}}/month\n🎁 First month FREE if you join before {{offerEnds}}\nJoin now 👇\n{{joinLink}}', variables: ['name', 'salonName', 'discount', 'price', 'offerEnds', 'joinLink'], createdAt: new Date().toISOString() },
      { id: 'beauty-selfcare', name: '💆‍♀️ Beauty — Self-care Promo', body: '💆‍♀️ {{name}}, you deserve this.\nBook your {{serviceName}} this week and get {{discount}}% off. ✨\n🌸 What\'s included:\n→ {{item1}}\n→ {{item2}}\n→ {{item3}}\n⏰ Duration: {{duration}} mins\n💰 Price: ₹{{price}} (was ₹{{originalPrice}})\n⚠️ Only {{slots}} slots left this week.\nTap to book yours 👇\n{{bookLink}}', variables: ['name', 'serviceName', 'discount', 'item1', 'item2', 'item3', 'duration', 'price', 'originalPrice', 'slots', 'bookLink'], createdAt: new Date().toISOString() },
      { id: 'beauty-reminder', name: '💆‍♀️ Beauty — Appointment Reminder', body: '💆‍♀️ See you tomorrow, {{name}}!\nJust a reminder about your {{serviceName}} appointment.\n⏰ Time: {{time}}\n📍 At: {{salonName}}\nWe\'re looking forward to seeing you! 💛\nReply RESCHEDULE if needed 📞', variables: ['name', 'serviceName', 'time', 'salonName'], createdAt: new Date().toISOString() },

      /* ===== LOCAL BUSINESS ===== */
      { id: 'local-order-ready', name: '✅ Local — Order Ready', body: '✅ Your order is ready, {{name}}!\n📦 Order #{{orderId}} is packed and waiting for you.\n📍 Pickup from: {{businessName}}\n⏰ We\'re open till: {{openTill}}\nSee you soon! 😊', variables: ['name', 'orderId', 'businessName', 'openTill'], createdAt: new Date().toISOString() },
      { id: 'local-loyalty', name: '💛 Local — Loyalty Offer', body: '💛 {{name}}, this one\'s just for you!\nAs one of our most valued regulars, you get {{discount}}% off on {{item}} — this week only. 🎁\n📍 Walk into {{businessName}} and mention this message at the counter.\n⏳ Valid till {{validTill}} only.\nNo codes. No hassle. Just walk in! 🙌', variables: ['name', 'discount', 'item', 'businessName', 'validTill'], createdAt: new Date().toISOString() },
      { id: 'local-new-launch', name: '🆕 Local — New Launch', body: '🆕 We\'ve been working on something exciting, {{name}}!\nIntroducing {{newItem}} at {{businessName}} 🎊\n🌟 {{description}}\n📅 Launching: {{launchDate}}\n🎁 First {{limit}} customers get: {{offer}}\n📍 Come visit us or order here 👇\n{{link}}\nWe can\'t wait for you to try it! 😊', variables: ['name', 'newItem', 'businessName', 'description', 'launchDate', 'limit', 'offer', 'link'], createdAt: new Date().toISOString() },
      { id: 'local-festive', name: '🎉 Local — Festive Special', body: '🎉 Happy {{festival}}, {{name}}!\nWe\'re celebrating with you! 🎊\n✨ Festive Special Offers:\n→ {{item1}} — {{discount1}}% OFF\n→ {{item2}} — {{discount2}}% OFF\n→ {{item3}} — Buy 1 Get 1 FREE\n📍 Visit us at {{businessName}}\n⏳ Valid: {{validFrom}} to {{validTill}} only\nBring the whole family! 👨‍👩‍👧‍👦', variables: ['name', 'festival', 'item1', 'discount1', 'item2', 'discount2', 'item3', 'businessName', 'validFrom', 'validTill'], createdAt: new Date().toISOString() },
      { id: 'local-feedback', name: '⭐ Local — Feedback Request', body: 'Hi {{name}}! 👋\nWe hope you enjoyed your experience at {{businessName}}.\nWe\'d love your feedback! 💬\n⭐ Rate us: {{ratingLink}}\n📝 Share your thoughts: {{feedbackLink}}\nYour feedback helps us serve you better! 🙏', variables: ['name', 'businessName', 'ratingLink', 'feedbackLink'], createdAt: new Date().toISOString() },

      /* ===== GENERAL ===== */
      { id: 'gen-welcome', name: '👋 General — Welcome Message', body: 'Hi {{name}}! 👋\nWelcome to {{businessName}}!\nWe are excited to have you on board. 🎉\nFeel free to reach out if you have any questions.\nHow can we help you today? 💬', variables: ['name', 'businessName'], createdAt: new Date().toISOString() },
      { id: 'gen-support', name: '🎫 General — Support Ticket', body: 'Hi {{name}},\nWe received your support request (#{{ticketId}}).\nOur team will get back to you within {{responseTime}} hours.\n📌 Issue: {{issueSummary}}\nIn the meantime, you can check FAQs here: {{faqLink}}\nThank you for your patience! 🙏', variables: ['name', 'ticketId', 'responseTime', 'issueSummary', 'faqLink'], createdAt: new Date().toISOString() },
      { id: 'gen-birthday', name: '🎂 General — Birthday Wish', body: '🎂🎉 Happy Birthday, {{name}}! 🎉🎂\nFrom all of us at {{businessName}}, we wish you an amazing day filled with joy and laughter! 🥳\n🎁 As a special gift, here\'s {{offer}} just for you!\nValid till {{validTill}}. Show this message at our store or use code {{code}} online.\nEnjoy your special day! 🎈', variables: ['name', 'businessName', 'offer', 'validTill', 'code'], createdAt: new Date().toISOString() },
      { id: 'gen-referral', name: '🤝 General — Referral Program', body: '🤝 {{name}}, refer a friend and both of you win!\nShare {{businessName}} with your friends and:\n🎁 You get: {{rewardYou}}\n🎁 They get: {{rewardFriend}}\n📋 How to refer:\nJust share your unique referral link: {{referralLink}}\n⏳ Offer valid till {{validTill}}\nShare now and save! 🎉', variables: ['name', 'businessName', 'rewardYou', 'rewardFriend', 'referralLink', 'validTill'], createdAt: new Date().toISOString() },
      { id: 'gen-event-invite', name: '📅 General — Event Invitation', body: '🎊 You\'re invited, {{name}}!\n{{businessName}} is hosting {{eventName}} 🎉\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Venue: {{venue}}\n✨ Highlights:\n→ {{highlight1}}\n→ {{highlight2}}\n→ {{highlight3}}\n🎟️ RSVP here: {{rsvpLink}}\nSee you there! 🥳', variables: ['name', 'businessName', 'eventName', 'date', 'time', 'venue', 'highlight1', 'highlight2', 'highlight3', 'rsvpLink'], createdAt: new Date().toISOString() },
    ]);
  }
  if (!readJSON('flows').length) {
    writeJSON('flows', [
      {
        id: 'flow-support', name: 'Customer Support', trigger: 'help',
        active: true, createdAt: new Date().toISOString(),
        steps: [
          { id: 'fs1', type: 'send', message: 'Hi! 👋 Welcome to support.\n\nPlease select an option:\n1️⃣ Order Issue\n2️⃣ Product Inquiry\n3️⃣ Speak to Agent\n\nReply with 1, 2, or 3.' },
          { id: 'fs2', type: 'wait', conditions: [{ match: '1', thenStep: 'fs3' }, { match: '2', thenStep: 'fs4' }, { match: '3', thenStep: 'fs5' }] },
          { id: 'fs3', type: 'send', message: 'We are sorry about the issue! Please share your order ID and we will look into it right away.' },
          { id: 'fs4', type: 'send', message: 'Sure! Tell us which product you are interested in and we will share all the details.' },
          { id: 'fs5', type: 'send', message: 'Connecting you to a live agent. Please hold on — someone will be with you shortly.' },
          { id: 'fs6', type: 'end' },
        ],
      },
      {
        id: 'flow-hours', name: 'Business Hours', trigger: 'hours',
        active: true, createdAt: new Date().toISOString(),
        steps: [
          { id: 'fh1', type: 'send', message: '🕐 Our Business Hours:\n\nMon–Fri: 9:00 AM – 8:00 PM\nSaturday: 10:00 AM – 6:00 PM\nSunday: Closed\n\nFor urgent queries, reply "urgent" and we will get back to you ASAP.' },
          { id: 'fh2', type: 'wait' },
          { id: 'fh3', type: 'send', message: 'Noted! We have flagged this as urgent. Our team will reach out within 30 minutes. Thank you for your patience!' },
          { id: 'fh4', type: 'end' },
        ],
      },
      {
        id: 'flow-feedback', name: 'Collect Feedback', trigger: 'feedback',
        active: true, createdAt: new Date().toISOString(),
        steps: [
          { id: 'ff1', type: 'send', message: 'We value your feedback! 🎯\n\nHow would you rate your experience?\n⭐ 1 — Poor\n⭐ 2 — Fair\n⭐ 3 — Good\n⭐ 4 — Great\n⭐ 5 — Excellent\n\nReply with a number 1–5.' },
          { id: 'ff2', type: 'wait', conditions: [{ match: '1', thenStep: 'ff3' }, { match: '2', thenStep: 'ff3' }, { match: '3', thenStep: 'ff4' }, { match: '4', thenStep: 'ff5' }, { match: '5', thenStep: 'ff5' }] },
          { id: 'ff3', type: 'send', message: 'We are sorry to hear that! 😔 We want to make it right. Please share what went wrong so we can improve.' },
          { id: 'ff4', type: 'send', message: 'Thank you for your feedback! 😊 We are always working to get better. Let us know how we can improve further.' },
          { id: 'ff5', type: 'send', message: 'Wow, thank you for the 5-star rating! 🌟 We are thrilled you had a great experience. Share us with your friends! 🎉' },
          { id: 'ff6', type: 'end' },
        ],
      },
      {
        id: 'flow-order', name: 'Order Status', trigger: 'order',
        active: true, createdAt: new Date().toISOString(),
        steps: [
          { id: 'fo1', type: 'send', message: '📦 Track Your Order\n\nPlease share your Order ID so we can check the status for you.' },
          { id: 'fo2', type: 'wait', conditions: [{ matchType: 'contains', match: '#', thenStep: 'fo3' }, { matchType: 'contains', match: 'ord', thenStep: 'fo3' }] },
          { id: 'fo3', type: 'send', message: 'Thank you! Let me look up your order. 🔍\nOne moment please...' },
          { id: 'fo4', type: 'send', message: '✅ Your order is currently being processed.\n📅 Expected delivery: 3–5 business days.\n\nNeed more help? Reply "help" to speak to support.' },
          { id: 'fo5', type: 'end' },
        ],
      },
    ]);
  }
  if (!readJSON('campaign-templates').length) {
    writeJSON('campaign-templates', [
      { id: 'ct-holiday', name: '🎄 Holiday Greeting Campaign', message: '🎄 Wishing you and your family a wonderful holiday season! Thank you for being a valued customer. May the new year bring you joy and prosperity! 🥂', targetType: 'all', targetFilter: '', createdAt: new Date().toISOString() },
      { id: 'ct-promo', name: '🔥 Flash Sale Campaign', message: '🔥 Flash Sale! Get {{discount}}% off on all products this weekend only. Use code {{code}} at checkout. Visit our store or reply for details! ⏳', targetType: 'all', targetFilter: '', variables: ['discount', 'code'], createdAt: new Date().toISOString() },
      { id: 'ct-feedback', name: '⭐ Customer Feedback Campaign', message: 'Hi {{name}}, we would love to hear about your recent experience with us. Reply with your feedback or rate us 1-5 ⭐', targetType: 'all', targetFilter: '', variables: ['name'], createdAt: new Date().toISOString() },
      { id: 'ct-reengage', name: '💛 Re-engagement Campaign', message: 'Hey {{name}}, we miss you! Here\'s a special {{discount}}% discount on your next purchase. Use code: {{code}}. Valid till {{expiry}}. 🎉', targetType: 'all', targetFilter: '', variables: ['name', 'discount', 'code', 'expiry'], createdAt: new Date().toISOString() },
      { id: 'ct-abandoned-cart', name: '🛒 Abandoned Cart Recovery', message: 'Hi {{name}}! You left items in your cart. Complete your purchase now and get {{discount}}% off. Shop here: {{link}}', targetType: 'all', targetFilter: '', variables: ['name', 'discount', 'link'], createdAt: new Date().toISOString() },
      { id: 'ct-new-year', name: '🎆 New Year Campaign', message: '🎆 Happy New Year {{name}}! Thank you for being part of our journey. Here\'s to an amazing year ahead! Use code {{code}} for {{discount}}% off your first purchase this year. 🥳', targetType: 'all', targetFilter: '', variables: ['name', 'code', 'discount'], createdAt: new Date().toISOString() },
      { id: 'ct-birthday', name: '🎂 Birthday Campaign', message: '🎂 Happy Birthday {{name}}! 🎉 As a special gift, enjoy {{discount}}% off on us. Show this message in-store or use code {{code}} online. Valid till {{expiry}}! 🎁', targetType: 'all', targetFilter: '', variables: ['name', 'discount', 'code', 'expiry'], createdAt: new Date().toISOString() },
      { id: 'ct-event', name: '📅 Event Invitation Campaign', message: '🎊 You\'re invited {{name}}! Join us at {{eventName}} on {{date}}. Limited seats available — RSVP here: {{rsvpLink}}', targetType: 'all', targetFilter: '', variables: ['name', 'eventName', 'date', 'rsvpLink'], createdAt: new Date().toISOString() },
    ]);
  }
}

seedData();

/* ---------- INIT ---------- */
ev.on('qr.*', (data, sessionId) => {
  if (data && typeof data === 'string') {
    currentQR = data;
  }
});
ev.on('authenticated.*', () => {
  currentQR = null;
  waReady = true;
});

async function initClient() {
create({
  sessionId: 'main',
  headless: true,
  useChrome: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  useStealth: true,
  port: 8080,
  multiDevice: true,
  cacheEnabled: true,
  popup: false,
  blockCrashLogs: true,
  logConsole: true,
  disableSpins: true,
  ezqr: true,
  qrTimeout: 300,
  authTimeout: 300,
  autoReject: true,
  killProcessOnTimeout: false,
  customUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36',
  eventMode: true,
  waitForRipeSession: false,
  defaultViewport: null,
  userDataDir: process.env.WA_USER_DATA_DIR || './session-data',
  skipBrokenMethodsCheck: true,
}).then(client => {
  clientInstance = client;
  clientInstance._startTime = Date.now();
  console.log('CLIENT READY!', client.hostAccountNumber);
  waReady = true;
  initSupabase();

  /* resume pending scheduled messages */
  const scheduled = readJSON('scheduled');
  scheduled.filter(s => s.status === 'pending').forEach(s => scheduleMessage(s));

  /* resume daily-paused campaigns */
  cleanupDailyLog();
  resumeDailyPausedCampaigns();
  resumeScheduledCampaigns();
  flushBroadcastQueue();

  client.onStateChanged((state) => {
    console.log('State:', state);
    if (state === 'CONNECTED' && clientInstance) {
      clientInstance._startTime = Date.now();
    }
    waReady = state === 'CONNECTED';
  });
  client.onMessage(msg => {
    console.log('MSG from', msg.from, ':', (msg.body || '').slice(0, 60));
    saveMsg(msg.from, {
      id: msg.id?._serialized || msg.id,
      from: msg.from,
      fromMe: !!msg.fromMe,
      body: msg.body || msg.caption || '',
      timestamp: msg.t,
      type: msg.type || 'text',
      mimetype: msg.mimetype || null,
    });
    if (!msg.fromMe) {
      supabaseUpsertContact(msg.from, null, null, null, null, null);
      supabaseResolveWaitlist(msg.from);
      try { handleIncomingMessage(msg); } catch (err) { console.error('[INCOMING MSG ERROR]', err); }
    }
  });
}).catch(e => {
  launchAttempts++;
  lastError = e?.message || String(e);
  console.error('FAILED:', lastError);
  waReady = false;
  if (!clientInstance) setTimeout(initClient, 5000);
});
}

const PORT = Number(process.env.PORT || process.env.WA_PORT || 8080);
server.listen(PORT, () => console.log(`Dashboard at http://localhost:${PORT}`));
initClient();
