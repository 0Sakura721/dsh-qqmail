/**
 * dsh-qqmail / lib/seal.js
 *
 * workbuddy.js 的解密反向：把明文令牌重新封回 WorkBuddy 的密文信封。
 *
 * 为什么需要它：QQ 邮箱的 refresh_token 是一次性轮换的 —— 用一次就作废，
 * 服务端返回一条新的。插件一旦用 WorkBuddy 那条续期，WorkBuddy 自己存的
 * 那条就死了，它的连接器会在 access token 到期后集体失效。
 * 所以每次续期后，除了写自己的 credentials.json，还要把新的 refresh_token
 * 按原格式封回去，两边共享同一条活令牌。
 */
import crypto from 'node:crypto';

const KDF_INFO = Buffer.from('workbuddy-oauth-credentials-v1', 'utf8');
const IV_LEN = 12;
const KEY_LEN = 32;

function deriveAesKey(masterKey, userId, salt) {
  const ikm = Buffer.concat([masterKey, Buffer.from(userId, 'utf8')]);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, KDF_INFO, KEY_LEN));
}

/**
 * 加密一个字段，产出 {iv, tag, ct} 三元组（全部 base64）。
 * @param {Buffer} aesKey
 * @param {string} plaintext
 * @param {Buffer} aad
 */
export function sealField(aesKey, plaintext, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * 就地把新令牌写回某个 store 的 mcpOAuth 条目。
 * @param {object} store  listWorkBuddyStores() 的元素
 * @param {string} serverKey
 * @param {{accessToken?: string, refreshToken?: string, expiresAt?: number, scope?: string, tokenType?: string}} tokens
 * @returns {{ok: boolean, reason?: string}}
 */
export function resealStore(store, serverKey, tokens) {
  try {
    const salt = Buffer.from(store.cred.encryption.salt, 'base64');
    const aesKey = deriveAesKey(store.master, store.userId, salt);
    const entry = store.cred.mcpOAuth[serverKey];
    if (!entry) return { ok: false, reason: 'entry-missing' };
    const aadOf = (field) => Buffer.from(`${store.userId}|${serverKey}|${field}`, 'utf8');
    if (typeof tokens.accessToken === 'string') {
      entry.accessToken = sealField(aesKey, tokens.accessToken, aadOf('accessToken'));
    }
    if (typeof tokens.refreshToken === 'string') {
      entry.refreshToken = sealField(aesKey, tokens.refreshToken, aadOf('refreshToken'));
    }
    if (typeof tokens.expiresAt === 'number') entry.expiresAt = tokens.expiresAt;
    if (typeof tokens.scope === 'string' && tokens.scope) entry.scope = tokens.scope;
    if (typeof tokens.tokenType === 'string' && tokens.tokenType) entry.tokenType = tokens.tokenType;
    return { ok: true, cred: store.cred };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
