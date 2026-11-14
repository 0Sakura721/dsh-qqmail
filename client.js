/**
 * dsh-qqmail / client.js
 *
 * 设置页「QQ 邮箱」：在这里扫码授权、看状态、断开授权。
 *
 * 为什么放在设置页：终端二维码要截图、要切窗口，而设置页就在 DSH 里，
 * 扫码、看权限、断开都在同一处完成。
 *
 * 数据面在同源路由 /dsh-qqmail/api/*（宿主半边的 lib/settings-api.js），
 * 这里只负责渲染与交互，不直接接触令牌。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqmail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/dsh-qqmail/api';
    const CSS_ID = 'dsh-qqmail/settings.css';

    const CSS = `
.dqm{max-width:720px;display:flex;flex-direction:column;gap:16px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
.dqm-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dqm-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.dqm-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dqm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;
  display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-l1)}
.dqm-row{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
.dqm-k{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}
.dqm-v{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
.dqm-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;
  padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2)}
.dqm-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.dqm-ok{color:var(--dsw-alias-state-success-primary)}.dqm-ok .dqm-dot{background:var(--dsw-alias-state-success-primary)}
.dqm-warn{color:var(--dsw-alias-state-warn-primary)}.dqm-warn .dqm-dot{background:var(--dsw-alias-state-warn-primary)}
.dqm-bad{color:var(--dsw-alias-state-error-primary)}.dqm-bad .dqm-dot{background:var(--dsw-alias-state-error-primary)}
.dqm-actions{display:flex;gap:8px;flex-wrap:wrap}
.dqm-btn{font:inherit;font-size:13px;height:32px;padding:0 14px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-primary);cursor:pointer}
.dqm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-l2)}
.dqm-btn:disabled{opacity:.55;cursor:default}
.dqm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-bg-base)}
.dqm-btn-primary:hover:not(:disabled){filter:brightness(1.06);
  background:var(--dsw-alias-brand-primary)}
.dqm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)}
.dqm-qr{display:flex;flex-direction:column;align-items:center;gap:10px;
  padding:12px 0 4px}
.dqm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;
  max-width:420px}
.dqm-err{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.dqm-scopes{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dqm-scope{font-size:11.5px;padding:1px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-secondary)}
`;

    function ensureStyle() {
      if (document.getElementById(CSS_ID)) return;
      const el = document.createElement('style');
      el.id = CSS_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function fmtTime(iso) {
      if (!iso) return '未知';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
        + `${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 把 scope 字符串拆成徽章。 */
    function ScopeList({ scope }) {
      const parts = String(scope || '').split(/\s+/).filter(Boolean);
      if (parts.length === 0) return h('span', { className: 'dqm-v' }, '未知');
      return h('div', { className: 'dqm-scopes' },
        parts.map((s) => h('span', { key: s, className: 'dqm-scope' }, s)));
    }

    function StatusBadge({ state }) {
      const map = {
        ok: { cls: 'dqm-ok', text: '已授权' },
        expired: { cls: 'dqm-warn', text: '令牌已过期' },
        none: { cls: 'dqm-bad', text: '未授权' },
      };
      const it = map[state] || map.none;
      return h('span', { className: `dqm-badge ${it.cls}` },
        h('span', { className: 'dqm-dot' }), it.text);
    }

    function SettingsPage() {
      const [status, setStatus] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [qr, setQr] = useState(null);
      const [error, setError] = useState(null);
      const pollRef = useRef(null);

      const stopPolling = useCallback(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      const loadStatus = useCallback(async () => {
        try {
          const res = await fetch(`${API}/status`, { headers: { Accept: 'application/json' } });
          if (res.status === 401 || res.status === 403) {
            setError('没有权限访问插件接口（会话未认证）。请在 DSH 客户端页面内操作，而不是直接用浏览器/curl 访问。');
            return;
          }
          if (!res.ok) {
            setError(`读取状态失败（HTTP ${res.status}）：路由未注册或宿主端异常，请确认插件已安装并重启。`);
            return;
          }
          const text = await res.text();
          if (!text) {
            setError('读取状态失败：服务端返回空响应，插件数据面可能尚未就绪。');
            return;
          }
          const data = JSON.parse(text);
          setStatus(data);
          setError(null);
        } catch (e) {
          setError(`读取状态失败：${e.message}`);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        ensureStyle();
        loadStatus();
        return stopPolling;
      }, [loadStatus, stopPolling]);

      const startLogin = useCallback(async () => {
        setError(null);
        setBusy(true);
        setQr(null);
        try {
          const res = await fetch(`${API}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const text = await res.text();
          const data = text ? JSON.parse(text) : {};
          if (!res.ok) {
            setError(data?.message || data?.error || `发起授权失败（HTTP ${res.status}）`);
            return;
          }
          if (!data.url) {
            setError('服务端没有返回授权链接，请检查插件是否就绪后重试。');
            return;
          }
          setQr(data.url);
          // 轮询授权进度
          stopPolling();
          pollRef.current = setInterval(async () => {
            try {
              const r = await fetch(`${API}/login`, { headers: { Accept: 'application/json' } });
              const t = await r.text();
              const s = t ? JSON.parse(t) : {};
              if (s.status === 'done') {
                stopPolling();
                setQr(null);
                await loadStatus();
              } else if (s.status === 'error') {
                stopPolling();
                setQr(null);
                setError(s.error || '授权失败');
              } else if (s.status === 'idle') {
                // 宿主那边已经清理（超时或另一处完成）
                stopPolling();
              }
            } catch {
              /* 轮询失败不作处理，下次再试 */
            }
          }, 1500);
        } catch (e) {
          setError(`发起授权失败：${e.message}`);
        } finally {
          setBusy(false);
        }
      }, [loadStatus, stopPolling]);

      const doLogout = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`${API}/logout`, { method: 'POST' });
          if (!res.ok) {
            const t = await res.text();
            const d = t ? JSON.parse(t) : {};
            setError(d.error || '断开失败');
          }
          stopPolling();
          setQr(null);
          await loadStatus();
        } catch (e) {
          setError(`断开失败：${e.message}`);
        } finally {
          setBusy(false);
        }
      }, [loadStatus, stopPolling]);

      const authorized = status?.authorized === true;
      const badge = authorized ? (status?.expired ? 'expired' : 'ok') : 'none';

      return h('div', { className: 'dqm' },
        h('div', { className: 'dqm-head' },
          h('div', null,
            h('h2', { className: 'dqm-title' }, 'QQ 邮箱'),
            h('p', { className: 'dqm-sub' }, '收发邮件、搜索、附件下载。令牌只存在本机。')),
          h(StatusBadge, { state: loading ? 'none' : badge })),

        error ? h('div', { className: 'dqm-err' }, error) : null,

        loading
          ? h('div', { className: 'dqm-card' }, h('span', { className: 'dqm-hint' }, '正在读取状态…'))
          : h('div', { className: 'dqm-card' },
            authorized
              ? [
                status?.account?.email
                  ? h('div', { key: 'acc', className: 'dqm-row' },
                    h('span', { className: 'dqm-k' }, '账号'),
                    h('span', { className: 'dqm-v' }, status.account.email))
                  : null,
                h('div', { key: 'scope', className: 'dqm-row' },
                  h('span', { className: 'dqm-k' }, '权限'),
                  h(ScopeList, { scope: status?.scope })),
                h('div', { key: 'exp', className: 'dqm-row' },
                  h('span', { className: 'dqm-k' }, '令牌到期'),
                  h('span', { className: 'dqm-v' }, fmtTime(status?.expiresAt))),
                h('div', { key: 'src', className: 'dqm-row' },
                  h('span', { className: 'dqm-k' }, '授权来源'),
                  h('span', { className: 'dqm-v' }, status?.importedFrom || '未知')),
              ].filter(Boolean)
              : h('span', { className: 'dqm-hint', style: { textAlign: 'left' } },
                '还没有授权。点下面的按钮，浏览器会自动打开授权页，登录 QQ 邮箱确认后即可（之后自动续期）。')),

        qr
          ? h('div', { className: 'dqm-card' },
            h('div', { className: 'dqm-qr' },
              h('div', { className: 'dqm-hint' },
                '浏览器已打开授权页。请在浏览器里登录 QQ 邮箱并确认授权，',
                '完成后本页会自动刷新。'),
              qr.startsWith('http')
                ? h('a', {
                  href: qr, target: '_blank', rel: 'noreferrer',
                  className: 'dqm-btn', style: { marginTop: '8px', textDecoration: 'none', display: 'inline-block' },
                }, '没打开？点这里手动打开授权页')
                : null,
              h('button', {
                type: 'button', className: 'dqm-btn', style: { marginTop: '8px' }, disabled: busy,
                onClick: () => { stopPolling(); setQr(null); },
              }, '取消')))
          : null,

        h('div', { className: 'dqm-actions' },
          h('button', {
            type: 'button',
            className: 'dqm-btn dqm-btn-primary',
            disabled: busy || Boolean(qr),
            onClick: startLogin,
          }, authorized ? '重新授权' : '开始授权'),
          authorized
            ? h('button', {
              type: 'button',
              className: 'dqm-btn dqm-btn-danger',
              disabled: busy,
              onClick: doLogout,
            }, '断开授权')
            : null,
          h('button', {
            type: 'button', className: 'dqm-btn', disabled: busy,
            onClick: () => { setLoading(true); loadStatus(); },
          }, '刷新状态')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle();
        ctx.effect(() => () => {
          const el = document.getElementById(CSS_ID);
          if (el) el.remove();
        });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-qqmail',
          order: 45,
          label: () => 'QQ 邮箱',
        }, SettingsPage));
      },
    };
  },
});
