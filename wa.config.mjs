import { createPlugin, defineConfig } from '@open-wa/plugin-sdk';

export default defineConfig({
  sessionId: process.env.WA_SESSION_ID ?? 'main',
  port: Number(process.env.WA_PORT ?? 8080),
  apiKey: process.env.WA_API_KEY,
  licenseKey: process.env.WA_LICENSE_KEY,
  linkCode: process.env.WA_LINK_CODE,
  userDataDir: process.env.WA_USER_DATA_DIR ?? './session-data',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  customUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Safari/537.36',
  headless: true,
  qrTimeout: 0,
  authTimeout: 120,
  chromiumArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-default-apps',
    '--ignore-certificate-errors',
  ],

  plugins: [
    '@open-wa/integration-webhook',
    new URL('./plugins/greeting-bot.mjs', import.meta.url).href,
    new URL('./plugins/moderation.mjs', import.meta.url).href,
  ],

  pluginConfig: {
    webhook: {
      url: process.env.WA_WEBHOOK_URL,
      events: ['message.received', 'message.sent', 'session.state.changed'],
      headers: {
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET,
      },
    },
    'greeting-bot': {
      greeting: process.env.GREETING_MESSAGE ?? 'Welcome! How can I help?',
      triggerWord: 'Hi',
    },
    moderation: {
      enabled: true,
      blockedWords: ['spam', 'scam'],
      maxMessageLength: 5000,
    },
  },

  mcp: {
    enabled: true,
    path: '/mcp',
    exposeToolsMeta: true,
  },
});