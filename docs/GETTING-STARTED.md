# 从零开始使用 dsh-qqmail

**最常见的情况：你什么都不用配。** 装完插件直接说“看看我邮箱”就行。

为什么：插件会优先借用你本机 WorkBuddy 里已有的 QQ 邮箱授权。整个过程中你**一次码都不用扫**，也不用改任何文件。

---

## 第 0 步：前提

| 条件 | 要求 | 怎么查 |
|---|---|---|
| DeepSeek Harness 桌面版 | 能打开、能对话 | 打开 `DeepSeek Harness.exe` |
| Node.js | **22 或更高** | `node --version` |
| QQ 邮箱授权 | 见下面"三种情形" | — |

Node 必须 ≥ 22：插件用了 `fetch`、`AbortSignal.any`、`crypto.hkdfSync`。

---

## 第 1 步：拿代码

```bash
mkdir -p ~/.dsh/plugins
git clone https://github.com/0Sakura721/dsh-qqmail.git ~/.dsh/plugins/dsh-qqmail
```

Windows 上 `~/.dsh/plugins/` 就是 `C:\Users\<你>\.dsh\plugins\`。

放在别处也行，但 DSH 用软链接指向这个目录，删了文件夹插件就失效。

---

## 第 2 步：装进 DSH

1. 打开 DSH → **设置 → 插件**
2. 选「本地安装 / 从目录安装」
3. 选 `~/.dsh/plugins/dsh-qqmail` 这个**目录**
4. 确认

或者直接跟我说：

> 帮我装插件，目录：C:\Users\<你>\.dsh\plugins\dsh-qqmail

**装好的判据**：能看到 13 个以 `qqmail_` 开头的工具。工具注册不需要授权，所以"工具出现了"就等于插件装好了。

---

## 第 3 步：授权——大概率你什么都不用做

### 情形 A：电脑装过 WorkBuddy，且绑过 QQ 邮箱 —— **零操作**

直接说一句：

> 我的 QQ 邮箱授权到什么状态了？

它会回你主账号、权限、限额。到这儿就结束了，**没有二维码，没有文件要改**。

原理：插件从 `~/.workbuddy/connectors/<userId>/` 解开你已有的 OAuth 令牌，接管续期，
并把它写进 `~/.dsh/qqmail/credentials.json`（权限 0600）。

### 情形 B：没有 WorkBuddy —— 走扫码

说：

> 帮我授权 QQ 邮箱

我会调 `qqmail_login`，在终端画出二维码，你用手机 QQ 扫一次、确认即可。

扫码这条路的限制要知道：
- 手机和电脑要能互通（回调用 `127.0.0.1`，**同一台机器**最稳；跨设备需在同一局域网并放通端口）
- 二维码 5 分钟内有效
- 扫完手机上显示"授权成功"页面，就可以关掉了

### 情形 C：想手工放一条令牌

创建 `~/.dsh/qqmail/credentials.json`：

```json
{ "refreshToken": "<你的 refresh token>" }
```

**只有这一行是必需的**。`serverUrl` 走默认网关，`clientId` 退回内置公共 id，
`accessToken` 缺失时会立刻用 refreshToken 换新的。

令牌从哪来：用插件自带解密器从 WorkBuddy 直接解出来。

```bash
cd ~/.dsh/plugins/dsh-qqmail
node -e "import('./lib/workbuddy.js').then(m=>{const r=m.importFromWorkBuddy(); console.log(r.ok?JSON.stringify(r.record,null,2):r.reason)})"
```

---

## 第 4 步：开始用

不需要记工具名，说人话：

**看**
```
看看我最近收到的邮件
有没有未读邮件
搜一下主题里带「发票」的邮件
这封邮件有什么附件？
```

**发**（会先弹一张确认卡）
```
给 someone@example.com 发封邮件，主题「周报」
把这封回复一下，说我明天处理
附件在 D:/report.pdf，一起发过去
```

**删**（同样要确认）
```
把这封移到垃圾箱
清空垃圾箱
```

### 发信卡在确认卡片上是正常的

第一次调用发信，服务端一定返回 42801，插件把摘要和 `confirmation_token` 交给模型，
模型弹确认卡。

**你点确认** → 带着 token 重发 → 真的发出。
**你不点** → 什么都不会发生（我实测确认过，`sent` 文件夹一封都没有）。

令牌约 5 分钟过期，放着不管会告诉你作废、需要重来。

---

## 常见问题

**Q：装上但看不到 `qqmail_*` 工具？**
看设置里插件是否 enabled，以及 profile 的 `package.json` 里 `dsh.profile.bundles`
有没有 `dsh-qqmail`。改完要重载 DSH。

**Q：说「还没有 QQ 邮箱授权」？**
直接说“帮我授权 QQ 邮箱”，或看情形 B/C。

**Q：能读不能发？**
`qqmail_get_me` 看 `scopes`。缺 `mail:send` 就得重新授权。

**Q：报限速？**
网关 10 次/分钟、200 次/小时、日发 2000 封。

**Q：附件传不上去？**
上限 3 个、单文件 1MB、合计 3MB，服务端定的。插件会先在本地校验。

**Q：换电脑？**
`~/.dsh/qqmail/` 整个目录带走（含 `credentials.json`）。里面有明文令牌，别放公共网盘。

---

## 关于 WorkBuddy 的令牌回封

插件续期后会**把新令牌加密写回 WorkBuddy 的凭据文件**。

必须这么做：QQ 邮箱的 `refresh_token` 一次性轮换，插件一续期，WorkBuddy 原来那条就作废了。
不回封的话，你用插件越勤，WorkBuddy 越早失效。

不想让插件碰那些文件，在 `~/.dsh/qqmail/config.json` 里关掉：

```json
{ "workbuddyReseal": false, "workbuddyAutoImport": false }
```

代价是两边各自独立，**同一时刻只有一边能续期成功**，另一边下次用会失败并要求重新授权。
