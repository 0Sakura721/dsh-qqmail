/**
 * dsh-qqmail / lib/auth.js
 *
 * 令牌生命周期：加载 → 解码/借用 → 续期 → 落盘。
 *
 * 令牌来源优先级：
 *   1. ~/.dsh/qqmail/credentials.json（插件自有，写完即 0600）
 *   2. WorkBuddy 连接器凭据（自动借用，无需扫码；拿到的 refresh_token 可长期续期）
 *
 * 续期端点（取自 api.mail.qq.com 的 OAuth 发现文档）：
 *   token_endpoint    https://wx.mail.qq.com/oauth/token
 *   client_id         从凭据里读；WorkBuddy 注册的公共客户端 id 作为默认值
 *   grant_type        refresh_token
 *
 * 实测：refresh 后返回的 refresh_token 与原来相同（不轮换），所以只要第一次拿到，
 * 后续就能一直续下去；即便如此仍每次写回，防止服务端将来改成轮换模式。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { CREDENTIALS_PATH, readJson, writeJson, log } from './paths.js';
import { importFromWorkBuddy, listWorkBuddyStores } from './workbuddy.js';
import { resealStore } from './seal.js';

const TOKEN_ENDPOINT = 'https://wx.mail.qq.com/oauth/token';
export const DEFAULT_CLIENT_ID = '002e8cd14071aad2'
/** 提前 90 秒续期，避免刚好卡在边界上。 */
const REFRESH_MARGIN_MS = 90_000;

export class AuthError extends Error {
  constructor(message, { code = 'AUTH_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AuthError';
    this.code = code;
  }
}

export class TokenManager {
  /**
   * @param {object} config 插件配置
   */
  constructor(config = {}) {
    this.config = config;
    this.record = null;
    this.refreshPromise = null;
    this.lastRefreshAt = 0;
  }

  /** 读凭据文件；没有就尝试从 WorkBuddy 借用并落盘。 */
  async load() {
    if (this.record) return this.record;
    const saved = readJson(CREDENTIALS_PATH, null);
    if (saved && saved.refreshToken) {
      this.record = saved;
      log(`credentials loaded from ${CREDENTIALS_PATH} scope=${saved.scope || '?'}`);
      return this.record;
    }
    if (this.config.workbuddyAutoImport === false) {
      throw new AuthError('没有可用凭据，且已关闭 WorkBuddy 自动借用。请先授权。', { code: 'NO_CREDENTIALS' });
    }
    const imported = importFromWorkBuddy();
    if (!imported.ok) {
      throw new AuthError(`没有可用凭据（WorkBuddy 借用失败：${imported.reason}）`, { code: 'NO_CREDENTIALS' });
    }
    this.record = {
      ...imported.record,
      importedFrom: 'workbuddy',
      importedAt: new Date().toISOString(),
    };
    this.#persist();
    log('credentials imported from workbuddy and persisted');
    return this.record;
  }

  #persist() {
    if (!this.record) return;
    writeJson(CREDENTIALS_PATH, this.record);
  }

