import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import express from 'express';
import fs from 'fs';
import { execSync } from 'child_process';

const { Client, LocalAuth, MessageMedia } = pkg;


function killOrphanPuppeteerChrome() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH 2>NUL', { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      const pid = parseInt(parts[1]);
      if (!pid || isNaN(pid)) continue;
      try {
        const wmic = execSync(`wmic process where processid=${pid} get commandline /value 2>NUL`, { encoding: 'utf8' });
        if (wmic.includes('--remote-debugging-port') || wmic.includes('user-data-dir')) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
      } catch { /* skip */ }
    }
  } catch { /* best effort */ }
}

const COMMANDS = {
  help:    { description: 'Show this help menu' },
  ping:    { description: 'Check if bot is alive' },
  say:     { description: 'Repeat a message: !say <text>' },
  poll:    { description: 'Create a poll: !poll "Question" | opt1 | opt2' },
  image:   { description: 'Send a sample image' },
  groups:  { description: 'List your groups (group chats only)' },
  notify:  { description: 'Subscribe to broadcast notifications' },
};

const subscribers = new Set();
let currentQR = '';
let botStatus = 'starting'; // 'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected'
let clientReady = false;  // true only after warm-up delay post-ready event

// Helper: wait for WA store to be ready by probing via page evaluate
async function waitForStore() {
  const timeout = Date.now() + 30000;
  let delay = 1000;
  while (Date.now() < timeout) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const result = await client.pupPage.evaluate(() => {
        try {
          const collections = window.require('WAWebCollections');
          if (!collections || !collections.Chat) return { ok: false, reason: 'WAWebCollections.Chat not found' };
          const models = collections.Chat.getModelsArray();
          return { ok: true, count: models ? models.length : 0 };
        } catch (e) {
          return { ok: false, reason: e.message || String(e) };
        }
      });
      if (result.ok) {
        clientReady = true;
        console.log(`[READY] WhatsApp data store warm-up complete - ${result.count} chats ready in memory`);
        return;
      }
      console.warn(`[READY] Store not ready (${result.reason}), retrying in ${delay}ms…`);
    } catch (e) {
      console.warn('[READY] pupPage eval failed, retrying…', e.message);
    }
    delay = Math.min(delay + 1500, 6000);
  }
  clientReady = true;
  console.warn('[READY] Warm-up timed out — allowing API calls anyway');
}

// Helper: get chats directly from WA store safely via Puppeteer
async function getChatsFromStore() {
  return client.pupPage.evaluate(() => {
    try {
      const ChatCollection = window.require('WAWebCollections').Chat;
      const chats = ChatCollection ? ChatCollection.getModelsArray() : [];
      return chats.map(c => {
        try {
          const id = c.id?._serialized || String(c.id || '');
          const isGroup = Boolean(c.isGroup || id.endsWith('@g.us'));
          const lastMsgObj = c.lastMessage || (c.msgs?.getModelsArray ? c.msgs.getModelsArray().slice(-1)[0] : null);
          const lastMsg = lastMsgObj?.body || lastMsgObj?.caption || (lastMsgObj?.type && lastMsgObj.type !== 'chat' ? `[${lastMsgObj.type}]` : '');

          let rawPic = null;
          if (c.contact && c.contact.profilePicThumb) {
            const p = c.contact.profilePicThumb;
            rawPic = p.imgFull || p.img || p.attributes?.imgFull || p.attributes?.img || null;
          }
          const profilePicUrl = rawPic ? `/api/image-proxy?url=${encodeURIComponent(rawPic)}` : null;

          return {
            id,
            name: c.name || c.formattedTitle || c.contact?.name || c.contact?.pushname || c.id?.user || 'Unknown',
            isGroup,
            timestamp: c.t || c.timestamp || 0,
            unreadCount: c.unreadCount || 0,
            lastMessage: lastMsg,
            profilePicUrl,
            pinned: Boolean(c.pin),
            archived: Boolean(c.archive),
          };
        } catch {
          return null;
        }
      }).filter(Boolean).slice(0, 100);
    } catch (e) {
      console.error('[Browser evaluate getChatsFromStore error]', e);
      return [];
    }
  });
}

