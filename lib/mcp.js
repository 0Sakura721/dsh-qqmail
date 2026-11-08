/**
 * dsh-qqmail / lib/mcp.js
 *
 * 一个够用且不臃肿的 MCP Streamable-HTTP 客户端。
 * 只实现本插件真正需要的部分：initialize、tools/list、tools/call。
 *
 * 协议要点（对 api.mail.qq.com 实测）：
 *   - POST 必须带 Accept: application/json, text/event-stream
 *   - 服务端可能直接回 JSON，也可能回 SSE（data: {...}），两种都要吃
 *   - 服务端协商到 2025-03-26，不回 Mcp-Session-Id；有则回传，没有就不带
 *   - 工具级错误包在 JSON-RPC error 里，message 字段是「文本化的 JSON」，
 *     真正的业务错误码藏在 error.message 内层的 {"error":{"code":...}} 里
 */
import { log } from './paths.js';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;

/** 服务端把真正的业务结果塞在 error.message 的字符串里，这里统一还原成对象。 */
function unwrapPayload(raw) {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return raw;
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

/** 把 MCP tools/call 的 content[] 折成「一句能读的结果 + 原始结构化数据」。 */
function foldContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = [];
  const others = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block) others.push(block);
  }
  const joined = texts.join('\n');
  const parsed = unwrapPayload(joined);
  return { text: joined, data: parsed, extra: others };
}

/** 从任意层级的错误结构里挖出业务 error.code / message。 */
function extractBusinessError(value) {
  let node = value;
  for (let depth = 0; depth < 5 && node && typeof node === 'object'; depth += 1) {
    if (typeof node.code === 'number' && typeof node.message === 'string') {
      return { code: node.code, message: node.message, details: node.details, hints: node._hints };
    }
    const next = node.error ?? node.data;
    if (next === undefined) break;
    node = typeof next === 'string' ? unwrapPayload(next) : next;
  }
  return null;
}

export class McpError extends Error {
  constructor(message, { code = 'MCP_ERROR', business = null, httpStatus = 0, raw = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'McpError';
    this.code = code;
    this.business = business;
    this.httpStatus = httpStatus;
    this.raw = raw;
  }

  /** 42801 = 需要二次确认；把 token 与 operation_summary 交出去。 */
  get isConfirmationRequired() {
    return this.business?.code === 42801;
  }

  get confirmationToken() {
    return this.business?.details?.confirmation_token ?? null;
  }

  get operationSummary() {
    return this.business?.details?.operation_summary ?? null;
  }
}

export class QqMailClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint MCP 端点，默认 https://api.mail.qq.com/mcp
   * @param {() => Promise<string>} options.getToken 拿到当前可用 access token
   * @param {() => Promise<void>} [options.onUnauthorized] 401 时触发一次强制续期后再试
   * @param {number} [options.timeoutMs]
   */
  constructor({ endpoint, getToken, onUnauthorized, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.endpoint = endpoint;
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.sessionId = null;
    this.serverInfo = null;
    this.protocolVersion = null;
  }

  async #post(body, { signal, retryOn401 = true } = {}) {
    const token = await this.getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: composite });
    } catch (error) {
      throw new McpError(`QQ 邮箱 MCP 请求失败：${error.message}`, { code: 'NETWORK', cause: error });
    }

    if (response.status === 401 && retryOn401 && this.onUnauthorized) {
      await this.onUnauthorized();
      return this.#post(body, { signal, retryOn401: false });
    }

    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) this.sessionId = sessionHeader;

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();

    if (!response.ok && !contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
      throw new McpError(`QQ 邮箱 MCP 返回 HTTP ${response.status}`, { code: 'HTTP', httpStatus: response.status, raw: rawText });
    }

    let payload;
    if (contentType.includes('text/event-stream')) {
      payload = parseSse(rawText, body.id);
      if (payload === undefined) {
        throw new McpError('QQ 邮箱 MCP 的 SSE 响应里没有匹配的 JSON-RPC 结果', { code: 'PARSE', raw: rawText });
      }
    } else {
      try {
        payload = JSON.parse(rawText);
      } catch (error) {
        throw new McpError(`QQ 邮箱 MCP 返回无法解析的响应：${rawText.slice(0, 200)}`, {
          code: 'PARSE',
          httpStatus: response.status,
          raw: rawText,
          cause: error,
        });
      }
    }

    if (payload.error) {
      const business = extractBusinessError(payload.error);
      const message = business?.message ?? payload.error.message ?? '未知错误';
      throw new McpError(message, {
        code: business ? String(business.code) : String(payload.error.code ?? 'MCP_ERROR'),
        business,
        httpStatus: response.status,
        raw: payload.error,
      });
    }

    return payload.result;
  }

  async initialize({ signal } = {}) {
    const result = await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-qqmail', version: '1.0.0' },
      },
    }, { signal });
    this.protocolVersion = result?.protocolVersion ?? null;
    this.serverInfo = result?.serverInfo ?? null;
    log(`mcp initialize ok: server=${this.serverInfo?.name}@${this.serverInfo?.version} protocol=${this.protocolVersion}`);
    return result;
  }

  async listTools({ signal } = {}) {
    const result = await this.#post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} }, { signal });
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * 调一个 QQ 邮箱工具。
   * @returns {Promise<{data: any, text: string, extra: any[]}>}
   */
  async callTool(name, args, { signal } = {}) {
    const result = await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    }, { signal });
    const folded = foldContent(result);
    if (result?.isError === true) {
      const business = extractBusinessError(folded.data);
      throw new McpError(business?.message ?? folded.text.slice(0, 300) ?? `${name} 执行失败`, {
        code: business ? String(business.code) : 'TOOL_ERROR',
        business,
      });
    }
    if (folded.data && typeof folded.data === 'object' && folded.data.error) {
      const business = extractBusinessError(folded.data);
      throw new McpError(business?.message ?? `${name} 返回错误`, {
        code: business ? String(business.code) : 'TOOL_ERROR',
        business,
      });
    }
    return folded;
  }
}

/** 解析 SSE，取 id 匹配的那条 result / error。 */
function parseSse(text, expectedId) {
  const events = text.split(/\r?\n\r?\n/);
  let fallback;
  for (const event of events) {
    const dataLines = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    let parsed;
    try {
      parsed = JSON.parse(joined);
    } catch {
      continue;
    }
    if (parsed && parsed.id === expectedId) return parsed;
    if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) fallback = parsed;
  }
  return fallback;
}
