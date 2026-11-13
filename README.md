# dsh-qqmail

把 QQ 邮箱接进 DeepSeek Harness。13 个原生工具覆盖收、发、搜、附件，凭据复用本机已授权的
OAuth 令牌并自动续期 —— 不需要重新扫码。

> **第一次用？** 直接看 [从零开始使用](docs/GETTING-STARTED.md)。
>
> 大概率你**什么都不用配**：本机 WorkBuddy 若已绑定 QQ 邮箱，插件自动复用其授权，
> 不扫码、不改文件，装完直接说"看看我邮箱"即可。

## 它是怎么工作的

```
模型
 └─ qqmail_send_message（不带 token）
     └─ QQ 邮箱 MCP 网关 → 42801 + confirmation_token + operation_summary
         └─ 插件把摘要与 token 交给模型
             └─ 模型 ask_user_question → 用户点确认
                 └─ 模型带 token 重发 → 真正发出
```

服务端的两阶段确认是强制的、绕不过去。插件不做"替用户点头"的短路：不带
`confirmation_token` 的请求永远只拿到 42801，不会真的发信。删信、清空垃圾箱同理。

## 工具清单

| 工具 | 作用 | 需要确认 |
|---|---|---|
| `qqmail_login` | 初始化授权；有凭据时直接复用，零扫码 | — |
| `qqmail_get_me` | 授权状态、主/附属账号、权限、限额 | — |
| `qqmail_list_messages` | 列邮件（文件夹 / 时间 / 已读 / 附件筛选 + 翻页） | — |
| `qqmail_get_message` | 读单封全文（HTML 自动转纯文本） | — |
| `qqmail_search_messages` | 关键词 / 发件人 / 收件人 / 时间搜索 | — |
| `qqmail_list_attachments` | 列附件元信息 | — |
| `qqmail_download_attachment` | 附件落盘（默认系统下载目录） | — |
| `qqmail_send_message` | 发新信 | ✓ |
| `qqmail_reply_message` | 回复（可 reply_all） | ✓ |
| `qqmail_forward_message` | 转发（可带原附件） | ✓ |
| `qqmail_delete_message` | 移入垃圾箱（30 天可恢复） | ✓ |
| `qqmail_permanent_delete_message` | 永久删除 | ✓ |
| `qqmail_clear_trash` | 清空垃圾箱 | ✓ |

## 安装

DSH 用 bundle 机制加载本插件，源码放在任意工作目录即可：

```bash
# 1. 把本仓库放到一个工作目录，例如 ~/.dsh/plugins/dsh-qqmail
# 2. 安装到 profile（把路径换成你本地实际路径）
plugin_manager install_bundle  action: install_bundle  target: <仓库绝对路径>
```

或者手动加进 profile 的 `package.json` 依赖 + `dsh.profile.bundles`，再让 Loader 重载。

装完后插件会自动注册 12 个工具，并把一段使用约定写进系统提示词。

## 授权：两条路

### 路一：从 WorkBuddy 借用（推荐，免扫码）

WorkBuddy 桌面端把 QQ 邮箱的 OAuth 令牌加密存在本地。插件能直接借用并接管续期：

- `~/.workbuddy/connectors/<userId>/.master.key` —— 32 字节主密钥
- `~/.workbuddy/connectors/<userId>/.credentials.v3.json` —— 密文令牌

首次调用工具时自动解密、落盘到 `~/.dsh/qqmail/credentials.json`（权限 `0600`）。

### 路二：手工放一条令牌

如果没有 WorkBuddy，自己拿一条带 `refresh_token` 的授权结果，写到
`~/.dsh/qqmail/credentials.json` 即可，字段：

```json
{
  "serverUrl": "https://api.mail.qq.com/mcp",
  "clientId": "<你的 OAuth client id>",
  "accessToken": "<access token>",
  "refreshToken": "<refresh token>",
  "expiresAt": 1794108777023,
  "scope": "alias:read mail:read mail:send mail:delete"
}
```

`clientId` 留空会退回内置的公共客户端 id。

## 加密方案（WorkBuddy 令牌怎么解开的）

逆向自 WorkBuddy 桌面端 `app.asar` 里的 `CredentialFieldCipher`：

```
header  = { scheme: 'aes-256-gcm', kdf: 'hkdf-sha256', salt(b64 16B), userIdCheck, keyCheck }
ikm     = masterKey(32B) || userId(utf8)
aesKey  = HKDF-SHA256(ikm, salt, info='workbuddy-oauth-credentials-v1', 32B)
aad     = `${userId}|${serverKey}|${fieldName}`
box     = { iv(b64 12B), tag(b64 16B), ct(b64) }
校验     = SHA256(value || salt).digest().subarray(0,16).base64
```

先验 `userIdCheck`（证明 userId 对），再验 `keyCheck`（证明 masterKey 对），两者都过才解密。
这样某个字段换了编码方式也不会静默用错密钥解出乱码。

