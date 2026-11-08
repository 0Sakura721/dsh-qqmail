# 从零开始使用 dsh-qqmail

假设你现在手上什么都没有：没装 DSH、没有 QQ 邮箱授权、没装过任何插件。
跟着走完五步，就能在 DSH 里说"看看我邮箱有什么"并且真的看到。

---

## 第 0 步：确认前提

需要的东西只有三样：

| 条件 | 要求 | 怎么查 |
|---|---|---|
| DeepSeek Harness 桌面版 | 能正常打开、能对话 | 打开 `DeepSeek Harness.exe` |
| Node.js | **22 或更高** | 终端里跑 `node --version` |
| QQ 邮箱账号 | 能正常登录收信 | 浏览器打开 `mail.qq.com` |

Node 版本必须 ≥ 22：插件用了 `fetch`、`AbortSignal.any`、`crypto.hkdfSync`
这些 22 才稳定的 API。低于 22 会在加载阶段直接报错。

查 Node 版本：

```bash
node --version
# v24.19.0    ← 这样就对了
```

没有 Node 或版本太低，去 https://nodejs.org 装 LTS。

---

## 第 1 步：拿到插件代码

```bash
git clone https://github.com/0Sakura721/dsh-qqmail.git
cd dsh-qqmail
```

放哪都行，但**建议放在不会被清理的位置**。因为 DSH 用软链接指向这个目录，
你把文件夹删了插件就失效：

```bash
# 推荐：放到 DSH 自己的插件目录下，长期稳定
mkdir -p ~/.dsh/plugins
git clone https://github.com/0Sakura721/dsh-qqmail.git ~/.dsh/plugins/dsh-qqmail
```

