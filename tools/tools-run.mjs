/**
 * tools/tools-run.mjs
 * 用真实账号把工具层逐个跑一遍（只做读取类，不真发信）。
 * 目的：验证 format/toolkit/别名解析在执行路径上都对，而不只是 diag 里对。
 *
 * 说明：末尾那段发信自检要用你自己的邮箱做收件人。
 * 不传 --send-to 就跳过，避免把别人的地址写进仓库。
 */
import { apply } from '../index.js';

const registered = [];
const fakeCtx = {
  tools: { register: (def) => { registered.push(def); return () => {}; } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 3100 },
};

apply(fakeCtx, { promptSection: false });
console.log('registered tools:', registered.length, registered.map((t) => t.name).join(', '));

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const exec = { signal: AbortSignal.timeout(120000) };

async function run(name, args) {
  const tool = byName[name];
  if (!tool) throw new Error('no tool ' + name);
  const out = await tool.execute(args, exec);
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  console.log(String(out.text).slice(0, 900));
  return out;
}

// 1. 授权状态
await run('qqmail_get_me', {});

// 2. 收件箱前 3 封
await run('qqmail_list_messages', { limit: 3 });

// 3. 搜索
await run('qqmail_search_messages', { q: 'qq.com', limit: 3 });

// 4. 取一封正文（用第 2 步拿到的 id）
const list = await run('qqmail_list_messages', { limit: 1 });
const firstId = list.data?.data?.[0]?.message_id ?? list.data?.messages?.[0]?.message_id ?? null;
console.log('\nfirst message id:', firstId);
if (firstId) {
  await run('qqmail_get_message', { message_id: firstId });
  await run('qqmail_list_attachments', { message_id: firstId });
}

// 5. 二次确认路径：只走第一阶段（不带 confirmation_token），不会真的发出去。
//    收件人从命令行取，没给就跳过。
const sendTo = process.argv.includes('--send-to')
  ? process.argv[process.argv.indexOf('--send-to') + 1]
  : null;
if (sendTo) {
  await run('qqmail_send_message', {
    to: sendTo,
    subject: '[dsh-qqmail] 自检，不应真的发出',
    body: '这是一次确认流程自检。若第一阶段没有被拦住，这封信会真的发出。',
  });
} else {
  console.log('\n（跳过发信自检：用 --send-to <你的邮箱> 才会跑）');
}
