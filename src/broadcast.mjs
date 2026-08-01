import 'dotenv/config';
import { create } from '@open-wa/wa-automate';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTS_FILE = path.join(__dirname, '..', 'data', 'contacts.json');

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

async function broadcast() {
  const [, , ...args] = process.argv;

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node src/broadcast.mjs send <message>     — Send to all contacts');
    console.log('  node src/broadcast.mjs add <number@c.us>  — Add a contact');
    console.log('  node src/broadcast.mjs list               — List contacts');
    process.exit(0);
  }

  const command = args[0];

  if (command === 'add') {
    const contact = args[1];
    if (!contact) { console.error('Usage: node src/broadcast.mjs add <number@c.us>'); process.exit(1); }
    const contacts = loadContacts();
    if (contacts.includes(contact)) {
      console.log(`${contact} already exists`);
    } else {
      contacts.push(contact);
      saveContacts(contacts);
      console.log(`Added ${contact}`);
    }
    process.exit(0);
  }

  if (command === 'list') {
    const contacts = loadContacts();
    console.log('Contacts:', contacts.length ? contacts.join('\n') : '(none)');
    process.exit(0);
  }

  if (command === 'send') {
    const message = args.slice(1).join(' ');
    if (!message) { console.error('Usage: node src/broadcast.mjs send <message>'); process.exit(1); }

    const contacts = loadContacts();
    if (contacts.length === 0) {
      console.error('No contacts. Add some with: node src/broadcast.mjs add <number@c.us>');
      process.exit(1);
    }

    console.log(`Broadcasting to ${contacts.length} contact(s)...`);

    const client = await create({
      sessionId: process.env.WA_SESSION_ID ?? 'main',
      headless: true,
      qrTimeout: 0,
      authTimeout: 120,
      userDataDir: process.env.WA_USER_DATA_DIR ?? './session-data',
    });

    let sent = 0;
    let failed = 0;

    for (const contact of contacts) {
      try {
        await client.sendText(contact, message);
        console.log(`  ✓ ${contact}`);
        sent++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`  ✗ ${contact}: ${err.message}`);
        failed++;
      }
    }

    console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
    await client.stop();
    process.exit(0);
  }
}

broadcast().catch(console.error);