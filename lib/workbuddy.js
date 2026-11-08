/**
 * dsh-qqmail / lib/workbuddy.js
 *
 * 从 WorkBuddy 连接器目录里"借"出已授权的 QQ 邮箱 OAuth 令牌，免去二次扫码。
 *
 * 加密方案逆向自 WorkBuddy 桌面端 app.asar 里的 CredentialFieldCipher：
 *   header = { scheme: 'aes-256-gcm', kdf: 'hkdf-sha256', salt(b64,16B), userIdCheck(b64), keyCheck(b64) }
 *   ikm    = masterKey(32B) || userId(utf8)
 *   aesKey = HKDF-SHA256(ikm, salt, info = 'workbuddy-oauth-credentials-v1', 32B)
 *   aad    = `${userId}|${serverKey}|${fieldName}`
 *   box    = { iv(b64,12B), tag(b64,16B), ct(b64) }
 *
 * 校验顺序按原实现：computeCheck(value, salt) = SHA256(value||salt).digest().subarray(0,16).toString('base64')
 *   先验 userIdCheck 证明 userId 正确，再验 keyCheck 证明 masterKey 正确 —— 两者都过才解密。
 * 这样即便某个字段换了编码方式，也不会静默拿到错误密钥去解出一堆乱码。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORKBUDDY_CONNECTORS, log } from './paths.js';

const KDF_INFO = Buffer.from('workbuddy-oauth-credentials-v1', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const CHECK_LEN = 16;

function computeCheck(value, salt) {
  return crypto.createHash('sha256').update(value).update(salt).digest().subarray(0, CHECK_LEN).toString('base64');
}

function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.iv === 'string' && typeof value.tag === 'string' && typeof value.ct === 'string';
}

/**
 * 枚举 WorkBuddy 连接器目录，找出所有带 mcpOAuth 记录的 userId。
 * @returns {Array<{userId: string, dir: string, cred: object, master: Buffer}>}
 */
export function listWorkBuddyStores() {
  let entries;
  try {
    entries = fs.readdirSync(WORKBUDDY_CONNECTORS, { withFileTypes: true });
  } catch {
    return [];
  }
  const stores = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(WORKBUDDY_CONNECTORS, entry.name);
    const credFile = path.join(dir, '.credentials.v3.json');
    const keyFile = path.join(dir, '.master.key');
    let cred;
    try {
      cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    } catch {
      continue;
    }
    let master;
    try {
      master = fs.readFileSync(keyFile);
    } catch {
      continue;
    }
    if (master.length !== KEY_LEN) continue;
    if (!cred || typeof cred !== 'object' || !cred.mcpOAuth) continue;
    stores.push({ userId: entry.name, dir, cred, master });
  }
  return stores;
}

/**
 * 用 header 里的 userIdCheck / keyCheck 验证 (userId, masterKey) 这一对是对的。
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyHeader(header, userId, masterKey) {
  if (!header || header.scheme !== 'aes-256-gcm' || header.kdf !== 'hkdf-sha256') {
    return { ok: false, reason: 'malformed-header' };
  }
  let salt;
  try {
    salt = Buffer.from(header.salt, 'base64');
  } catch {
    return { ok: false, reason: 'malformed-salt' };
  }
  if (salt.length !== SALT_LEN) return { ok: false, reason: 'salt-length' };
  if (computeCheck(Buffer.from(userId, 'utf8'), salt) !== header.userIdCheck) {
    return { ok: false, reason: 'userId-mismatch' };
  }
  if (computeCheck(masterKey, salt) !== header.keyCheck) {
    return { ok: false, reason: 'key-mismatch' };
  }
  return { ok: true };
}

function deriveAesKey(masterKey, userId, salt) {
  const ikm = Buffer.concat([masterKey, Buffer.from(userId, 'utf8')]);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, KDF_INFO, KEY_LEN));
}

function decryptField(aesKey, envelope, aad) {
  if (!isEnvelope(envelope)) throw new Error('envelope shape invalid');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error(`iv length ${iv.length}, expect ${IV_LEN}`);
  if (tag.length !== TAG_LEN) throw new Error(`tag length ${tag.length}, expect ${TAG_LEN}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * 把一条 mcpOAuth 记录解成明文令牌。serverKey 形如 `qq-mail|<hash>`。
 */
export function decryptOAuthEntry(store, serverKey) {
  const header = store.cred.encryption;
  const verified = verifyHeader(header, store.userId, store.master);
  if (!verified.ok) throw new Error(`header verify failed: ${verified.reason}`);
  const salt = Buffer.from(header.salt, 'base64');
  const aesKey = deriveAesKey(store.master, store.userId, salt);
  const entry = store.cred.mcpOAuth[serverKey];
  if (!entry) throw new Error(`no mcpOAuth entry for ${serverKey}`);
  const aadOf = (fieldName) => Buffer.from(`${store.userId}|${serverKey}|${fieldName}`, 'utf8');
  const out = {
    serverKey,
    serverName: entry.serverName,
    serverUrl: entry.serverUrl,
    tokenType: entry.tokenType || 'Bearer',
    scope: entry.scope || '',
    expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : 0,
    accessTokenRecoverable: entry.accessTokenRecoverable === true,
    clientId: store.cred.mcpClientInfo?.[serverKey]?.client_id || '',
    redirectUris: store.cred.mcpClientInfo?.[serverKey]?.redirect_uris || [],
    userId: store.userId,
  };
  if (isEnvelope(entry.accessToken)) out.accessToken = decryptField(aesKey, entry.accessToken, aadOf('accessToken'));
  if (isEnvelope(entry.refreshToken)) out.refreshToken = decryptField(aesKey, entry.refreshToken, aadOf('refreshToken'));
  return out;
}

/**
 * 扫描所有 WorkBuddy store，返回第一条 QQ 邮箱 OAuth 记录。
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
export function importFromWorkBuddy({ serverUrlHint = 'api.mail.qq.com' } = {}) {
  const stores = listWorkBuddyStores();
  if (stores.length === 0) return { ok: false, reason: 'no-workbuddy-store' };
  const failures = [];
  for (const store of stores) {
    for (const serverKey of Object.keys(store.cred.mcpOAuth || {})) {
      const entry = store.cred.mcpOAuth[serverKey];
      const url = typeof entry?.serverUrl === 'string' ? entry.serverUrl : '';
      if (!url.includes(serverUrlHint)) continue;
      try {
        const record = decryptOAuthEntry(store, serverKey);
        if (!record.refreshToken) {
          failures.push(`${serverKey}: no refresh token`);
          continue;
        }
        log(`workbuddy import ok: serverKey=${serverKey} userId=${store.userId} scope=${record.scope}`);
        return { ok: true, record };
      } catch (error) {
        failures.push(`${serverKey}: ${error.message}`);
      }
    }
  }
  return { ok: false, reason: failures.length > 0 ? failures.join('; ') : 'no-qqmail-oauth-entry' };
}
