import { diagnose } from '../index.js';
const r = await diagnose();
console.log('credentials:', JSON.stringify(r.credentials, null, 1));
console.log('server:', JSON.stringify(r.server));
console.log('tools:', r.tools.length, r.tools.join(','));
console.log('primary:', JSON.stringify(r.primary));
console.log('aliases:', JSON.stringify(r.aliases));
