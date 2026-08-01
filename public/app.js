const API = (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const token = localStorage.getItem('wa_bot_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(path, { headers, ...opts }).then(r => r.json()).catch(() => ({ error: 'network' }));
};
const COLORS = ['#00a884','#5b61b9','#a069c3','#f15a6a','#f19e38','#4ad2a6','#6f8c9f','#cb6d62','#4eacd6','#d9a460','#79c577','#e379b3'];
function avatarColor(id) { let h = 0; for (const c of id) h = ((h << 5) - h) + c.charCodeAt(0); return COLORS[Math.abs(h) % COLORS.length]; }
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase() : name.slice(0,2).toUpperCase();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function mediaIcon(type) {
  const map = {
    image: '🖼️', video: '🎬', audio: '🎵', document: '📄', sticker: '✨', album: '🖼️', location: '📍', contact: '👤'
  };
  return `<span class="media-ic">${map[type] || '📎'}</span>`;
}

function avatarHTML(id, name, size = 36) {
  const s = size;
  const bg = avatarColor(id);
  const ini = initials(name);
  const fs = Math.max(10, Math.round(s * 0.4));
  return `<div class="avatar-wrapper" style="width:${s}px;height:${s}px;background:${bg};flex-shrink:0" data-id="${esc(id)}">
    <div class="avatar-fallback" style="width:${s}px;height:${s}px;font-size:${fs}px">${esc(ini)}</div>
    <img src="/api/profile-pic/${encodeURIComponent(id)}" class="avatar-img" alt="" style="width:${s}px;height:${s}px" onerror="this.remove()" onload="this.classList.add('loaded')">
  </div>`;
}
function formatTime(ts) {
  if (!ts) return ''; const d = new Date(ts * 1000); const n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const yest = new Date(n); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day:'numeric', month:'short' });
}
function formatFullTime(ts) { return new Date(ts * 1000).toLocaleString(); }
function formatDateTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleString(); }

/* ---- STATE ---- */
const state = { activeView: 'inbox', chats: [], contacts: [], activeChat: null, templates: [], rules: [], campaigns: [], groups: [], scheduled: [], history: [], waitlist: [], token: localStorage.getItem('wa_bot_token') || null };

/* ---- AUTH ---- */
async function checkSession() {
  if (!state.token) return false;
  const data = await API('/api/session');
  if (data.error || !data.authenticated) { localStorage.removeItem('wa_bot_token'); state.token = null; return false; }
  return true;
}

async function login(username, password) {
  const data = await API('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (data.error) return data;
  state.token = data.token;
  localStorage.setItem('wa_bot_token', data.token);
  return data;
}

async function logout() {
  const btn = document.getElementById('logout-btn');
  if (btn) { btn.textContent = 'Logging out...'; btn.disabled = true; }
  await API('/api/logout', { method: 'POST' });
  localStorage.removeItem('wa_bot_token');
  state.token = null;
  if (btn) setTimeout(() => window.location.href = '/', 400);
}

document.addEventListener('DOMContentLoaded', async () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  const authenticated = await checkSession();
  if (authenticated) {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('sidebar').style.display = '';
    document.getElementById('main').style.display = '';
    poll();
  } else {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('main').style.display = 'none';
  }
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('login-password').value;
      const un = document.getElementById('login-username').value;
      const errEl = document.getElementById('login-error');
      const btn = document.getElementById('login-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
      const result = await login(un, pw);
      if (result.error) {
        if (errEl) { errEl.textContent = result.error; errEl.classList.remove('hidden'); }
        if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
        return;
      }
      if (errEl) errEl.classList.add('hidden');
      document.getElementById('login-overlay').classList.add('hidden');
      document.getElementById('sidebar').style.display = '';
      document.getElementById('main').style.display = '';
      poll();
    });
  }
});

/* ---- NAVIGATION ---- */
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const view = el.dataset.view;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    state.activeView = view;
    if (view === 'contacts') loadContacts(true);
    if (view === 'campaigns') loadCampaigns();
    if (view === 'templates') loadTemplates();
    if (view === 'autoreply') loadAutoReply();
    if (view === 'flows') loadFlows();
    if (view === 'groups') loadGroups();
    if (view === 'history') loadHistory();
    if (view === 'waitlist') loadWaitlist();
    if (view === 'analytics') loadAnalytics();
    if (view === 'schedule') loadScheduled();
  });
});

