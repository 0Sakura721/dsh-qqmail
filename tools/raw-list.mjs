/**
 * tools/raw-list.mjs
 * 直接看 ListMessages 的真实返回结构，确认是"真的没邮件"还是"字段名不同"。
 */
import { TokenManager } from '../lib/auth.js';
import { QqMailClient } from '../lib/mcp.js';

const tokens = new TokenManager({ workbuddyAutoImport: true });
const client = new QqMailClient({
  endpoint: 'https://api.mail.qq.com/mcp',
  getToken: () => tokens.getAccessToken(),
  onUnauthorized: () => tokens.refresh(),
});
await client.initialize();

const me = await client.callTool('GetMe', {});
const aliasId = me.data.data.data.aliases.find((a) => a.is_primary)?.alias_id;
console.log('alias_id', aliasId);

for (const args of [
  { alias_id: aliasId, limit: 5 },
  { alias_id: aliasId, limit: 5, dir: 'inbox' },
  { alias_id: aliasId, limit: 5, dir: 'sent' },
]) {
  console.log('\n--- args', JSON.stringify(args));
  const r = await client.callTool('ListMessages', args);
  console.log(JSON.stringify(r.data).slice(0, 900));
}