// Helper: get contacts directly from WA store via Puppeteer (WAWebCollections)
async function getContactsFromStore() {
  return client.pupPage.evaluate(() => {
    try {
      const ContactCollection = window.require('WAWebCollections').Contact;
      const contacts = ContactCollection ? ContactCollection.getModelsArray() : [];
      return contacts
        .map(c => {
          try {
            const id = c.id?._serialized || String(c.id || '');
            if (!id.endsWith('@c.us')) return null;
            const name = c.name || c.pushname || c.verifiedName || c.formattedName || c.id?.user || 'Unknown';

            let rawPic = null;
            if (c.profilePicThumb) {
              const p = c.profilePicThumb;
              rawPic = p.imgFull || p.img || p.attributes?.imgFull || p.attributes?.img || null;
            }
            const profilePicUrl = rawPic ? `/api/image-proxy?url=${encodeURIComponent(rawPic)}` : null;

            return {
              id,
              name,
              number: c.id?.user || '',
              profilePicUrl,
              isMyContact: Boolean(c.isMyContact),
              isBlocked: Boolean(c.isBlocked),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, 2000);
    } catch (e) {
      console.error('[Browser evaluate getContactsFromStore error]', e);
      return [];
    }
  });
}


// Helper: get messages for a chat directly from WA store via Puppeteer & trigger sync if needed
async function getMessagesFromStore(chatId) {
  return client.pupPage.evaluate(async (targetChatId) => {
    try {
      const ChatCollection = window.require('WAWebCollections').Chat;
      const chat = ChatCollection ? ChatCollection.get(targetChatId) : null;
      if (!chat) return [];

      // Trigger syncing of earlier messages from WhatsApp servers if fewer than 20 msgs in memory
      if (chat.msgs) {
        const msgsArray = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
        if (msgsArray.length < 20) {
          try {
            const loader = window.require('WAWebChatLoadMessages');
            if (loader && loader.loadEarlierMsgs) {
              await loader.loadEarlierMsgs({ chat });
            } else if (chat.loadEarlierMsgs) {
              await chat.loadEarlierMsgs();
            }
          } catch (loadErr) {
            console.warn('[loadEarlierMsgs warning]', loadErr);
          }
        }
      }

      const msgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
      return msgs
        .filter(m => !m.isNotification)
        .slice(-50)
        .map(m => {
          try {
            const isMedia = Boolean(m.isMedia || m.mediaKey || m.type === 'image' || m.type === 'video' || m.type === 'audio' || m.type === 'document' || m.type === 'sticker' || m.type === 'album');
            let body = m.body || m.caption || '';
            if (isMedia || body.startsWith('/9j/') || body.startsWith('data:') || (body.length > 100 && !body.includes(' '))) {
              body = m.caption || `[${(m.type || 'media').toUpperCase()}]`;
            }
            if (!body) body = isMedia ? '[MEDIA]' : '';
            return {
              id: m.id?._serialized || String(m.id || ''),
              body,
              fromMe: Boolean(m.id?.fromMe),
              timestamp: m.t || m.timestamp || 0,
              type: m.type || 'chat',
              author: m.author?._serialized || m.author || null,
              hasMedia: isMedia,
            };

          } catch {
            return null;
          }
        })
        .filter(Boolean);

    } catch (e) {
      console.error('[Browser evaluate getMessagesFromStore error]', e);
      return [];
    }
  }, chatId);
}





// ── WhatsApp Client ──────────────────────────────────────────────────────────

let client = null;
let manualLogout = false;
let logoutInProgress = false;

function initClient() {
  client = new Client({
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      headless: true,
    },
    authStrategy: new LocalAuth({ clientId: 'main' }),
    qrMaxRetries: 5,
    takeoverOnConflict: true,
    // Local cache: loads live WhatsApp Web, then caches the bundle for fast, offline-friendly restarts
    webVersionCache: {
      type: 'local',
      strict: false,
    },
  });

  client.on('qr', (qr) => {
  currentQR = qr;
  botStatus = 'qr';
  armInitWatchdog();
  console.log('[QR] New QR code generated — visit http://localhost:' + (process.env.WEBHOOK_PORT ?? 3001) + ' to scan');
});

client.on('authenticated', () => {
  console.log('[AUTH] Authenticated successfully');
  currentQR = '';
  botStatus = 'authenticated';
  armInitWatchdog();
});

client.on('auth_failure', (msg) => {
  console.error('[AUTH] Authentication failure:', msg);
  botStatus = 'starting';
  currentQR = '';
  armInitWatchdog();
});

client.on('ready', () => {
  console.log('[READY] Bot authenticated — warming up WhatsApp data store…');
  botStatus = 'ready';
  currentQR = '';
  clearTimeout(initWatchdog);
  clientReady = false;
  waitForStore().catch(err => console.error('[READY] Warm-up error:', err));
});

client.on('disconnected', (reason) => {
  if (manualLogout) return;
  console.warn('[DISCONNECTED] Bot disconnected:', reason, '— reinitializing…');
  botStatus = 'starting';
  clientReady = false;
  currentQR = '';
  setTimeout(() => {
    client.initialize().catch((err) => console.error('[REINIT] Failed to reinitialize:', err));
  }, 5000);
});

// ── Message Handler ──────────────────────────────────────────────────────────

client.on('message', async (message) => {
  try {
    if (message.fromMe) return;

    const body = message.body;
    if (!body || !body.startsWith('!')) return;

    const text = body.trim();
    const parts = text.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    const chatId = message.from;

    switch (command) {
      case 'help': {
        const lines = Object.entries(COMMANDS).map(
          ([cmd, cfg]) => `*!${cmd}* — ${cfg.description}`
        );
        await message.reply(`*Available commands*\n\n${lines.join('\n')}`);
        break;
      }

      case 'ping': {
        await message.reply('pong! 🏓');
        break;
      }

      case 'say': {
        if (args.length === 0) {
          await message.reply('Usage: !say <message>');
        } else {
          await message.reply(args.join(' '));
        }
        break;
      }

      case 'poll': {
        const fullText = text.slice(5).trim();
        const partsSplit = fullText.split('|').map(s => s.trim());
        if (partsSplit.length < 3) {
          await message.reply('Usage: !poll "Question" | option1 | option2');
        } else {
          const question = partsSplit[0];
          const options = partsSplit.slice(1);
          await client.sendMessage(chatId, {
            poll: { name: question, values: options, selectableCount: 1 },
          });
        }
        break;
      }

      case 'image': {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#075e54"/><text x="200" y="150" text-anchor="middle" fill="white" font-size="24">Hello from OpenWA!</text></svg>`;
        await client.sendMessage(chatId, {
          image: { data: Buffer.from(svg), filename: 'hello.svg' },
          caption: 'Hello from OpenWA! 👋',
        });
        break;
      }

      case 'groups': {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup);
        if (groups.length === 0) {
          await message.reply('No groups found.');
        } else {
          const list = groups.map(g => `• ${g.name}`).join('\n');
          await message.reply(`*Your groups*\n${list}`);
        }
        break;
      }

      case 'notify': {
        if (subscribers.has(chatId)) {
          subscribers.delete(chatId);
          await message.reply('Unsubscribed from notifications. 🔕');
        } else {
          subscribers.add(chatId);
          await message.reply('Subscribed to notifications! 🔔');
        }
        break;
      }

      default: {
        await message.reply(`Unknown command: *${command}*\nType !help for available commands.`);
      }
    }
  } catch (err) {
    console.error('[MSG ERROR]', err);
  }
});

  client.initialize().catch((err) => {
    console.error('[INIT ERROR]', err);
  });
}

let initWatchdog = null;
function armInitWatchdog() {
  clearTimeout(initWatchdog);
  const startedAt = Date.now();
  initWatchdog = setTimeout(() => {
    const stuck = (botStatus === 'starting' || botStatus === 'qr') && Date.now() - startedAt > 90000;
    if (!stuck || manualLogout || logoutInProgress) return;
    console.warn('[WATCHDOG] initialize() stuck for 90s — force restarting WhatsApp client…');
    botStatus = 'starting';
    currentQR = '';
    try { client?.destroy?.(); } catch (e) { /* best effort */ }
    setTimeout(() => {
      killOrphanPuppeteerChrome();
      try { initClient(); } catch (e) { console.error('[WATCHDOG] Re-init failed:', e); }
    }, 3000);
  }, 95000);
}

killOrphanPuppeteerChrome();
initClient();
armInitWatchdog();

// ── Express Server ───────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.WEBHOOK_PORT ?? 3001;

app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));


