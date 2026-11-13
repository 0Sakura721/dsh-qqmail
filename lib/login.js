/**
 * dsh-qqmail / lib/login.js
 *
 * 扫码授权：一条二维码，一次扫码，扫完即完成。
 *
 * ## 走的是哪条路（这条是实测走通的）
 *
 * 标准 OAuth 2.0 授权码 + PKCE，配 loopback 回调：
 *
 *   1. 本地起一个只监听 127.0.0.1 的临时 HTTP 服务（随机端口）
 *   2. 生成 code_verifier / code_challenge(S256) 与随机 state
 *   3. 拼 https://wx.mail.qq.com/oauth/authorize?...
 *   4. 把这条 URL 渲染成二维码给用户扫
 *   5. 用户在手机 QQ 里确认授权后，服务端回跳 127.0.0.1:PORT/callback?code=..&state=..
 *   6. 用 code + code_verifier 换 access_token / refresh_token
 *   7. 落盘到 ~/.dsh/qqmail/credentials.json
 *
 * ## 走过的两条弯路（都实测过，别再绕回去）
 *
 * **弯路一：`/login/scan_login` 的 agent 扫码通道。**
 * 带 `scan_type=1&from=agent&oauth_info=<json>` 调它，确实能拿到扫码链接，
 * 但那链接跳到 `app_scan_login.html` —— 手机上的表现是"登录成功"，**没有授权确认步骤**。
 * 也就是说它只完成登录，不完成授权；随后再调 `/oauth/auth` 会回 `ret=9`
 * （服务端把它当成一个未授权的登录态，回跳 `common_login.html?err_type=9`）。
 *
 * **弯路二：以为授权页要求"先登录"，所以需要二次扫码。**
 * 实际上 `oauth.html` 在手机 QQ 内置浏览器里能直接进确认页；`step=qrcode`
 * 只影响桌面浏览器（没有登录态时才要扫码）。用手机扫同一条 URL 不会出现第二个码。
 * 我一开始看到桌面抓取的结果是"扫码页"，就误判成"必须扫两次"。
 *
 * 结论：直接把 `/oauth/authorize` 的 URL 做成二维码即可。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { CREDENTIALS_PATH, writeJson, log } from './paths.js';
import { DEFAULT_CLIENT_ID } from './auth.js';

const AUTHORIZE_ENDPOINT = 'https://wx.mail.qq.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://wx.mail.qq.com/oauth/token';
const DEFAULT_SCOPES = 'alias:read mail:read mail:send mail:delete';
const CALLBACK_PATH = '/callback';

function createVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function createChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * 拼授权 URL。
 * @param {object} options
 * @param {number} options.port loopback 端口
 * @param {string} options.state
 * @param {string} options.challenge
 * @param {string} [options.clientId]
 * @param {string} [options.scopes]
 */
export function buildAuthorizeUrl({
  port,
  state,
  challenge,
  clientId = DEFAULT_CLIENT_ID,
  scopes = DEFAULT_SCOPES,
}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** 找一个空闲端口，只绑 127.0.0.1。 */
function listenOnLoopback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** 手机上看到的极简结果页。 */
function resultPage(title, detail, ok = true) {
  const color = ok ? '#1a7f37' : '#b42318';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:flex;
       min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328}
  .card{background:#fff;border-radius:12px;padding:32px 28px;max-width:420px;margin:16px;
        box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
  h1{font-size:19px;margin:0 0 12px;color:${color}}
  p{font-size:14px;line-height:1.7;color:#59636e;margin:0}
</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/**
 * 扫码授权主流程。
 *
 * @param {object} options
 * @param {number} [options.timeoutMs] 等待扫码上限，默认 5 分钟
 * @param {(url: string) => void} [options.onUrl] 拿到授权 URL 时回调（渲染二维码用）
 * @param {string} [options.clientId]
 * @param {string} [options.scopes]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} 凭据记录
 */
export async function loginWithScan({
  timeoutMs = 5 * 60_000,
  onUrl,
  clientId = DEFAULT_CLIENT_ID,
  scopes = DEFAULT_SCOPES,
  signal,
} = {}) {
  const { server, port } = await listenOnLoopback();
  const verifier = createVerifier();
  const challenge = createChallenge(verifier);
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const authorizeUrl = buildAuthorizeUrl({ port, state, challenge, clientId, scopes });

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), timeoutMs);
  const abortListener = () => settle({ ok: false, reason: 'aborted' });
  signal?.addEventListener('abort', abortListener, { once: true });

  server.on('request', (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('授权未完成', `网关返回：${escapeHtml(error)}。回到 DSH 重试即可。`, false));
      settle({ ok: false, reason: `gateway-error:${error}` });
      return;
    }
    if (returnedState !== state) {
      // state 不匹配说明这个回调不是本次发起的，直接丢弃
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('回调校验失败', 'state 不匹配，这次授权已作废。请重新发起。', false));
      settle({ ok: false, reason: 'state-mismatch' });
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('回调缺少 code', '没有拿到授权码，请重新发起。', false));
      settle({ ok: false, reason: 'no-code' });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(resultPage('授权成功', '可以关掉这个页面，回到 DSH 继续。'));
    settle({ ok: true, code });
  });

  if (typeof onUrl === 'function') onUrl(authorizeUrl);
  log(`login: listening on 127.0.0.1:${port}`);
  log(`login: authorize url ${authorizeUrl}`);

  let outcome;
  try {
    outcome = await done;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }

  if (!outcome.ok) throw new Error(loginFailureMessage(outcome.reason));

  return exchangeCode({ code: outcome.code, verifier, redirectUri, clientId, scopes });
}

/** 用授权码换令牌并落盘。 */
async function exchangeCode({ code, verifier, redirectUri, clientId, scopes }) {
  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`换取令牌时网络失败：${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  // 网关的习惯：失败时回 200 + 空 body + LogicRet 头
  if (response.ok && (text || '').trim() === '') {
    const logicRet = response.headers.get('logicret') || '';
    throw new Error(`换取令牌被网关拒绝（空响应${logicRet ? `，LogicRet ${logicRet}` : ''}）。`
      + '通常是授权码已使用或已过期，请重新发起。');
  }
  if (!response.ok || !payload?.access_token) {
    throw new Error(`换取令牌失败（HTTP ${response.status}）：${payload?.error_description || payload?.error || text.slice(0, 200) || '(空)'}`);
  }
  if (!payload.refresh_token) {
    throw new Error('网关没有返回 refresh_token，无法后续自动续期。请确认授权范围包含离线访问。');
  }

  const record = {
    serverUrl: 'https://api.mail.qq.com/mcp',
    serverName: 'qq-mail',
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || scopes,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    clientId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    importedFrom: 'builtin-scan-login',
    loggedInAt: new Date().toISOString(),
  };

  writeJson(CREDENTIALS_PATH, record);
  log(`login: token persisted, scope=${record.scope}`);
  return record;
}

function loginFailureMessage(reason) {
  switch (reason) {
    case 'timeout':
      return '等待扫码超时。重新发起即可。';
    case 'aborted':
      return '授权已取消。';
    case 'state-mismatch':
      return '回调的 state 与本次请求不匹配（可能是过期或伪造的回调），已丢弃。请重新发起。';
    case 'no-code':
      return '回调里没有授权码。请重新发起。';
    default:
      return `授权未完成：${reason}`;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