/* ---- INBOX ---- */
let chatListSignature = '';
let chatSearchQuery = '';
function chatListFilter() {
  const q = chatSearchQuery.trim().toLowerCase();
  if (!q) return state.chats;
  return state.chats.filter(c => (c.name || c.id).toLowerCase().includes(q));
}
function renderChats(chats) {
  const el = document.getElementById('chat-list');
  if (!chats.length) {
    if (chatListSignature !== 'empty') { chatListSignature = 'empty'; el.innerHTML = '<div style="padding:24px;text-align:center;color:#555;font-size:13px">No conversations</div>'; }
    return;
  }
  const sig = chats.map(c => (c.id + '|' + (c.name || '') + '|' + (c.lastMessage || '') + '|' + (c.unreadCount || 0) + '|' + (c.timestamp || 0))).join('\n');
  if (sig === chatListSignature) return;
  chatListSignature = sig;
  el.innerHTML = chats.map(c => {
    const act = state.activeChat === c.id;
    const n = c.name || c.id;
    return `<div class="chat-item${act?' active':''}" data-id="${esc(c.id)}">
      ${avatarHTML(c.id, n, 44)}
      <div class="chat-body">
        <div class="chat-top"><div class="chat-name">${esc(n)}</div><div class="chat-time">${formatTime(c.timestamp)}</div></div>
        <div class="chat-preview">${esc((c.lastMessage||'').slice(0, 120))}</div>
      </div>
      ${c.unreadCount > 0 ? `<div class="chat-badge">${c.unreadCount}</div>` : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('.chat-item').forEach(el => el.addEventListener('click', () => selectChat(el.dataset.id)));
}

async function selectChat(chatId) {
  state.activeChat = chatId;
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('msg-input').focus();
  const chat = state.chats.find(c => c.id === chatId);
  const name = chat ? (chat.name || chatId) : chatId;
  document.getElementById('chat-name').textContent = name;
  const av = document.getElementById('chat-avatar');
  av.innerHTML = avatarHTML(chatId, name, 36);
  document.getElementById('chat-presence').textContent = chat?.contact?.name ? esc(chat.contact.name) : '';
  renderChats(chatListFilter());
  await loadMessages(chatId);
}

let messagesRequestSeq = 0;
async function loadMessages(chatId) {
  const seq = ++messagesRequestSeq;
  const msgs = await API('/api/messages/' + encodeURIComponent(chatId));
  if (msgs.error || seq !== messagesRequestSeq || state.activeChat !== chatId) return;
  const scroller = document.getElementById('messages');
  const inner = document.getElementById('messages-inner');
  const wasNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  if (!msgs.length) { inner.innerHTML = '<div style="text-align:center;color:#555;font-size:13px;padding:40px">No messages</div>'; return; }
  inner.innerHTML = msgs.map((m, i) => {
    const prev = msgs[i-1];
    const same = prev && prev.fromMe === m.fromMe;
    const cls = (m.fromMe ? 'out' : 'in') + (same ? (m.fromMe ? ' out-stack' : ' in-stack') : '');
    const icon = m.hasMedia ? mediaIcon(m.type) : '';
    const body = m.hasMedia ? `<div class="msg-media">${icon}<span>${esc(m.body)}</span></div>` : `<p>${esc(m.body)}</p>`;
    return `<div class="msg ${cls}">${body}<div class="msg-meta"><span class="msg-time">${formatTime(m.timestamp)}</span></div></div>`;
  }).join('');
  if (wasNearBottom) scroller.scrollTop = scroller.scrollHeight;
}

/* ---- FILE UPLOAD / PASTE ---- */
const uploadQueue = [];
document.getElementById('attach-btn').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', function() {
  for (const f of this.files) addToUploadQueue(f);
  this.value = '';
});
document.getElementById('msg-input').addEventListener('paste', async function(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      e.preventDefault();
      const f = item.getAsFile();
      if (f) addToUploadQueue(f);
    }
  }
});
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('msg-input').addEventListener('input', () => {
  const ta = document.getElementById('msg-input');
  const v = ta.value.trim();
  document.getElementById('send-btn').disabled = !v || !state.activeChat;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
});
document.getElementById('chat-search').addEventListener('input', function() {
  chatSearchQuery = this.value;
  renderChats(chatListFilter());
});

function addToUploadQueue(f) {
  uploadQueue.push(f);
  renderUploadPreview();
}

function renderUploadPreview() {
  const el = document.getElementById('upload-preview');
  if (!uploadQueue.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = uploadQueue.map((f, i) => {
    const isImg = f.type?.startsWith('image/');
    const url = isImg ? URL.createObjectURL(f) : '';
    return `<div class="upload-preview-item">${isImg ? `<img src="${url}">` : '<div class="file-icon">📄</div>'}<div class="file-name">${esc(f.name)}</div><button class="upload-preview-remove" data-idx="${i}">✕</button></div>`;
  }).join('') + '<button class="upload-preview-send" id="upload-send-btn">Send ' + uploadQueue.length + ' file(s)</button>';
  el.querySelectorAll('.upload-preview-remove').forEach(b => b.addEventListener('click', () => {
    uploadQueue.splice(parseInt(b.dataset.idx), 1);
    renderUploadPreview();
  }));
  const sendBtn = document.getElementById('upload-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', sendUploadQueue);
}

async function sendUploadQueue() {
  if (!state.activeChat || !uploadQueue.length) return;
  const btn = document.getElementById('upload-send-btn');
  const prevText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  const failures = [];
  for (const f of uploadQueue) {
    try {
      const b64 = await fileToBase64(f);
      const caption = document.getElementById('msg-input').value.trim();
      const res = await API('/api/send-media', { method: 'POST', body: JSON.stringify({ chatId: state.activeChat, base64: b64, filename: f.name, caption }) });
      if (res.error) failures.push(f.name);
    } catch (e) { console.error('Upload failed:', f.name, e); failures.push(f.name); }
  }
  uploadQueue.length = 0;
  const mi = document.getElementById('msg-input');
  mi.value = ''; mi.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  renderUploadPreview();
  await loadMessages(state.activeChat);
  if (failures.length) alert('Failed to send: ' + failures.join(', '));
}

function fileToBase64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}

document.getElementById('send-btn').addEventListener('click', sendMessage);

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeChat) return;
  input.value = ''; input.style.height = 'auto'; document.getElementById('send-btn').disabled = true;
  await API('/api/send', { method: 'POST', body: JSON.stringify({ chatId: state.activeChat, text }) });
  await loadMessages(state.activeChat);
}

let contactsPage = 1;
const CONTACTS_PAGE_SIZE = 60;
let contactsData = null;

async function loadContacts(resetPage) {
  if (resetPage) contactsPage = 1;
  const search = document.getElementById('contacts-search').value;
  const url = '/api/contacts?page=' + contactsPage + '&pageSize=' + CONTACTS_PAGE_SIZE + (search ? '&search=' + encodeURIComponent(search) : '');
  const data = await API(url);
  if (data.error) return;
  contactsData = data;
  document.getElementById('contacts-count').textContent = `(${data.filtered})`;
  const grid = document.getElementById('contacts-grid');
  const list = data.contacts || [];
  if (contactsPage === 1) grid.innerHTML = '';
  if (!list.length) {
    if (contactsPage === 1) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#555">No contacts</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach(c => {
    const n = c.name || c.id;
    const displayId = c.chatId || c.id || '';
    const div = document.createElement('div');
    div.className = 'contact-card';
    div.dataset.id = c.id;
    div.innerHTML = `<div class="contact-card-top">
      ${avatarHTML(c.id, n, 38)}
      <div style="flex:1;min-width:0"><div class="contact-card-name">${esc(n)}</div>
        <div class="contact-card-number" style="font-size:11px">${esc(c.number || '')}${c.isBusiness ? ' <span class="tag" style="font-size:9px">Business</span>' : ''}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:1px;display:flex;align-items:center;gap:4px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${esc(displayId)}</span><button class="copy-id-btn" data-id="${esc(displayId)}" title="Copy ID" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0;font-size:10px;flex-shrink:0">📋</button></div>
      </div>
    </div>
    ${c.tags?.length ? `<div class="contact-card-tags">${c.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${c.notes ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(c.notes)}</div>` : ''}`;
    div.addEventListener('click', (e) => { if (e.target.closest('.copy-id-btn')) return; showContactDetail(c.id); });
    frag.appendChild(div);
  });
  grid.appendChild(frag);
  grid.querySelectorAll('.copy-id-btn').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.id); b.textContent = '✅'; setTimeout(() => b.textContent = '📋', 1500); } catch {}
  }));
  const existingLoader = document.getElementById('contacts-loader');
  if (existingLoader) existingLoader.remove();
  if (contactsPage < data.totalPages) {
    const loader = document.createElement('div');
    loader.id = 'contacts-loader';
    loader.style.cssText = 'grid-column:1/-1;text-align:center;padding:16px';
    loader.innerHTML = '<button class="btn btn-secondary" style="width:100%;max-width:200px">Load More</button>';
    loader.querySelector('button').addEventListener('click', () => {
      contactsPage++;
      loadContacts();
    });
    grid.appendChild(loader);
  }
}

document.getElementById('contacts-search').addEventListener('input', () => loadContacts(true));
document.getElementById('import-contacts-btn').addEventListener('click', () => {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>Import Contacts</h3>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Paste CSV with columns: <strong>phone,name,tags</strong> (one per line). Tags separated by semicolons.</div>
    <textarea id="import-csv" rows="8" placeholder="phone,name,tags&#10;911234567890,John Doe,customer;vip&#10;919876543210,Jane Smith,lead" style="width:100%;background:var(--bg-primary);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;resize:vertical;font-size:13px"></textarea>
    <div style="margin:12px 0;text-align:center;color:var(--text-muted);font-size:13px">or</div>
    <input type="file" id="import-file" accept=".csv,.txt" style="font-size:13px">
    <div class="modal-actions"><button class="btn btn-primary" id="import-execute">Import</button><button class="btn btn-secondary" id="import-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('import-file').addEventListener('change', function() {
    const f = this.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = e => document.getElementById('import-csv').value = e.target.result;
    reader.readAsText(f);
  });
  document.getElementById('import-execute').addEventListener('click', async () => {
    const csv = document.getElementById('import-csv').value.trim();
    if (!csv) return;
    const result = await API('/api/contacts/import', { method:'POST', body: JSON.stringify({ csv }) });
    hideModal();
    if (result.imported) alert(`${result.imported} contacts imported`);
    loadContacts();
  });
  document.getElementById('import-cancel').addEventListener('click', hideModal);
});

async function showContactDetail(id) {
  const data = await API('/api/contacts/' + encodeURIComponent(id));
  if (data.error) return;
  const panel = document.getElementById('contact-panel');
  const n = data.name || data.number || id;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div style="width:48px;height:48px;border-radius:50%;background:${avatarColor(id)};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff;flex-shrink:0">${initials(n)}</div>
      <div><div style="font-weight:600;font-size:16px">${esc(n)}</div>
        <div style="color:var(--text-muted);font-size:12px">${esc(data.number || '')} ${data.isBusiness ? '• Business' : ''}</div>
        <div style="display:flex;align-items:center;gap:4px;margin-top:2px"><span style="font-size:11px;color:var(--text-muted);word-break:break-all">${esc(id)}</span><button class="detail-copy-id" data-id="${esc(id)}" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;flex-shrink:0">📋 Copy</button></div>
      </div>
    </div>
    <div class="form-group"><label>Tags (comma-separated)</label><input type="text" id="edit-tags" value="${esc((data.tags||[]).join(', '))}" placeholder="vip, customer, lead"></div>
    <div class="form-group"><label>Label</label><input type="text" id="edit-label" value="${esc(data.label||'')}" placeholder="e.g. High Value"></div>
    <div class="form-group"><label>Notes</label><textarea id="edit-notes" rows="3" placeholder="Add notes about this contact...">${esc(data.notes||'')}</textarea></div>
    <div class="modal-actions"><button class="btn btn-primary" id="save-contact">Save</button><button class="btn btn-secondary" id="close-contact-detail">Close</button></div>
  `;
  document.getElementById('contact-detail').classList.remove('hidden');
  panel.querySelector('.detail-copy-id')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(id); alert('Chat ID copied!'); } catch {}
  });
  document.getElementById('save-contact').addEventListener('click', async () => {
    const tags = document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    await API('/api/contacts/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ tags, notes: document.getElementById('edit-notes').value, label: document.getElementById('edit-label').value }) });
    document.getElementById('contact-detail').classList.add('hidden');
    contactCache = null; loadContacts(true);
  });
  document.getElementById('close-contact-detail').addEventListener('click', () => document.getElementById('contact-detail').classList.add('hidden'));
  document.getElementById('contact-detail-close').addEventListener('click', () => document.getElementById('contact-detail').classList.add('hidden'));
}