const API_KEY = process.env.API_KEY || process.env.WA_API_KEY || '';

// ── CORS & Security Middleware ────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-KEY, Authorization');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── API Authentication Middleware ──────────────────────────────────────────────
const authenticate = (req, res, next) => {
  // Allow public status, verify-auth, and logout
  if (req.path === '/api/status' || req.path === '/api/verify-auth' || req.path === '/api/logout') return next();
  // If no API key configured, auth is disabled
  if (!API_KEY) return next();
  const clientKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!clientKey || clientKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Security Key', code: 'AUTH_REQUIRED' });
  }
  next();
};

app.use('/api', authenticate);

// ── Serve public folder ───────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '../public')));
// Also serve static assets at root so the dashboard HTML (which references /style.css, /app.js) works
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ── POST /api/verify-auth — Validate Master Key ────────────────────────────────
app.post('/api/verify-auth', (req, res) => {
  const { key } = req.body;
  if (key === API_KEY) {
    res.json({ success: true, key: API_KEY });
  } else {
    res.status(401).json({ error: 'Invalid Security Key' });
  }
});

// ── GET /api/status ──────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status: botStatus,
    ready: clientReady,
    qr: currentQR || null,
    phone: client.info?.wid?.user ?? null,
    securityEnabled: true,
  });
});


