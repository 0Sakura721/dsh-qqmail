/**
 * dsh-qqmail / lib/attachments.js
 *
 * 附件在 API 层是 Base64 内联的，模型没法（也不该）手工造 Base64。
 * 这里把它换成本地路径：发信时读文件 → base64 + sha1 + size；下载时解码写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

export function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * 读本地文件 → API 需要的附件对象。
 * @param {string} filePath
 * @param {string} [displayName]
 */
export function buildAttachment(filePath, displayName) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`不是文件：${resolved}`);
  const buffer = fs.readFileSync(resolved);
  return {
    filename: displayName || path.basename(resolved),
    content_type: guessContentType(resolved),
    content: buffer.toString('base64'),
    size: buffer.length,
    sha1: crypto.createHash('sha1').update(buffer).digest('hex'),
  };
}

/**
 * 批量：字符串路径或 {path,name} 混写都可以。
 * @param {Array<string|{path:string,name?:string}>|undefined} spec
 */
export function buildAttachments(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return undefined;
  return spec.map((item) => {
    if (typeof item === 'string') return buildAttachment(item);
    if (item && typeof item === 'object' && typeof item.path === 'string') return buildAttachment(item.path, item.name);
    throw new Error('attachments 每项应为文件路径字符串或 {path,name}');
  });
}

/** 提前做本地校验，避免把服务端的限制错误带进上下文。 */
export function validateAttachmentBudget(parts, constraints) {
  const maxCount = Number(constraints?.max_attachment_count) || 3;
  const maxOne = Number(constraints?.max_attachment_size_bytes) || 1024 * 1024;
  const maxTotal = Number(constraints?.max_total_attachments_size_bytes) || 3 * 1024 * 1024;
  if (parts.length > maxCount) {
    throw new Error(`附件数量超限：${parts.length} 个，上限 ${maxCount} 个`);
  }
  let total = 0;
  for (const part of parts) {
    if (part.size > maxOne) {
      throw new Error(`附件 ${part.filename} 有 ${part.size} 字节，超过单文件上限 ${maxOne} 字节`);
    }
    total += part.size;
  }
  if (total > maxTotal) {
    throw new Error(`附件合计 ${total} 字节，超过上限 ${maxTotal} 字节`);
  }
  return { total, count: parts.length };
}

/**
 * 下载附件：解码 Base64 落盘，文件名做安全化处理。
 * @returns {{path: string, bytes: number}}
 */
export function saveAttachment({ base64, filename, dir }) {
  const safeName = sanitizeFilename(filename || 'attachment.bin');
  const targetDir = path.resolve(dir);
  fs.mkdirSync(targetDir, { recursive: true });
  const buffer = Buffer.from(base64 ?? '', 'base64');
  let target = path.join(targetDir, safeName);
  if (fs.existsSync(target)) {
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext);
    let index = 1;
    while (fs.existsSync(target)) {
      target = path.join(targetDir, `${stem}-${index}${ext}`);
      index += 1;
    }
  }
  fs.writeFileSync(target, buffer);
  return { path: target, bytes: buffer.length };
}

export function sanitizeFilename(name) {
  const base = path.basename(String(name).replace(/[\\/:*?"<>|]/g, '_')).trim();
  return base === '' || base === '.' || base === '..' ? 'attachment.bin' : base;
}