Windows 上 `~/.dsh/plugins/` 就是 `C:\Users\<你>\.dsh\plugins\`。

---

## 第 2 步：装进 DSH

插件是 DSH 的 **bundle**，装进哪个 profile 就对该 profile 的所有会话生效。
大多数人只有 `desktop` 一个 profile。

### 方式 A：在 DSH 界面里装（推荐）

1. 打开 DSH，进入 **设置 → 插件**
2. 找到「本地安装 / 从目录安装」入口（不同版本措辞略有差异）
3. 选你刚才 clone 下来的**目录**（注意选目录本身，不是选里面的 `package.json`）
4. 确认后它会自己跑依赖安装并挂进配置树

装成功后，设置里的插件列表会出现 **QQ 邮箱**（图标是个带感叹号的信封），
描述是"把 QQ 邮箱接进 DSH：12 个原生工具…"。

### 方式 B：让 agent 装

在 DSH 里直接说：

```
帮我装插件，目录：C:\Users\<你>\.dsh\plugins\dsh-qqmail
```

agent 会调 `plugin_manager` 的 `install_bundle`，效果和方式 A 一样。

### 方式 C：手工改配置

不推荐，但确实可行。在 profile 的 `package.json` 里做两件事：

```json
{
  "dependencies": {
    "dsh-qqmail": "link:D:/path/to/dsh-qqmail"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-qqmail"
      ]
    }
  }
}
```

`link:` 后面写你实际的目录。改完重载 DSH。

### 怎么确认装上了

装好后，DSH 能看到的工具里应该多出 12 个以 `qqmail_` 开头的：

```
qqmail_get_me                      qqmail_send_message
qqmail_list_messages               qqmail_reply_message
qqmail_get_message                 qqmail_forward_message
qqmail_search_messages             qqmail_delete_message
qqmail_list_attachments            qqmail_permanent_delete_message
qqmail_download_attachment         qqmail_clear_trash
```

**注意：工具的注册不依赖凭据。** 没授权也能看到这 12 个工具，
只是调用时会告诉你需要授权。所以"工具出现了"等于"插件装好了"。

---

## 第 3 步：授权，二选一

插件自己不会跳浏览器扫码。**令牌必须从外部拿进来。**

### 路径一：你本机装过 WorkBuddy —— 零配置，自动借用

如果你电脑上有 WorkBuddy 桌面版，并且里面**绑过 QQ 邮箱连接器**，那就什么都不用做。

插件第一次被调用时会自动去读：

```
~/.workbuddy/connectors/<userId>/.master.key
~/.workbuddy/connectors/<userId>/.credentials.v3.json
```

解密出令牌后自己接管续期，并落盘到 `~/.dsh/qqmail/credentials.json`。

直接用一句话验证：

> 我的 QQ 邮箱授权到什么状态了？

如果它回你主账号、权限范围、限额——第 3 步就完了，跳到第 4 步。

### 路径二：没有 WorkBuddy —— 手工放一条令牌

这是**真正从零**的情况，需要你自己搞到一条 `refresh_token`。

创建文件 `~/.dsh/qqmail/credentials.json`（Windows 是
`C:\Users\<你>\.dsh\qqmail\credentials.json`）：

```json
{
  "serverUrl": "https://api.mail.qq.com/mcp",
  "clientId": "002e8cd14071aad2",
  "refreshToken": "<你的 refresh token>",
  "scope": "alias:read mail:read mail:send mail:delete"
}
```

**只有 `refreshToken` 是硬性必需的**，其他字段都有默认值。我实测过最小配置：

```json
{ "refreshToken": "<你的 refresh token>" }
```

光这一行就能跑通——`serverUrl` 会走默认的官方网关，`clientId` 会退回内置公共客户端 id，
`accessToken` 和 `expiresAt` 缺失时会立刻用 `refreshToken` 换一个新的。

**这条 refresh token 从哪来？** 三条现实可行的路：

**（1）从 WorkBuddy 的密文里解（有 WorkBuddy 但不想让它接管）**

用插件自带的解密器：

```bash
cd ~/.dsh/plugins/dsh-qqmail
node -e "
import('./lib/workbuddy.js').then(m => {
  const r = m.importFromWorkBuddy();
  if (r.ok) console.log(JSON.stringify(r.record, null, 2));
  else console.error('失败:', r.reason);
});
"
```

它会打印出完整记录（含明文 `refreshToken`），你自己挑要的字段写进
`credentials.json`。

**（2）从 WorkBuddy 的开发者工具里抓**

WorkBuddy 扫码授权的那一刻，网络面板里能看到发往
`https://wx.mail.qq.com/oauth/token` 的响应，里面就有 `access_token`
和 `refresh_token`。复制 `refresh_token` 即可。

**（3）自己走一遍 OAuth 授权码流程**

技术上可行，但**前提是你得有一个被网关信任的 `redirect_uri`**。我实测过：
`register` 端点会拒绝所有没登记过的回调地址（返回
`redirect_uri does not match any trusted platform`），所以自建客户端拿不到授权码。
可行的做法是复用一个已登记的客户端 id 与其 `redirect_uri`，然后用一个能接收
该协议的本地监听器接住回调——这已经超出"从零配置"的范围，不展开。

> **一句话结论：** 没有 WorkBuddy 的话，最省事的是让 WorkBuddy 扫一次码，
> 再用上面的（1）把令牌搬到 DSH。扫码这一步绕不过去，因为网关只信任它自己
> 登记过的客户端。

### 授权配错的典型症状

| 现象 | 原因 |
|---|---|
| `没有可用凭据（WorkBuddy 借用失败：no-workbuddy-store）` | 本机没有 WorkBuddy，或没绑 QQ 邮箱；走路径二 |
| `header verify failed: key-mismatch` | `.master.key` 被换过，WorkBuddy 需要重新授权 |
| `REFRESH_TOKEN_DEAD` | refresh token 已被用掉/轮换；重新拿一条 |
| `40101 Bearer token is missing` | `credentials.json` 里 `refreshToken` 写错或为空 |

