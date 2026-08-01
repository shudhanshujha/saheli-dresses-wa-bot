import { createPlugin } from '@open-wa/plugin-sdk';

function getTextMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const candidate = message;
  if (typeof candidate.body !== 'string' || typeof candidate.from !== 'string') return null;
  return { body: candidate.body, from: candidate.from };
}

export default createPlugin({
  meta: {
    name: 'greeting-bot',
    version: '1.0.0',
    description: 'Greets contacts with a customizable welcome message',
  },

  init: async ({ client, logger, config }) => ({
    'message.received': async ({ message }) => {
      const msg = getTextMessage(message);
      if (!msg) return;

      if (msg.body.toLowerCase() === config.triggerWord.toLowerCase()) {
        await client.sendText(msg.from, config.greeting);
        logger.info('Sent greeting', { from: msg.from });
      }
    },
  }),
});