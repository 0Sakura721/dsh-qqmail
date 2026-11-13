/**
 * dsh-qqmail / lib/settings-api.js
 *
 * 设置页的数据面（Host 侧 HTTP 路由）。
 *
 * 为什么需要它：扫码和状态查看放在 DSH 设置页里，比在终端里画二维码顺手得多。
 * 浏览器半边（client.js）不能直接触碰令牌和网络，它只能同源 fetch 这里的路由。
 *
 * 路由（全部挂在本机回环 Web 端口下）：
 *   GET  /dsh-qqmail/api/status   → 授权状态（不含明文令牌）
 *   POST /dsh-qqmail/api/login    → 发起扫码，返回 qr 的 SVG 与等待句柄
 *   GET  /dsh-qqmail/api/login    → 轮询扫码进度
 *   POST /dsh-qqmail/api/logout   → 断开授权
 *
 * 信任：每个请求都过 ctx.connection.requestRejection，与官方路由同一套
 * Host/Origin 校验和浏览器认证。DSH 的端口在回环地址上，但任何网页都能向回环发
 * 请求 —— 不加这道栅栏等于把账号令牌的操作权开放给任意页面。
 */
import { log } from './paths.js';
import { encodeQr, renderSvg } from './qr.js';
import { loginWithScan } from './login.js';

const BASE = '/dsh-qqmail/api';

/** 极简 JSON 响应。 */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 读取并限制请求体大小，避免被超大 body 拖住。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 注册设置页路由。
 *
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {() => object} deps.getTokens 取 TokenManager
 * @param {() => Promise<object|null>} deps.getMe 取授权信息
 * @returns {Array<() => void>} disposers
 */
export function registerSettingsApi({ ctx, getTokens, getMe }) {
  const disposers = [];
  const webServer = ctx.get?.('webServer');
  if (!webServer) {
    log('settings api: webServer unavailable, settings page will be inert');
    return disposers;
  }

  /** 每个请求的统一入口：信任校验 + 路由分发。 */
  const handler = (req, res) => {
    const conn = ctx.get?.('connection');
    if (conn && typeof conn.requestRejection === 'function') {
      const rejection = conn.requestRejection(req);
      if (rejection) {
        json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
        return;
      }
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    const method = req.method || 'GET';

    if (route === `${BASE}/status` && method === 'GET') {
      handleStatus(res).catch((error) => json(res, 500, { error: String(error?.message ?? error) }));
      return;
    }
    if (route === `${BASE}/login` && method === 'POST') {
      handleLoginStart(req, res).catch((error) => json(res, 500, { error: String(error?.message ?? error) }));
      return;
    }
    if (route === `${BASE}/login` && method === 'GET') {
      handleLoginPoll(res).catch((error) => json(res, 500, { error: String(error?.message ?? error) }));
      return;
    }
    if (route === `${BASE}/logout` && method === 'POST') {
      handleLogout(req, res).catch((error) => json(res, 500, { error: String(error?.message ?? error) }));
      return;
    }
    json(res, 404, { error: 'not found' });
  };

  // ── 授权状态 ────────────────────────────────────────────────
  async function handleStatus(res) {
    const tokens = getTokens();
    try {
      const info = await tokens.describe();
      let account = null;
      try {
        const me = await getMe();
        const payload = me?.data ?? me ?? {};
        const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];
        const primary = aliases.find((a) => a?.is_primary === true) ?? aliases[0] ?? null;
        account = {
          email: primary?.email ?? null,
          aliasId: primary?.alias_id ?? null,
          aliases: aliases.map((a) => ({ email: a.email, primary: a.is_primary === true })),
        };
      } catch {
        // 令牌可能刚过期，账号信息取不到不影响状态展示
      }
      json(res, 200, {
        authorized: true,
        scope: info.scope,
        expiresAt: info.expiresAt,
        expired: info.expired,
        importedFrom: info.importedFrom,
        hasRefreshToken: info.hasRefreshToken,
        account,
      });
    } catch (error) {
      json(res, 200, {
        authorized: false,
        reason: error?.code ?? 'NO_CREDENTIALS',
        message: String(error?.message ?? error),
      });
    }
  }

  // ── 扫码登录 ────────────────────────────────────────────────
  // 一次只允许一个登录流程，避免多个页面同时开两条回调
  let pending = null;

  async function handleLoginStart(req, res) {
    if (pending) {
      json(res, 409, { error: 'login-in-progress', message: '已经有一个扫码流程在进行中。' });
      return;
    }
    const raw = await readBody(req).catch(() => '{}');
    let scopes;
    try {
      const parsed = JSON.parse(raw || '{}');
      if (typeof parsed.scopes === 'string' && parsed.scopes.trim()) scopes = parsed.scopes.trim();
    } catch {
      // 忽略非法 body，用默认 scope
    }

    const controller = new AbortController();
    const state = { status: 'waiting', svg: null, error: null, svgReady: false };
    pending = { state, controller };

    const promise = loginWithScan({
      scopes,
      signal: controller.signal,
      onUrl: (url) => {
        try {
          state.svg = renderSvg(encodeQr(url), { moduleSize: 5, quietZone: 2 });
          state.svgReady = true;
        } catch (error) {
          state.error = `二维码生成失败：${error.message}`;
          state.status = 'error';
        }
      },
    })
      .then((record) => {
        state.status = 'done';
        state.scope = record.scope;
        return record;
      })
      .catch((error) => {
        state.status = controller.signal.aborted ? 'cancelled' : 'error';
        state.error = String(error?.message ?? error);
      })
      .finally(() => {
        // 保留结果给轮询读一次，随后由 logout/超时清理
        setTimeout(() => {
          if (pending && pending.state === state) pending = null;
        }, 60_000);
      });

    // 等二维码就绪再返回，避免前端拿空图
    const deadline = Date.now() + 15_000;
    while (!state.svgReady && state.status === 'waiting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (state.status === 'error') {
      json(res, 500, { error: state.error ?? 'login failed' });
      return;
    }
    json(res, 200, { svg: state.svg, status: state.status });
    // promise 自行推进，不阻塞响应
    void promise;
  }

  function handleLoginPoll(res) {
    if (!pending) {
      json(res, 200, { status: 'idle' });
      return;
    }
    const { state } = pending;
    json(res, 200, {
      status: state.status,
      scope: state.scope ?? null,
      error: state.error ?? null,
    });
  }

  // ── 断开授权 ────────────────────────────────────────────────
  async function handleLogout(req, res) {
    await readBody(req).catch(() => '');
    if (pending) {
      pending.controller.abort();
      pending = null;
    }
    const tokens = getTokens();
    try {
      const { CREDENTIALS_PATH } = await import('./paths.js');
      const fs = await import('node:fs');
      fs.rmSync(CREDENTIALS_PATH, { force: true });
      // 清掉内存缓存，下次调用会重新读取
      tokens.record = null;
      log('logout: credentials removed');
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) });
    }
  }

  disposers.push(webServer.register({ kind: 'prefix', path: BASE, handler }));
  log(`settings api registered at ${BASE}`);
  return disposers;
}
