import 'dotenv/config';
import express from 'express';

const app = express();
const PORT = process.env.WEBHOOK_RECEIVER_PORT ?? 3002;

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

function getMessageFields(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload.message;
  if (!msg || typeof msg !== 'object') return null;
  return {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    body: msg.body || msg.caption || '',
    type: msg.type,
    timestamp: msg.timestamp,
    isGroupMsg: msg.isGroupMsg,
    isMedia: msg.isMedia,
  };
}

app.post('/webhooks/open-wa', (req, res) => {
  const secret = req.header('X-Webhook-Secret');
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { webhookId, sessionId, event, payload, timestamp } = req.body;

  console.log(`[webhook] ${event} (session: ${sessionId}, id: ${webhookId})`);

  if (event === 'message.received' || event === 'message.any') {
    const msg = getMessageFields(payload);
    if (msg) {
      console.log(`  from: ${msg.from}`);
      console.log(`  text: ${msg.body}`);
      console.log(`  type: ${msg.type}`);
    }
  }

  if (event === 'session.state.changed') {
    const details = payload?.details;
    if (details) {
      console.log(`  state: ${details.prev} -> ${details.next}`);
    }
  }

  res.sendStatus(204);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', webhookReceiver: true });
});

app.get('/webhooks/log', (_req, res) => {
  res.json({ message: 'Webhook receiver running. Check server logs for events.' });
});

app.listen(PORT, () => {
  console.log(`Webhook receiver listening on http://localhost:${PORT}`);
  console.log(`Configure WA_WEBHOOK_URL=http://localhost:${PORT}/webhooks/open-wa`);
});