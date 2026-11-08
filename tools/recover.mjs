/**
 * tools/recover.mjs
 *
 * 断链急救：传入任意含 refresh_token 的 JSON，续期一次并把结果同时写回
 *   1. ~/.dsh/qqmail/credentials.json（插件自有）
 *   2. WorkBuddy 的 .credentials.v3.json（重新封装，保持连接器可用）
 *
 * QQ 邮箱的 refresh token 是一次性轮换的，所以这一步必须"续期即落盘"，
 * 中间任何一次丢失都会让那条链失效。
 *
 * 用法：
 *   node tools/recover.mjs <含 refresh_token 的 json 路径>
 *
 * 从哪找那条 JSON：
 *   - WorkBuddy 的 .credentials.v3.json 里令牌是密文，不能直接用；
 *     先用插件自己的 ~/.dsh/qqmail/credentials.json（一次续期后就是明文）
 *   - 或任何你手工保存下来的 token 响应体
 */
import fs from 'node:fs';
import path from 'node:path';
import { listWorkBuddyStores } from '../lib/workbuddy.js';
import { resealStore } from '../lib/seal.js';
import { writeJson } from '../lib/paths.js';
import { DEFAULT_CLIENT_ID } from '../lib/auth.js';

const LATEST = process.argv[2];
if (!LATEST) {
  console.error('用法：node tools/recover.mjs <含 refresh_token 的 json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
const refreshToken = raw.refresh_token || raw.refreshToken;
if (!refreshToken) throw new Error('no refresh token in ' + LATEST);
const clientId = raw.clientId || raw.client_id || DEFAULT_CLIENT_ID;
console.log('refresh token 指纹:', refreshToken.slice(0, 8) + '…', 'len', refreshToken.length);

const response = await fetch('https://wx.mail.qq.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }),
});
const text = await response.text();
if (!response.ok || !text) {
  console.error('refresh failed', response.status, JSON.stringify(text.slice(0, 200), mapLogicRet(response)));
  process.exit(1);
}
const payload = JSON.parse(text);
const expiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
console.log('新令牌已签发，到期', new Date(expiresAt).toISOString());

function mapLogicRet(res) {
  const logicRet = res.headers.get('logicret');
  return logicRet ? { logicRet } : null;
}

// 1) 插件自有凭据
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');
const own = {
  ...raw,
  tokenType: payload.token_type || raw.tokenType || 'Bearer',
  scope: payload.scope || raw.scope || '',
  expiresAt,
  accessToken: payload.access_token,
  refreshToken: payload.refresh_token,
  refreshedAt: new Date().toISOString(),
};
writeJson(path.join(dshHome, 'qqmail', 'credentials.json'), own);
console.log('已写入 ~/.dsh/qqmail/credentials.json');

// 2) 回封到 WorkBuddy，两边共享同一条活令牌
let resealed = 0;
for (const store of listWorkBuddyStores()) {
  for (const serverKey of Object.keys(store.cred.mcpOAuth || {})) {
    if (!/api\.mail\.qq\.com/.test(store.cred.mcpOAuth[serverKey]?.serverUrl || '')) continue;
    const result = resealStore(store, serverKey, {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt,
      scope: payload.scope,
      tokenType: payload.token_type,
    });
    if (result.ok) {
      writeJson(path.join(store.dir, '.credentials.v3.json'), result.cred, 0o600);
      resealed += 1;
      console.log('已回封到', path.join(store.dir, '.credentials.v3.json'));
    } else {
      console.error('reseal failed', serverKey, result.reason);
    }
  }
}
console.log('回封数量:', resealed);

// 3) 立刻验证新 access token 能调通
const verify = await fetch('https://api.mail.qq.com/mcp', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${payload.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'GetMe', arguments: {} },
  }),
});
const verifyText = await verify.text();
let ok = false;
try {
  ok = JSON.parse(verifyText)?.result?.content?.[0]?.text !== undefined;
} catch {
  ok = false;
}
console.log('GetMe 验证:', ok ? '通过' : '失败', '（HTTP', verify.status + '）');
if (!ok) process.exit(1);