日志在 `~/.dsh/qqmail/qqmail.log`，续期和回封都有记录（不含明文令牌）。

---

## 第 4 步：开始用

不需要记工具名，直接说人话。以下都是实测能跑通的句式：

**看**
```
看看我最近收到的邮件
帮我查一下有没有未读邮件
搜一下主题里带「发票」的邮件
读一下这封，message_id 是 msg_xxx
这封邮件有什么附件？
```

**发**（会先给你一张确认卡）
```
给 someone@example.com 发封邮件，主题「周报」，正文写一下本周进展
把这封邮件回复一下，说我明天处理
把这封转发给 another@example.com
附件在 D:/report.pdf，一起发过去
```

**删**（同样要确认）
```
把这封移到垃圾箱
清空垃圾箱
```

### 发信会卡在一张卡片上，这是设计而非故障

第一次调用发信工具，服务端一定返回 **42801**，插件把邮件摘要
（发件人 / 收件人 / 主题 / 附件数）和一枚 `confirmation_token` 交给模型，
模型弹出确认卡片。

**你点确认** → 模型带 token 重发 → 真的发出。
**你不点** → 什么都不会发生。

我实测确认过：只走第一阶段时，`sent` 文件夹里一封都没有。这个卡点是服务端强制的，
插件没有留后门。

`confirmation_token` 约 5 分钟过期。你放着不管，模型会告诉你作废、需要重来。

---

## 第 5 步：确认它真的在工作（可选）

想自己验一遍而不是只听我说，在插件目录下跑：

```bash
cd ~/.dsh/plugins/dsh-qqmail

# 凭据 + 连接 + 工具清单 + 主账号（全程只读）
node tools/diag.mjs
```

正常输出长这样：

```
scope: alias:read mail:read mail:send mail:delete
expired: false
primary: <你的主账号>
tools: 12 GetMe,ListMessages,GetMessage,SendMessage,...
```

再确认二次确认阶段确实没发信：

```bash
node tools/check-sent.mjs
# sent 文件夹条数: N
# 自检邮件是否发出: false
```

---

## 常见问题

**Q：装上但看不到 `qqmail_*` 工具？**
看设置里插件是否 enabled，以及 profile 的 `package.json` 里 `dsh.profile.bundles`
有没有 `dsh-qqmail`。改完要重载 DSH。

**Q：能读不能发？**
`qqmail_get_me` 看 `scopes`。缺 `mail:send` 就得重新授权，要带上这个 scope。
`mail:delete` 同理，缺了删信会 403。

**Q：报限速？**
网关是 10 次/分钟、200 次/小时、日发 2000 封。批量处理邮件时慢一点。

**Q：附件传不上去？**
上限 3 个、单文件 1MB、合计 3MB，服务端定的。插件会先在本地校验，
超了直接告诉你超多少，不会白跑一趟网络。

**Q：换了电脑 / 重装系统？**
`~/.dsh/qqmail/` 整个目录带走（含 `credentials.json`），新机器放到同位置就行。
注意那里面有明文令牌，别放公共网盘。

**Q：想撤销授权？**
删掉 `~/.dsh/qqmail/credentials.json` 就断开插件侧；
要彻底撤销，去 QQ 邮箱设置里移除该应用授权。

---

## 别忘了这一件事

插件会**把续期后的新令牌回封进 WorkBuddy 的凭据文件**。

这么做是因为 QQ 邮箱的 `refresh_token` 一次性轮换：插件一续期，WorkBuddy 原来存的那条
就作废了。不回封的话，你用插件越勤，WorkBuddy 那边越早失效。

如果你**不希望插件碰 WorkBuddy 的文件**，在
`~/.dsh/qqmail/config.json` 里关掉：

```json
{
  "workbuddyReseal": false,
  "workbuddyAutoImport": false
}
```

关掉之后两边各自独立，但**同一时刻只有一边能续期成功**——另一边会在你下次用它时失败并需要重新授权。