/* ---- TEMPLATES ---- */
async function loadTemplates() {
  const data = await API('/api/templates');
  if (data.error) return;
  state.templates = data;
  const grid = document.getElementById('templates-grid');
  if (!data.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#555">No templates yet</div>'; return; }
  grid.innerHTML = data.map(t => `
    <div class="template-card">
      <div class="template-name">${esc(t.name)}</div>
      <div class="template-body">${esc(t.body)}</div>
      ${t.variables?.length ? `<div class="template-vars">${t.variables.map(v => `<span class="template-var">{{${esc(v)}}}</span>`).join('')}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:4px">
        <button class="btn btn-secondary btn-sm use-template" data-id="${t.id}">Use</button>
        <button class="btn btn-secondary btn-sm edit-template" data-id="${t.id}">Edit</button>
        <button class="btn btn-danger btn-sm delete-template" data-id="${t.id}">Delete</button>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.use-template').forEach(el => el.addEventListener('click', () => useTemplate(el.dataset.id)));
  grid.querySelectorAll('.edit-template').forEach(el => el.addEventListener('click', () => editTemplate(el.dataset.id)));
  grid.querySelectorAll('.delete-template').forEach(el => el.addEventListener('click', async () => { await API('/api/templates/' + el.dataset.id, { method: 'DELETE' }); loadTemplates(); }));
}

function showTemplateModal(template) {
  const modal = document.getElementById('modal-content');
  const t = template || { id:'', name:'', body:'' };
  modal.innerHTML = `
    <h3>${t.id ? 'Edit Template' : 'New Template'}</h3>
    <div class="form-group"><label>Template Name</label><input type="text" id="tmpl-name" value="${esc(t.name)}"></div>
    <div class="form-group"><label>Message Body <span style="color:var(--text-muted);font-weight:400">(use {{variable}} for placeholders)</span></label><textarea id="tmpl-body" rows="5">${esc(t.body)}</textarea></div>
    <div class="form-group"><div id="tmpl-preview" style="font-size:13px;color:var(--text-muted);background:var(--bg-primary);padding:10px;border-radius:6px;white-space:pre-wrap"></div></div>
    <div class="modal-actions"><button class="btn btn-primary" id="tmpl-save">${t.id ? 'Update' : 'Create'}</button><button class="btn btn-secondary" id="tmpl-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('tmpl-body').addEventListener('input', () => updatePreview());
  document.getElementById('tmpl-save').addEventListener('click', async () => {
    const name = document.getElementById('tmpl-name').value.trim();
    const body = document.getElementById('tmpl-body').value.trim();
    if (!name || !body) return;
    if (t.id) await API('/api/templates/' + t.id, { method: 'PUT', body: JSON.stringify({ name, body }) });
    else await API('/api/templates', { method: 'POST', body: JSON.stringify({ name, body }) });
    hideModal(); loadTemplates();
  });
  document.getElementById('tmpl-cancel').addEventListener('click', hideModal);
  updatePreview();
}

function updatePreview() {
  const body = document.getElementById('tmpl-body').value;
  const preview = body.replace(/\{\{(\w+)\}\}/g, '<span style="color:var(--warning)">[$1]</span>');
  document.getElementById('tmpl-preview').innerHTML = preview || 'Preview will appear here';
}

function useTemplate(id) {
  const t = state.templates.find(x => x.id === id);
  if (!t) return;
  navigateToView('inbox');
  document.getElementById('msg-input').value = t.body;
  document.getElementById('msg-input').focus();
  document.getElementById('send-btn').disabled = false;
}

document.getElementById('new-template-btn').addEventListener('click', () => showTemplateModal(null));

async function editTemplate(id) {
  const t = state.templates.find(x => x.id === id);
  if (t) showTemplateModal(t);
}

/* ---- HISTORY ---- */
let historyPage = 1;
let historySearch = '';
let historyFilter = '';

async function loadHistory() {
  const url = '/api/history?page=' + historyPage + '&pageSize=50' + (historySearch ? '&wa_id=' + encodeURIComponent(historySearch) : '') + (historyFilter ? '&source=' + encodeURIComponent(historyFilter) : '');
  const data = await API(url);
  if (data.error) return;
  state.history = data.messages || [];
  const el = document.getElementById('history-list');
  const items = data.messages || [];
  if (!items.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#555">No message history</div>';
    return;
  }
  el.innerHTML = `<table class="history-table"><thead><tr><th>Time</th><th>Contact</th><th>Source</th><th>Direction</th><th>Body</th><th>Status</th></tr></thead><tbody>
    ${items.map(m => `<tr>
      <td style="color:var(--text-muted);font-size:12px;white-space:nowrap">${formatDateTime(m.created_at)}</td>
      <td>${esc(m.contacts?.name || m.wa_id)}</td>
      <td><span class="tag">${esc(m.source || 'manual')}</span></td>
      <td>${m.direction === 'outbound' ? '📤' : '📥'}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((m.body || '').slice(0, 80))}</td>
      <td>${esc(m.status || 'sent')}</td>
    </tr>`).join('')}
  </tbody></table>
  <div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">Showing ${items.length} of ${data.total || 0} messages</div>`;
}

document.getElementById('history-search')?.addEventListener('input', function() { historySearch = this.value; loadHistory(); });
document.getElementById('history-filter')?.addEventListener('change', function() { historyFilter = this.value; loadHistory(); });

/* ---- WAITLIST ---- */
async function loadWaitlist() {
  const data = await API('/api/waitlist');
  if (data.error) return;
  state.waitlist = data.waitlist || [];
  const el = document.getElementById('waitlist-list');
  const items = data.waitlist || [];
  if (!items.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#555">No pending waitlist items</div>';
    return;
  }
  el.innerHTML = items.map(w => `
    <div class="waitlist-item" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px">
      ${avatarHTML(w.contacts?.id || w.contact_id, w.contacts?.name || w.wa_id, 32)}
      <div style="flex:1;min-width:0">
        <div style="font-weight:500">${esc(w.contacts?.name || w.wa_id)}</div>
        <div style="color:var(--text-muted);font-size:11px">${esc(w.reason)} · ${formatDateTime(w.created_at)}</div>
        ${w.message_history?.body ? `<div style="color:var(--text-secondary);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px">Last: ${esc(w.message_history.body.slice(0, 60))}</div>` : ''}
      </div>
      <button class="btn btn-primary btn-sm resolve-waitlist" data-id="${w.id}">Resolve</button>
    </div>
  `).join('');
  const resolveAll = document.getElementById('waitlist-resolve-all');
  if (resolveAll) resolveAll.onclick = async () => {
    for (const w of items) {
      await API('/api/waitlist/' + w.id + '/resolve', { method: 'POST' });
    }
    loadWaitlist();
  };
}

document.getElementById('waitlist-list')?.addEventListener('click', e => {
  const btn = e.target.closest('.resolve-waitlist');
  if (!btn) return;
  API('/api/waitlist/' + btn.dataset.id + '/resolve', { method: 'POST' }).then(loadWaitlist);
});

/* ---- CAMPAIGNS ---- */
async function loadCampaigns() {
  const data = await API('/api/campaigns');
  if (data.error) return;
  state.campaigns = data;
  const el = document.getElementById('campaigns-list');
  if (!data.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:#555">No campaigns yet. Create one to broadcast messages.</div>'; return; }
  el.innerHTML = data.map(c => {
    const pct = c.progress?.total ? Math.round((c.progress.sent / c.progress.total) * 100) : 0;
    return `<div class="campaign-card">
      <div class="campaign-header"><span class="campaign-name">${esc(c.name)}</span><span class="campaign-status ${c.status}">${c.status}</span></div>
      ${c.scheduleAt ? `<div style="font-size:12px;color:var(--warning)">Scheduled: ${new Date(c.scheduleAt).toLocaleString()}</div>` : ''}
      <div class="campaign-progress">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
          <span>Sent: ${c.progress?.sent || 0} / ${c.progress?.total || 0}</span>
          <span>Failed: ${c.progress?.failed || 0}</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="campaign-message">${esc(c.message)}</div>
      <div style="margin-top:8px;display:flex;gap:4px">
        ${c.status === 'draft' ? `<button class="btn btn-primary btn-sm start-campaign" data-id="${c.id}">Start</button>` : ''}
        ${c.status === 'daily_paused' ? `<button class="btn btn-primary btn-sm resume-campaign" data-id="${c.id}">Resume (${(c.progress?.total - c.progress?.sent - c.progress?.failed)} remaining)</button>` : ''}
        <button class="btn btn-secondary btn-sm save-campaign-template" data-id="${c.id}" title="Save as campaign template">Save as Template</button>
        <button class="btn btn-danger btn-sm delete-campaign" data-id="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.start-campaign').forEach(el => el.addEventListener('click', async () => { await API('/api/campaigns/' + el.dataset.id + '/start', { method:'POST' }); loadCampaigns(); }));
  el.querySelectorAll('.resume-campaign').forEach(el => el.addEventListener('click', async () => { await API('/api/campaigns/' + el.dataset.id + '/start', { method:'POST' }); loadCampaigns(); }));
  el.querySelectorAll('.delete-campaign').forEach(el => el.addEventListener('click', async () => { if (!confirm('Delete this campaign?')) return; await API('/api/campaigns/' + el.dataset.id, { method:'DELETE' }); loadCampaigns(); }));
  el.querySelectorAll('.save-campaign-template').forEach(el => el.addEventListener('click', async () => {
    const c = state.campaigns.find(x => x.id === el.dataset.id);
    if (!c) return;
    await API('/api/campaign-templates', { method:'POST', body: JSON.stringify({ name: c.name + ' (Template)', message: c.message }) });
    loadCampaigns();
  }));
}

document.getElementById('new-campaign-btn').addEventListener('click', () => openNewCampaignModal());

function openNewCampaignModal(template) {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>${template ? 'New from Template: ' + esc(template.name) : 'New Campaign'}</h3>
    <div class="form-group"><label>Campaign Name</label><input type="text" id="camp-name" value="${template ? esc(template.name + ' - ' + new Date().toLocaleDateString()) : ''}"></div>
    <div class="form-group"><label>Message</label><textarea id="camp-msg" rows="4">${esc(template ? template.message : '')}</textarea></div>
    <div class="form-group"><label>Target</label><select id="camp-target"><option value="all" ${template && template.targetType === 'all' ? 'selected' : ''}>All Contacts</option><option value="tag" ${template && template.targetType === 'tag' ? 'selected' : ''}>Contacts with Tag</option></select></div>
    <div class="form-group" id="camp-tag-group" style="display:${template && template.targetType === 'tag' ? 'block' : 'none'}"><label>Tag</label><input type="text" id="camp-tag" placeholder="tag name" value="${esc(template ? template.targetFilter : '')}"></div>
    <div class="form-group"><label>Schedule (optional)</label><input type="datetime-local" id="camp-schedule"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="camp-save">Create & Start</button><button class="btn btn-secondary" id="camp-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('camp-target').addEventListener('change', function() {
    document.getElementById('camp-tag-group').style.display = this.value === 'tag' ? 'block' : 'none';
  });
  document.getElementById('camp-save').addEventListener('click', async () => {
    const body = { name: document.getElementById('camp-name').value.trim(), message: document.getElementById('camp-msg').value.trim(), targetType: document.getElementById('camp-target').value };
    if (body.targetType === 'tag') body.targetFilter = document.getElementById('camp-tag').value.trim();
    const schedule = document.getElementById('camp-schedule').value;
    if (schedule) body.scheduleAt = new Date(schedule).toISOString();
    if (!body.name || !body.message) return;
    await API('/api/campaigns', { method:'POST', body: JSON.stringify(body) });
    hideModal(); loadCampaigns();
  });
  document.getElementById('camp-cancel').addEventListener('click', hideModal);
}

/* ---- CAMPAIGN TEMPLATES ---- */
async function loadCampaignTemplates() {
  const data = await API('/api/campaign-templates');
  if (data.error) return;
  const el = document.getElementById('campaign-templates-list');
  if (!data.length) { el.innerHTML = '<div style="padding:16px;text-align:center;color:#555;font-size:13px">No campaign templates. Save a campaign config as a template to reuse it.</div>'; return; }
  el.innerHTML = data.map(ct => `
    <div class="campaign-card" style="margin-bottom:8px;opacity:0.8">
      <div class="campaign-header"><span class="campaign-name">${esc(ct.name)}</span><span style="font-size:11px;color:var(--text-muted)">template</span></div>
      <div class="campaign-message">${esc(ct.message)}</div>
      ${ct.variables?.length ? `<div class="template-vars" style="margin-top:6px">${ct.variables.map(v => `<span class="template-var">{{${esc(v)}}}</span>`).join('')}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:4px">
        <button class="btn btn-primary btn-sm use-campaign-template" data-id="${ct.id}">Use Template</button>
        <button class="btn btn-danger btn-sm delete-campaign-template" data-id="${ct.id}">Delete</button>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.use-campaign-template').forEach(el => el.addEventListener('click', async () => {
    const ct = data.find(x => x.id === el.dataset.id);
    if (ct) openNewCampaignModal(ct);
  }));
  el.querySelectorAll('.delete-campaign-template').forEach(el => el.addEventListener('click', async () => { await API('/api/campaign-templates/' + el.dataset.id, { method:'DELETE' }); loadCampaignTemplates(); }));
}

/* ---- AUTO-REPLY ---- */
async function loadAutoReply() {
  const data = await API('/api/auto-reply');
  if (data.error) return;
  state.rules = data;
  const el = document.getElementById('autoreply-list');
  if (!data.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:#555">No auto-reply rules. Add rules to automatically respond to messages.</div>'; return; }
  el.innerHTML = data.map(r => `
    <div class="rule-card">
      <div class="rule-header">
        <div><span class="campaign-name">${esc(r.name)}</span> <span style="font-size:11px;color:var(--text-muted)">${r.matchType}</span></div>
        <span class="rule-toggle ${r.active !== false ? 'active' : 'inactive'}" data-id="${r.id}">${r.active !== false ? '● Active' : '○ Inactive'}</span>
      </div>
      ${r.keywords?.length ? `<div class="rule-keywords">${r.keywords.map(k => `<span class="rule-keyword">${esc(k)}</span>`).join('')}</div>` : ''}
      <div class="rule-reply">→ ${esc(r.reply)}</div>
      <div style="margin-top:8px;display:flex;gap:4px">
        <button class="btn btn-secondary btn-sm toggle-rule" data-id="${r.id}">Toggle</button>
        <button class="btn btn-danger btn-sm delete-rule" data-id="${r.id}">Delete</button>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.toggle-rule').forEach(el => el.addEventListener('click', async () => { const r = state.rules.find(x => x.id === el.dataset.id); if (r) { await API('/api/auto-reply/' + r.id, { method:'PUT', body: JSON.stringify({ active: r.active === false }) }); loadAutoReply(); } }));
  el.querySelectorAll('.delete-rule').forEach(el => el.addEventListener('click', async () => { await API('/api/auto-reply/' + el.dataset.id, { method:'DELETE' }); loadAutoReply(); }));
}

/* ---- FLOWS ---- */
async function loadFlows() {
  const data = await API('/api/flows');
  if (data.error) return;
  state.flows = data;
  const el = document.getElementById('flows-list');
  if (!data.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:#555">No flows yet. Create a flow to build conversational automations.</div>'; return; }
  el.innerHTML = data.map(f => {
    const steps = f.steps || [];
    const stepLabels = steps.map(s => ({ send: '💬', wait: '⏳', end: '⏹️' })[s.type] || '•');
    return `<div class="flow-card">
      <div class="flow-card-top">
        <div class="flow-name">${esc(f.name)}</div>
        <span class="rule-toggle ${f.active !== false ? 'active' : 'inactive'}" data-id="${f.id}">${f.active !== false ? '● Active' : '○ Inactive'}</span>
      </div>
      <div class="flow-trigger">Trigger: <strong>${esc(f.trigger)}</strong></div>
      <div class="flow-steps">${steps.map((s, i) => `<span class="flow-step-badge ${s.type}">${i + 1}. ${s.type}${s.message ? ': ' + esc(s.message.slice(0, 30)) : ''}</span>`).join(' → ')}</div>
      <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm edit-flow" data-id="${f.id}">Edit Steps</button>
        <button class="btn btn-secondary btn-sm toggle-flow" data-id="${f.id}">Toggle</button>
        <button class="btn btn-danger btn-sm delete-flow" data-id="${f.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.toggle-flow').forEach(el => el.addEventListener('click', async () => { await API('/api/flows/' + el.dataset.id + '/toggle', { method:'POST' }); loadFlows(); }));
  el.querySelectorAll('.delete-flow').forEach(el => el.addEventListener('click', async () => { await API('/api/flows/' + el.dataset.id, { method:'DELETE' }); loadFlows(); }));
  el.querySelectorAll('.edit-flow').forEach(el => el.addEventListener('click', () => editFlow(el.dataset.id)));
}

function editFlow(id) {
  const f = state.flows.find(x => x.id === id);
  if (!f) return;
  const modal = document.getElementById('modal-content');
  const steps = f.steps || [];
  modal.innerHTML = `
    <h3>Edit Flow: ${esc(f.name)}</h3>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Trigger keyword: <strong>${esc(f.trigger)}</strong></div>
    <div id="flow-steps-editor"></div>
    <div style="margin-top:8px;display:flex;gap:4px">
      <button class="btn btn-secondary btn-sm" id="flow-add-send">+ Send Step</button>
      <button class="btn btn-secondary btn-sm" id="flow-add-wait">+ Wait Step</button>
      <button class="btn btn-secondary btn-sm" id="flow-add-end">+ End Step</button>
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn btn-primary" id="flow-save">Save Flow</button>
      <button class="btn btn-secondary" id="flow-cancel">Cancel</button>
    </div>
  `;
  showModal();

  function renderFlowSteps() {
    const s = state.editingFlow || { steps: steps.map(x => ({ ...x })) };
    const el = document.getElementById('flow-steps-editor');
    el.innerHTML = s.steps.map((step, i) => {
      let extra = '';
      if (step.type === 'send') extra = `<textarea class="flow-step-msg" data-idx="${i}" rows="2" placeholder="Message text...">${esc(step.message || '')}</textarea>`;
      if (step.type === 'wait') extra = `<div style="font-size:12px;color:var(--text-muted)">Waits for user reply before continuing</div>`;
      if (step.type === 'end') extra = `<div style="font-size:12px;color:var(--text-muted)">Ends the flow</div>`;
      return `<div class="flow-editor-step" data-idx="${i}">
        <div class="flow-editor-step-header">
          <span class="flow-step-type ${step.type}">${i + 1}. ${step.type}</span>
          <div>
            <button class="btn btn-secondary btn-sm flow-step-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-secondary btn-sm flow-step-down" data-idx="${i}" ${i === s.steps.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-danger btn-sm flow-step-del" data-idx="${i}">×</button>
          </div>
        </div>
        ${extra}
      </div>`;
    }).join('');
  }

  state.editingFlow = { steps: steps.map(x => ({ ...x })) };
  renderFlowSteps();

  document.getElementById('flow-add-send').addEventListener('click', () => {
    state.editingFlow.steps.push({ id: 's' + Date.now(), type: 'send', message: '' });
    renderFlowSteps();
  });
  document.getElementById('flow-add-wait').addEventListener('click', () => {
    state.editingFlow.steps.push({ id: 's' + Date.now(), type: 'wait' });
    renderFlowSteps();
  });
  document.getElementById('flow-add-end').addEventListener('click', () => {
    state.editingFlow.steps.push({ id: 's' + Date.now(), type: 'end' });
    renderFlowSteps();
  });

  document.getElementById('flow-steps-editor').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    if (btn.classList.contains('flow-step-up') && idx > 0) {
      [state.editingFlow.steps[idx - 1], state.editingFlow.steps[idx]] = [state.editingFlow.steps[idx], state.editingFlow.steps[idx - 1]];
      renderFlowSteps();
    }
    if (btn.classList.contains('flow-step-down') && idx < state.editingFlow.steps.length - 1) {
      [state.editingFlow.steps[idx], state.editingFlow.steps[idx + 1]] = [state.editingFlow.steps[idx + 1], state.editingFlow.steps[idx]];
      renderFlowSteps();
    }
    if (btn.classList.contains('flow-step-del')) {
      state.editingFlow.steps.splice(idx, 1);
      renderFlowSteps();
    }
  });

  document.getElementById('flow-steps-editor').addEventListener('input', e => {
    const ta = e.target.closest('textarea');
    if (!ta) return;
    const idx = parseInt(ta.dataset.idx);
    if (state.editingFlow.steps[idx]) state.editingFlow.steps[idx].message = ta.value;
  });

  document.getElementById('flow-save').addEventListener('click', async () => {
    await API('/api/flows/' + id, { method: 'PUT', body: JSON.stringify({ steps: state.editingFlow.steps }) });
    delete state.editingFlow;
    hideModal(); loadFlows();
  });
  document.getElementById('flow-cancel').addEventListener('click', hideModal);
}

document.getElementById('new-flow-btn').addEventListener('click', () => {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>New Conversational Flow</h3>
    <div class="form-group"><label>Flow Name</label><input type="text" id="flow-name" placeholder="e.g. Support Flow"></div>
    <div class="form-group"><label>Trigger Keyword</label><input type="text" id="flow-trigger" placeholder="e.g. help, support, menu"></div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">When a contact sends this keyword, the flow starts automatically. You can edit the steps after creation.</div>
    <div class="modal-actions"><button class="btn btn-primary" id="flow-create">Create Flow</button><button class="btn btn-secondary" id="flow-create-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('flow-create').addEventListener('click', async () => {
    const name = document.getElementById('flow-name').value.trim();
    const trigger = document.getElementById('flow-trigger').value.trim();
    if (!name || !trigger) return;
    await API('/api/flows', { method:'POST', body: JSON.stringify({ name, trigger }) });
    hideModal(); loadFlows();
  });
  document.getElementById('flow-create-cancel').addEventListener('click', hideModal);
});

document.getElementById('new-autoreply-btn').addEventListener('click', () => {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>New Auto-Reply Rule</h3>
    <div class="form-group"><label>Rule Name</label><input type="text" id="ar-name"></div>
    <div class="form-group"><label>Match Type</label><select id="ar-match"><option value="contains">Contains</option><option value="exact">Exact Match</option><option value="startsWith">Starts With</option><option value="regex">Regex</option></select></div>
    <div class="form-group"><label>Keywords (comma-separated)</label><input type="text" id="ar-keywords" placeholder="hello,hi,hey"></div>
    <div class="form-group"><label>Reply Message</label><textarea id="ar-reply" rows="3"></textarea></div>
    <div class="modal-actions"><button class="btn btn-primary" id="ar-save">Create</button><button class="btn btn-secondary" id="ar-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('ar-save').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('ar-name').value.trim(),
      matchType: document.getElementById('ar-match').value,
      keywords: document.getElementById('ar-keywords').value.split(',').map(k => k.trim()).filter(Boolean),
      reply: document.getElementById('ar-reply').value.trim(),
    };
    if (!body.name || !body.reply) return;
    await API('/api/auto-reply', { method:'POST', body: JSON.stringify(body) });
    hideModal(); loadAutoReply();
  });
  document.getElementById('ar-cancel').addEventListener('click', hideModal);
});

/* ---- GROUPS ---- */
async function loadGroups() {
  const data = await API('/api/groups');
  if (data.error) return;
  state.groups = data;
  document.getElementById('groups-count').textContent = `(${data.length})`;
  const grid = document.getElementById('groups-grid');
  if (!data.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#555">No groups</div>'; return; }
  grid.innerHTML = data.map(g => `
    <div class="group-card">
      <div class="group-name">${esc(g.name)}</div>
      <div class="group-meta">${g.participants || '?'} participants${g.description ? ' · ' + esc(g.description.slice(0,60)) : ''}</div>
      <div style="margin-top:8px;display:flex;gap:4px">
        <button class="btn btn-secondary btn-sm view-group" data-id="${esc(g.id)}">View</button>
        <button class="btn btn-secondary btn-sm msg-group" data-id="${esc(g.id)}">Message</button>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.view-group').forEach(el => el.addEventListener('click', () => showGroupDetail(el.dataset.id)));
  grid.querySelectorAll('.msg-group').forEach(el => el.addEventListener('click', () => {
    navigateToView('inbox');
    selectChat(el.dataset.id);
  }));
}

async function showGroupDetail(id) {
  const data = await API('/api/groups/' + encodeURIComponent(id));
  if (data.error) return;
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>${esc(data.name)}</h3>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">${data.description || 'No description'}</div>
    <div style="font-size:13px;margin-bottom:8px;font-weight:500">Participants (${data.participants?.length || 0})</div>
    <div style="max-height:300px;overflow-y:auto">
      ${(data.participants || []).map(p => `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">${esc(p.name || p.id)} ${p.isAdmin ? '👑' : ''}</div>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn btn-secondary" id="group-close">Close</button></div>
  `;
  showModal();
  document.getElementById('group-close').addEventListener('click', hideModal);
}

document.getElementById('new-group-btn').addEventListener('click', () => {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>Create Group</h3>
    <div class="form-group"><label>Group Name</label><input type="text" id="grp-name"></div>
    <div class="form-group"><label>Participants (comma-separated phone numbers)</label><textarea id="grp-participants" rows="3" placeholder="911234567890@c.us, 919876543210@c.us"></textarea></div>
    <div class="modal-actions"><button class="btn btn-primary" id="grp-save">Create</button><button class="btn btn-secondary" id="grp-cancel">Cancel</button></div>
  `;
  showModal();
  document.getElementById('grp-save').addEventListener('click', async () => {
    const name = document.getElementById('grp-name').value.trim();
    const parts = document.getElementById('grp-participants').value.split(',').map(p => p.trim()).filter(Boolean);
    if (!name) return;
    await API('/api/groups/create', { method:'POST', body: JSON.stringify({ name, participants: parts }) });
    hideModal(); loadGroups();
  });
  document.getElementById('grp-cancel').addEventListener('click', hideModal);
});

/* ---- ANALYTICS ---- */
async function loadAnalytics() {
  const data = await API('/api/analytics');
  if (data.error) return;
  const grid = document.getElementById('analytics-grid');
  const supabaseMsgs = data.supabaseMessages || 0;
  const pendingWaitlist = data.waitlistPending || 0;
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value">${data.chats || 0}</div><div class="stat-label">💬 Chats</div></div>
    <div class="stat-card"><div class="stat-value">${data.contacts || 0}</div><div class="stat-label">👤 Contacts</div></div>
    <div class="stat-card"><div class="stat-value">${data.groups || 0}</div><div class="stat-label">👥 Groups</div></div>
    <div class="stat-card"><div class="stat-value">${data.messages || 0}</div><div class="stat-label">📨 Total Messages</div></div>
    <div class="stat-card"><div class="stat-value">${data.unread || 0}</div><div class="stat-label">📩 Unread Chats</div></div>
    <div class="stat-card"><div class="stat-value">${data.msgsSentToday || 0}</div><div class="stat-label">📤 Sent Today</div></div>
    <div class="stat-card"><div class="stat-value ${(data.dailySendQuota?.remaining || 0) === 0 ? 'stat-warning' : ''}">${data.dailySendQuota?.used || 0} / ${data.dailySendQuota?.limit || 50}</div><div class="stat-label">📊 Daily Broadcast Quota</div></div>
    <div class="stat-card"><div class="stat-value">${data.campaigns?.dailyPaused || 0}</div><div class="stat-label">⏸️ Daily-Paused Campaigns</div></div>
    <div class="stat-card"><div class="stat-value">${data.scheduled?.active || 0}</div><div class="stat-label">⏰ Active Schedules</div></div>
    <div class="stat-card"><div class="stat-value">${data.scheduled?.completed || 0}</div><div class="stat-label">✅ Sched. Completed</div></div>
    <div class="stat-card"><div class="stat-value">${data.campaigns?.running || 0}</div><div class="stat-label">🚀 Campaigns Running</div></div>
    <div class="stat-card"><div class="stat-value">${data.campaigns?.completed || 0}</div><div class="stat-label">🏁 Campaigns Done</div></div>
    <div class="stat-card"><div class="stat-value">${data.templates || 0}</div><div class="stat-label">📝 Templates</div></div>
    <div class="stat-card"><div class="stat-value">${data.autoReplyRules || 0}</div><div class="stat-label">🤖 Auto-Reply Rules</div></div>
    <div class="stat-card"><div class="stat-value">${supabaseMsgs}</div><div class="stat-label">🗄️ Supabase Messages</div></div>
    <div class="stat-card"><div class="stat-value">${pendingWaitlist}</div><div class="stat-label">⏳ Pending Waitlist</div></div>
  `;
  const top = data.topChats || [];
  if (top.length) {
    const max = Math.max(...top.map(c => c.msgCount), 1);
    grid.innerHTML += `<div style="grid-column:1/-1"><h3 style="margin:16px 0 8px;font-size:15px">📊 Top Chats by Messages</h3>
      <div style="display:flex;flex-direction:column;gap:4px">${top.map(c => {
        const pct = (c.msgCount / max * 100).toFixed(0);
        return `<div style="display:flex;align-items:center;gap:8px;font-size:13px">
          <span style="min-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</span>
          <div style="flex:1;height:20px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:4px;display:flex;align-items:center;padding-left:6px;font-size:11px;color:#fff;min-width:30px">${c.msgCount}</div>
          </div>
        </div>`;
      }).join('')}</div></div>`;
  }
}

/* ---- SCHEDULE ---- */
let schTab = 'upcoming';

function schStatusIcon(status) {
  const icons = { active: '⏰', pending: '⏳', paused: '⏸', completed: '✅', failed: '❌' };
  return icons[status] || '⏳';
}

function schRecurrenceLabel(r) {
  if (!r || r.type === 'once') return '';
  const labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  return labels[r.type] || r.type;
}

async function loadScheduled() {
  const search = document.getElementById('sch-search').value;
  const url = '/api/scheduled?tab=' + schTab + (search ? '&search=' + encodeURIComponent(search) : '');
  const data = await API(url);
  if (data.error) return;
  const stats = data.stats || {};
  document.getElementById('sch-count').textContent = `(${stats.total || 0})`;

  const statsEl = document.getElementById('sch-stats');
  if (schTab === 'upcoming') {
    statsEl.innerHTML = `
      <div class="sch-stat total"><div class="sch-stat-val">${stats.total || 0}</div><div class="sch-stat-lbl">Total</div></div>
      <div class="sch-stat active"><div class="sch-stat-val">${stats.active || 0}</div><div class="sch-stat-lbl">Active</div></div>
      <div class="sch-stat paused"><div class="sch-stat-val">${stats.paused || 0}</div><div class="sch-stat-lbl">Paused</div></div>
      <div class="sch-stat completed"><div class="sch-stat-val">${stats.completed || 0}</div><div class="sch-stat-lbl">Completed</div></div>
      <div class="sch-stat failed"><div class="sch-stat-val">${stats.failed || 0}</div><div class="sch-stat-lbl">Failed</div></div>
      <div class="sch-stat total"><div class="sch-stat-val">${stats.sentToday || 0}</div><div class="sch-stat-lbl">Sent Today</div></div>`;
  } else {
    statsEl.innerHTML = `<div class="sch-stat total"><div class="sch-stat-val">${data.items?.length || 0}</div><div class="sch-stat-lbl">Executed</div></div>`;
  }

  const el = document.getElementById('scheduled-list');

  if (schTab === 'history') {
    const items = data.items || [];
    if (!items.length) {
      el.innerHTML = '<div class="schedule-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><div>No execution history yet</div></div>';
      return;
    }
    el.innerHTML = `<table class="sch-history-table"><thead><tr><th>Title</th><th>Targets</th><th>Sent</th><th>Failed</th><th>Preview</th><th>Executed</th></tr></thead><tbody>
      ${items.map(h => `<tr>
        <td class="sch-history-title">${esc(h.title || '—')}</td>
        <td>${h.targets || 0}</td>
        <td class="sch-history-success">${h.sent || 0}</td>
        <td class="sch-history-fail">${h.failed || 0}</td>
        <td style="color:var(--text-muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.text || '')}</td>
        <td style="color:var(--text-muted);font-size:12px">${new Date(h.executedAt).toLocaleString()}</td>
      </tr>`).join('')}
    </tbody></table>
    <div style="margin-top:12px;text-align:right"><button class="btn btn-danger btn-sm" id="sch-clear-history">Clear History</button></div>`;
    const clearBtn = document.getElementById('sch-clear-history');
    if (clearBtn) clearBtn.addEventListener('click', async () => { await API('/api/scheduled/history/clear', { method: 'DELETE' }); loadScheduled(); });
    return;
  }

  const items = data.items || [];
  if (!items.length) {
    el.innerHTML = '<div class="schedule-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><div>No schedules yet</div><button class="btn btn-primary" style="margin-top:12px" id="sch-empty-create">+ Create Schedule</button></div>';
    const cb = document.getElementById('sch-empty-create');
    if (cb) cb.addEventListener('click', openScheduleModal);
    return;
  }

  el.innerHTML = items.map(s => {
    const nextRun = new Date(s.nextRunAt || s.scheduleAt).getTime();
    const isLate = nextRun < Date.now() && (s.status === 'active' || s.status === 'pending');
    const targetLabel = s.sendToAll ? 'All Chats' : s.groupIds?.length ? s.groupIds.length + ' group(s)' : s.chatId || '—';
    return `<div class="schedule-card">
      <div class="schedule-icon ${s.status}">${schStatusIcon(s.status)}</div>
      <div class="schedule-body">
        <div class="schedule-title">${esc(s.title || 'Untitled')}</div>
        <div class="schedule-text">${s.media ? '📎 ' : ''}${esc(s.text || '(template)')}</div>
        <div class="schedule-meta">
          <span>🎯 ${esc(targetLabel)}</span>
          ${s.recurrence?.type && s.recurrence.type !== 'once' ? `<span class="tag">🔄 ${schRecurrenceLabel(s.recurrence)}</span>` : ''}
          <span class="tag">📅 ${new Date(s.nextRunAt || s.scheduleAt).toLocaleString()}${isLate ? ' (overdue)' : ''}</span>
          ${s.sentCount > 0 ? `<span class="tag">✅ ${s.sentCount} sent</span>` : ''}
          ${s.failCount > 0 ? `<span class="tag" style="color:var(--danger)">❌ ${s.failCount} failed</span>` : ''}
          <span class="schedule-badge ${s.status}">${s.status}</span>
        </div>
      </div>
      <div class="schedule-actions">
        ${s.status === 'paused' ? `<button class="btn btn-primary btn-sm sch-resume" data-id="${s.id}">Resume</button>`
        : s.status === 'active' || s.status === 'pending' ? `<button class="btn btn-secondary btn-sm sch-pause" data-id="${s.id}">Pause</button>` : ''}
        <button class="btn btn-secondary btn-sm sch-edit" data-id="${s.id}">Edit</button>
        <button class="btn btn-secondary btn-sm sch-duplicate" data-id="${s.id}">Copy</button>
        <button class="btn btn-danger btn-sm sch-delete" data-id="${s.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sch-pause').forEach(b => b.addEventListener('click', async () => { await API('/api/scheduled/' + b.dataset.id + '/pause', { method: 'POST' }); loadScheduled(); }));
  el.querySelectorAll('.sch-resume').forEach(b => b.addEventListener('click', async () => { await API('/api/scheduled/' + b.dataset.id + '/resume', { method: 'POST' }); loadScheduled(); }));
  el.querySelectorAll('.sch-delete').forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this schedule?')) { await API('/api/scheduled/' + b.dataset.id, { method: 'DELETE' }); loadScheduled(); } }));
  el.querySelectorAll('.sch-duplicate').forEach(b => b.addEventListener('click', async () => { await API('/api/scheduled/' + b.dataset.id + '/duplicate', { method: 'POST' }); loadScheduled(); }));
  el.querySelectorAll('.sch-edit').forEach(b => b.addEventListener('click', async () => {
    const all = await API('/api/scheduled?tab=upcoming');
    const item = all.items?.find(i => i.id === b.dataset.id);
    if (item) openScheduleModal(item);
  }));
}

async function openScheduleModal(editItem) {
  const modal = document.getElementById('modal-content');
  const isEdit = !!editItem;
  const r = editItem?.recurrence || {};
  modal.innerHTML = `
    <h3>${isEdit ? 'Edit Schedule' : 'New Schedule'}</h3>
    <div class="form-group"><label>Title</label><input type="text" id="sch-title" placeholder="e.g. Weekly Promo" value="${esc(editItem?.title || '')}"></div>
    <div class="form-group">
      <label>Send To</label>
      <select id="sch-target-type"><option value="chat" ${!editItem?.sendToAll && !editItem?.groupIds?.length ? 'selected' : ''}>Single Contact</option><option value="groups" ${editItem?.groupIds?.length ? 'selected' : ''}>Group(s)</option><option value="all" ${editItem?.sendToAll ? 'selected' : ''}>All Contacts</option></select>
    </div>
    <div class="form-group" id="sch-chat-group"><label>Chat ID</label><input type="text" id="sch-chat" placeholder="911234567890@c.us" value="${esc(editItem?.chatId || '')}"></div>
    <div class="form-group hidden" id="sch-groups-group"><label>Group IDs (comma separated)</label><input type="text" id="sch-groups" placeholder="123@g.us,456@g.us" value="${esc(editItem?.groupIds?.join(', ') || '')}"></div>
    <div class="form-group">
      <label>Message <span style="color:var(--text-muted);font-weight:400">or use a template</span></label>
      <textarea id="sch-msg" rows="3" placeholder="Type your message...">${esc(editItem?.text || '')}</textarea>
    </div>
    <div class="form-group"><label>Use Template</label><select id="sch-template"><option value="">— No template —</option></select></div>
    <div class="form-group" id="sch-template-vars-group" style="display:none"><label>Template Variables</label><div id="sch-template-vars"></div></div>
    <div class="form-group"><label>Media Attachment</label><input type="file" id="sch-media" accept="image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx,.ppt,.pptx,.zip,.rar" hidden><button type="button" class="btn btn-secondary btn-sm" id="sch-media-btn">📎 Attach File</button><div id="sch-media-preview" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div></div>
    <div class="form-group">
      <label>Schedule Date & Time</label>
      <input type="datetime-local" id="sch-time" value="${editItem?.scheduleAt ? new Date(editItem.scheduleAt).toISOString().slice(0, 16) : ''}">
    </div>
    <div class="form-group">
      <label>Repeat</label>
      <select id="sch-recurrence"><option value="once">— Once —</option><option value="daily" ${r.type === 'daily' ? 'selected' : ''}>Daily</option><option value="weekly" ${r.type === 'weekly' ? 'selected' : ''}>Weekly</option><option value="monthly" ${r.type === 'monthly' ? 'selected' : ''}>Monthly</option></select>
    </div>
    <div class="form-group hidden" id="sch-recur-interval-group"><label>Repeat Every (days)</label><input type="number" id="sch-recur-interval" value="${r.interval || 1}" min="1"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="sch-save">${isEdit ? 'Update' : 'Schedule'}</button><button class="btn btn-secondary" id="sch-cancel">Cancel</button></div>
  `;
  showModal();

  const targetType = document.getElementById('sch-target-type');
  function updateTargetFields() {
    document.getElementById('sch-chat-group').classList.toggle('hidden', targetType.value !== 'chat');
    document.getElementById('sch-groups-group').classList.toggle('hidden', targetType.value !== 'groups');
  }
  targetType.addEventListener('change', updateTargetFields);
  updateTargetFields();

  const recSel = document.getElementById('sch-recurrence');
  recSel.addEventListener('change', () => {
    document.getElementById('sch-recur-interval-group').classList.toggle('hidden', recSel.value === 'once');
  });
  document.getElementById('sch-recur-interval-group').classList.toggle('hidden', recSel.value === 'once');

  const tplSel = document.getElementById('sch-template');
  const templates = await API('/api/templates');
  (templates || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name || t.id;
    if (editItem?.templateId === t.id) opt.selected = true;
    tplSel.appendChild(opt);
  });

  const varsGroup = document.getElementById('sch-template-vars-group');
  const varsContainer = document.getElementById('sch-template-vars');
  tplSel.addEventListener('change', async () => {
    const tid = tplSel.value;
    if (tid) {
      const tpl = (templates || []).find(t => t.id === tid);
      if (tpl && tpl.variables?.length) {
        varsGroup.style.display = 'block';
        varsContainer.innerHTML = tpl.variables.map(v => `<div style="margin-bottom:6px"><label style="font-size:11px;color:var(--text-muted)">{{${v}}}</label><input type="text" class="sch-tpl-var" data-var="${v}" placeholder="${v}" value="${esc(editItem?.templateVars?.[v] || '')}" style="width:100%;background:var(--bg-input);border:1px solid var(--border-light);padding:6px 10px;border-radius:var(--radius-sm);color:var(--text-primary);outline:none"></div>`).join('');
      } else {
        varsGroup.style.display = 'none';
      }
    } else {
      varsGroup.style.display = 'none';
    }
  });
  tplSel.dispatchEvent(new Event('change'));

  document.getElementById('sch-save').addEventListener('click', async () => {
    const body = { title: document.getElementById('sch-title').value.trim() || 'Untitled' };
    const target = document.getElementById('sch-target-type').value;
    if (target === 'chat') body.chatId = document.getElementById('sch-chat').value.trim();
    else if (target === 'groups') body.groupIds = document.getElementById('sch-groups').value.split(',').map(s => s.trim()).filter(Boolean);
    else if (target === 'all') body.sendToAll = true;
    body.text = document.getElementById('sch-msg').value.trim();
      if (schMediaData) {
        const f = document.getElementById('sch-media').files[0];
        const mime = schMediaData.split(';')[0].split(':')[1] || 'image/png';
        const ext = f ? '.' + f.name.split('.').pop() : '.bin';
        body.media = { type: mime.startsWith('image') ? 'image' : 'file', data: schMediaData.split(',')[1], filename: (f?.name || 'attachment') + ext };
      }
    const tplId = document.getElementById('sch-template').value;
    if (tplId) { body.templateId = tplId; body.templateVars = {}; document.querySelectorAll('.sch-tpl-var').forEach(el => { body.templateVars[el.dataset.var] = el.value; }); }
    const dt = document.getElementById('sch-time').value;
    if (!dt) return;
    body.scheduleAt = new Date(dt).toISOString();
    const rec = document.getElementById('sch-recurrence').value;
    if (rec !== 'once') body.recurrence = { type: rec, interval: parseInt(document.getElementById('sch-recur-interval').value, 10) || 1 };
    const url = isEdit ? '/api/scheduled/' + editItem.id : '/api/scheduled';
    const method = isEdit ? 'PUT' : 'POST';
    await API(url, { method, body: JSON.stringify(body) });
    hideModal(); loadScheduled();
  });
  let schMediaData = null;
  document.getElementById('sch-media-btn').addEventListener('click', () => document.getElementById('sch-media').click());
  document.getElementById('sch-media').addEventListener('change', function() {
    const f = this.files[0];
    if (!f) return;
    schMediaData = null;
    const reader = new FileReader();
    reader.onload = () => { schMediaData = reader.result; document.getElementById('sch-media-preview').textContent = '📎 ' + f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)'; };
    reader.readAsDataURL(f);
  });
  document.getElementById('sch-cancel').addEventListener('click', hideModal);
}

document.getElementById('new-schedule-btn').addEventListener('click', () => openScheduleModal(null));
document.getElementById('sch-search').addEventListener('input', () => loadScheduled());
document.querySelectorAll('.sch-tab').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.sch-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    schTab = el.dataset.tab;
    loadScheduled();
  });
});

/* ---- MODAL ---- */
function showModal() { document.getElementById('modal-overlay').classList.remove('hidden'); }
function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) hideModal(); });

/* ---- BROADCAST ---- */
async function openBroadcastModal() {
  const modal = document.getElementById('modal-content');
  modal.innerHTML = `
    <h3>📡 Broadcast Message</h3>
    <div class="form-group"><label>Message</label><textarea id="bc-msg" rows="4" placeholder="Type your message..."></textarea></div>
    <div class="form-group"><label>Attachment (optional)</label>
      <div class="bc-row">
        <button class="btn btn-secondary btn-sm" id="bc-attach-btn" type="button">📎 Attach file</button>
        <input type="file" id="bc-file" hidden>
        <span class="bc-file-name" id="bc-file-name"></span>
      </div>
    </div>
    <div class="form-group"><label>Recipients</label>
      <div class="bc-tabs">
        <button type="button" class="bc-tab active" data-bc-tab="chats">Chats</button>
        <button type="button" class="bc-tab" data-bc-tab="contacts">All Contacts</button>
      </div>
      <div class="bc-options">
        <label class="bc-option"><input type="checkbox" id="bc-all"> <span>All chats</span></label>
        <span class="bc-divider">or select individually:</span>
      </div>
      <div class="bc-search-row"><input type="text" id="bc-search" placeholder="Search recipients..."></div>
      <div class="bc-chat-list" id="bc-chat-list">
        <div style="text-align:center;color:#555;padding:16px">Loading chats...</div>
      </div>
    </div>
    <div class="bc-status" id="bc-status"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="bc-send" disabled>Send Broadcast</button><button class="btn btn-secondary" id="bc-cancel">Cancel</button></div>
  `;
  showModal();
  const [chats, contactsRes] = await Promise.all([API('/api/chats'), API('/api/contacts?pageSize=500')]);
  const contacts = contactsRes.error ? [] : (contactsRes.contacts || []);
  const listEl = document.getElementById('bc-chat-list');
  const selectedIds = new Set();
  let bcMedia = null;
  let bcTab = 'chats';
  let bcSearch = '';

  document.getElementById('bc-attach-btn').addEventListener('click', () => document.getElementById('bc-file').click());
  document.getElementById('bc-file').addEventListener('change', function() {
    const f = this.files[0];
    if (!f) { bcMedia = null; document.getElementById('bc-file-name').textContent = ''; updateState(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      bcMedia = { data: reader.result, mimetype: f.type || 'application/octet-stream', filename: f.name };
      document.getElementById('bc-file-name').textContent = `📎 ${f.name} (${(f.size/1024).toFixed(1)} KB)`;
      updateState();
    };
    reader.readAsDataURL(f);
    this.value = '';
  });

  const selAll = document.createElement('button');
  selAll.type = 'button';
  selAll.className = 'bc-select-all';
  selAll.textContent = 'Select all';
  listEl.insertAdjacentElement('beforebegin', selAll);

  const updateState = () => {
    const msg = document.getElementById('bc-msg').value.trim();
    const all = document.getElementById('bc-all').checked;
    const count = selectedIds.size;
    const hasMedia = Boolean(bcMedia);
    document.getElementById('bc-send').disabled = (!msg && !hasMedia) || (!all && count === 0);
    const status = document.getElementById('bc-status');
    if (all) status.textContent = count ? `Will send to all chats (plus ${count} selected)` : 'Will send to all chats';
    else status.textContent = count ? `${count} selected` : 'Select recipients';
  };

  function visibleItems() {
    const q = bcSearch.trim().toLowerCase();
    if (bcTab === 'contacts') {
      return contacts.filter(c => !q || (c.name || c.id || c.number).toLowerCase().includes(q));
    }
    return (chats.error || !chats.length) ? [] : chats.filter(c => !q || (c.name || c.id).toLowerCase().includes(q));
  }
  function itemId(c) {
    return bcTab === 'contacts' ? (c.id || c.number + '@c.us') : c.id;
  }
  function syncSelectAllLabel() {
    const allChecked = document.getElementById('bc-all').checked;
    if (allChecked || !visibleItems().length) { selAll.style.display = 'none'; return; }
    selAll.style.display = '';
    const items = visibleItems();
    const allSel = items.every(c => selectedIds.has(itemId(c)));
    selAll.textContent = allSel ? 'Deselect all' : 'Select all';
  }
  function renderTab() {
    listEl.scrollTop = 0;
    const items = visibleItems();
    const allChecked = document.getElementById('bc-all').checked;
    if (!items.length) {
      listEl.innerHTML = '<div style="text-align:center;color:#555;padding:16px">No ' + (bcTab === 'contacts' ? 'contacts' : 'chats') + (bcSearch.trim() ? ' matching' : ' available') + '</div>';
    } else {
      listEl.innerHTML = items.map(c => {
        const id = itemId(c);
        const isSel = selectedIds.has(id);
        const disabled = allChecked ? ' disabled' : '';
        return `<label class="bc-chat-option${disabled}">
          <input type="checkbox" class="bc-chat-cb" value="${esc(id)}"${disabled ? ' disabled' : ''}${isSel ? ' checked' : ''}>
          <span class="bc-chat-name">${esc(c.name || c.number || c.id)}</span>
          <span class="bc-chat-icon">${bcTab === 'contacts' ? '👤' : (c.isGroup ? '👥' : '👤')}</span>
        </label>`;
      }).join('');
    }
    syncSelectAllLabel();
    updateState();
  }
  renderTab();

  document.querySelectorAll('.bc-tab').forEach(t => t.addEventListener('click', () => {
    bcTab = t.dataset.bcTab;
    document.querySelectorAll('.bc-tab').forEach(x => x.classList.toggle('active', x === t));
    renderTab();
  }));

  let bcSearchTimer;
  document.getElementById('bc-search').addEventListener('input', function() {
    clearTimeout(bcSearchTimer);
    const v = this.value;
    bcSearchTimer = setTimeout(() => { bcSearch = v; renderTab(); }, 150);
  });

  document.getElementById('bc-msg').addEventListener('input', updateState);
  document.getElementById('bc-all').addEventListener('change', e => {
    if (e.target.checked) {
      selectedIds.clear();
      document.querySelectorAll('.bc-chat-cb').forEach(cb => cb.checked = false);
    }
    renderTab();
  });
  selAll.addEventListener('click', () => {
    const items = visibleItems();
    if (!items.length) return;
    const allSel = items.every(c => selectedIds.has(itemId(c)));
    items.forEach(c => {
      const id = itemId(c);
      if (allSel) selectedIds.delete(id); else selectedIds.add(id);
    });
    renderTab();
  });
  listEl.addEventListener('change', e => {
    if (e.target.classList.contains('bc-chat-cb')) {
      if (e.target.checked) selectedIds.add(e.target.value);
      else selectedIds.delete(e.target.value);
      syncSelectAllLabel();
      updateState();
    }
  });
  document.getElementById('bc-cancel').addEventListener('click', hideModal);
  document.getElementById('bc-send').addEventListener('click', async () => {
    const msg = document.getElementById('bc-msg').value.trim();
    const all = document.getElementById('bc-all').checked;
    let chatIds;
    if (all) {
      chatIds = (chats.error || !chats.length) ? [] : chats.map(c => c.id).filter(Boolean);
      selectedIds.forEach(id => { if (!chatIds.includes(id)) chatIds.push(id); });
    } else {
      chatIds = [...selectedIds];
    }
    if ((!msg && !bcMedia) || !chatIds.length) return;
    const btn = document.getElementById('bc-send');
    const status = document.getElementById('bc-status');
    btn.disabled = true; btn.textContent = 'Sending...';
    status.textContent = `Preparing to send to ${chatIds.length} recipient(s)...`;
    const payload = { chatIds, message: msg };
    if (bcMedia) { payload.mimetype = bcMedia.mimetype; payload.data = bcMedia.data; payload.filename = bcMedia.filename; }
    try {
      const resp = await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Send failed' }));
        throw new Error(err.error || 'Send failed');
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let doneData = null;
      let progress = { done: 0, total: chatIds.length };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'progress') {
              progress = ev;
              status.textContent = `Sending... ${ev.done}/${ev.total} done`;
            } else if (ev.type === 'done') {
              doneData = ev;
            }
          } catch { /* skip malformed */ }
        }
      }
      if (doneData) {
        const ok = doneData.results?.filter(r => r.success).length || 0;
        const fail = doneData.failed || 0;
        status.textContent = `✅ Sent to ${ok}${fail ? `, ${fail} failed` : ''}`;
        btn.textContent = 'Done';
        setTimeout(hideModal, 1500);
      } else {
        status.textContent = 'Broadcast finished (no summary received)';
        btn.textContent = 'Done';
        setTimeout(hideModal, 1500);
      }
    } catch (e) {
      status.textContent = e.message;
      btn.textContent = 'Send Broadcast';
      btn.disabled = false;
    }
  });
}

document.getElementById('broadcast-btn').addEventListener('click', openBroadcastModal);

/* ---- POLL ---- */
async function poll() {
  try {
    const [status, chats] = await Promise.all([API('/api/status'), API('/api/chats')]);
    if (status.error === 'invalid or expired session' || status.error === 'authentication required') {
      handleSessionExpired();
      return;
    }
    const badge = document.getElementById('status-badge');
    const logoutBtn = document.getElementById('logout-btn');
    const qrPanel = document.getElementById('qr-panel');
    const qrImg = document.getElementById('qr-img');
    const isConnected = status.connected || status.status === 'ready' || status.status === 'authenticated';
    if (isConnected) {
      badge.className = 'status-dot connected';
      badge.textContent = status.host || status.phone || 'Connected';
      if (logoutBtn) logoutBtn.style.display = 'inline-flex';
      if (qrPanel) qrPanel.classList.add('hidden');
    } else {
      badge.className = 'status-dot disconnected';
      badge.textContent = 'Disconnected';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (qrPanel && status.qr && qrImg) {
        qrImg.src = status.qr.startsWith('data:') ? status.qr : 'data:image/png;base64,' + status.qr;
        qrPanel.classList.remove('hidden');
      } else if (qrPanel) {
        qrPanel.classList.add('hidden');
      }
    }
    if (chats.length && state.activeView === 'inbox') {
      const prevSig = chatListSignature;
      state.chats = chats;
      renderChats(chatListFilter());
      if (state.activeChat && chatListSignature !== prevSig) {
        loadMessages(state.activeChat);
      }
    }
    if (state.activeView === 'analytics') loadAnalytics();
  } catch (e) {
    console.error('[Poll] Error:', e);
  }
}

function handleSessionExpired() {
  localStorage.removeItem('wa_bot_token');
  state.token = null;
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('main').style.display = 'none';
  }
}

/* ---- UTIL ---- */
function navigateToView(view) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  state.activeView = view;
}

/* ---- INIT ---- */
poll();
setInterval(poll, 5000);