### 令牌轮换：为什么必须"续期即回封"

QQ 邮箱的 `refresh_token` 是**一次性轮换**的 —— 用一次就作废，服务端返回一条新的。
所以插件每次续期后，除了写自己的 `credentials.json`，还会把新令牌**按原格式加密回
WorkBuddy 的凭据文件**（`lib/seal.js`）。不回封的话，插件跑得越勤，WorkBuddy 那边越早
集体失效。

网关对"已失效的 refresh_token"的回应是 **HTTP 200 + 空 body + `LogicRet: -21653`**，
不是标准的 4xx —— 插件单独识别这个形态，报 `REFRESH_TOKEN_DEAD` 而不是"网络异常"。

## 配置（可选）

`~/.dsh/qqmail/config.json`：

```json
{
  "downloadDir": "~/Downloads",
  "confirmTtlMs": 300000,
  "workbuddyAutoImport": true,
  "workbuddyReseal": true,
  "timeoutMs": 60000,
  "promptSection": true
}
```

同名键也可以在 `cordis.patch.yml` 的 `config` 里给（行配置优先于文件）。
`defaultAlias` 也可以填，但一般留空让它自动取主账号。

## 状态与日志

- `~/.dsh/qqmail/credentials.json` —— 当前令牌（`0600`）
- `~/.dsh/qqmail/qqmail.log` —— 续期、连接、回封记录（不含明文令牌）

授权失效时：删掉 `credentials.json`，下次调用会重新从 WorkBuddy 借用；若 WorkBuddy 侧
也失效，在 WorkBuddy 里重新扫一次码即可。

## 文件结构

```
index.js         插件入口：注册工具 + 提示词段
cordis.patch.yml 挂载声明（inject: [tools, systemPrompt]）
lib/mcp.js       Streamable-HTTP MCP 客户端（initialize / tools/list / tools/call）
lib/auth.js      令牌生命周期（加载 → 续期 → 落盘 → 回封）
lib/workbuddy.js WorkBuddy 凭据解密（HKDF + AES-256-GCM）
lib/seal.js      反向加密，把新令牌封回 WorkBuddy
lib/tools.js     12 个工具定义
lib/toolkit.js   参数 DSL → JSON Schema + 校验（不依赖 @deepseek-ai/dsh-tools）
lib/format.js    面向模型的文本整形（列表/详情/HTML 去标签）
lib/attachments.js 附件：路径 → base64+sha1+size，下载解码落盘
lib/paths.js     落盘位置集中管理
```

## 实现说明

**为什么不用 `defineTool`**：`@deepseek-ai/dsh-tools` 是随 dsh 安装包一起装的 peer，
profile 的 `node_modules` 里没有它 —— 插件从 profile 加载时 `import` 会解析失败。
所以 `lib/toolkit.js` 自己实现了参数 DSL 编译与校验（约 60 行），注册、调度、超时、
渲染仍然交给 `ctx.tools`。

**懒连接**：插件加载时不建立连接，第一次真正调工具才 `initialize`。这样即便凭据暂时
不可用，也不会把整个 profile 拖成 `failed`。

**GetMe 缓存 5 分钟**：几乎每个工具都要 `alias_id`，但不该每次都多打一发（网关限速
10 次/分钟）。

## 自检脚本

`tools/` 下是排障用的脚本，都用真实账号跑，不写死任何令牌或地址：

```bash
# 从 profile 目录跑，包名才能解析
cd ~/.dsh/profiles/<你的 profile>

node <仓库>/tools/diag.mjs         # 凭据 + 连接 + 工具清单 + 主账号
node <仓库>/tools/live.mjs         # 走注册后的 wrapped execute 路径
node <仓库>/tools/tools-run.mjs    # 逐个跑读取类工具
node <仓库>/tools/tools-run.mjs --send-to me@example.com   # 额外验证二次确认第一阶段
node <仓库>/tools/check-sent.mjs   # 确认自检信没有真的发出
node <仓库>/tools/dead.mjs         # 用伪造令牌验证 REFRESH_TOKEN_DEAD 分类
node <仓库>/tools/recover.mjs <json>  # 令牌断链后恢复并双向回封
```

`tools/recover.mjs` 是断链急救：传入任意含 `refresh_token` 的 JSON，续期一次并把结果同时
写回 `~/.dsh/qqmail/credentials.json` 和 WorkBuddy 的 `.credentials.v3.json`。

## 已知边界

- 依赖 QQ 邮箱官方 MCP 网关 `https://api.mail.qq.com/mcp` 与其 OAuth 服务
- 附件上限由服务端决定（实测 3 个 / 单文件 1MB / 合计 3MB），插件会在本地先校验一遍
- 网关限速 10 次/分钟、200 次/小时，高频批量操作会被拒
- 只覆盖网关暴露的 12 个工具；没有 POP3/IMAP 直连路径

## License

MIT
