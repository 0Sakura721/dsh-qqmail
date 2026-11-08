/**
 * dsh-qqmail / lib/format.js
 *
 * 面向模型的文本整形。原则：结构稳定、字段名中英混排时以中文标签为准、
 * 列表类结果每行以 `message_id` 开头（模型后面要靠它取正文）。
 */

export function fmtTime(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function addrs(list) {
  if (!Array.isArray(list) || list.length === 0) return '无';
  return list
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return String(item);
      const email = item.email || item.address || '';
      const name = item.name || item.display_name || '';
      return name ? `${name} <${email}>` : email;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * 逐层剥 `data` 外壳，直到拿到真正的业务对象。
 *
 * 为什么需要：QQ 邮箱网关的返回是双层包装 —— MCP 的 content[].text 里是
 * `{"data":{"data":{scopes,aliases,…}}}`，一层是网关信封，一层是 MCP 信封。
 * 写死剥一层，换个接口就错位；按"哪层有这个字段"下钻才稳。
 */
export function unwrapData(value) {
  let node = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node ?? {};
    const inner = node.data;
    if (inner === undefined) return node;
    // 当前层自己就是业务对象（有真正的业务字段）时停止下钻
    if (node.aliases !== undefined || node.scopes !== undefined || node.messages !== undefined
      || node.message_id !== undefined || node.subject !== undefined) {
      return node;
    }
    node = typeof inner === 'string' ? tryJson(inner) : inner;
  }
  return node ?? {};
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 从 GetMe 结果里挑出主别名与全部别名。 */
export function pickAliases(getMeData) {
  const payload = unwrapData(getMeData);
  const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];
  const primary = aliases.find((a) => a?.is_primary === true) ?? aliases[0] ?? null;
  return { aliases, primary };
}

export function formatMe(getMeData) {
  const payload = unwrapData(getMeData);
  const { aliases, primary } = pickAliases(getMeData);
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  const limits = payload.rate_limits ?? {};
  const constraints = payload.constraints ?? {};
  const lines = [];
  lines.push(`主账号：${primary?.email ?? '未知'}${primary?.alias_id ? `（alias_id: ${primary.alias_id}）` : ''}`);
  if (aliases.length > 1) {
    lines.push('附属账号：');
    for (const alias of aliases) {
      if (alias === primary) continue;
      lines.push(`  - ${alias.email}${alias.alias_id ? `（alias_id: ${alias.alias_id}）` : ''}`);
    }
  }
  lines.push(`权限范围：${scopes.length > 0 ? scopes.join(', ') : '未知'}`);
  const limitBits = [];
  if (limits.requests_per_minute) limitBits.push(`${limits.requests_per_minute} 次/分钟`);
  if (limits.requests_per_hour) limitBits.push(`${limits.requests_per_hour} 次/小时`);
  if (limits.daily_send_quota) limitBits.push(`日发 ${limits.daily_send_quota} 封`);
  if (limitBits.length > 0) lines.push(`频率限制：${limitBits.join('、')}`);
  const capBits = [];
  if (constraints.max_attachment_count) capBits.push(`最多 ${constraints.max_attachment_count} 个附件`);
  if (constraints.max_attachment_size_bytes) capBits.push(`单文件 ≤ ${fmtBytes(constraints.max_attachment_size_bytes)}`);
  if (constraints.max_total_attachments_size_bytes) capBits.push(`合计 ≤ ${fmtBytes(constraints.max_total_attachments_size_bytes)}`);
  if (capBits.length > 0) lines.push(`附件上限：${capBits.join('、')}`);
  return lines.join('\n');
}

/** ListMessages / SearchMessages 的统一列表渲染。 */
export function formatMessageList(payload, { title = '邮件列表' } = {}) {
  const body = unwrapData(payload);
  const messages = extractMessages(body);
  const pagination = body.pagination ?? {};
  const nextCursor = pagination.next_cursor || body.next_cursor || '';
  if (messages.length === 0) return `${title}：没有匹配的邮件。`;
  const lines = [`${title}：共 ${messages.length} 封${nextCursor ? '（还有下一页）' : ''}`];
  for (const msg of messages) {
    const flags = [];
    if (msg.is_read === false) flags.push('未读');
    if (Array.isArray(msg.attachments) ? msg.attachments.length > 0 : msg.has_attachments === true) flags.push('有附件');
    const flagText = flags.length > 0 ? ` [${flags.join('/')}]` : '';
    const dirName = msg.dir?.dir_name;
    const dirText = dirName ? ` (${dirName})` : '';
    lines.push(`- ${msg.message_id || msg.id || '(无 id)'} | ${fmtTime(msg.created_at || msg.date || msg.sent_at || msg.received_at)} | 发件人 ${addrs(msg.from ? [msg.from] : msg.sender)}${dirText} | 主题 ${msg.subject || '(无主题)'}${flagText}`);
    if (msg.snippet) {
      const snippet = String(msg.snippet).replace(/\s+/g, ' ').trim();
      if (snippet) lines.push(`  摘要：${snippet.slice(0, 160)}${snippet.length > 160 ? '…' : ''}`);
    }
  }
  if (nextCursor) lines.push(`next_cursor: ${nextCursor}`);
  return lines.join('\n');
}

/**
 * 从各种可能的形状里取出邮件数组。
 * 实测网关把列表直接放在 data 上（data 是数组），不是 data.messages；
 * 但搜索接口有可能是 data.messages —— 两种都接住。
 */
export function extractMessages(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.list)) return body.list;
  return [];
}

