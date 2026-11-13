# 完全独立使用（不依赖 WorkBuddy）

插件本身就是完整的 QQ 邮箱客户端：自己授权、自己续期、自己存令牌。
WorkBuddy 只是可选的“省掉首次扫码”的便捷通道，不是依赖。

按本文操作后，**删掉 WorkBuddy 也不影响任何功能**。

---

## 一、默认已是独立模式

从 `dsh-qqmail` 1.1.0 起，默认配置是：

```json
{
  "workbuddyAutoImport": false,   // 不读 WorkBuddy 的凭据
  "workbuddyReseal": false        // 不回写 WorkBuddy 的文件
}
```

也就是说：**插件完全不碰 `~/.workbuddy/` 目录**。

想让插件借用本机已有的 WorkBuddy 授权（省掉首次扫码），才需要显式打开这两项。

---

## 二、首次授权（只做一次）

### 方式 A：浏览器授权（推荐）

1. 跟我说：「帮我授权 QQ 邮箱，给链接就行」
2. 我调 `qqmail_login` 的 `as_link` 模式，给你一条带好 PKCE 参数的授权链接
3. 在浏览器打开，确认授权
4. 两种情况：
   - **回跳成功**：页面显示"授权成功"，插件自动完成
   - **显示"无法访问"**：把地址栏里那段完整 URL 复制回来给我 —— 里面带 `code`，我用它换令牌

之所以会出现第二种情况：回调地址是本机 `127.0.0.1:<port>`，如果那一刻没有进程在监听，
浏览器自然打不开。但 `code` 已经在 URL 里了，不影响使用。

### 方式 B：终端扫码

跟我说「帮我授权 QQ 邮箱」，我在终端画二维码，手机 QQ 扫一次确认。

前提：手机和电脑要能互通（回调用 `127.0.0.1`，**同一台机器**最稳）。
跨设备时手机访问不到电脑的 `127.0.0.1`，这种情况走方式 A。

### 方式 C：手工放一条令牌

`~/.dsh/qqmail/credentials.json`：

```json
{ "refreshToken": "<你的 refresh token>" }
```

只有这一行是必需的。

---

## 三、授权之后

插件把令牌存在 `~/.dsh/qqmail/credentials.json`（权限 `0600`），并自己做续期：

- access token 到期前 90 秒自动用 refresh token 换新的
- QQ 邮箱的 refresh token **一次性轮换**，所以每次续期后立刻落盘
- 全程不读也不写 `~/.workbuddy/`

验证独立性：

```bash
# 1. 确认凭据来源是插件自己
node -e "console.log(require(process.env.USERPROFILE+'/.dsh/qqmail/credentials.json').importedFrom)"
# 期望输出：builtin-scan-login

# 2. 假设性地把 WorkBuddy 目录改名（不要真删），插件应照常工作
#    Windows：
#    ren %USERPROFILE%\.workbuddy .workbuddy.bak
#    然后随便调一个 qqmail_* 工具，应正常返回
```

---

## 四、WorkBuddy 与插件的关系（若两者都用）

QQ 邮箱的 `refresh_token` 一次性轮换：谁用了那条，另一方的就作废。

- **独立模式（默认）**：插件用自己的令牌，与 WorkBuddy 互不影响
- **借用模式**（手动打开 `workbuddyAutoImport`）：插件复用 WorkBuddy 的令牌，
  续期时必须回写（`workbuddyReseal: true`），否则 WorkBuddy 会失效

两种模式不要混用。开关都在 `~/.dsh/qqmail/config.json`。

---

## 五、撤销授权

```bash
rm ~/.dsh/qqmail/credentials.json
```

插件侧立刻断开。要彻底撤销，去 QQ 邮箱设置里移除该应用授权。
