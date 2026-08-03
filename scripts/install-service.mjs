import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Load environment variables from .env if available
dotenv.config({ path: path.join(rootDir, '.env') });

const svc = new Service({
  name: 'SaheliDressesWABot',
  description: 'Saheli Dresses WhatsApp automation bot (dashboard + API).',
  script: path.join(rootDir, 'src', 'main.mjs'),
  nodeOptions: [],
  workingDirectory: rootDir,
  env: [
    { name: 'NODE_ENV', value: process.env.NODE_ENV || 'production' },
    { name: 'PORT', value: process.env.PORT || '8080' },
    { name: 'WA_PORT', value: process.env.WA_PORT || '8080' },
    { name: 'WA_USER_DATA_DIR', value: process.env.WA_USER_DATA_DIR || path.join(rootDir, 'session-data') },
    { name: 'PUPPETEER_EXECUTABLE_PATH', value: process.env.PUPPETEER_EXECUTABLE_PATH || '' },
  ],
  maxRetries: 10,       // restart attempts if it crashes
  wait: 5,              // seconds between retries
  grow: 0.25            // backoff growth factor between retries
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => console.log('Service already installed.'));
svc.on('start', () => console.log('Service started — bot is now running in the background.'));
svc.on('error', (err) => console.error('Service error:', err));

svc.install();