// ── GET /api/chats — list recent chats ───────────────────────────────────────
app.get('/api/chats', async (_req, res) => {
  try {
    if (botStatus !== 'ready') return res.json([]);
    if (!clientReady) {
      const deadline = Date.now() + 10000;
      while (!clientReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
    }
    const chats = await getChatsFromStore();
    res.json(chats);
  } catch (e) {
    console.error('[API /api/chats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/messages/:chatId ─────────────────────────────────────────────────
app.get('/api/messages/:chatId', async (req, res) => {
  try {
    if (!clientReady) return res.json([]);
    const messages = await getMessagesFromStore(req.params.chatId);
    res.json(messages);
  } catch (e) {
    console.error('[API /api/messages]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/send ────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    if (!clientReady) return res.status(503).json({ error: 'Bot not ready yet — please wait a moment' });
    const { chatId, message, text } = req.body;
    const msg = message || text;
    if (!chatId || !msg) return res.status(400).json({ error: 'chatId and message required' });
    const result = await client.sendMessage(chatId, msg);
    const msgId = result?.id?._serialized || result?.id || 'sent'; res.json({ success: true, id: msgId });
  } catch (e) {
    console.error('[API /api/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/send-media ──────────────────────────────────────────────────────
app.post('/api/send-media', async (req, res) => {
  try {
    if (!clientReady) return res.status(503).json({ error: 'Bot not ready yet' });
    const { chatId, base64, mimetype, data, filename, caption } = req.body;
    const fileData = data || base64;
    if (!chatId || !fileData) {
      return res.status(400).json({ error: 'chatId and data/base64 required' });
    }
    let mime = mimetype;
    if (!mime) {
      const m = fileData.match(/^data:([^;]+);base64,/);
      mime = m ? m[1] : 'image/png';
    }
    const cleanData = fileData.includes(',') ? fileData.split(',')[1] : fileData;
    const media = new MessageMedia(mime, cleanData, filename || 'attachment');
    const result = await client.sendMessage(chatId, media, { caption: caption || '' });
    const msgId = result?.id?._serialized || result?.id || 'sent';
    res.json({ success: true, id: msgId });
  } catch (e) {
    console.error('[API /api/send-media]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/contacts?page=&pageSize=&search= ─────────────────────────────
app.get('/api/contacts', async (req, res) => {
  try {
    if (botStatus !== 'ready') return res.json({ contacts: [], filtered: 0, totalPages: 0 });
    if (!clientReady) {
      const deadline = Date.now() + 10000;
      while (!clientReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
    }
    const contacts = await getContactsFromStore();
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const search = (req.query.search || '').toLowerCase().trim();
    let filtered = contacts;
    if (search) {
      filtered = contacts.filter(c => (c.name || c.id || '').toLowerCase().includes(search));
    }
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    res.json({ contacts: items, filtered: filtered.length, totalPages });
  } catch (e) {
    console.error('[API /api/contacts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/groups ───────────────────────────────────────────────────────────
app.get('/api/groups', async (_req, res) => {
  try {
    if (botStatus !== 'ready') return res.json([]);
    if (!clientReady) {
      const deadline = Date.now() + 10000;
      while (!clientReady && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
    }
    const chats = await getChatsFromStore();
    const groups = chats.filter(c => c.isGroup);
    res.json(groups);
  } catch (e) {
    console.error('[API /api/groups]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/profile-pic/:id ──────────────────────────────────────────────────
const profilePicCache = new Map();
const PROFILE_PIC_TTL = 10 * 60 * 1000;

app.get('/api/profile-pic/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cached = profilePicCache.get(id);
    if (cached && Date.now() - cached.t < PROFILE_PIC_TTL) {
      return cached.url ? res.redirect(cached.url) : res.status(404).end();
    }
    if (!clientReady || !client.pupPage) return res.status(404).end();

    // Direct WhatsApp profile picture fetch via WAWebContactProfilePicThumbBridge
    const rawPicUrl = await client.pupPage.evaluate(async (targetId) => {
      try {
        let target = null;
        if (window.WWebJS) {
          try { target = await window.WWebJS.getContact(targetId); } catch { /* silent */ }
          if (!target) {
            try { target = await window.WWebJS.getChat(targetId); } catch { /* silent */ }
          }
        }

        const bridge = window.require('WAWebContactProfilePicThumbBridge');
        if (bridge && bridge.requestProfilePicFromServer) {
          const pic = await bridge.requestProfilePicFromServer(target || targetId);
          if (pic) {
            const url = typeof pic === 'string' ? pic : (pic.eurl || pic.imgFull || pic.img || pic.attributes?.imgFull || pic.attributes?.img || null);
            if (url) return url;
          }
        }
      } catch { /* silent */ }

      // Fallback: check profilePicThumb on contact or chat in memory
      try {
        const Collections = window.require('WAWebCollections');
        const rawUser = targetId.split('@')[0];
        let contact = Collections.Contact ? Collections.Contact.get(targetId) : null;
        if (!contact && Collections.Contact && Collections.Contact._models) {
          contact = Collections.Contact._models.find(c => c.id?._serialized === targetId || c.id?.user === rawUser);
        }
        if (contact && contact.profilePicThumb) {
          const p = contact.profilePicThumb;
          return p.imgFull || p.img || p.attributes?.imgFull || p.attributes?.img || null;
        }
      } catch { /* silent */ }

      return null;
    }, id);

    let proxiedUrl = null;
    if (rawPicUrl) {
      proxiedUrl = `/api/image-proxy?url=${encodeURIComponent(rawPicUrl)}`;
    }
    profilePicCache.set(id, { url: proxiedUrl, t: Date.now() });

    return proxiedUrl ? res.redirect(proxiedUrl) : res.status(404).end();
  } catch (e) {
    res.status(404).end();
  }
});

// ── Daily send quota ────────────────────────────────────────────────────────
const DAILY_SEND_LIMIT = 50;
let dailySendDate = new Date().toDateString();
let dailySendCount = 0;
function checkDailyQuota(count) {
  const today = new Date().toDateString();
  if (dailySendDate !== today) { dailySendDate = today; dailySendCount = 0; }
  if (dailySendCount + count > DAILY_SEND_LIMIT) {
    return { allowed: false, remaining: Math.max(0, DAILY_SEND_LIMIT - dailySendCount) };
  }
  return { allowed: true };
}

// ── POST /api/broadcast ───────────────────────────────────────────────────────
app.post('/api/broadcast', async (req, res) => {
  try {
    if (botStatus !== 'ready') return res.status(503).json({ error: 'Bot not ready' });
    const { chatIds: rawIds, message, mimetype, data, filename } = req.body;
    if (!rawIds?.length || (!message && !data)) {
      return res.status(400).json({ error: 'chatIds[] and either message or media required' });
    }
    const chatIds = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String).map(s => s.trim()).filter(Boolean))];
    if (!chatIds.length) return res.status(400).json({ error: 'chatIds[] must contain valid recipient IDs' });

    const quota = checkDailyQuota(chatIds.length);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'Daily broadcast limit reached', used: dailySendCount, limit: DAILY_SEND_LIMIT, remaining: quota.remaining });
    }

    let media = null;
    if (data && mimetype) {
      const cleanData = data.includes(',') ? data.split(',')[1] : data;
      media = new MessageMedia(mimetype, cleanData, filename || 'broadcast_attachment');
    }

    // Stream progress as text/event-stream so the UI can show live status
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const emit = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ } };

    const results = [];
    let failed = 0;
    for (let i = 0; i < chatIds.length; i++) {
      const chatId = chatIds[i];
      emit({ type: 'progress', done: i, total: chatIds.length, current: chatId });
      try {
        if (media) {
          await client.sendMessage(chatId, media, { caption: message || '' });
        } else {
          await client.sendMessage(chatId, message);
        }
        results.push({ chatId, success: true });
        dailySendCount++;
      } catch (err) {
        failed++;
        results.push({ chatId, success: false, error: err.message });
      }
      await new Promise(r => setTimeout(r, 350));
    }
    emit({ type: 'done', results, quota: { used: dailySendCount, limit: DAILY_SEND_LIMIT, remaining: Math.max(0, DAILY_SEND_LIMIT - dailySendCount) }, failed });
    res.end();
  } catch (e) {
    console.error('[API /api/broadcast]', e);
    try { res.status(500).json({ error: e.message }); } catch { /* already streaming */ }
  }
});


// ── GET /api/image-proxy ──────────────────────────────────────────────────────
app.get('/api/image-proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).send('Missing url');

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      }
    });

    if (!response.ok) return res.status(response.status).send('Failed to fetch image');

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send('Error proxying image');
  }
});







// ── POST /api/logout ──────────────────────────────────────────────────────────
app.post('/api/logout', async (_req, res) => {
  try {
    logoutInProgress = true;
    manualLogout = true;
    clearTimeout(initWatchdog);
    botStatus = 'starting';
    clientReady = false;
    currentQR = '';
    const old = client;
    client = null;
    try { await old?.destroy(); } catch {}
    try {
      const authDir = path.join(__dirname, '../.wwebjs_auth');
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    } catch {}
    res.json({ success: true });
    // Re-init after a short delay so the old browser fully releases the profile lock
    setTimeout(() => {
      killOrphanPuppeteerChrome();
      logoutInProgress = false;
      manualLogout = false;
      try { initClient(); } catch (e) { console.error('[LOGOUT] Re-init failed:', e); }
    }, 2500);
  } catch (e) {
    logoutInProgress = false;
    manualLogout = false;
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/contacts/:id ─────────────────────────────────────────────────
app.get('/api/contacts/:id', async (req, res) => {
  try {
    const contacts = await getContactsFromStore();
    const c = contacts.find(x => x.id === req.params.id);
    res.json(c || { id: req.params.id, name: '', isGroup: false, isUser: true, isWAContact: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/contacts/:id ─────────────────────────────────────────────────
app.put('/api/contacts/:id', async (req, res) => {
  try {
    const { tags, notes, label } = req.body || {};
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/import ──────────────────────────────────────────────
app.post('/api/contacts/import', async (req, res) => {
  try { res.json({ success: true, imported: 0 }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/contacts/refresh ────────────────────────────────────────────
app.post('/api/contacts/refresh', async (_req, res) => {
  try { res.json({ success: true, count: 0 }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET/POST/PUT/DELETE /api/templates ────────────────────────────────────
app.get('/api/templates', async (_req, res) => { try { res.json([]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/templates', async (req, res) => { try { res.json({ success: true, id: 't_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/templates/:id', async (_req, res) => { res.json({ success: true }); });
app.delete('/api/templates/:id', async (_req, res) => { res.json({ success: true }); });
app.post('/api/templates/preview', async (_req, res) => { res.json({ html: '<p>Preview</p>' }); });

// ── GET/POST/DELETE /api/campaigns ────────────────────────────────────────
app.get('/api/campaigns', async (_req, res) => { try { res.json([]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/campaigns', async (req, res) => { try { res.json({ success: true, id: 'cmp_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/campaigns/:id/start', async (_req, res) => { res.json({ success: true }); });
app.delete('/api/campaigns/:id', async (_req, res) => { res.json({ success: true }); });

// ── GET/POST/DELETE /api/campaign-templates ───────────────────────────────
app.get('/api/campaign-templates', async (_req, res) => { try { res.json([]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/campaign-templates', async (req, res) => { try { res.json({ success: true, id: 'ctpl_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/campaign-templates/:id', async (_req, res) => { res.json({ success: true }); });

// ── GET/POST/PUT/DELETE /api/auto-reply ───────────────────────────────────
app.get('/api/auto-reply', async (_req, res) => { try { res.json([]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/auto-reply', async (req, res) => { try { res.json({ success: true, id: 'ar_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/auto-reply/:id', async (_req, res) => { res.json({ success: true }); });
app.delete('/api/auto-reply/:id', async (_req, res) => { res.json({ success: true }); });

// ── GET/POST/PUT/DELETE /api/flows ────────────────────────────────────────
app.get('/api/flows', async (_req, res) => { try { res.json([]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/flows', async (req, res) => { try { res.json({ success: true, id: 'fl_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/flows/:id', async (_req, res) => { res.json({ success: true }); });
app.delete('/api/flows/:id', async (_req, res) => { res.json({ success: true }); });
app.post('/api/flows/:id/toggle', async (_req, res) => { res.json({ success: true }); });
app.post('/api/flows/:id/trigger', async (_req, res) => { res.json({ success: true }); });

// ── GET /api/analytics ───────────────────────────────────────────────────
app.get('/api/analytics', async (_req, res) => {
  try {
    if (botStatus !== 'ready') return res.json({ chats: 0, contacts: 0, groups: 0, messages: 0, unread: 0, msgsSentToday: dailySendCount, dailySendQuota: { used: dailySendCount, limit: DAILY_SEND_LIMIT }, campaigns: {}, scheduled: {}, templates: 0, autoReplyRules: 0, topChats: [] });
    const [chats, contacts] = await Promise.all([getChatsFromStore().catch(() => []), getContactsFromStore().catch(() => [])]);
    const groups = chats.filter(c => c.isGroup);
    const unread = chats.filter(c => c.unreadCount > 0).length;
    const totalMsgs = chats.reduce((acc, c) => acc + (c.unreadCount || 0), 0);
    const topChats = chats.filter(c => c.unreadCount > 0).slice(0, 10).map(c => ({ name: c.name, msgCount: c.unreadCount }));
    res.json({
      chats: chats.length,
      contacts: contacts.length,
      groups: groups.length,
      messages: totalMsgs,
      unread,
      msgsSentToday: dailySendCount,
      dailySendQuota: { used: dailySendCount, limit: DAILY_SEND_LIMIT },
      campaigns: { running: 0, completed: 0, dailyPaused: 0 },
      scheduled: { active: 0, completed: 0 },
      templates: 0,
      autoReplyRules: 0,
      topChats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/groups/:id ──────────────────────────────────────────────────
app.get('/api/groups/:id', async (req, res) => {
  try {
    const groups = await getChatsFromStore();
    const g = groups.find(x => x.id === req.params.id);
    res.json(g || { id: req.params.id, name: '', participants: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/groups/create ──────────────────────────────────────────────
app.post('/api/groups/create', async (req, res) => {
  try { res.json({ success: true, id: 'g_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/groups/:id/add ─────────────────────────────────────────────
app.post('/api/groups/:id/add', async (_req, res) => { res.json({ success: true }); });

// ── POST /api/groups/:id/remove ──────────────────────────────────────────
app.post('/api/groups/:id/remove', async (_req, res) => { res.json({ success: true }); });

// ── POST /api/groups/:id/set-title ───────────────────────────────────────
app.post('/api/groups/:id/set-title', async (_req, res) => { res.json({ success: true }); });

// ── POST /api/groups/:id/set-description ─────────────────────────────────
app.post('/api/groups/:id/set-description', async (_req, res) => { res.json({ success: true }); });

// ── POST /api/groups/:id/push-all ────────────────────────────────────────
app.post('/api/groups/:id/push-all', async (_req, res) => { res.json({ success: true }); });

// ── GET /api/search ──────────────────────────────────────────────────────
app.get('/api/search', async (_req, res) => {
  try { res.json({ messages: [], total: 0 }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/unread-count ────────────────────────────────────────────────
app.get('/api/unread-count', async (_req, res) => {
  try { res.json(0); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CRUD /api/scheduled ───────────────────────────────────────────────────
app.get('/api/scheduled', async (req, res) => {
  try {
    res.json({ items: [], stats: { total: 0, active: 0, paused: 0, completed: 0, failed: 0, sentToday: 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/scheduled', async (req, res) => { try { res.json({ success: true, id: 'sch_' + Date.now() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/scheduled/:id', async (_req, res) => { res.json({ success: true }); });
app.delete('/api/scheduled/:id', async (_req, res) => { res.json({ success: true }); });
app.post('/api/scheduled/:id/pause', async (_req, res) => { res.json({ success: true }); });
app.post('/api/scheduled/:id/resume', async (_req, res) => { res.json({ success: true }); });
app.post('/api/scheduled/:id/duplicate', async (_req, res) => { res.json({ success: true, id: 'sch_dup_' + Date.now() }); });
app.delete('/api/scheduled/history/clear', async (_req, res) => { res.json({ success: true }); });

// ── Sessions ───────────────────────────────────────────────────────────────
app.get('/api/sessions', async (_req, res) => {
  try { res.json([{ id: 'default', name: 'Main Session', connected: botStatus === 'ready' }]); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/create', async (_req, res) => { res.json({ success: true, id: 'default' }); });
app.post('/api/sessions/:id/terminate', async (_req, res) => { res.json({ success: true }); });

// ── Labels ─────────────────────────────────────────────────────────────────
app.get('/api/labels', async (_req, res) => { res.json([]); });
app.get('/api/labels/:id/messages', async (_req, res) => { res.json([]); });

// ── GET /api/export/:chatId ──────────────────────────────────────────────
app.get('/api/export/:chatId', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const msgs = await getMessagesFromStore(chatId);
    let text = '';
    for (const m of msgs) {
      const d = m.t ? new Date(m.t).toLocaleString() : '?';
      text += `[${d}] ${m.from || ''}: ${m.body || ''}\n`;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_export.txt"`);
    res.send(text || 'No messages found.');
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>saheli dresses WA bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0a1628 0%, #1a2f4e 50%, #0f2033 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 24px;
      padding: 40px 36px;
      max-width: 440px;
      width: 92%;
      text-align: center;
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .logo { width:64px;height:64px;background:linear-gradient(135deg,#25d366,#128c7e);border-radius:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:32px; }
    h1 { font-size: 26px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: rgba(255,255,255,0.55); font-size: 14px; margin-bottom: 28px; }
    .status-badge { display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:100px;font-size:13px;font-weight:600;margin-bottom:24px;transition:all 0.3s; }
    .dot { width:8px;height:8px;border-radius:50%;animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)} }
    .status-starting{background:rgba(255,193,7,.15);border:1px solid rgba(255,193,7,.3);color:#ffc107}
    .status-starting .dot{background:#ffc107}
    .status-qr{background:rgba(33,150,243,.15);border:1px solid rgba(33,150,243,.3);color:#42a5f5}
    .status-qr .dot{background:#42a5f5}
    .status-ready{background:rgba(37,211,102,.15);border:1px solid rgba(37,211,102,.3);color:#25d366}
    .status-ready .dot{background:#25d366;animation:none}
    .status-disconnected{background:rgba(244,67,54,.15);border:1px solid rgba(244,67,54,.3);color:#ef5350}
    .status-disconnected .dot{background:#ef5350}
    #qr-section img{width:260px;height:260px;border-radius:16px;border:6px solid rgba(255,255,255,.1);margin-bottom:16px}
    .hint{font-size:12px;color:rgba(255,255,255,.4);line-height:1.6}
    #connected-section{display:none}
    .check{font-size:64px;margin-bottom:12px}
    .phone{font-size:18px;font-weight:600;color:#25d366;margin-bottom:8px}
    .ready-text{color:rgba(255,255,255,.5);font-size:13px}
    .commands-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:20px;text-align:left}
    .cmd-item{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;font-size:12px}
    .cmd-item strong{color:#25d366;display:block;margin-bottom:2px}
    .cmd-item span{color:rgba(255,255,255,.45)}
    #waiting-section{display:none}
    .spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.1);border-top-color:#25d366;border-radius:50%;animation:spin .9s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .poll-indicator{position:fixed;bottom:16px;right:16px;font-size:11px;color:rgba(255,255,255,.25)}
    .dashboard-link{display:inline-block;margin-top:20px;padding:10px 24px;background:linear-gradient(135deg,#25d366,#128c7e);color:white;text-decoration:none;border-radius:100px;font-size:13px;font-weight:600}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">📱</div>
  <h1>saheli dresses WA bot</h1>
  <p class="subtitle">WhatsApp Automation Dashboard</p>
  <div id="status-badge" class="status-badge status-starting"><div class="dot"></div><span id="status-text">Connecting…</span></div>
  <div id="qr-section" style="display:none"><img id="qr-img" src="" alt="QR Code" /><p class="hint">Open WhatsApp → <strong>Settings → Linked Devices → Link a Device</strong><br>then scan this code</p></div>
  <div id="waiting-section"><div class="spinner"></div><p class="hint">Initializing WhatsApp session…</p></div>
  <div id="connected-section">
    <div class="check">✅</div>
    <div class="phone" id="phone-number"></div>
    <div class="ready-text">Bot is online and ready</div>
    <div class="commands-grid">
      <div class="cmd-item"><strong>!ping</strong><span>Check if bot is alive</span></div>
      <div class="cmd-item"><strong>!help</strong><span>Show all commands</span></div>
      <div class="cmd-item"><strong>!say</strong><span>Echo a message</span></div>
      <div class="cmd-item"><strong>!poll</strong><span>Create a poll</span></div>
      <div class="cmd-item"><strong>!groups</strong><span>List groups</span></div>
      <div class="cmd-item"><strong>!notify</strong><span>Subscribe to alerts</span></div>
    </div>
    <a href="http://localhost:3001/dashboard" class="dashboard-link">Open Full Dashboard →</a>
  </div>
</div>
<div class="poll-indicator" id="poll-indicator">Checking status…</div>
<script>
  const badge=document.getElementById('status-badge'),badgeTxt=document.getElementById('status-text'),
        qrSec=document.getElementById('qr-section'),qrImg=document.getElementById('qr-img'),
        waitSec=document.getElementById('waiting-section'),conSec=document.getElementById('connected-section'),
        phoneTxt=document.getElementById('phone-number'),pollInd=document.getElementById('poll-indicator');
  let lastQR=null;
  async function poll(){
    try{
      const data=await fetch('/api/status').then(r=>r.json());
      const{status,qr,phone}=data;
      badge.className='status-badge status-'+(status==='authenticated'?'ready':status);
      badgeTxt.textContent={starting:'Starting browser…',qr:'Scan QR Code',authenticated:'Authenticated',ready:'Online ✓',disconnected:'Reconnecting…'}[status]||status;
      if(status==='ready'||status==='authenticated'){qrSec.style.display='none';waitSec.style.display='none';conSec.style.display='block';phoneTxt.textContent=phone?'+'+phone:'Connected';}
      else if(status==='qr'&&qr){if(qr!==lastQR){lastQR=qr;qrImg.src='https://api.qrserver.com/v1/create-qr-code/?size=260x260&data='+encodeURIComponent(qr);}qrSec.style.display='block';waitSec.style.display='none';conSec.style.display='none';}
      else{qrSec.style.display='none';waitSec.style.display='block';conSec.style.display='none';}
      pollInd.textContent='Last updated: '+new Date().toLocaleTimeString();
    }catch(e){pollInd.textContent='Server unreachable — retrying…';}
  }
  poll();setInterval(poll,3000);
</script>
</body>
</html>`);
});

// ── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhooks/open-wa', (req, res) => {
  const secret = req.header('X-Webhook-Secret');
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { webhookId, sessionId, event, payload } = req.body;
  console.log('[webhook]', event, 'session:', sessionId, 'id:', webhookId);
  res.sendStatus(204);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: botStatus, phone: client.info?.wid?.user ?? null, qr: !!currentQR });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('[SERVER] saheli dresses WA bot running on http://localhost:' + PORT);
});