export function formatMessageDetail(payload) {
  const body = normalizeMessage(unwrapData(payload));
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const lines = [];
  lines.push(`发件人：${addrs(body.from ? [body.from] : body.sender)}`);
  lines.push(`收件人：${addrs(body.to ?? body.recipients)}`);
  if (body.cc) lines.push(`抄送：${addrs(body.cc)}`);
  lines.push(`主题：${body.subject || '(无主题)'}`);
  lines.push(`时间：${fmtTime(body.created_at || body.date || body.sent_at || body.received_at)}`);
  if (body.message_id || body.id) lines.push(`message_id：${body.message_id || body.id}`);
  if (body.dir?.dir_name) lines.push(`所在文件夹：${body.dir.dir_name}`);
  lines.push('邮件正文：');
  // 网关用 body + body_format 表达正文类型（HTML / PLAIN / MARKDOWN），
  // 不是分开的 body_text / body_html。按声明格式处理，别把 HTML 当纯文本倒出来。
  const rawBody = body.body ?? body.body_text ?? body.text ?? body.content ?? '';
  const format = String(body.body_format ?? '').toUpperCase();
  const looksHtml = typeof rawBody === 'string' && /<\s*(!doctype|html|body|div|p|table)[\s>]/i.test(rawBody.slice(0, 400));
  if (typeof rawBody === 'string' && rawBody.trim() !== '') {
    if (format === 'HTML' || (format === '' && looksHtml)) {
      lines.push('\t（正文为 HTML，已去除标签与样式）');
      const cleaned = stripHtml(rawBody);
      for (const line of cleaned.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) lines.push(`\t${trimmed}`);
      }
    } else {
      for (const line of rawBody.split(/\r?\n/)) lines.push(`\t${line}`);
    }
  } else {
    lines.push('\t（空）');
  }
  lines.push('附件：');
  if (attachments.length === 0) {
    lines.push('\t无');
  } else {
    for (const att of attachments) {
      const size = att.size ?? att.size_bytes ?? att.content_length;
      lines.push(`\t${att.filename || att.name || '(未命名)'} (${fmtBytes(size)}) attachment_id=${att.attachment_id || att.id || '?'}`);
    }
  }
  return lines.join('\n');
}

/** 单封邮件可能又被包一层（{ data: {...} } 或 { message: {...} }）。 */
export function normalizeMessage(value) {
  let node = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
    if (node.message && typeof node.message === 'object') {
      node = node.message;
      continue;
    }
    if (node.message_id !== undefined || node.subject !== undefined || node.from !== undefined) return node;
    if (node.data === undefined) return node;
    node = node.data;
  }
  return node ?? {};
}

export function formatAttachmentList(payload, messageId) {
  const body = unwrapData(payload);
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : Array.isArray(body) ? body : [];
  if (attachments.length === 0) return `邮件 ${messageId} 没有附件。`;
  const lines = [`邮件 ${messageId} 的附件：共 ${attachments.length} 个`];
  for (const att of attachments) {
    lines.push(`- ${att.filename || att.name || '(未命名)'} | ${fmtBytes(att.size ?? att.size_bytes)} | ${att.content_type || att.mime_type || '未知类型'} | attachment_id: ${att.attachment_id || att.id || '?'}`);
  }
  return lines.join('\n');
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

/** 收件人字符串 → {email,name}[]；支持 "Name <a@b.c>"、"a@b.c"，可混写。 */
export function parseRecipients(input) {
  if (input === undefined || input === null) return undefined;
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const email = item.email || item.address;
      if (email) out.push({ email: String(email), ...(item.name ? { name: String(item.name) } : {}) });
      continue;
    }
    if (typeof item !== 'string') continue;
    for (const piece of item.split(/[,;]/)) {
      const text = piece.trim();
      if (!text) continue;
      const match = /^(.*?)<([^>]+)>$/.exec(text);
      if (match) {
        const name = match[1].trim().replace(/^"|"$/g, '');
        out.push({ email: match[2].trim(), ...(name ? { name } : {}) });
      } else {
        out.push({ email: text });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}
