import { createPlugin, defineConfig } from '@open-wa/plugin-sdk';

function getTextMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const candidate = message;
  if (typeof candidate.body !== 'string' || typeof candidate.from !== 'string') return null;
  return { body: candidate.body, from: candidate.from };
}

export default createPlugin({
  meta: {
    name: 'moderation',
    version: '1.0.0',
    description: 'Filter and moderate incoming messages',
  },

  init: async ({ client, logger, config }) => ({
    'message.received': async ({ message }) => {
      if (!config.enabled) return;

      const msg = getTextMessage(message);
      if (!msg) return;

      if (msg.body.length > config.maxMessageLength) {
        await client.sendText(msg.from, 'Message is too long. Please keep it under 5000 characters.');
        logger.warn('Blocked long message', { from: msg.from, length: msg.body.length });
        return;
      }

      for (const word of config.blockedWords) {
        if (msg.body.toLowerCase().includes(word)) {
          logger.warn('Blocked message with prohibited word', { from: msg.from, word });
          return;
        }
      }
    },
  }),
});