  /** 过期判断（留 90 秒余量）。 */
  #isExpired(record) {
    if (!record?.accessToken) return true;
    if (!record.expiresAt) return false;
    return Date.now() >= record.expiresAt - REFRESH_MARGIN_MS;
  }

  /**
   * 拿一个当前可用的 access token；必要时先续期。
   * 并发调用共享同一次续期。
   */
  async getAccessToken() {
    const record = await this.load();
    if (!this.#isExpired(record)) return record.accessToken;
    await this.refresh();
    return this.record.accessToken;
  }

  /** 强制续期（401 时也走这里）。 */
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async #doRefresh() {
    const record = await this.load();
    if (!record.refreshToken) {
      throw new AuthError('凭据里没有 refresh_token，需要重新授权。', { code: 'NO_REFRESH_TOKEN' });
    }
    const clientId = record.clientId || DEFAULT_CLIENT_ID;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: clientId,
    });

    let response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AuthError(`续期请求失败：${error.message}`, { code: 'NETWORK', cause: error });
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    // 网关对"已失效/已轮换的 refresh_token"的回应是 HTTP 200 + 空 body + LogicRet 头，
    // 不是标准的 4xx。单独识别它，才能给出"该重新授权"而不是"网络异常"的结论。
    if (response.ok && (text || '').trim() === '') {
      const logicRet = response.headers.get('logicret') || '';
      throw new AuthError(
        `续期被网关拒绝（空响应${logicRet ? `，LogicRet ${logicRet}` : ''}）：refresh_token 已失效或被轮换。`
        + '删除 ~/.dsh/qqmail/credentials.json 后重跑一次即可重新从本机 WorkBuddy 凭据借用；'
        + '若 WorkBuddy 侧也已失效，需要在 WorkBuddy 里重新扫一次码授权 QQ 邮箱。',
        { code: 'REFRESH_TOKEN_DEAD' },
      );
    }

    if (!response.ok || !payload?.access_token) {
      throw new AuthError(
        `续期被拒（HTTP ${response.status}）：${payload?.error_description || payload?.error || text.slice(0, 200) || '(空响应)'}`,
        { code: 'REFRESH_REJECTED' },
      );
    }

    this.record = {
      ...record,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || record.refreshToken,
      tokenType: payload.token_type || record.tokenType || 'Bearer',
      scope: payload.scope || record.scope || '',
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      refreshedAt: new Date().toISOString(),
    };
    this.lastRefreshAt = Date.now();
    this.#persist();
    this.#resealWorkBuddy();
    log(`token refreshed, expires at ${new Date(this.record.expiresAt).toISOString()}`);
    return this.record;
  }

  /**
   * 把新令牌回封到 WorkBuddy 的加密凭据里。
   *
   * 必要性：QQ 邮箱的 refresh_token 一次性轮换 —— 插件一旦用它续期，
   * WorkBuddy 自己存的那条就作废了。不回封的话，插件跑得越勤，
   * WorkBuddy 那边越早集体失效。回封后两边共享同一条活令牌。
   *
   * 失败只记日志，不影响插件自身的可用性（WorkBuddy 是可选来源，不是依赖）。
   */
  #resealWorkBuddy() {
    const record = this.record;
    if (!record) return;
    if (this.config.workbuddyReseal === false) return;
    try {
      let resealed = 0;
      for (const store of listWorkBuddyStores()) {
        for (const serverKey of Object.keys(store.cred.mcpOAuth || {})) {
          const url = store.cred.mcpOAuth[serverKey]?.serverUrl || '';
          if (!url.includes('api.mail.qq.com')) continue;
          const result = resealStore(store, serverKey, {
            accessToken: record.accessToken,
            refreshToken: record.refreshToken,
            expiresAt: record.expiresAt,
            scope: record.scope,
            tokenType: record.tokenType,
          });
          if (!result.ok) {
            log(`workbuddy reseal failed for ${serverKey}: ${result.reason}`);
            continue;
          }
          writeJson(path.join(store.dir, '.credentials.v3.json'), result.cred, 0o600);
          resealed += 1;
        }
      }
      if (resealed > 0) log(`resealed ${resealed} workbuddy store(s) with rotated token`);
    } catch (error) {
      log(`workbuddy reseal skipped: ${error.message}`);
    }
  }

  /** 给状态面板用：不含明文令牌。 */
  async describe() {
    const record = await this.load();
    return {
      scope: record.scope || '',
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      expired: this.#isExpired(record),
      tokenType: record.tokenType || 'Bearer',
      importedFrom: record.importedFrom || 'local',
      hasRefreshToken: Boolean(record.refreshToken),
      accessTokenFingerprint: record.accessToken
        ? crypto.createHash('sha256').update(record.accessToken).digest('hex').slice(0, 12)
        : null,
    };
  }
}
