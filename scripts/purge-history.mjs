import { purgeOldHistory } from '../jobs/purge.mjs';

console.log('[purge] Running manual history purge...');
await purgeOldHistory();
console.log('[purge] Manual history purge complete.');