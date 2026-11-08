// 用一条已被轮换作废的 refresh token 走完续期路径，验证错误分类与文案。
//
// 这里的 refreshToken 是刻意伪造的样本：格式和长度与真实令牌一致，但内容无效。
// 它能触发网关的 LogicRet: -21653，用来验证「空响应 + 200」这个陷阱被正确识别。
import { TokenManager } from '../lib/auth.js';
import { DEFAULT_CLIENT_ID } from '../lib/auth.js';

const tm = new TokenManager({ workbuddyAutoImport: false });

/** 造一条结构合法但必然失效的 refresh token（120 字符，base64 风格）。 */
function fakeRefreshToken() {
  const head = 'REVOKED0SAMPLE0AAAAAABgAA';
  const body = 'x'.repeat(120 - head.length);
  return head + body;
}

const fake = {
  serverKey: 'qq-mail|<server-key>',
  serverUrl: 'https://api.mail.qq.com/mcp',
  clientId: DEFAULT_CLIENT_ID,
  accessToken: 'stale',
  refreshToken: fakeRefreshToken(),
  expiresAt: 1,
};
tm.record = fake;

try {
  await tm.refresh();
  console.log('unexpected success');
  process.exit(1);
} catch (error) {
  console.log('code:', error.code);
  console.log('name:', error.name);
  console.log('message:', error.message);
  if (error.code !== 'REFRESH_TOKEN_DEAD') {
    console.error('期望 REFRESH_TOKEN_DEAD，实际拿到', error.code);
    process.exit(1);
  }
}
