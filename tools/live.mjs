// 模拟注册后的执行路径：apply() 拿到的 wrapped tool 直接跑
import { apply } from 'dsh-qqmail';
const reg = [];
const ctx = {
  tools: { register: (d) => { reg.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 3100 },
};
apply(ctx, { promptSection: true });
const list = reg.find(t => t.name === 'qqmail_list_messages');
const me = reg.find(t => t.name === 'qqmail_get_me');
console.log('--- get_me via wrapped execute ---');
console.log((await me.execute({}, { signal: AbortSignal.timeout(60000) })).text.slice(0, 200));
console.log('\n--- list via wrapped execute (limit 2) ---');
console.log((await list.execute({ limit: 2 }, { signal: AbortSignal.timeout(60000) })).text.slice(0, 400));
