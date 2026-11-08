/**
 * dsh-qqmail / lib/tools.js
 *
 * 12 个模型可见工具。命名空间沿用 DSH 的 MCP 惯例：qqmail_get_me 等。
 *
 * 设计取舍：
 *   - 工具名平铺（不走 mcp__ 前缀），因为这不是通用 MCP 桥，而是 QQ 邮箱专用插件：
 *     模型看到的就是「发邮件/看邮件」，不需要再理解一层协议。
 *   - 发信/删信天然具备二次确认：服务端返回 42801 时把 confirmation_token 与
 *     operation_summary 原样抛给模型，由它调 ask_user_question 取得人确认，
 *     再带 token 重发。插件不替用户点头。
 *   - 附件一律用本地路径，base64/sha1/size 由插件算，模型不碰。
 */
import { defineTool } from './toolkit.js';
import { McpError } from './mcp.js';
import { buildAttachments, validateAttachmentBudget, saveAttachment } from './attachments.js';
import {
  formatMe,
  formatMessageList,
  formatMessageDetail,
  formatAttachmentList,
  parseRecipients,
  fmtBytes,
  pickAliases,
  unwrapData,
  extractMessages,
  normalizeMessage,
} from './format.js';

/** 统一的输出 schema：一个给人看的 text + 原始结构 data。 */
const outputShape = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
      data: { type: 'json' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const recipientSchema = {
  type: 'stringOrArray',
  description: '收件人。可写单个地址 "a@b.com"、带名字 "张三 <a@b.com>"，或用数组/逗号分隔多个地址。',
  items: { type: 'string' },
};

function aliasParameter(defaultAlias) {
  return {
    type: 'string',
    description: defaultAlias
      ? `发件别名 alias_id，留空即用主账号（当前主账号 ${defaultAlias}）。仅当用户明确要求用附属账号时才填。`
      : '发件别名 alias_id，留空即用主账号。不知道就别填，先用 qqmail_get_me 查。',
  };
}

/**
 * 把 McpError 转成一条模型能读懂的失败说明：
 * 需要确认的走特殊文案，让模型知道下一步是问人而不是重试。
 */
function describeFailure(error, toolLabel) {
  if (error instanceof McpError) {
    if (error.isConfirmationRequired) {
      const summary = error.operationSummary ?? {};
      const lines = [`${toolLabel} 需要二次确认，尚未执行。`];
      if (summary.from) lines.push(`发件人：${summary.from}`);
      if (Array.isArray(summary.to)) lines.push(`收件人：${summary.to.join(', ')}`);
      if (summary.subject) lines.push(`主题：${summary.subject}`);
      if (summary.attachment_count !== undefined) lines.push(`附件数：${summary.attachment_count}`);
      if (error.business?.details?.expires_at) lines.push(`确认令牌有效至：${error.business.details.expires_at}`);
      lines.push('');
      lines.push('下一步：调用 ask_user_question 把这封邮件的摘要展示给用户，取得明确同意后，');
      lines.push(`再用完全相同的参数重发本工具，并额外传 confirmation_token: "${error.confirmationToken}"。`);
      lines.push('用户未确认、或令牌已过期，就不要重发。');
      return { text: lines.join('\n'), data: { confirmation_required: true, confirmation_token: error.confirmationToken, operation_summary: error.operationSummary } };
    }
    const bits = [`${toolLabel} 失败：${error.message}`];
    if (error.business?.code) bits.push(`业务码 ${error.business.code}`);
    if (error.business?._hints?.suggested_action) bits.push(`建议：${error.business._hints.suggested_action}`);
    return { text: bits.join('\n'), data: { error: { code: error.business?.code ?? error.code, message: error.message } } };
  }
  return { text: `${toolLabel} 失败：${error?.message ?? String(error)}`, data: { error: { message: String(error?.message ?? error) } } };
}

/**
 * @param {object} deps
 * @param {import('./mcp.js').QqMailClient} deps.client
 * @param {object} deps.config
 * @param {() => Promise<object|null>} deps.getMe  带缓存
 */
export function createTools({ client, config, getMe, downloadDir }) {
  const defaultAlias = config.defaultAlias || '';
  const confirmTtl = Number(config.confirmTtlMs) || 300_000;

  /** 调工具并做失败整形；成功则返回 {text,data}。 */
  async function invoke(toolName, args, { signal, label }) {
    try {
      const result = await client.callTool(toolName, args, { signal });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof McpError && error.code === '40101') {
        // 令牌在调用间隙过期：客户端已自动续期重试过一次，仍失败说明需要重新授权。
        return { ok: false, value: { text: `QQ 邮箱授权失效：${error.message}\n需要重新授权（删除 ~/.dsh/qqmail/credentials.json 后会重新从本机 WorkBuddy 凭据借用）。`, data: { error: { code: 40101 } } } };
      }
      return { ok: false, value: describeFailure(error, label) };
    }
  }

  /** 别名：显式传入优先，否则用 GetMe 的主别名。 */
  async function resolveAlias(explicit, { signal } = {}) {
    if (explicit) return explicit;
    const me = await getMe({ signal });
    const { primary } = pickAliases(me);
    if (primary?.alias_id) return primary.alias_id;
    return undefined; // 服务端默认主别名
  }

  const tools = [];

  // ── qqmail_get_me ────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_get_me',
    description: '查询 QQ 邮箱授权状态：主/附属账号、权限范围、频率限制、附件上限。改账号或怀疑授权失效时先跑这个。',
    parameters: {},
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const outcome = await invoke('GetMe', {}, { signal: exec.signal, label: '查询授权状态' });
      if (!outcome.ok) return outcome.value;
      return { text: formatMe(outcome.result.data), data: unwrapData(outcome.result.data) };
    },
  }));

  // ── qqmail_list_messages ─────────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_list_messages',
    description: '列出邮箱里的邮件（默认收件箱）。可按文件夹、时间范围、是否已读、是否有附件筛选，支持翻页。',
    parameters: {
      dir: { type: 'string', enum: ['inbox', 'sent', 'trash', 'spam'], description: '文件夹，默认 inbox。' },
      limit: { type: 'integer', description: '返回条数，最多 50，默认 10。' },
      cursor: { type: 'string', description: '翻页游标，用上次结果里的 next_cursor。' },
      after: { type: 'string', description: '只返回此时间之后的邮件，ISO 8601，例如 2026-11-01T00:00:00Z。' },
      before: { type: 'string', description: '只返回此时间之前的邮件，ISO 8601。' },
      has_attachments: { type: 'boolean', description: 'true 只看带附件的。' },
      is_read: { type: 'boolean', description: 'true 只看已读，false 只看未读。' },
      alias_id: aliasParameter(defaultAlias),
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const payload = {
        ...(aliasId ? { alias_id: aliasId } : {}),
        ...(args.dir ? { dir: args.dir } : {}),
        ...(args.limit !== undefined ? { limit: Math.min(Number(args.limit) || 10, 50) } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.after ? { after: args.after } : {}),
        ...(args.before ? { before: args.before } : {}),
        ...(args.has_attachments !== undefined ? { has_attachments: args.has_attachments } : {}),
        ...(args.is_read !== undefined ? { is_read: args.is_read } : {}),
      };
      const outcome = await invoke('ListMessages', payload, { signal: exec.signal, label: '列出邮件' });
      if (!outcome.ok) return outcome.value;
      const flat = unwrapData(outcome.result.data);
      return {
        text: formatMessageList(outcome.result.data),
        data: { messages: extractMessages(flat) },
      };
    },
  }));

  // ── qqmail_get_message ───────────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_get_message',
    description: '读取单封邮件的完整内容（含附件清单）。message_id 从列表或搜索结果里拿。',
    parameters: {
      message_id: { type: 'string', required: true, description: '邮件 ID，形如 msg_xxx。' },
      alias_id: aliasParameter(defaultAlias),
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const outcome = await invoke('GetMessage', {
        ...(aliasId ? { alias_id: aliasId } : {}),
        message_id: args.message_id,
      }, { signal: exec.signal, label: '读取邮件' });
      if (!outcome.ok) return outcome.value;
      return { text: formatMessageDetail(outcome.result.data), data: normalizeMessage(unwrapData(outcome.result.data)) };
    },
  }));

  // ── qqmail_search_messages ───────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_search_messages',
    description: '搜索邮件：关键词（主题+正文，可限定范围）、发件人、收件人、文件夹、时间范围、附件与已读状态。',
    parameters: {
      q: { type: 'string', description: '搜索关键词或短语。' },
      search_in: { type: 'string', enum: ['SEARCH_IN_ALL', 'SEARCH_IN_SUBJECT', 'SEARCH_IN_CONTENT'], description: '搜索范围，默认 SEARCH_IN_ALL。用户说「标题里」用 SUBJECT，「正文里」用 CONTENT。' },
      from: { type: 'string', description: '按发件人邮箱过滤。' },
      to: { type: 'string', description: '按收件人邮箱过滤。' },
      dir: { type: 'string', enum: ['inbox', 'sent', 'trash', 'spam'], description: '限定文件夹。' },
      after: { type: 'string', description: '起始时间，ISO 8601。' },
      before: { type: 'string', description: '截止时间，ISO 8601。' },
      has_attachments: { type: 'boolean', description: '只看带附件的。' },
      is_read: { type: 'boolean', description: '只看已读 / 未读。' },
      limit: { type: 'integer', description: '返回条数，最多 50，默认 10。' },
      cursor: { type: 'string', description: '翻页游标。' },
      alias_id: aliasParameter(defaultAlias),
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const payload = {};
      if (aliasId) payload.alias_id = aliasId;
      for (const key of ['q', 'search_in', 'from', 'to', 'dir', 'after', 'before', 'cursor']) {
        if (args[key] !== undefined && args[key] !== '') payload[key] = args[key];
      }
      for (const key of ['has_attachments', 'is_read']) {
        if (args[key] !== undefined) payload[key] = args[key];
      }
      if (args.limit !== undefined) payload.limit = Math.min(Number(args.limit) || 10, 50);
      if (!payload.q && !payload.from && !payload.to) {
        return { text: '至少给出一个搜索条件：q（关键词）、from（发件人）或 to（收件人）。', data: { error: { message: 'missing criteria' } } };
      }
      const outcome = await invoke('SearchMessages', payload, { signal: exec.signal, label: '搜索邮件' });
      if (!outcome.ok) return outcome.value;
      const flat = unwrapData(outcome.result.data);
      return {
        text: formatMessageList(outcome.result.data, { title: '搜索结果' }),
        data: { messages: extractMessages(flat) },
      };
    },
  }));

  // ── qqmail_list_attachments ──────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_list_attachments',
    description: '列出某封邮件的附件元信息（文件名、大小、类型、attachment_id），不下载内容。',
    parameters: {
      message_id: { type: 'string', required: true, description: '邮件 ID。' },
      alias_id: aliasParameter(defaultAlias),
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const outcome = await invoke('ListAttachments', {
        ...(aliasId ? { alias_id: aliasId } : {}),
        message_id: args.message_id,
      }, { signal: exec.signal, label: '列出附件' });
      if (!outcome.ok) return outcome.value;
      return {
        text: formatAttachmentList(outcome.result.data, args.message_id),
        data: unwrapData(outcome.result.data),
      };
    },
  }));

  // ── qqmail_download_attachment ───────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_download_attachment',
    description: '下载附件到本地磁盘（默认目录可在插件配置里改），返回落盘路径与大小。',
    parameters: {
      message_id: { type: 'string', required: true, description: '邮件 ID。' },
      attachment_id: { type: 'string', required: true, description: '附件 ID，形如 att_xxx。' },
      dir: { type: 'string', description: '保存目录；不填用插件配置的 downloadDir，再退回系统下载目录。' },
      alias_id: aliasParameter(defaultAlias),
    },
    output: outputShape,
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const outcome = await invoke('DownloadAttachment', {
        ...(aliasId ? { alias_id: aliasId } : {}),
        message_id: args.message_id,
        attachment_id: args.attachment_id,
      }, { signal: exec.signal, label: '下载附件' });
      if (!outcome.ok) return outcome.value;
      const body = unwrapData(outcome.result.data);
      const att = body.attachment ?? body;
      const base64 = att.content ?? att.data ?? att.content_base64;
      if (typeof base64 !== 'string' || base64.length === 0) {
        return { text: '下载接口没有返回附件内容。', data: outcome.result.data };
      }
      const saved = saveAttachment({
        base64,
        filename: att.filename || att.name || `${args.attachment_id}.bin`,
        dir: args.dir || downloadDir,
      });
      const lines = [
        `已保存：${saved.path}`,
        `大小：${fmtBytes(saved.bytes)}`,
        `attachment_id：${args.attachment_id}`,
      ];
      if (att.sha1) lines.push(`sha1：${att.sha1}`);
      return { text: lines.join('\n'), data: { path: saved.path, bytes: saved.bytes, filename: att.filename ?? null } };
    },
  }));

  // ── 发信族：统一的两阶段确认 ───────────────────────────────────────
  const sendParams = {
    to: recipientSchema,
    cc: recipientSchema,
    bcc: recipientSchema,
    subject: { type: 'string', description: '邮件主题，最长 998 字符。' },
    body: { type: 'string', description: '邮件正文。' },
    body_format: { type: 'string', enum: ['PLAIN', 'HTML', 'MARKDOWN'], description: '正文格式，默认 PLAIN。' },
    attachments: {
      type: 'array',
      description: '本地附件文件路径列表。插件负责读文件、算 sha1/大小并转 Base64；上限 3 个、单文件 1MB、合计 3MB。',
      items: { type: 'string' },
    },
    skip_confirmation: { type: 'boolean', description: '仅供自动化脚本使用；默认必须走用户确认。不要替用户设成 true。' },
    confirmation_token: { type: 'string', description: '只有用户明确确认后才填，取值来自上一次调用的返回。' },
    alias_id: aliasParameter(defaultAlias),
  };

  async function sendFamily(toolName, label, args, exec, buildExtra) {
    const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
    const payload = { ...(aliasId ? { alias_id: aliasId } : {}), ...buildExtra(args) };
    if (args.body_format) payload.body_format = args.body_format;
    if (args.confirmation_token) payload.confirmation_token = args.confirmation_token;
    if (args.skip_confirmation === true) payload.skip_confirmation = true;

    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      let parts;
      try {
        parts = buildAttachments(args.attachments);
      } catch (error) {
        return { text: `读取附件失败：${error.message}`, data: { error: { message: error.message } } };
      }
      const me = await getMe({ signal: exec.signal });
      const constraints = unwrapData(me)?.constraints;
      try {
        validateAttachmentBudget(parts, constraints);
      } catch (error) {
        return { text: error.message, data: { error: { message: error.message } } };
      }
      payload.attachments = parts;
    }

    const outcome = await invoke(toolName, payload, { signal: exec.signal, label });
    if (!outcome.ok) return outcome.value;
    const body = unwrapData(outcome.result.data);
    const lines = [`${label}完成。`];
    if (body.message_id) lines.push(`message_id：${body.message_id}`);
    if (body.thread_id) lines.push(`thread_id：${body.thread_id}`);
    if (body.date) lines.push(`时间：${body.date}`);
    if (body.quota) lines.push(`今日剩余发送额度：${body.quota}`);
    if (lines.length === 1) lines.push(outcome.result.text || '（服务端未返回更多细节）');
    return { text: lines.join('\n'), data: body };
  }

  tools.push(defineTool({
    name: 'qqmail_send_message',
    description: '发送新邮件。首次调用不带 confirmation_token 会返回确认摘要，必须先把摘要交给用户确认，再带 token 重发。',
    parameters: {
      ...sendParams,
      to: { ...recipientSchema, required: true },
      subject: { ...sendParams.subject, required: true },
      body: { ...sendParams.body, required: true },
    },
    output: outputShape,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const to = parseRecipients(args.to);
      if (!to) return { text: '缺少收件人（to）。', data: { error: { message: 'missing to' } } };
      return sendFamily('SendMessage', '发送邮件', args, exec, () => ({
        to,
        ...(parseRecipients(args.cc) ? { cc: parseRecipients(args.cc) } : {}),
        ...(parseRecipients(args.bcc) ? { bcc: parseRecipients(args.bcc) } : {}),
        subject: args.subject,
        body: args.body,
      }));
    },
  }));

  tools.push(defineTool({
    name: 'qqmail_reply_message',
    description: '回复某封邮件（自动带上会话头）。同样需要先拿到确认摘要、经用户确认后再带 token 重发。',
    parameters: {
      message_id: { type: 'string', required: true, description: '被回复的邮件 ID。' },
      body: { type: 'string', required: true, description: '回复正文。' },
      body_format: sendParams.body_format,
      reply_all: { type: 'boolean', description: 'true 回复全部原收件人。' },
      cc: sendParams.cc,
      bcc: sendParams.bcc,
      attachments: sendParams.attachments,
      skip_confirmation: sendParams.skip_confirmation,
      confirmation_token: sendParams.confirmation_token,
      alias_id: sendParams.alias_id,
    },
    output: outputShape,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return sendFamily('ReplyMessage', '回复邮件', args, exec, () => ({
        message_id: args.message_id,
        body: args.body,
        ...(args.reply_all !== undefined ? { reply_all: args.reply_all } : {}),
        ...(parseRecipients(args.cc) ? { cc: parseRecipients(args.cc) } : {}),
        ...(parseRecipients(args.bcc) ? { bcc: parseRecipients(args.bcc) } : {}),
      }));
    },
  }));

  tools.push(defineTool({
    name: 'qqmail_forward_message',
    description: '转发某封邮件给新收件人。同样需要先拿确认摘要、经用户确认后再带 token 重发。',
    parameters: {
      message_id: { type: 'string', required: true, description: '被转发的邮件 ID。' },
      to: { ...recipientSchema, required: true },
      body: sendParams.body,
      body_format: sendParams.body_format,
      cc: sendParams.cc,
      bcc: sendParams.bcc,
      include_attachments: { type: 'boolean', description: '是否带上原邮件的附件，默认 true。' },
      attachments: sendParams.attachments,
      skip_confirmation: sendParams.skip_confirmation,
      confirmation_token: sendParams.confirmation_token,
      alias_id: sendParams.alias_id,
    },
    output: outputShape,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const to = parseRecipients(args.to);
      if (!to) return { text: '缺少收件人（to）。', data: { error: { message: 'missing to' } } };
      return sendFamily('ForwardMessage', '转发邮件', args, exec, () => ({
        message_id: args.message_id,
        to,
        body: args.body ?? '',
        ...(args.include_attachments !== undefined ? { include_attachments: args.include_attachments } : {}),
        ...(parseRecipients(args.cc) ? { cc: parseRecipients(args.cc) } : {}),
        ...(parseRecipients(args.bcc) ? { bcc: parseRecipients(args.bcc) } : {}),
      }));
    },
  }));

  // ── 删除族 ──────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'qqmail_delete_message',
    description: '把邮件移到垃圾箱（软删除，30 天内可恢复）。同样先返回确认摘要，经用户确认后带 token 重发。',
    parameters: {
      message_id: { type: 'string', required: true, description: '邮件 ID。' },
      confirmation_token: sendParams.confirmation_token,
      alias_id: sendParams.alias_id,
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const payload = {
        ...(aliasId ? { alias_id: aliasId } : {}),
        message_id: args.message_id,
        ...(args.confirmation_token ? { confirmation_token: args.confirmation_token } : {}),
      };
      const outcome = await invoke('DeleteMessage', payload, { signal: exec.signal, label: '删除邮件' });
      if (!outcome.ok) return outcome.value;
      return { text: `已把邮件 ${args.message_id} 移入垃圾箱（30 天内可恢复）。`, data: outcome.result.data };
    },
  }));

  tools.push(defineTool({
    name: 'qqmail_permanent_delete_message',
    description: '永久删除垃圾箱里的某封邮件，不可恢复。同样先返回确认摘要，经用户确认后带 token 重发。',
    parameters: {
      message_id: { type: 'string', required: true, description: '邮件 ID（必须已在垃圾箱）。' },
      confirmation_token: sendParams.confirmation_token,
      alias_id: sendParams.alias_id,
    },
    output: outputShape,
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const payload = {
        ...(aliasId ? { alias_id: aliasId } : {}),
        message_id: args.message_id,
        ...(args.confirmation_token ? { confirmation_token: args.confirmation_token } : {}),
      };
      const outcome = await invoke('PermanentDeleteMessage', payload, { signal: exec.signal, label: '永久删除邮件' });
      if (!outcome.ok) return outcome.value;
      return { text: `已永久删除邮件 ${args.message_id}。`, data: outcome.result.data };
    },
  }));

  tools.push(defineTool({
    name: 'qqmail_clear_trash',
    description: '清空垃圾箱，永久删除其中所有邮件，不可恢复。同样先返回确认摘要，经用户确认后带 token 重发。',
    parameters: {
      confirmation_token: sendParams.confirmation_token,
      alias_id: sendParams.alias_id,
    },
    output: outputShape,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const aliasId = await resolveAlias(args.alias_id, { signal: exec.signal });
      const payload = {
        ...(aliasId ? { alias_id: aliasId } : {}),
        ...(args.confirmation_token ? { confirmation_token: args.confirmation_token } : {}),
      };
      const outcome = await invoke('ClearTrash', payload, { signal: exec.signal, label: '清空垃圾箱' });
      if (!outcome.ok) return outcome.value;
      const body = unwrapData(outcome.result.data);
      const deleted = body.deleted_count ?? body.count;
      return { text: `垃圾箱已清空${deleted !== undefined ? `，删除 ${deleted} 封` : ''}。`, data: body };
    },
  }));

  return { tools, confirmTtl };
}
