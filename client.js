/**
 * everything-search —— Everything 文件搜索面板（客户端）
 * ---------------------------------------------------------------------------
 * 契约：
 *  - 整体走 window.__ModuleLoader__.load({ id, factory })，factory 内只能 require('react')
 *  - 不引入任何裸包、不用 iframe，全部用 React.createElement 渲染
 *  - 样式通过 useStylesheet() 注入 <style id="es-style">，比对 textContent 以支持热重载
 *  - 注册四个槽位：sidebar.panellist（入口图标）、main（面板主体）、
 *    conversation.session.header.utilities（右上角搜索栏）、shell.overlay（Hero 入口）
 *  - 每个槽位单独兜错：某个槽位名在宿主换代后消失，只少一个入口，不让整块界面挂掉
 */

/* 宿主换代兜底之一：加载器本身没了就安静退出。
   以前这里直接 `window.__ModuleLoader__.load(...)`，一旦宿主把模块加载器换掉或改名，
   顶层就抛 TypeError —— 而客户端 bundle 的顶层抛错会把同一个 bundle 里别的插件一起带崩。
   包一层 IIFE 只是为了能在顶层 return；里面的缩进不动，语义不变。 */
;(function boot(loader) {
  if (!loader || typeof loader.load !== 'function') return
  loader.load({
  id: 'everything-search',
  factory(require) {
    /* 兜底之二：react 取不到（宿主换了 factory 的参数形态）就返回空壳模块，
       同样不让一个 require 失败连累整个 bundle。 */
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }
    if (!React || typeof React.createElement !== 'function') return { inject: [], apply() {} }
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const PANEL_ID = 'everything-search'
    const API = '/api/plugins/everything-search'

    /* ------------------------------------------------------ 搜索历史 / 拖拽投递 */

    const HIST_KEY = 'es:history:v1'
    /* 存 50 条，弹层里默认只露 8 条、点「展开」看全部 —— 存得多是为了回访能翻到旧词，
       但一屏铺满 20 行会把弹层撑成一面墙，所以展示层单独收口。 */
    const HIST_MAX = 50
    const HIST_COLLAPSED = 8
    /* 历史态弹层宽度：只放关键词，比搜索结果窄一档 */
    const HIST_WIDTH = 300

    /** 读历史：localStorage 坏了也绝不让搜索栏跟着挂。 */
    function loadHistory() {
      try {
        const raw = window.localStorage.getItem(HIST_KEY)
        const arr = raw ? JSON.parse(raw) : []
        if (!Array.isArray(arr)) return []
        const seen = new Set()
        const out = []
        for (const x of arr) {
          if (typeof x !== 'string') continue
          const t = x.trim()
          if (!t) continue
          const k = t.toLowerCase()
          if (seen.has(k)) continue
          seen.add(k)
          out.push(t)
          if (out.length >= HIST_MAX) break
        }
        return out
      } catch {
        return []
      }
    }

    function saveHistory(list) {
      try {
        window.localStorage.setItem(HIST_KEY, JSON.stringify(list))
      } catch {
        /* 隐私模式 / 配额满：当成没记住 */
      }
    }

    /* 鼠标拖拽（pointer 版）的落点标记：同一时刻只高亮一个 composer。 */
    const dropMarks = []
    function markDropHost(el) {
      if (!el || dropMarks.indexOf(el) >= 0) return
      if (typeof el.setAttribute !== 'function') return
      el.setAttribute('data-es-drop', '1')
      dropMarks.push(el)
    }
    function clearDropMarks() {
      for (const el of dropMarks) {
        if (typeof el.removeAttribute === 'function') el.removeAttribute('data-es-drop')
      }
      dropMarks.length = 0
    }

    /* 拖到一半时跟着鼠标的小卡片；纯 DOM，不参与 React 渲染。 */
    function makeChip(label) {
      if (typeof document === 'undefined' || !document.createElement || !document.body) return null
      const el = document.createElement('div')
      if (!el || !el.style) return null
      el.textContent = String(label || '')
      el.style.cssText =
        'position:fixed;left:0;top:0;z-index:100002;pointer-events:none;max-width:300px;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 10px;border-radius:8px;' +
        'font:500 12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:rgba(32,36,42,.96);' +
        'color:#f4f6f8;border:1px solid #37699e;box-shadow:0 10px 28px rgba(0,0,0,.32)'
      document.body.appendChild(el)
      return el
    }
    function moveChip(el, x, y) {
      if (!el || !el.style) return
      el.style.left = x + 10 + 'px'
      el.style.top = y + 12 + 'px'
    }
    function killChip(el) {
      if (!el) return
      try {
        if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el)
      } catch {
        /* 已经不在文档里了 */
      }
    }

    /* 拖拽刚结束的那一下不要再当成点击去打开文件。 */
    let dragEndedAt = 0

    const baseName = (p) => {
      const s = String(p || '')
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
      return i >= 0 ? s.slice(i + 1) : s
    }

    /**
     * 往上找宿主对话区的容器：先认含可编辑区的那层（input 是它的兄弟节点，
     * 所以不能要求同一层同时有 input 和 contenteditable，否则会一路找到 body）。
     */
    function composerHostOf(el) {
      let node = el
      while (node && node.nodeType === 1) {
        if (node.querySelector && node.querySelector('[contenteditable="true"]')) {
          /* 这层有可编辑区；再往上找同时含 file input 的那层（InputBar 根）——
             输入框和隐藏 input 是兄弟节点，只有容器层才同时看得见两者。 */
          let up = node
          while (up && up.nodeType === 1) {
            if (up.querySelector && up.querySelector('input[type="file"]')) return up
            up = up.parentElement
          }
          return node
        }
        node = node.parentElement
      }
      return null
    }

    /**
     * 兜底：页面上最后一个可用的多选文件 input（宿主 composer 的那个）。
     * 多会话时页面里会挂好几个 composer，input 本身是 hidden 的看不出可见性，
     * 所以往上量一下外层盒子的尺寸，优先选真的占着位置的那个。
     */
    function lastFileInput() {
      const all = document.querySelectorAll('input[type="file"][multiple]')
      let fallback = null
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const input = all[i]
        if (!input || input.disabled) continue
        if (!fallback) fallback = input
        const box = input.parentElement && input.parentElement.getBoundingClientRect
          ? input.parentElement.getBoundingClientRect()
          : null
        if (box && box.width > 0 && box.height > 0) return input
      }
      return fallback
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.es-root{
  /* 低饱和中性灰：底色只差一点，靠字重和明度分层，不用彩色抢注意力 */
  --e-bg:#f1f2f4; --e-surface:#ffffff; --e-surface-2:#f6f7f8;
  --e-line:#e4e6ea; --e-line-strong:#d3d7dd;
  --e-ink:#191c21; --e-ink-2:#333941; --e-dim:#4b5360; --e-faint:#6d7581;
  --e-brand:#37699e; --e-brand-soft:#eaf0f6;
  --e-ok:#2c7a58; --e-ok-soft:#e9f3ee;
  --e-warn:#8a6314; --e-warn-soft:#f8f1e0;
  --e-bad:#b23a30; --e-bad-soft:#f9eae8;
  --e-mark:#fbf0c6;
  --e-shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  --e-shadow-lg:0 8px 28px rgba(16,24,40,.10);
  --e-radius:10px; --e-radius-sm:8px;
  --e-font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Noto Sans SC",sans-serif;
  --e-mono:"SFMono-Regular",ui-monospace,Menlo,Consolas,"Liberation Mono","Microsoft YaHei",monospace;
}
@media (prefers-color-scheme: dark){
  .es-root{
    --e-bg:#12151a; --e-surface:#1a1e24; --e-surface-2:#161a20;
    --e-line:#272c34; --e-line-strong:#3a414c;
    --e-ink:#e7eaee; --e-ink-2:#c6ccd4; --e-dim:#a5adba; --e-faint:#858e9c;
    --e-brand:#8aacd8; --e-brand-soft:#212a35;
    --e-ok:#57c39a; --e-ok-soft:#13241e;
    --e-warn:#d8ae63; --e-warn-soft:#241f15;
    --e-bad:#e0837c; --e-bad-soft:#2a1b1a;
    --e-mark:#3f3618;
    --e-shadow:0 1px 2px rgba(0,0,0,.4);
    --e-shadow-lg:0 10px 30px rgba(0,0,0,.5);
  }
}
html[data-theme="dark"] .es-root, body[data-theme="dark"] .es-root,
html[data-dsw-theme="dark"] .es-root, body[data-dsw-theme="dark"] .es-root,
.dsh-theme-dark .es-root{
  --e-bg:#12151a; --e-surface:#1a1e24; --e-surface-2:#161a20;
  --e-line:#272c34; --e-line-strong:#3a414c;
  --e-ink:#e7eaee; --e-ink-2:#c6ccd4; --e-dim:#a5adba; --e-faint:#858e9c;
  --e-brand:#8aacd8; --e-brand-soft:#212a35;
  --e-ok:#57c39a; --e-ok-soft:#13241e;
  --e-warn:#d8ae63; --e-warn-soft:#241f15;
  --e-bad:#e0837c; --e-bad-soft:#2a1b1a;
  --e-mark:#3f3618;
  --e-shadow:0 1px 2px rgba(0,0,0,.4);
  --e-shadow-lg:0 10px 30px rgba(0,0,0,.5);
}

.es-root{
  box-sizing:border-box;
  display:flex; flex-direction:column; align-items:stretch;
  width:100%; max-width:100%; min-width:0; min-height:100%; height:100%;
  overflow:hidden;
  background:var(--e-bg); color:var(--e-ink);
  font-family:var(--e-font);
  font-size:14.5px; line-height:1.6; letter-spacing:.01em;
  -webkit-font-smoothing:antialiased; text-align:left;
}
.es-root *{box-sizing:border-box;}

/* ---- 顶栏 ---- */
.es-head{
  flex:0 0 auto; padding:14px 18px 0;
  background:linear-gradient(180deg,var(--e-surface) 0%,var(--e-bg) 100%);
}
.es-title{display:flex;align-items:center;gap:10px;margin-bottom:12px;min-width:0;}
.es-title h1{
  margin:0;font-size:15px;font-weight:650;letter-spacing:.02em;color:var(--e-ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.es-badge{
  flex:0 0 auto;font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;
  background:var(--e-brand-soft);color:var(--e-brand);font-weight:600;
  border:1px solid color-mix(in srgb, var(--e-brand) 22%, transparent);
  font-family:var(--e-mono);
}
.es-badge.es-bad{background:var(--e-bad-soft);color:var(--e-bad);border-color:color-mix(in srgb,var(--e-bad) 30%,transparent);}
.es-spacer{flex:1 1 auto;min-width:8px;}

.es-searchbar{
  position:relative;display:flex;align-items:center;gap:0;
  background:var(--e-surface);border:1px solid var(--e-line-strong);
  border-radius:var(--e-radius);box-shadow:var(--e-shadow);
  transition:border-color .14s ease, box-shadow .14s ease;
}
.es-searchbar:focus-within{
  border-color:var(--e-brand);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--e-brand) 14%, transparent);
}
.es-searchbar > .es-ico{
  flex:0 0 auto;display:flex;align-items:center;padding:0 0 0 12px;color:var(--e-faint);
}
.es-input{
  flex:1 1 auto;min-width:0;height:42px;padding:0 10px;
  background:transparent;border:0;outline:0;color:var(--e-ink);
  font-family:var(--e-font);font-size:14.5px;letter-spacing:.01em;
}
.es-input::placeholder{color:var(--e-faint);}
.es-clear{
  flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  width:26px;height:26px;margin-right:6px;border:0;border-radius:50%;
  background:transparent;color:var(--e-faint);cursor:pointer;
}
.es-clear:hover{background:var(--e-line);color:var(--e-ink-2);}
.es-spin{
  flex:0 0 auto;width:14px;height:14px;margin-right:12px;border-radius:50%;
  border:2px solid var(--e-line-strong);border-top-color:var(--e-brand);
  animation:es-rot .7s linear infinite;
}
@keyframes es-rot{to{transform:rotate(360deg);}}

/* ---- 工具条 ---- */
.es-tools{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:10px 0 12px;
}
.es-seg{display:inline-flex;background:var(--e-surface);border:1px solid var(--e-line);border-radius:var(--e-radius-sm);overflow:hidden;}
.es-seg button{
  appearance:none;border:0;background:transparent;cursor:pointer;
  padding:5px 11px;font-family:var(--e-font);font-size:12.5px;color:var(--e-dim);
  border-right:1px solid var(--e-line);white-space:nowrap;
}
.es-seg button:last-child{border-right:0;}
.es-seg button:hover{background:var(--e-surface-2);color:var(--e-ink-2);}
.es-seg button[data-on="1"]{background:var(--e-brand-soft);color:var(--e-brand);font-weight:600;}

.es-chk{
  display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;
  padding:5px 9px;border-radius:var(--e-radius-sm);border:1px solid var(--e-line);
  background:var(--e-surface);font-size:12.5px;color:var(--e-dim);white-space:nowrap;
}
.es-chk:hover{border-color:var(--e-line-strong);color:var(--e-ink-2);}
.es-chk[data-on="1"]{background:var(--e-brand-soft);border-color:color-mix(in srgb,var(--e-brand) 30%,transparent);color:var(--e-brand);font-weight:600;}
.es-chk input{display:none;}

.es-sel{
  appearance:none;padding:5px 26px 5px 9px;border-radius:var(--e-radius-sm);
  border:1px solid var(--e-line);background:var(--e-surface);color:var(--e-dim);
  font-family:var(--e-font);font-size:12.5px;cursor:pointer;outline:0;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 52%, calc(100% - 9px) 52%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
}
.es-sel:hover{border-color:var(--e-line-strong);color:var(--e-ink-2);}
.es-sel option{background:var(--e-surface);color:var(--e-ink);}

.es-btn{
  display:inline-flex;align-items:center;gap:5px;
  padding:5px 10px;border-radius:var(--e-radius-sm);cursor:pointer;
  border:1px solid var(--e-line);background:var(--e-surface);
  font-family:var(--e-font);font-size:12.5px;color:var(--e-dim);white-space:nowrap;
}
.es-btn:hover{border-color:var(--e-line-strong);color:var(--e-ink-2);background:var(--e-surface-2);}

/* ---- 状态行 ---- */
.es-meta{
  flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:8px 18px;border-top:1px solid var(--e-line);border-bottom:1px solid var(--e-line);
  background:var(--e-surface);font-size:12px;color:var(--e-faint);
}
.es-meta b{color:var(--e-ink-2);font-weight:600;font-variant-numeric:tabular-nums;}
.es-meta .es-warn{color:var(--e-warn);}
.es-meta .es-bad{color:var(--e-bad);}

/* ---- 结果列表 ---- */
.es-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 0 4px;}
.es-row{
  display:flex;align-items:center;gap:10px;
  padding:7px 18px;cursor:default;border-left:2px solid transparent;
  min-width:0;
}
.es-row:hover{background:var(--e-surface-2);}
.es-row[data-sel="1"]{background:var(--e-brand-soft);border-left-color:var(--e-brand);}
.es-row .es-ricon{flex:0 0 auto;display:flex;align-items:center;color:var(--e-faint);}
.es-row[data-dir="1"] .es-ricon{color:var(--e-warn);}
.es-row .es-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}
.es-row .es-name{
  font-size:13.5px;color:var(--e-ink);font-weight:570;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.es-row .es-name mark{background:var(--e-mark);color:inherit;border-radius:2px;padding:0 1px;}
.es-row .es-path{
  font-size:11.5px;color:var(--e-dim);font-family:var(--e-mono);font-weight:460;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr;
}
.es-row .es-fig{
  flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:1px;
  font-size:11px;color:var(--e-faint);font-variant-numeric:tabular-nums;
  min-width:78px;
}
.es-row .es-acts{
  flex:0 0 auto;display:flex;align-items:center;gap:4px;
  opacity:0;transition:opacity .12s ease;
}
.es-row:hover .es-acts,.es-row[data-sel="1"] .es-acts{opacity:1;}
.es-act{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:6px;cursor:pointer;
  border:1px solid var(--e-line);background:var(--e-surface);color:var(--e-dim);
}
.es-act:hover{border-color:var(--e-brand);color:var(--e-brand);}

/* ---- 空态 ---- */
.es-empty{
  flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;padding:40px 24px;color:var(--e-faint);text-align:center;
}
.es-empty .es-empty-ico{color:var(--e-line-strong);}
.es-empty .es-empty-t{font-size:13.5px;color:var(--e-dim);}
.es-empty .es-empty-s{font-size:12px;color:var(--e-faint);max-width:520px;line-height:1.7;}
.es-quick{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:6px;max-width:600px;}
.es-quick button{
  appearance:none;padding:4px 10px;border-radius:999px;cursor:pointer;
  border:1px solid var(--e-line);background:var(--e-surface);
  font-family:var(--e-font);font-size:12px;color:var(--e-dim);
}
.es-quick button:hover{border-color:var(--e-brand);color:var(--e-brand);}

/* ---- 底栏 ---- */
.es-foot{
  flex:0 0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:7px 18px;border-top:1px solid var(--e-line);
  background:var(--e-surface);font-size:11.5px;color:var(--e-faint);
}
.es-key{
  display:inline-block;padding:1px 5px;border-radius:4px;
  border:1px solid var(--e-line-strong);background:var(--e-surface-2);
  font-family:var(--e-mono);font-size:10.5px;color:var(--e-dim);
}
.es-toast{
  position:fixed;left:50%;bottom:36px;transform:translateX(-50%);
  padding:8px 16px;border-radius:999px;z-index:100003;
  background:var(--e-ink,#191c21);color:var(--e-bg,#f1f2f4);font-size:12.5px;font-weight:520;
  box-shadow:var(--e-shadow-lg,0 10px 30px rgba(0,0,0,.4));pointer-events:none;
}

/* ---- 浏览器式页签条 ---- */
.es-tb{
  flex:0 0 auto;display:flex;align-items:center;gap:2px;
  padding:7px 10px 0;background:var(--e-surface-2);
  border-bottom:1px solid var(--e-line);overflow-x:auto;overflow-y:hidden;
}
.es-tb::-webkit-scrollbar{height:0;}
.es-tab{
  position:relative;flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;
  max-width:220px;min-width:88px;padding:5px 7px 5px 11px;
  border:1px solid transparent;border-bottom:0;border-radius:9px 9px 0 0;
  background:transparent;color:var(--e-dim);font-family:inherit;
  font-size:12.5px;font-weight:600;line-height:1.5;cursor:pointer;
}
.es-tab:hover{background:var(--e-brand-soft);color:var(--e-ink-2);}
.es-tab[data-on="1"]{
  background:var(--e-surface);color:var(--e-ink);
  border-color:var(--e-line);
}
.es-tab-ic{flex:0 0 auto;display:inline-flex;color:var(--e-faint);}
.es-tab[data-on="1"] .es-tab-ic{color:var(--e-brand);}
.es-tab-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.es-tab-x{
  flex:0 0 auto;width:15px;height:15px;display:inline-flex;align-items:center;
  justify-content:center;border:0;border-radius:50%;background:transparent;
  color:var(--e-faint);cursor:pointer;padding:0;
}
.es-tab-x:hover{background:var(--e-line-strong);color:var(--e-ink);}
.es-tab-plus{
  flex:0 0 auto;width:25px;height:25px;margin:0 0 3px 3px;display:inline-flex;
  align-items:center;justify-content:center;border:1px solid transparent;
  border-radius:7px;background:transparent;color:var(--e-dim);
  font-size:16px;line-height:1;cursor:pointer;
}
.es-tab-plus:hover{background:var(--e-surface);border-color:var(--e-line);color:var(--e-ink);}

/* ---- 浏览器式地址栏 ---- */
.es-nav{
  flex:0 0 auto;display:flex;align-items:center;gap:6px;
  padding:8px 12px;border-bottom:1px solid var(--e-line);background:var(--e-surface);
}
.es-addrb{
  flex:1 1 auto;display:flex;align-items:center;gap:7px;min-width:0;height:30px;
  padding:0 11px;border:1px solid var(--e-line-strong);border-radius:999px;
  background:var(--e-surface-2);
}
.es-addrb:focus-within{
  border-color:var(--e-brand);background:var(--e-surface);
  box-shadow:0 0 0 3px var(--e-brand-soft);
}
.es-addr{
  flex:1 1 auto;min-width:0;border:0;outline:none;background:transparent;
  color:var(--e-ink);font-family:var(--e-mono);font-size:12.5px;font-weight:500;
}
.es-addr::placeholder{color:var(--e-faint);font-family:inherit;}
.es-icobtn{
  flex:0 0 auto;width:27px;height:27px;display:inline-flex;align-items:center;
  justify-content:center;border:1px solid transparent;border-radius:7px;
  background:transparent;color:var(--e-dim);font-size:13px;cursor:pointer;
  font-family:var(--e-mono);
}
.es-icobtn:hover:not(:disabled){background:var(--e-surface-2);border-color:var(--e-line);color:var(--e-ink);}
.es-icobtn:disabled{opacity:.3;cursor:default;}
.es-addr-err{
  flex:0 0 auto;width:15px;height:15px;display:inline-flex;align-items:center;
  justify-content:center;border-radius:50%;background:var(--e-bad);color:#fff;
  font-size:10px;font-weight:700;cursor:help;
}
.es-browse{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}

/* ---- 浏览：工具条 ---- */
.esb-bar{
  flex:0 0 auto;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;
  padding:8px 14px;border-bottom:1px solid var(--e-line);overflow:hidden;
}
.esb-btn{
  flex:0 0 auto;width:27px;height:27px;display:inline-flex;align-items:center;
  justify-content:center;border:1px solid var(--e-line);border-radius:7px;
  background:var(--e-surface);color:var(--e-ink-2);cursor:pointer;
}
.esb-btn:hover:not(:disabled){background:var(--e-surface-2);border-color:var(--e-line-strong);color:var(--e-ink);}
.esb-btn:disabled{opacity:.35;cursor:default;}
.esb-btn[data-wide="1"]{width:auto;padding:0 9px;gap:5px;font-size:12px;font-weight:520;}
.esb-crumbs{
  flex:1 1 auto;display:flex;align-items:center;gap:1px;min-width:0;
  overflow:hidden;font-size:12.5px;padding-left:4px;
}
.esb-crumb{
  flex:0 0 auto;max-width:190px;padding:3px 7px;border:0;border-radius:6px;
  background:transparent;color:var(--e-ink-2);font-family:inherit;font-size:12.5px;
  font-weight:500;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.esb-crumb:hover{background:var(--e-brand-soft);color:var(--e-brand);}
.esb-crumb[data-last="1"]{color:var(--e-ink);font-weight:650;}
.esb-sep{flex:0 0 auto;color:var(--e-faint);font-size:11px;}

/* ---- 浏览：表格 ---- */
.esb-wrap{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;outline:none;
}
.esb-head{
  flex:0 0 auto;display:grid;grid-template-columns:minmax(0,1fr) 124px 104px 84px;
  gap:10px;padding:6px 16px;border-bottom:1px solid var(--e-line);
  background:var(--e-surface-2);font-size:11.5px;color:var(--e-faint);user-select:none;
}
.esb-head > span{
  display:flex;align-items:center;gap:3px;cursor:pointer;
  white-space:nowrap;overflow:hidden;color:inherit;
}
.esb-head > span:hover{color:var(--e-ink-2);}
.esb-head .esb-h-size{justify-content:flex-end;}
.esb-arrow{font-size:9px;color:var(--e-brand);}
.esb-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;}
.esb-row{
  position:relative;display:grid;grid-template-columns:minmax(0,1fr) 124px 104px 84px;
  gap:10px;align-items:center;padding:5px 16px;font-size:13px;
  color:var(--e-ink-2);border-left:2px solid transparent;cursor:default;
}
.esb-row:hover{background:var(--e-surface-2);}
.esb-row[data-sel="1"]{background:var(--e-brand-soft);border-left-color:var(--e-brand);}
.esb-row[data-dir="1"] .esb-nm{color:var(--e-ink);font-weight:560;}
.esb-name{display:flex;align-items:center;gap:7px;min-width:0;}
.esb-name > span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.esb-name > .esb-ic{flex:0 0 auto;display:inline-flex;color:var(--e-dim);}
.esb-row[data-dir="1"] .esb-ic{color:var(--e-brand);}
.esb-dim{color:var(--e-faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.esb-num{color:var(--e-faint);font-size:12px;text-align:right;white-space:nowrap;}
.esb-acts{
  display:none;position:absolute;right:12px;top:50%;transform:translateY(-50%);
  gap:3px;padding-left:8px;background:linear-gradient(90deg,transparent,var(--e-surface-2) 22%);
}
.esb-row:hover .esb-acts{display:flex;}
.esb-row[data-sel="1"] .esb-acts{background:linear-gradient(90deg,transparent,var(--e-brand-soft) 22%);}
.esb-empty{
  flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:7px;padding:36px 28px;text-align:center;color:var(--e-faint);
}
.esb-empty-t{font-size:13.5px;font-weight:600;color:var(--e-ink-2);}
.esb-empty-s{font-size:12px;max-width:420px;line-height:1.7;}

/* ================= 右上角常驻搜索栏（header utilities 槽位）================= */
.esh-root{
  --e-bg:#f1f2f4; --e-surface:#ffffff; --e-surface-2:#f6f7f8;
  --e-line:#e4e6ea; --e-line-strong:#d3d7dd;
  --e-ink:#191c21; --e-ink-2:#333941; --e-dim:#4b5360; --e-faint:#6d7581;
  --e-brand:#37699e; --e-brand-soft:#eaf0f6;
  --e-ok:#2c7a58; --e-ok-soft:#e9f3ee; --e-bad:#b23a30; --e-mark:#fbf0c6;
  --e-shadow:0 1px 2px rgba(16,24,40,.05);
  --e-shadow-lg:0 10px 34px rgba(16,24,40,.14);
  --e-font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Noto Sans SC",sans-serif;
  --e-mono:"SFMono-Regular",ui-monospace,Menlo,Consolas,"Liberation Mono","Microsoft YaHei",monospace;
  position:relative; display:inline-flex; align-items:center; gap:6px;
  height:32px; width:208px; min-width:0; padding:0 10px;
  border:1px solid var(--e-line); border-radius:999px;
  background:var(--e-surface-2); color:var(--e-ink);
  font:500 12.5px/1 var(--e-font); letter-spacing:.01em;
  transition:width .18s ease,border-color .15s,box-shadow .15s,background .15s;
}
@media (prefers-color-scheme: dark){
  .esh-root{
    --e-bg:#12151a; --e-surface:#1a1e24; --e-surface-2:#161a20;
    --e-line:#272c34; --e-line-strong:#3a414c;
    --e-ink:#e7eaee; --e-ink-2:#c6ccd4; --e-dim:#a5adba; --e-faint:#858e9c;
    --e-brand:#8aacd8; --e-brand-soft:#212a35;
    --e-ok:#57c39a; --e-ok-soft:#13241e; --e-bad:#e0837c; --e-mark:#3f3618;
    --e-shadow:0 1px 2px rgba(0,0,0,.4);
    --e-shadow-lg:0 12px 36px rgba(0,0,0,.55);
  }
}
html[data-theme="dark"] .esh-root, body[data-theme="dark"] .esh-root,
html[data-dsw-theme="dark"] .esh-root, body[data-dsw-theme="dark"] .esh-root,
.dsh-theme-dark .esh-root{
  --e-bg:#12151a; --e-surface:#1a1e24; --e-surface-2:#161a20;
  --e-line:#272c34; --e-line-strong:#3a414c;
  --e-ink:#e7eaee; --e-ink-2:#c6ccd4; --e-dim:#a5adba; --e-faint:#858e9c;
  --e-brand:#8aacd8; --e-brand-soft:#212a35;
  --e-ok:#57c39a; --e-ok-soft:#13241e; --e-bad:#e0837c; --e-mark:#3f3618;
  --e-shadow:0 1px 2px rgba(0,0,0,.4);
  --e-shadow-lg:0 12px 36px rgba(0,0,0,.55);
}
.esh-root[data-open="1"]{
  width:310px; background:var(--e-surface);
  border-color:var(--e-brand); box-shadow:0 0 0 3px var(--e-brand-soft);
}
.esh-ico{ display:inline-flex; align-items:center; color:var(--e-faint); flex:0 0 auto; }
.esh-root[data-open="1"] .esh-ico{ color:var(--e-brand); }
.esh-input{
  flex:1 1 auto; min-width:0; height:100%; border:0; outline:0; padding:0;
  background:transparent; color:inherit; font:inherit; letter-spacing:inherit;
}
.esh-input::placeholder{ color:var(--e-faint); font-weight:450; }
.esh-clear{
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto;
  width:17px; height:17px; padding:0; border:0; border-radius:50%; cursor:pointer;
  background:var(--e-line); color:var(--e-dim);
}
.esh-clear:hover{ background:var(--e-line-strong); color:var(--e-ink); }
.esh-spin{
  flex:0 0 auto; width:12px; height:12px; border-radius:50%;
  border:1.6px solid var(--e-line-strong); border-top-color:var(--e-brand);
  animation:esh-spin .7s linear infinite;
}
@keyframes esh-spin{ to{ transform:rotate(360deg); } }

.esh-pop{
  position:fixed; z-index:100000;
  width:408px; max-width:calc(100vw - 20px);
  background:var(--e-surface); color:var(--e-ink);
  border:1px solid var(--e-line-strong); border-radius:12px;
  box-shadow:var(--e-shadow-lg); overflow:hidden;
  font:450 13px/1.5 var(--e-font); letter-spacing:.012em; text-align:left;
}
.esh-pop[data-dense="1"]{ width:376px; }
.esh-pop-head{
  display:flex; align-items:center; gap:8px; padding:6px 11px;
  border-bottom:1px solid var(--e-line); background:var(--e-surface-2);
  font-size:12px; font-weight:480; color:var(--e-dim); line-height:1.4;
}
.esh-pill{
  display:inline-flex; align-items:center; padding:1px 6px; border-radius:999px;
  background:var(--e-brand-soft); color:var(--e-brand); font-weight:600; font-size:10.5px;
}
/* 筛选条：一行放下「全部/文件/文件夹 + 精确 + 条数」，比再开一层菜单省事 */
.esh-tools{
  display:flex; align-items:center; gap:6px; padding:5px 11px;
  border-bottom:1px solid var(--e-line); background:var(--e-surface);
  font-size:11px; color:var(--e-dim); white-space:nowrap; overflow:hidden;
}
.esh-seg{ display:inline-flex; align-items:center; gap:2px; padding:2px; border-radius:7px; background:var(--e-surface-2); border:1px solid var(--e-line); }
.esh-seg > button{
  border:0; background:transparent; color:var(--e-dim); font:inherit; font-size:11px;
  padding:2px 7px; border-radius:5px; cursor:pointer;
}
.esh-seg > button[data-on="1"]{ background:var(--e-surface); color:var(--e-ink); font-weight:600; box-shadow:0 1px 2px rgba(20,24,30,.10); }
.esh-exact{
  flex:0 0 auto; border:1px solid var(--e-line); background:var(--e-surface-2);
  color:var(--e-dim); font:inherit; font-size:11px; padding:2px 7px;
  border-radius:6px; cursor:pointer;
}
.esh-exact[data-on="1"]{ background:var(--e-brand-soft); border-color:var(--e-brand); color:var(--e-brand); font-weight:600; }
.esh-sel{
  flex:0 0 auto; border:1px solid var(--e-line); background:var(--e-surface-2);
  color:var(--e-ink-2); font:inherit; font-size:11px; padding:2px 4px;
  border-radius:6px; cursor:pointer;
}
.esh-pill[data-tone="ok"]{ background:var(--e-ok-soft); color:var(--e-ok); }
.esh-list{ max-height:min(324px,48vh); overflow-y:auto; overscroll-behavior:contain; }
.esh-row{
  display:flex; align-items:center; gap:9px; padding:7px 12px; cursor:pointer;
  border-left:2px solid transparent;
}
.esh-row:hover{ background:var(--e-surface-2); }
.esh-row[data-sel="1"]{ background:var(--e-brand-soft); border-left-color:var(--e-brand); }
/* 非历史行都能拖（目录拖出去是把路径插进输入框），给个抓手光标 */
.esh-row[data-hist="0"]{ cursor:grab; }
.esh-row[data-hist="0"]:active{ cursor:grabbing; }
.esh-row[data-hist="1"]{ cursor:pointer; }
/* 历史行只有一行词，压紧一点，别跟结果行一样高 */
.esh-pop[data-mode="history"] .esh-row{ padding:5px 10px; gap:7px; }
.esh-pop[data-mode="history"] .esh-row-name{ font-size:12.6px; font-weight:540; color:var(--e-ink-2); }
.esh-row-ico{ flex:0 0 auto; display:inline-flex; color:var(--e-faint); }
.esh-row-ico[data-dir="1"]{ color:var(--e-brand); }
.esh-row-main{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px; }
.esh-row-name{
  font-size:13.2px; font-weight:570; color:var(--e-ink); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
}
.esh-row-path{
  font-size:11.6px; font-weight:480; color:var(--e-dim); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; direction:rtl; text-align:left;
}
.esh-row-size{ flex:0 0 auto; font:550 10.5px/1 var(--e-mono); color:var(--e-dim); }
.esh-row mark{ background:var(--e-mark); color:inherit; border-radius:2px; padding:0 1px; }
.esh-empty{ padding:20px 12px; text-align:center; color:var(--e-dim); font-size:12.5px; font-weight:480; }
.esh-foot{
  display:flex; align-items:center; flex-wrap:wrap; gap:3px 7px; padding:6px 12px;
  border-top:1px solid var(--e-line); background:var(--e-surface-2);
  font-size:11px; font-weight:460; color:var(--e-dim);
  white-space:normal; overflow:visible;
}
/* 每组都别收缩，组内也不许断字（「选/择」那种）；一行放不下就让整组换到下一行，
   以前这里是 nowrap + overflow:hidden，窄弹层下直接裁掉「选择」「定位」「关闭」。 */
.esh-foot > span{ flex:0 0 auto; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.esh-foot > .esh-spacer{ flex:1 1 auto; min-width:0; }
.esh-foot > .esh-hint{ flex:0 1 auto; min-width:0; }
/* 历史/浏览态弹层窄，说明文字先让位给快捷键 */
.esh-pop[data-mode="history"] .esh-foot > .esh-hint,
.esh-pop[data-dense="1"] .esh-foot > .esh-hint{ display:none; }
.esh-key{
  display:inline-block; padding:0 5px; border-radius:4px;
  border:1px solid var(--e-line-strong); background:var(--e-surface);
  font:620 10.5px/1.7 var(--e-mono); color:var(--e-dim);
}
.esh-dot{ color:var(--e-line-strong); }
.esh-spacer{ flex:1 1 auto; }

/* ---- 内嵌浏览：popover 里直接看目录，不再弹资源管理器 ---- */
.esh-crumbbar{
  display:flex; align-items:center; gap:2px; padding:5px 8px;
  border-bottom:1px solid var(--e-line); background:var(--e-surface-2);
  font-size:11.5px; color:var(--e-dim); overflow-x:auto;
}
.esh-crumbbar::-webkit-scrollbar{ height:0; }
.esh-crumb{
  flex:0 0 auto; max-width:130px; padding:2px 6px; border-radius:6px;
  border:0; background:transparent; color:var(--e-dim); cursor:pointer;
  font:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.esh-crumb:hover{ background:var(--e-line); color:var(--e-ink); }
.esh-crumb[data-last="1"]{ color:var(--e-ink); font-weight:620; }
.esh-crumbsep{ flex:0 0 auto; color:var(--e-faint); opacity:.7; }
.esh-pop[data-mode="browse"] .esh-list{ max-height:min(440px,60vh); }
@media (max-width:1100px){ .esh-root{ width:150px; } .esh-root[data-open="1"]{ width:230px; } }

/* ---- 搜索历史 / 加附件按钮 / 拖拽落点 ---- */
.esh-row-add{
  flex:0 0 auto; width:20px; height:20px; display:inline-flex;
  align-items:center; justify-content:center;
  border:1px solid var(--e-line); border-radius:6px; background:var(--e-surface);
  color:var(--e-dim); cursor:pointer; opacity:0;
  transition:opacity .12s ease, background .12s ease, color .12s ease;
}
.esh-row:hover .esh-row-add, .esh-row[data-sel="1"] .esh-row-add{ opacity:1; }
.esh-row-add:hover{ background:var(--e-brand); border-color:var(--e-brand); color:#fff; }
.esh-row[data-hist="1"] .esh-row-name{ color:var(--e-ink-2); font-weight:540; }
.esh-row-ico[data-hist="1"]{ color:var(--e-faint); }
.esh-hist-clear{
  flex:0 0 auto; padding:2px 9px; border:1px solid var(--e-line); border-radius:999px;
  background:var(--e-surface); color:var(--e-dim);
  font:inherit; font-size:11px; cursor:pointer;
}
.esh-hist-clear:hover{ border-color:var(--e-line-strong); color:var(--e-ink); }
/* 展开/收起：跟「清空」同款胶囊，但强调一点，它是推荐的下一步操作 */
.esh-hist-more{
  flex:0 0 auto; padding:2px 9px; border:1px solid var(--e-line); border-radius:999px;
  background:var(--e-surface); color:var(--e-brand);
  font:inherit; font-size:11px; font-weight:600; cursor:pointer;
}
.esh-hist-more:hover{ border-color:var(--e-brand); background:var(--e-brand-soft); }
.esh-hist-more[data-on="1"]{ color:var(--e-dim); font-weight:500; }
/* 历史行的删除按钮：复用 .esh-row-add 的盒子，只是平时隐着、悬停才显形 */
.esh-row-del{
  flex:0 0 auto; width:20px; height:20px; display:inline-flex;
  align-items:center; justify-content:center;
  border:1px solid transparent; border-radius:6px; background:transparent;
  color:var(--e-faint); cursor:pointer; opacity:0;
  transition:opacity .12s ease, background .12s ease, color .12s ease, border-color .12s ease;
}
.esh-row:hover .esh-row-del, .esh-row[data-sel="1"] .esh-row-del{ opacity:1; }
.esh-row-del:hover{ background:var(--e-bad-soft); border-color:var(--e-bad); color:var(--e-bad); }
.esh-note{
  display:flex; align-items:center; gap:5px; padding:5px 12px;
  border-bottom:1px solid var(--e-line);
  background:var(--e-brand-soft); color:var(--e-brand);
  font-size:11.5px; font-weight:540;
}
/* 失败提示：同一位置换成红色系，浏览态也看得到 */
.esh-note[data-tone="bad"]{ background:var(--e-bad-soft); color:var(--e-bad); }
/* 环境不具备（没装 Everything、没运行、版本不匹配）：黄色，不算故障 */
.esh-note[data-tone="warn"]{ background:var(--e-warn-soft); color:var(--e-warn); }
.esh-hint{ color:var(--e-faint); opacity:.85; }
/* 历史态默认只露 8 条（236px 上下）；点「展开」后按浏览态的尺度给满，50 条也能滚完 */
.esh-pop[data-mode="history"] .esh-list{ max-height:min(236px,40vh); }
.esh-pop[data-mode="history"][data-expanded="1"] .esh-list{ max-height:min(440px,60vh); }
/* composer 在 .esh-root 之外，变量拿不到，落点色按新品牌色写死 */
[data-es-drop="1"]{ outline:1px dashed #37699e; outline-offset:-3px; border-radius:8px; }

/* ================= 开始界面（Hero）入口 + 浮层搜索窗 ================= */
/* hero 行里的胶囊按钮：用宿主主题变量，跟着 DSH 明暗自动变 */
/* hero 行是 display:flex 但无 justify-content，子项全部左对齐（dsh-purge 的胶囊就是这样
   紧跟在「通用智能助手」后面）。所以这里只要 6px 间距，跟着同一行排队即可，不需要右推。 */
.ess-chip{ display:inline-flex; align-items:center; margin-left:6px; flex:0 0 auto; }
/* 找不到 hero 行时的兜底：右下角浮一个胶囊，保证入口始终可达 */
.ess-chip--float{
  position:fixed; right:18px; bottom:18px; z-index:99980; margin-left:0;
  pointer-events:auto;
}
.ess-chip--float .ess-chip-btn{
  height:34px; padding:0 14px; background:var(--dsw-alias-bg-layer-1,#fff);
  border-color:var(--dsw-alias-border-l2,#d3d7dd);
  box-shadow:0 8px 24px rgba(16,20,28,.16);
}
.ess-chip-btn{
  display:inline-flex; align-items:center; gap:5px;
  height:28px; padding:0 11px; border-radius:999px; cursor:pointer;
  pointer-events:auto;
  border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#6dbf8c) 46%, transparent);
  background:transparent; color:var(--dsw-alias-label-secondary,#5b6470);
  font:500 12.5px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  white-space:nowrap; transition:background .15s,border-color .15s,color .15s;
}
/* 顶栏全局导航位的入口：单行胶囊，不参与宿主 flex 的拉伸 */
.ess-entry{ display:inline-flex; align-items:center; flex:0 0 auto; min-width:0; }
.ess-entry .ess-chip-btn{ pointer-events:auto; }
.ess-chip-btn:hover{
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#6dbf8c) 12%, transparent);
  border-color:var(--dsw-alias-brand-primary,#6dbf8c);
  color:var(--dsw-alias-label-primary,#191c21);
}
.ess-chip-btn[data-open="1"]{
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#6dbf8c) 18%, transparent);
  border-color:var(--dsw-alias-brand-primary,#6dbf8c);
  color:var(--dsw-alias-label-primary,#191c21);
}
/* 浮层本身是 click-through，所有节点自己 opt-in 指针事件 */
.ess-backdrop{
  position:fixed; inset:0; z-index:99990; pointer-events:auto;
  background:rgba(14,18,24,.26);
}
html[data-theme="dark"] .ess-backdrop, body[data-theme="dark"] .ess-backdrop,
html[data-dsw-theme="dark"] .ess-backdrop, body[data-dsw-theme="dark"] .ess-backdrop,
.dsh-theme-dark .ess-backdrop{ background:rgba(0,0,0,.46); }
/* 同时挂 esh-root 拿变量，再用 ess-win 覆盖它的胶囊布局 */
.ess-win{
  position:fixed; left:50%; top:16vh; transform:translateX(-50%);
  z-index:99991; pointer-events:auto;
  display:flex; flex-direction:column; align-items:stretch; gap:0;
  width:min(680px,calc(100vw - 40px)); height:auto; max-height:min(66vh,600px);
  min-width:0; padding:0; border:1px solid var(--e-line-strong); border-radius:14px;
  background:var(--e-surface); color:var(--e-ink); overflow:hidden; text-align:left;
  box-shadow:0 24px 64px rgba(12,16,22,.26);
}
.ess-head{
  display:flex; align-items:center; gap:8px; padding:9px 13px;
  border-bottom:1px solid var(--e-line); background:var(--e-surface-2);
  color:var(--e-dim); font-size:11.5px; font-weight:500;
}
.ess-title{ color:var(--e-ink); font-size:13px; font-weight:620; }
.ess-kbd{
  padding:0 5px; border-radius:4px; border:1px solid var(--e-line-strong);
  background:var(--e-surface); color:var(--e-dim);
  font:620 10.5px/1.7 var(--e-mono);
}
.ess-x{
  display:inline-flex; align-items:center; justify-content:center;
  width:22px; height:22px; padding:0; border:0; border-radius:6px;
  background:transparent; color:var(--e-dim); cursor:pointer;
}
.ess-x:hover{ background:var(--e-line); color:var(--e-ink); }
.ess-ibar{
  display:flex; align-items:center; gap:9px; padding:11px 13px;
  border-bottom:1px solid var(--e-line); color:var(--e-faint);
}
.ess-input{
  flex:1 1 auto; min-width:0; height:26px; padding:0; border:0; outline:0;
  background:transparent; color:var(--e-ink);
  font:500 15px/1.45 var(--e-font); letter-spacing:.01em;
}
.ess-input::placeholder{ color:var(--e-faint); }
.ess-clear{
  display:inline-flex; align-items:center; justify-content:center;
  width:18px; height:18px; padding:0; border:0; border-radius:999px;
  background:var(--e-line); color:var(--e-dim); cursor:pointer;
}
.ess-clear:hover{ background:var(--e-line-strong); color:var(--e-ink); }
.ess-body{ flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.ess-body .esh-list{ flex:1 1 auto; max-height:none; }
.ess-body .esh-empty{ padding:34px 14px; }

/* ---- 结果行动作：右键菜单 + 悬停按钮（面板 / 顶部搜索条 / Hero 浮窗共用） ---- */
/* 菜单挂在 body 上，不在 .es-root / .esh-root 子树里，
   拿不到那边的变量，所以这里自带一份同色系的值（暗色另给） */
.esx-menu{
  --esx-surface:#ffffff; --esx-line:#e4e6ea; --esx-ink:#191c21;
  --esx-brand:#37699e; --esx-brand-soft:#eaf0f6;
  --esx-shadow-lg:0 10px 34px rgba(16,24,40,.16);
  --esx-font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Noto Sans SC",sans-serif;
  position:fixed;z-index:100001;min-width:178px;padding:4px;
  border-radius:10px;border:1px solid var(--esx-line);
  background:var(--esx-surface);box-shadow:var(--esx-shadow-lg);
  font:500 12.5px/1.35 var(--esx-font);color:var(--esx-ink);
  -webkit-user-select:none;user-select:none;
}
@media (prefers-color-scheme: dark){
  .esx-menu{
    --esx-surface:#1a1e24; --esx-line:#272c34; --esx-ink:#e7eaee;
    --esx-brand:#8aacd8; --esx-brand-soft:#212a35;
    --esx-shadow-lg:0 10px 30px rgba(0,0,0,.5);
  }
}
html[data-theme="dark"] .esx-menu, body[data-theme="dark"] .esx-menu,
html[data-dsw-theme="dark"] .esx-menu, body[data-dsw-theme="dark"] .esx-menu,
.dsh-theme-dark .esx-menu{
  --esx-surface:#1a1e24; --esx-line:#272c34; --esx-ink:#e7eaee;
  --esx-brand:#8aacd8; --esx-brand-soft:#212a35;
  --esx-shadow-lg:0 10px 30px rgba(0,0,0,.5);
}
.esx-item{
  display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;
  border:0;border-radius:7px;background:transparent;color:inherit;
  font:inherit;text-align:left;cursor:pointer;
}
.esx-item:hover{ background:var(--esx-brand-soft); color:var(--esx-brand); }
.esx-sep{ height:1px; margin:4px 6px; background:var(--esx-line); }
.esh-row-act{
  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border-radius:6px;cursor:pointer;
  border:1px solid var(--e-line);background:var(--e-surface);color:var(--e-dim);
  opacity:0;transition:opacity .12s ease;
}
.esh-row:hover .esh-row-act,.esh-row[data-sel="1"] .esh-row-act{ opacity:1; }
.esh-row-act:hover{ background:var(--e-brand);border-color:var(--e-brand);color:#fff; }
`

    function useStylesheet() {
      useEffect(() => {
        let el = document.getElementById('es-style')
        if (!el) {
          el = document.createElement('style')
          el.id = 'es-style'
          el.setAttribute('data-everything-search', '1')
          document.head.appendChild(el)
        }
        if (el.textContent !== CSS) el.textContent = CSS
      }, [])
    }

    /* -------------------------------------------------------------- API 封装 */

    /* ---------------------------------------------- 错误对象（带结构化字段） */
    /**
     * 后端不再用 500 表达「环境不具备」：缺 es.exe、Everything 没运行、版本不匹配
     * 都是 200 + data.unavailable。所以前端要能分三种情况：
     *   1) 环境不具备 → 空态 + 一句提示，不报错（err.soft = true）
     *   2) 参数不对（400/403/404）→ err.status 带着，可退回上一级
     *   3) 真故障 → 才算红字
     * 以前这里只留 message，cause/code 全丢了，三处面板只能靠字符串猜。
     */
    function apiError(json, res) {
      const msg = (json && json.error) || `请求失败（HTTP ${res.status}）`
      const err = new Error(msg)
      err.status = res.status
      if (json && json.data && typeof json.data === 'object') {
        err.code = json.data.code || ''
        err.reason = json.data.reason || ''
        err.unavailable = !!json.data.unavailable
      }
      // 401/403 是宿主层拦下来的（登录态过期、或整包路由没被挂上），不是这个插件的故障。
      // 这种情况常见于：插件刚装好但宿主还没重启到新代码，或页面放太久 token 失效。
      if (err.status === 401 || err.status === 403) {
        err.code = err.code || 'ES_HOST_AUTH'
        err.soft = true
        err.reason = err.reason || '宿主没放行这次请求（多半是登录态过期，刷新一下页面）'
      }
      err.soft = err.soft || !!(err.unavailable || (err.status >= 400 && err.status < 500 && err.code === 'ES_ENOENT'))
      return err
    }

    /* ------------------------------------------------ 环境不具备时的统一话术 */
    function softTip(err) {
      if (!err) return ''
      if (err.reason) return err.reason
      switch (err.code) {
        case 'ES_NO_ES':
          return '插件自带的 es.exe 不见了，重装插件可恢复'
        case 'ES_NOT_RUNNING':
          return 'Everything 没在运行，打开它就能搜（不用改任何设置）'
        case 'ES_NOT_READY':
          return 'Everything 刚启动，索引还在建，稍等一下再搜'
        case 'ES_QUERY_FAILED':
          return '这次没搜到内容：可能是索引在重建，或该版本的 es.exe 不支持这个语法'
        case 'ES_ES_TOO_OLD':
          return 'es.exe 版本太老，不支持插件要用的 -csv 输出；更新 Everything 后就能用'
        case 'ES_HOST_AUTH':
          return '宿主没放行这次请求（登录态过期或插件还没加载完），刷新页面再试'
        default:
          return err.message || '暂时搜不到'
      }
    }

    /**
     * 把 catch 到的东西归一成 { soft, msg }。
     * soft=true 表示「环境不具备」而不是「坏了」：渲染成黄色提示 + 人话，
     * soft=false 才是真失败，红字。以前三处面板各自 `e.message || String(e)`，
     * 结果「Everything 没装」也被涂成红色错误。
     */
    function softError(e) {
      if (!e) return { soft: false, msg: '' }
      if (e.soft) return { soft: true, msg: softTip(e) }
      return { soft: false, msg: e.message ? e.message : String(e) }
    }

    /**
     * error state 现在有两种形态：老代码里直接塞的人话字符串，和新代码的 {soft,msg}。
     * 渲染点统一走这两个取词函数，免得为了一个字段把十几处 setter 全翻一遍。
     */
    function errMsg(e) {
      if (!e) return ''
      if (typeof e === 'string') return e
      return e.msg || ''
    }

    function errSoft(e) {
      return Boolean(e && typeof e === 'object' && e.soft)
    }

    async function apiGet(path, params, signal) {
      const qs = params
        ? '?' +
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&')
        : ''
      const res = await fetch(API + path + qs, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal,
      })
      const json = await res.json().catch(() => ({ ok: false, error: `响应不是 JSON（HTTP ${res.status}）` }))
      if (!json.ok) throw apiError(json, res)
      return json.data
    }

    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({ ok: false, error: `响应不是 JSON（HTTP ${res.status}）` }))
      if (!json.ok) throw apiError(json, res)
      return json.data
    }

    /* ------------------------------------------- 结果行动作：打开 / 定位 / 复制 */

    let esxToastEl = null
    let esxToastTimer = null

    /** 轻提示：三处结果列表共用，节点直接挂 body，不受面板溢出裁剪。 */
    function esxToast(msg) {
      if (typeof document === 'undefined' || !document.body) return
      if (esxToastTimer) {
        clearTimeout(esxToastTimer)
        esxToastTimer = null
      }
      if (esxToastEl && esxToastEl.parentNode) esxToastEl.parentNode.removeChild(esxToastEl)
      const el = document.createElement('div')
      el.className = 'es-toast'
      el.textContent = String(msg == null ? '' : msg)
      document.body.appendChild(el)
      esxToastEl = el
      esxToastTimer = setTimeout(() => {
        if (esxToastEl && esxToastEl.parentNode) esxToastEl.parentNode.removeChild(esxToastEl)
        esxToastEl = null
        esxToastTimer = null
      }, 1800)
    }

    /**
     * 复制文本，三级兜底：navigator.clipboard → textarea + execCommand → 后端 /copy。
     * 第三级是给宿主 webview 关掉剪贴板 API 的场景留的后路。
     */
    async function esxCopyText(text) {
      const value = String(text == null ? '' : text)
      if (!value) return false
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          esxToast('路径已复制')
          return true
        }
      } catch (_) {
        /* 落到下一条通道 */
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', 'readonly')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        ta.style.top = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        if (ta.setSelectionRange) ta.setSelectionRange(0, value.length)
        const ok = document.execCommand ? document.execCommand('copy') : false
        document.body.removeChild(ta)
        if (ok) {
          esxToast('路径已复制')
          return true
        }
      } catch (_) {
        /* 落到下一条通道 */
      }
      try {
        await apiPost('/copy', { text: value })
        esxToast('路径已复制')
        return true
      } catch (e) {
        esxToast(`复制失败：${e && e.message ? e.message : e}`)
        return false
      }
    }

    /** 统一的打开 / 定位 / 复制：右键菜单与悬停按钮都走这一条。 */
    async function esxAct(kind, it) {
      const path = it && it.path ? String(it.path) : ''
      if (!path || path.indexOf('es-hist:') === 0) return false
      if (kind === 'copy') return esxCopyText(path)
      const isDir = Boolean(it && it.isDir)
      try {
        await apiPost(kind === 'reveal' ? '/reveal' : '/open', { path })
        if (kind === 'reveal') esxToast('已在资源管理器中定位')
        else esxToast(isDir ? '已在资源管理器中打开' : '已用默认程序打开')
        return true
      } catch (e) {
        esxToast(`${kind === 'reveal' ? '定位' : '打开'}失败：${e && e.message ? e.message : e}`)
        return false
      }
    }

    let esxMenuEl = null
    let esxMenuOff = null

    function esxCloseMenu() {
      if (esxMenuOff) {
        try {
          esxMenuOff()
        } catch (_) {
          /* 忽略 */
        }
        esxMenuOff = null
      }
      if (esxMenuEl && esxMenuEl.parentNode) esxMenuEl.parentNode.removeChild(esxMenuEl)
      esxMenuEl = null
    }

    /**
     * 右键菜单：普通 DOM 节点挂到 body 上，position:fixed 定位，
     * 免得被 .esh-list 的 overflow 裁掉，也不依赖 react-dom。
     *
     * @param {Event} e      事件对象（React 合成事件也能直接传）
     * @param {Array<{label: string, onPick: Function}>} items 菜单项
     */
    function esxOpenMenu(e, items) {
      const ev = e && e.nativeEvent ? e.nativeEvent : e
      if (ev) {
        if (ev.preventDefault) ev.preventDefault()
        if (ev.stopPropagation) ev.stopPropagation()
      }
      const list = (items || []).filter((it) => it && it.label)
      if (!list.length || typeof document === 'undefined' || !document.body) return
      esxCloseMenu()

      const menu = document.createElement('div')
      menu.className = 'esx-menu'
      menu.setAttribute('role', 'menu')
      list.forEach((it) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'esx-item'
        btn.setAttribute('role', 'menuitem')
        btn.textContent = it.label
        btn.addEventListener('mousedown', (ce) => ce.preventDefault())
        btn.addEventListener('click', (ce) => {
          if (ce.preventDefault) ce.preventDefault()
          if (ce.stopPropagation) ce.stopPropagation()
          esxCloseMenu()
          try {
            const r = it.onPick ? it.onPick() : null
            if (r && typeof r.catch === 'function') r.catch(() => {})
          } catch (_) {
            /* 动作内部自己会给提示 */
          }
        })
        menu.appendChild(btn)
      })
      document.body.appendChild(menu)

      const vw = window.innerWidth || document.documentElement.clientWidth || 0
      const vh = window.innerHeight || document.documentElement.clientHeight || 0
      const box = menu.getBoundingClientRect()
      let left = ev && ev.clientX ? ev.clientX : 0
      let top = ev && ev.clientY ? ev.clientY : 0
      if (left + box.width > vw - 8) left = Math.max(8, vw - box.width - 8)
      if (top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8)
      menu.style.left = Math.round(left) + 'px'
      menu.style.top = Math.round(top) + 'px'
      esxMenuEl = menu

      const onDown = (ce) => {
        if (!menu.contains(ce.target)) esxCloseMenu()
      }
      const onKey = (ce) => {
        if (ce.key === 'Escape') esxCloseMenu()
      }
      const onShift = () => esxCloseMenu()
      setTimeout(() => {
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onShift, true)
        window.addEventListener('resize', onShift)
      }, 0)
      esxMenuOff = () => {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('scroll', onShift, true)
        window.removeEventListener('resize', onShift)
      }
    }

    /** 结果行的三项标准动作（面板里目录要进面板，所以那边另外传）。 */
    function esxRowActions(it) {
      return [
        { label: it && it.isDir ? '在资源管理器中打开' : '用默认程序打开', onPick: () => esxAct('open', it) },
        { label: '在资源管理器中定位', onPick: () => esxAct('reveal', it) },
        { label: '复制路径', onPick: () => esxAct('copy', it) },
      ]
    }

    /* ---------------------------------------------------------------- 小工具 */

    function fmtSize(n) {
      if (n == null) return ''
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const u = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0
      let v = n
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024
        i += 1
      }
      const s = i === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
      return `${s} ${u[i]}`
    }

    function fmtDate(iso) {
      if (!iso) return ''
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
      if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
      return iso
    }

    function extOf(name) {
      const i = String(name || '').lastIndexOf('.')
      if (i <= 0) return ''
      return String(name).slice(i + 1).toLowerCase()
    }

    function highlight(text, needle) {
      const s = String(text || '')
      const n = String(needle || '').trim()
      if (!n) return s
      const lower = s.toLowerCase()
      const target = n.toLowerCase()
      const out = []
      let from = 0
      let idx = lower.indexOf(target)
      let guard = 0
      while (idx >= 0 && guard < 24) {
        if (idx > from) out.push(s.slice(from, idx))
        out.push(h('mark', { key: `m${idx}` }, s.slice(idx, idx + target.length)))
        from = idx + target.length
        idx = lower.indexOf(target, from)
        guard += 1
      }
      if (from < s.length) out.push(s.slice(from))
      return out.length > 0 ? out : s
    }

    /* --------------------------------------------------------------- 图标集合 */

    function IconSearch({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 6.9, cy: 6.9, r: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', {
          d: 'M10.3 10.3 L14 14',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function IconFolder({ size = 15 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M1.6 4.2c0-.6.5-1.1 1.1-1.1h3.1l1.3 1.5h6.2c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V4.2z',
          fill: 'currentColor',
          opacity: 0.92,
        }),
      )
    }

    function IconFile({ size = 15 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M3.4 1.9h5.3l3.9 3.9v8.3c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9V2.8c0-.5.4-.9.9-.9z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.6 1.9v3.9h4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
      )
    }

    function IconX({ size = 13 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function IconOpen({ size = 13 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M9.4 2.4h4.2v4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.6 2.4L7.8 8.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M12.3 9.6v2.9c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V4.6c0-.6.5-1.1 1.1-1.1h2.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    function IconTarget({ size = 13 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 5.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 8, cy: 8, r: 1.7, fill: 'currentColor' }),
      )
    }

    function IconCopy({ size = 13 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', {
          x: 5.3,
          y: 5.3,
          width: 8,
          height: 8,
          rx: 1.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          d: 'M10.7 3.1H3.9c-.6 0-1.1.5-1.1 1.1v6.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    function IconClock({ size = 14 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 5.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M8 4.8v3.5l2.5 1.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function IconPlus({ size = 13 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M8 3.2v9.6M3.2 8h9.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    /* ---------------------------------------------------------------- 导航总线 */

    /**
     * 极简发布订阅：右上角搜索栏点到目录时，通知侧栏面板切到浏览模式并跳转。
     * 面板没打开（无订阅者）时返回 false，调用方回退到资源管理器。
     */
    const navBus = {
      set: new Set(),
      add(fn) {
        this.set.add(fn)
        return fn
      },
      delete(fn) {
        this.set.delete(fn)
      },
      request(path) {
        if (this.set.size === 0) return false
        this.set.forEach((fn) => {
          try {
            fn(path)
          } catch (e) {
            /* 单个订阅者出错不影响其他 */
          }
        })
        return true
      },
    }

    /* ---------------------------------------------------------------- 主面板 */

    const SORT_OPTIONS = [
      { v: '', label: '相关度' },
      { v: 'name', label: '名称' },
      { v: 'path', label: '路径' },
      { v: 'size', label: '大小' },
      { v: 'date-modified', label: '修改时间' },
      { v: 'extension', label: '类型' },
    ]

    const LIMIT_OPTIONS = [50, 80, 200, 500]

    function App() {
      useStylesheet()

      const [q, setQ] = useState('')
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('all')
      const [matchPath, setMatchPath] = useState(false)
      const [matchCase, setMatchCase] = useState(false)
      const [regex, setRegex] = useState(false)
      const [wholeWord, setWholeWord] = useState(false)
      const [sort, setSort] = useState('')
      const [limit, setLimit] = useState(80)

      const [items, setItems] = useState([])
      const [total, setTotal] = useState(null)
      const [elapsedMs, setElapsedMs] = useState(null)
      const [hasMore, setHasMore] = useState(false)
      const [loading, setLoading] = useState(false)
      /* {soft,msg}：soft 决定是红色故障还是黄色「环境不具备」提示 */
      const [error, setError] = useState(null)
      const [sel, setSel] = useState(-1)
      const [toast, setToast] = useState(null)

      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState(null)

      const inputRef = useRef(null)
      const listRef = useRef(null)
      const abortRef = useRef(null)
      const countRef = useRef(null)
      const toastTimer = useRef(null)

      /* ---- 浏览（内嵌资源管理器）状态 ---- */
      const [mode, setMode] = useState('search')
      const [btabs, setBtabs] = useState([{ id: 1, path: '' }])
      const [btab, setBtab] = useState(1)
      const tabSeq = useRef(2)
      const [bhist, setBhist] = useState({ stack: [''], idx: 0 })
      const [bitems, setBitems] = useState([])
      const [bparent, setBparent] = useState(null)
      const [bvirtual, setBvirtual] = useState(false)
      const [btruncated, setBtruncated] = useState(false)
      const [bsel, setBsel] = useState(-1)
      const [bsort, setBsort] = useState('name')
      const [border, setBorder] = useState('asc')
      const [bloading, setBloading] = useState(false)
      const [berror, setBerror] = useState(null)
      const [btick, setBtick] = useState(0)
      const [addr, setAddr] = useState('')
      const [editing, setEditing] = useState(false)
      const blistRef = useRef(null)
      const addrRef = useRef(null)

      const activeTab = btabs.find((t) => t.id === btab) || btabs[0] || { id: 1, path: '' }
      const bpath = activeTab.path

      const showToast = useCallback((msg) => {
        setToast(msg)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 1600)
      }, [])

      /* 探针 */
      useEffect(() => {
        let alive = true
        apiGet('/status')
          .then((d) => {
            if (alive) setStatus(d)
          })
          .catch((e) => {
            if (alive) setStatusError(e.message)
          })
        return () => {
          alive = false
        }
      }, [])

      /* 输入防抖 */
      useEffect(() => {
        const t = setTimeout(() => setQuery(q.trim()), 140)
        return () => clearTimeout(t)
      }, [q])

      /* 搜索：先出结果，再懒补总数 */
      useEffect(() => {
        if (abortRef.current) {
          try {
            abortRef.current.abort()
          } catch {
            /* ignore */
          }
        }
        if (countRef.current) {
          try {
            countRef.current.abort()
          } catch {
            /* ignore */
          }
        }
        if (!query) {
          setItems([])
          setTotal(null)
          setElapsedMs(null)
          setHasMore(false)
          setError(null)
          setLoading(false)
          setSel(-1)
          return
        }
        const ctrl = new AbortController()
        abortRef.current = ctrl
        setLoading(true)
        setError(null)
        apiGet(
          '/search',
          {
            q: query,
            limit,
            kind,
            sort,
            order: sort === 'name' || sort === 'path' ? 'asc' : 'desc',
            matchPath: matchPath ? '1' : '',
            matchCase: matchCase ? '1' : '',
            wholeWord: wholeWord ? '1' : '',
            regex: regex ? '1' : '',
            count: '0',
          },
          ctrl.signal,
        )
          .then((d) => {
            if (ctrl.signal.aborted) return
            setItems(Array.isArray(d.items) ? d.items : [])
            setTotal(null)
            setElapsedMs(typeof d.elapsedMs === 'number' ? d.elapsedMs : null)
            setHasMore(!!d.hasMore)
            setSel(-1)
            /* 服务端刚把 Everything 拉起来时应一声 */
            if (d.autoStarted) setToast('Everything 没在运行，已自动帮你打开')
            setLoading(false)
            const c2 = new AbortController()
            countRef.current = c2
            apiGet(
              '/count',
              {
                q: query,
                kind,
                matchPath: matchPath ? '1' : '',
                matchCase: matchCase ? '1' : '',
                wholeWord: wholeWord ? '1' : '',
                regex: regex ? '1' : '',
              },
              c2.signal,
            )
              .then((c) => setTotal(typeof c.total === 'number' ? c.total : null))
              .catch(() => {})
          })
          .catch((e) => {
            if (ctrl.signal.aborted || (e && e.name === 'AbortError')) return
            setItems([])
            setTotal(null)
            setElapsedMs(null)
            setHasMore(false)
            setError(softError(e))
            setLoading(false)
          })
        return () => {
          try {
            ctrl.abort()
          } catch {
            /* ignore */
          }
        }
      }, [query, kind, sort, limit, matchPath, matchCase, regex, wholeWord])

      /* 选中项滚入可视区 */
      useEffect(() => {
        if (sel < 0 || !listRef.current) return
        const el = listRef.current.querySelector(`[data-idx="${sel}"]`)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [sel])

      const openItem = useCallback(
        async (it) => {
          if (!it) return
          try {
            await apiPost('/open', { path: it.path })
            showToast(it.isDir ? '已在资源管理器中打开' : '已用默认程序打开')
          } catch (e) {
            showToast(`打开失败：${e.message}`)
          }
        },
        [showToast],
      )

      const revealItem = useCallback(
        async (it) => {
          if (!it) return
          try {
            await apiPost('/reveal', { path: it.path })
            showToast('已在资源管理器中定位')
          } catch (e) {
            showToast(`定位失败：${e.message}`)
          }
        },
        [showToast],
      )

      const copyPath = useCallback(
        async (it) => {
          if (!it || !it.path) return
          /* 统一走三级兜底：clipboard → execCommand → 后端 /copy */
          await esxCopyText(it.path)
        },
        [],
      )

      /* ------------------------------------------------------ 浏览：导航动作 */

      const goto = useCallback(
        (path, push) => {
          const next = typeof path === 'string' ? path : ''
          setMode('browse')
          setBtabs((list) => {
            let hit = false
            const out = list.map((t) => {
              if (t.id !== btab) return t
              hit = true
              return { ...t, path: next }
            })
            return hit ? out : out
          })
          if (push !== false) {
            setBhist((h) => {
              if (h.stack[h.idx] === next) return h
              const stack = h.stack.slice(0, h.idx + 1)
              stack.push(next)
              return { stack: stack.slice(-80), idx: Math.min(79, stack.length - 1) }
            })
          }
          setBsel(-1)
        },
        [btab],
      )

      const newTab = useCallback(
        (path) => {
          const id = tabSeq.current
          tabSeq.current += 1
          setBtabs((list) => [...list, { id, path: typeof path === 'string' ? path : '' }])
          setBtab(id)
          setMode('browse')
          setBsel(-1)
        },
        [],
      )

      const closeTab = useCallback(
        (id) => {
          setBtabs((list) => {
            if (list.length <= 1) return list
            const idx = list.findIndex((t) => t.id === id)
            const rest = list.filter((t) => t.id !== id)
            if (id === btab) setBtab(rest[Math.max(0, idx - 1)].id)
            return rest
          })
        },
        [btab],
      )

      const navBack = () => {
        setBhist((h) => {
          if (h.idx <= 0) return h
          const idx = h.idx - 1
          setBtabs((list) => list.map((t) => (t.id === btab ? { ...t, path: h.stack[idx] } : t)))
          return { ...h, idx }
        })
      }

      const navFwd = () => {
        setBhist((h) => {
          if (h.idx >= h.stack.length - 1) return h
          const idx = h.idx + 1
          setBtabs((list) => list.map((t) => (t.id === btab ? { ...t, path: h.stack[idx] } : t)))
          return { ...h, idx }
        })
      }

      const navUp = () => {
        if (bvirtual || !bpath) return
        goto(bparent || '', true)
      }

      const toggleSort = (key) => {
        if (bsort === key) setBorder((o) => (o === 'asc' ? 'desc' : 'asc'))
        else {
          setBsort(key)
          setBorder(key === 'date' || key === 'size' ? 'desc' : 'asc')
        }
      }

      const enterItem = useCallback(
        (it) => {
          if (!it) return
          if (it.isDir) {
            goto(it.path, true)
            return
          }
          openItem(it)
        },
        [goto, openItem],
      )

      /* 列目录 */
      useEffect(() => {
        if (mode !== 'browse') return undefined
        let alive = true
        setBloading(true)
        apiGet('/ls', { path: bpath, sort: bsort, order: border })
          .then((d) => {
            if (!alive) return
            setBitems(Array.isArray(d.items) ? d.items : [])
            setBparent(d.parent || null)
            setBvirtual(!!d.virtual)
            setBtruncated(!!d.truncated)
            setBerror(null)
            setBloading(false)
            setBsel(-1)
            setAddr(d.virtual ? '' : d.path || bpath)
          })
          .catch((e) => {
            if (!alive) return
            setBerror(softError(e))
            setBitems([])
            setBloading(false)
          })
        return () => {
          alive = false
        }
      }, [mode, bpath, bsort, border, btick])

      /* 右上角胶囊 / 搜索结果点目录 → 面板内跳转 */
      useEffect(() => {
        const fn = (path) => goto(path, true)
        navBus.add(fn)
        return () => navBus.delete(fn)
      }, [goto])

      const crumbs = (() => {
        if (bvirtual || !bpath) return [{ label: '此电脑', path: '' }]
        const segs = String(bpath).split(/[\\/]+/).filter(Boolean)
        const out = [{ label: '此电脑', path: '' }]
        let acc = ''
        segs.forEach((s, i) => {
          if (i === 0 && /^[A-Za-z]:$/.test(s)) acc = s + '\\'
          else acc = acc.endsWith('\\') ? acc + s : acc + '\\' + s
          out.push({ label: s, path: acc })
        })
        return out
      })()

      const onAddrKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          goto(String(addr).trim(), true)
          setEditing(false)
          if (addrRef.current) addrRef.current.blur()
          return
        }
        if (e.key === 'Escape') {
          setAddr(bvirtual ? '' : bpath)
          setEditing(false)
          if (addrRef.current) addrRef.current.blur()
        }
      }

      const onBrowseKey = (e) => {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setBsel((s) => (bitems.length === 0 ? -1 : Math.min(bitems.length - 1, s + 1)))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setBsel((s) => (bitems.length === 0 ? -1 : Math.max(0, s - 1)))
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          enterItem(bitems[bsel < 0 ? 0 : bsel])
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          navUp()
        }
      }

      const onKeyDown = useCallback(
        (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => (items.length === 0 ? -1 : Math.min(items.length - 1, s + 1)))
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => (items.length === 0 ? -1 : Math.max(0, s - 1)))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            const it = items[sel < 0 ? 0 : sel]
            if (!it) return
            if (e.ctrlKey || e.metaKey) revealItem(it)
            else enterItem(it)
            return
          }
          if (e.key === 'Escape') {
            if (q) setQ('')
          }
        },
        [items, sel, enterItem, revealItem, q],
      )

      const badgeText = useMemo(() => {
        if (statusError) return '后端未响应'
        if (!status) return '连接中'
        if (!status.exists) return 'es.exe 缺失'
        if (!status.everythingVersion) return 'Everything 未运行'
        return `Everything ${status.everythingVersion}`
      }, [status, statusError])

      const badgeBad = !!(statusError || (status && (!status.exists || !status.everythingVersion)))

      /* 用户名不能写死：后端 /status 会把 homedir() 带过来，拿不到就用通配的
         path: 语法退化（只按目录名匹配），总之不能出现某个人的 C:\Users\xxx。 */
      const home = (status && typeof status.home === 'string' && status.home) || ''
      const homeQuery = (seg) => (home ? `path:"${home}\\${seg}" ` : `path:${seg} `)
      const quick = [
        { label: '文档', q: homeQuery('Documents') },
        { label: '桌面', q: homeQuery('Desktop') },
        { label: '下载', q: homeQuery('Downloads') },
        { label: '图片', q: 'ext:jpg;png;webp;gif ' },
        { label: '文档', q: 'ext:doc;docx;pdf;md;txt ' },
        { label: '代码', q: 'ext:js;ts;py;c;cpp;go;rs ' },
        { label: '今天改的', q: 'datemodified:today ' },
        { label: '大文件', q: 'size:>100mb ' },
      ]

      /* ------------------------------------------------------------ 渲染片段 */

      const row = (it, i) => {
        const ext = it.isDir ? '' : extOf(it.name)
        return h(
          'div',
          {
            key: it.path + '#' + i,
            className: 'es-row',
            'data-idx': i,
            'data-sel': i === sel ? '1' : '0',
            'data-dir': it.isDir ? '1' : '0',
            title: it.path,
            onClick: () => setSel(i),
            onDoubleClick: () => enterItem(it),
            onContextMenu: (e) => {
              setSel(i)
              esxOpenMenu(e, [
                { label: it.isDir ? '在面板中打开' : '用默认程序打开', onPick: () => enterItem(it) },
                { label: '在资源管理器中定位', onPick: () => revealItem(it) },
                { label: '复制路径', onPick: () => copyPath(it) },
              ])
            },
          },
          h('span', { className: 'es-ricon' }, it.isDir ? h(IconFolder, { size: 15 }) : h(IconFile, { size: 15 })),
          h(
            'span',
            { className: 'es-main' },
            h('span', { className: 'es-name' }, regex ? it.name : highlight(it.name, query)),
            h('span', { className: 'es-path' }, it.parent || ''),
          ),
          h(
            'span',
            { className: 'es-fig' },
            h('span', null, it.isDir ? '文件夹' : fmtSize(it.size)),
            h('span', null, fmtDate(it.mtime) || (ext ? `.${ext}` : '')),
          ),
          h(
            'span',
            { className: 'es-acts' },
            h(
              'button',
              {
                className: 'es-act',
                title: it.isDir ? '在面板中打开' : '打开',
                onClick: (e) => {
                  e.stopPropagation()
                  enterItem(it)
                },
              },
              h(IconOpen, {}),
            ),
            h(
              'button',
              {
                className: 'es-act',
                title: '在资源管理器中定位',
                onClick: (e) => {
                  e.stopPropagation()
                  revealItem(it)
                },
              },
              h(IconTarget, {}),
            ),
            h(
              'button',
              {
                className: 'es-act',
                title: '复制路径',
                onClick: (e) => {
                  e.stopPropagation()
                  copyPath(it)
                },
              },
              h(IconCopy, {}),
            ),
          ),
        )
      }

      const body = (() => {
        if (!query) {
          return h(
            'div',
            { className: 'es-empty' },
            h('span', { className: 'es-empty-ico' }, h(IconSearch, { size: 34 })),
            h('span', { className: 'es-empty-t' }, '输入关键词，直接搜本机文件'),
            h(
              'span',
              { className: 'es-empty-s' },
              '读的是 Everything 的实时索引，整盘毫秒级出结果。支持 Everything 语法：ext:、path:、size:>10mb、datemodified:today，也可勾选正则。',
            ),
            h(
              'span',
              { className: 'es-quick' },
              quick.map((x) =>
                h(
                  'button',
                  {
                    key: x.label,
                    onClick: () => {
                      setQ(x.q)
                      if (inputRef.current) inputRef.current.focus()
                    },
                  },
                  x.label,
                ),
              ),
            ),
          )
        }
        if (error && error.msg) {
          /* 环境不具备不是「搜索失败」，别用坏色吓人 */
          return h(
            'div',
            { className: 'es-empty' },
            h(
              'span',
              { className: 'es-empty-t', style: { color: error.soft ? 'var(--e-warn)' : 'var(--e-bad)' } },
              error.soft ? '暂时搜不了' : '搜索失败',
            ),
            h('span', { className: 'es-empty-s' }, error.msg),
          )
        }
        if (!loading && items.length === 0) {
          return h(
            'div',
            { className: 'es-empty' },
            h('span', { className: 'es-empty-ico' }, h(IconSearch, { size: 30 })),
            h('span', { className: 'es-empty-t' }, `没有匹配「${query}」的文件`),
            h('span', { className: 'es-empty-s' }, '试试缩短关键词、勾选「匹配路径」，或者换用 Everything 语法。'),
          )
        }
        return h('div', { className: 'es-list', ref: listRef }, items.map(row))
      })()

      /* -------------------------------------------------- 浏览模式：浏览器式 chrome */

      /** 页签名：取路径末段；根路径显示「此电脑」。 */
      const titleOf = (p) => {
        if (!p) return '此电脑'
        const seg = String(p)
          .replace(/[\\/]+$/, '')
          .split(/[\\/]+/)
          .filter(Boolean)
        return seg.length ? seg[seg.length - 1] : String(p)
      }

      const tabStrip = h(
        'div',
        {
          className: 'es-tb',
          title: '双击空白处新建标签页',
          onDoubleClick: (e) => {
            /* 只有点在页签条的空白处才新建，避免和双击页签冲突 */
            if (e.target === e.currentTarget) newTab('')
          },
        },
        h(
          'button',
          {
            className: 'es-tab',
            'data-on': mode === 'search' ? '1' : '0',
            title: '搜索（读 Everything 索引）',
            onClick: () => setMode('search'),
          },
          h('span', { className: 'es-tab-ic' }, h(IconSearch, { size: 12 })),
          h('span', { className: 'es-tab-t' }, '搜索'),
        ),
        btabs.map((t) =>
          h(
            'div',
            {
              key: t.id,
              className: 'es-tab',
              'data-on': mode === 'browse' && t.id === btab ? '1' : '0',
              title: t.path || '此电脑',
              onClick: () => {
                setBtab(t.id)
                setMode('browse')
              },
              onMouseDown: (e) => {
                /* 中键关闭，和浏览器一致 */
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(t.id)
                }
              },
            },
            h('span', { className: 'es-tab-ic' }, h(IconFolder, { size: 12 })),
            h('span', { className: 'es-tab-t' }, titleOf(t.path)),
            btabs.length > 1
              ? h(
                  'button',
                  {
                    className: 'es-tab-x',
                    title: '关闭标签页',
                    onClick: (e) => {
                      e.stopPropagation()
                      closeTab(t.id)
                    },
                  },
                  h(IconX, { size: 10 }),
                )
              : null,
          ),
        ),
        h('button', { className: 'es-tab-plus', title: '新标签页（此电脑）', onClick: () => newTab('') }, '+'),
      )

      const navBar = h(
        'div',
        { className: 'es-nav' },
        h('button', { className: 'es-icobtn', title: '后退', disabled: bhist.idx <= 0, onClick: navBack }, '←'),
        h(
          'button',
          { className: 'es-icobtn', title: '前进', disabled: bhist.idx >= bhist.stack.length - 1, onClick: navFwd },
          '→',
        ),
        h(
          'button',
          { className: 'es-icobtn', title: '上一级（Backspace）', disabled: bvirtual || !bparent, onClick: navUp },
          '↑',
        ),
        h('button', { className: 'es-icobtn', title: '刷新', onClick: () => setBtick((t) => t + 1) }, '⟳'),
        h(
          'div',
          { className: 'es-addrb' },
          h('span', { className: 'es-tab-ic' }, h(IconFolder, { size: 12 })),
          h('input', {
            ref: addrRef,
            className: 'es-addr',
            type: 'text',
            value: addr,
            placeholder: bpath ? '输入路径后回车，例如 D:\\Work\\notes' : '此电脑',
            spellCheck: false,
            autoComplete: 'off',
            onChange: (e) => setAddr(e.target.value),
            onKeyDown: onAddrKey,
            onFocus: (e) => {
              setEditing(true)
              try {
                e.target.select()
              } catch (err) {
                /* 忽略：部分环境下 select 不可用 */
              }
            },
            onBlur: () => setEditing(false),
          }),
          errMsg(berror) ? h('span', { className: 'es-addr-err', title: errMsg(berror) }, '!') : null,
        ),
        h(
          'button',
          {
            className: 'esb-btn',
            'data-wide': '1',
            title: '在资源管理器中打开当前目录',
            disabled: !bpath,
            onClick: () => {
              if (!bpath) return
              apiPost('/open', { path: bpath }).catch((e) => setToast('打不开：' + (e && e.message ? e.message : e)))
            },
          },
          '资源管理器',
        ),
      )

      const arrow = (key) => (bsort === key ? h('span', { className: 'esb-arrow' }, border === 'asc' ? '▲' : '▼') : null)

      const esbHead = h(
        'div',
        { className: 'esb-head' },
        h('span', { onClick: () => toggleSort('name'), title: '按名称排序' }, '名称', arrow('name')),
        h('span', { onClick: () => toggleSort('date'), title: '按修改日期排序' }, '修改日期', arrow('date')),
        h('span', { onClick: () => toggleSort('type'), title: '按类型排序' }, '类型', arrow('type')),
        h('span', { className: 'esb-h-size', onClick: () => toggleSort('size'), title: '按大小排序' }, '大小', arrow('size')),
      )

      const bActs = (it) => [
        h(
          'button',
          {
            key: 'open',
            className: 'esb-btn',
            title: it.isDir ? '在面板中打开' : '用默认程序打开',
            onClick: (e) => {
              e.stopPropagation()
              enterItem(it)
            },
          },
          h(IconOpen, { size: 12 }),
        ),
        h(
          'button',
          {
            key: 'reveal',
            className: 'esb-btn',
            title: '在资源管理器中定位',
            onClick: (e) => {
              e.stopPropagation()
              revealItem(it)
            },
          },
          h(IconTarget, { size: 12 }),
        ),
        h(
          'button',
          {
            key: 'copy',
            className: 'esb-btn',
            title: '复制完整路径',
            onClick: (e) => {
              e.stopPropagation()
              copyPath(it)
            },
          },
          h(IconCopy, { size: 12 }),
        ),
      ]

      const browseList = (() => {
        if (bloading && bitems.length === 0) {
          return h('div', { className: 'esb-empty' }, h('span', { className: 'esb-empty-t' }, '正在读取目录…'))
        }
        if (berror && berror.msg) {
          return h(
            'div',
            { className: 'esb-empty' },
            h(
              'span',
              { className: 'esb-empty-t', style: { color: berror.soft ? 'var(--e-warn)' : 'var(--e-bad)' } },
              berror.soft ? '暂时打不开' : '打不开这个位置',
            ),
            h('span', { className: 'esb-empty-s' }, berror.msg),
            h('button', { className: 'esb-btn', 'data-wide': '1', onClick: () => goto('', true) }, '回到此电脑'),
          )
        }
        if (bitems.length === 0) {
          return h(
            'div',
            { className: 'esb-empty' },
            h('span', { className: 'esb-empty-t' }, '这里是空的'),
            h('span', { className: 'esb-empty-s' }, '换个目录，或者点上面的 ↑ 回上一级。'),
          )
        }
        return h(
          'div',
          { className: 'esb-list', ref: blistRef },
          bitems.map((it, i) =>
            h(
              'div',
              {
                key: it.path || it.name + '#' + i,
                className: 'esb-row',
                'data-idx': i,
                'data-sel': i === bsel ? '1' : '0',
                'data-dir': it.isDir ? '1' : '0',
                title: it.path,
                onClick: () => setBsel(i),
                onDoubleClick: () => enterItem(it),
              },
              h(
                'span',
                { className: 'esb-name' },
                h('span', { className: 'esb-ic' }, it.isDir ? h(IconFolder, { size: 15 }) : h(IconFile, { size: 15 })),
                h('span', { className: 'esb-nm' }, it.name),
              ),
              h('span', { className: 'esb-dim' }, fmtDate(it.mtime)),
              h('span', { className: 'esb-dim' }, it.isDir ? '文件夹' : it.type || '文件'),
              h('span', { className: 'esb-num' }, it.isDir ? '—' : fmtSize(it.size)),
              h('span', { className: 'esb-acts' }, bActs(it)),
            ),
          ),
        )
      })()

      const browsePane = h(
        'div',
        { className: 'es-browse', onKeyDown: onBrowseKey, tabIndex: -1 },
        navBar,
        esbHead,
        browseList,
        btruncated
          ? h(
              'div',
              { className: 'esb-empty', style: { flex: '0 0 auto', padding: '6px 16px', alignItems: 'flex-start' } },
              h('span', { className: 'esb-empty-s' }, '条目太多，只显示前 4000 项，换个更具体的目录试试。'),
            )
          : null,
      )

      return h(
        'div',
        { className: 'es-root' },
        tabStrip,
        h(
          'div',
          { className: 'es-head', style: mode === 'browse' ? { display: 'none' } : undefined },
          h(
            'div',
            { className: 'es-title' },
            h('h1', null, '文件搜索'),
            h('span', { className: 'es-badge' + (badgeBad ? ' es-bad' : ''), title: status && status.esPath ? status.esPath : '' }, badgeText),
            h('span', { className: 'es-spacer' }),
          ),
          h(
            'div',
            { className: 'es-searchbar' },
            h('span', { className: 'es-ico' }, h(IconSearch, { size: 16 })),
            h('input', {
              ref: inputRef,
              className: 'es-input',
              type: 'text',
              value: q,
              placeholder: '搜文件或文件夹…  例：报告 ext:docx   /   size:>100mb',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (e) => setQ(e.target.value),
              onKeyDown,
            }),
            loading ? h('span', { className: 'es-spin' }) : null,
            q
              ? h(
                  'button',
                  {
                    className: 'es-clear',
                    title: '清空（Esc）',
                    onClick: () => {
                      setQ('')
                      if (inputRef.current) inputRef.current.focus()
                    },
                  },
                  h(IconX, {}),
                )
              : null,
          ),
          h(
            'div',
            { className: 'es-tools' },
            h(
              'span',
              { className: 'es-seg' },
              [
                { v: 'all', l: '全部' },
                { v: 'file', l: '文件' },
                { v: 'dir', l: '文件夹' },
              ].map((x) =>
                h(
                  'button',
                  { key: x.v, 'data-on': kind === x.v ? '1' : '0', onClick: () => setKind(x.v) },
                  x.l,
                ),
              ),
            ),
            h(
              'label',
              { className: 'es-chk', 'data-on': matchPath ? '1' : '0', title: '关键词匹配完整路径' },
              h('input', { type: 'checkbox', checked: matchPath, onChange: (e) => setMatchPath(e.target.checked) }),
              '匹配路径',
            ),
            h(
              'label',
              { className: 'es-chk', 'data-on': wholeWord ? '1' : '0', title: '整词匹配' },
              h('input', { type: 'checkbox', checked: wholeWord, onChange: (e) => setWholeWord(e.target.checked) }),
              '整词',
            ),
            h(
              'label',
              { className: 'es-chk', 'data-on': matchCase ? '1' : '0', title: '区分大小写' },
              h('input', { type: 'checkbox', checked: matchCase, onChange: (e) => setMatchCase(e.target.checked) }),
              '区分大小写',
            ),
            h(
              'label',
              { className: 'es-chk', 'data-on': regex ? '1' : '0', title: '按正则表达式匹配' },
              h('input', { type: 'checkbox', checked: regex, onChange: (e) => setRegex(e.target.checked) }),
              '正则',
            ),
            h('span', { className: 'es-spacer' }),
            h(
              'select',
              { className: 'es-sel', value: sort, onChange: (e) => setSort(e.target.value), title: '排序' },
              SORT_OPTIONS.map((o) => h('option', { key: o.v, value: o.v }, o.label)),
            ),
            h(
              'select',
              {
                className: 'es-sel',
                value: String(limit),
                onChange: (e) => setLimit(Number(e.target.value)),
                title: '每页条数',
              },
              LIMIT_OPTIONS.map((n) => h('option', { key: n, value: String(n) }, `${n} 条`)),
            ),
          ),
        ),

        h(
          'div',
          { className: 'es-meta', style: mode === 'browse' ? { display: 'none' } : undefined },
          error && error.msg
            ? h('span', { className: error.soft ? 'es-warn' : 'es-bad' }, error.msg)
            : total != null
              ? h(
                  'span',
                  null,
                  '共 ',
                  h('b', null, total.toLocaleString('zh-CN')),
                  ' 项命中 · 显示 ',
                  h('b', null, String(items.length)),
                  ' 项',
                  hasMore ? '（可继续细化关键词）' : '',
                )
              : query && !loading
                ? h('span', null, `显示 ${items.length} 项`)
                : h('span', null, status && status.esPath ? `索引：Everything ${status.everythingVersion || '?'} · es ${status.esVersion || '?'}` : '待输入'),
          elapsedMs != null ? h('span', null, `用时 `, h('b', null, String(elapsedMs)), ' ms') : null,
          statusError ? h('span', { className: 'es-warn' }, `状态探针失败：${statusError}`) : null,
        ),

        mode === 'search' ? body : browsePane,

        h(
          'div',
          { className: 'es-foot' },
          mode === 'browse'
            ? [
                h(
                  'span',
                  { key: 'sel' },
                  h('span', { className: 'es-key' }, '↑'),
                  h('span', { className: 'es-key' }, '↓'),
                  ' 选择',
                ),
                h('span', { key: 'enter' }, h('span', { className: 'es-key' }, 'Enter'), ' 进入'),
                h('span', { key: 'up' }, h('span', { className: 'es-key' }, 'Backspace'), ' 上一级'),
                h('span', { key: 'dbl' }, '双击行 = 进入 / 打开'),
                h('span', { key: 'sp', className: 'es-spacer' }),
                h('span', { key: 'cnt' }, `当前目录 ${bitems.length} 项`),
              ]
            : [
                h(
                  'span',
                  { key: 'sel' },
                  h('span', { className: 'es-key' }, '↑'),
                  h('span', { className: 'es-key' }, '↓'),
                  ' 选择',
                ),
                h('span', { key: 'enter' }, h('span', { className: 'es-key' }, 'Enter'), ' 打开'),
                h(
                  'span',
                  { key: 'reveal' },
                  h('span', { className: 'es-key' }, 'Ctrl'),
                  '+',
                  h('span', { className: 'es-key' }, 'Enter'),
                  ' 定位',
                ),
                h('span', { key: 'dbl' }, '双击行 = 打开'),
                h('span', { key: 'sp', className: 'es-spacer' }),
                h('span', { key: 'syn' }, '语法：ext: path: size:> date:'),
              ],
        ),

        toast ? h('div', { className: 'es-toast' }, toast) : null,
      )
    }

    /* --------------------------------------------------- 右上角常驻搜索栏 */

    /** 常驻栏首屏条数：少而准，够用就好；也可以让用户自己选。 */
    const TOP_LIMITS = [12, 30, 60]
    const TOP_DEFAULT = 12

    /**
     * 会话头右上角的常驻文件搜索胶囊。
     * 输入即搜（140ms 防抖），结果全在内存里做键盘导航；Enter 打开、Ctrl+Enter 定位。
     */
    function TopSearchBar() {
      useStylesheet()

      const [q, setQ] = useState('')
      const [query, setQuery] = useState('')
      const [open, setOpen] = useState(false)
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(null)
      const [elapsedMs, setElapsedMs] = useState(null)
      const [cached, setCached] = useState(false)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [sel, setSel] = useState(0)
      const [box, setBox] = useState({ top: 0, left: 0, width: 408 })

      /* 内嵌浏览：bp=null 表示在搜索态，否则显示该目录（'' = 此电脑） */
      const [bp, setBp] = useState(null)
      const [bitems, setBitems] = useState([])
      const [bparent, setBparent] = useState('')
      const [bvirtual, setBvirtual] = useState(false)
      const [bloading, setBloading] = useState(false)
      const [berror, setBerror] = useState('')
      const [bsel, setBsel] = useState(0)

      /* 弹层里的筛选：类型 / 精确整词 / 条数。搜索面板那套参数这里也能用上 */
      const [topKind, setTopKind] = useState('')
      const [topExact, setTopExact] = useState(false)
      const [topLimit, setTopLimit] = useState(TOP_DEFAULT)

      /* 搜索历史（输入框空着时给回访用）+ 拖拽/加附件的即时反馈 */
      const [history, setHistory] = useState(loadHistory)
      const [hsel, setHsel] = useState(0)
      const [note, setNote] = useState('')
      /* 历史折叠/展开：默认只露 8 条，展开后整份历史都在滚动区里 */
      const [histExpanded, setHistExpanded] = useState(false)

      const histShown = useMemo(
        () => (histExpanded ? history : history.slice(0, HIST_COLLAPSED)),
        [history, histExpanded],
      )
      const histMore = history.length > HIST_COLLAPSED

      /* 历史项伪装成列表行，走同一套选择 / 键盘逻辑 */
      const historyItems = useMemo(
        () => histShown.map((t) => ({ __hist: true, name: t, path: 'es-hist:' + t })),
        [histShown],
      )

      const rootRef = useRef(null)
      const popRef = useRef(null)
      const inputRef = useRef(null)
      const abortRef = useRef(null)
      const countRef = useRef(null)

      /* 输入防抖 */
      useEffect(() => {
        const t = setTimeout(() => setQuery(q.trim()), 140)
        return () => clearTimeout(t)
      }, [q])

      /* 搜索：先出结果，再懒补总数 */
      useEffect(() => {
        if (abortRef.current) abortRef.current.abort()
        if (countRef.current) countRef.current.abort()
        if (!query) {
          setItems([])
          setTotal(null)
          setElapsedMs(null)
          setCached(false)
          setLoading(false)
          setError('')
          return undefined
        }
        const hasAbort = typeof AbortController === 'function'
        const ctrl = hasAbort ? new AbortController() : null
        abortRef.current = ctrl
        setLoading(true)
        setError('')
        apiGet(
          '/search',
          {
            q: query,
            limit: topLimit,
            sort: '',
            count: '0',
            kind: topKind || 'all',
            wholeWord: topExact ? '1' : '',
          },
          ctrl ? ctrl.signal : undefined,
        )
          .then((d) => {
            const list = Array.isArray(d && d.items) ? d.items : []
            setItems(list)
            setSel(0)
            setElapsedMs(typeof (d && d.elapsedMs) === 'number' ? d.elapsedMs : null)
            setCached(Boolean(d && d.cached))
            /* 服务端发现 Everything 没在跑、刚帮你拉起来了 */
            if (d && d.autoStarted) setNote('Everything 没在运行，已自动帮你打开')
            setLoading(false)
            setOpen(true)
            const c2 = hasAbort ? new AbortController() : null
            countRef.current = c2
            /* 计数要跟着筛选走，否则「共 N 项」和列表对不上 */
            apiGet(
              '/count',
              { q: query, kind: topKind || 'all', wholeWord: topExact ? '1' : '' },
              c2 ? c2.signal : undefined,
            )
              .then((c) => setTotal(typeof (c && c.total) === 'number' ? c.total : null))
              .catch(() => {})
          })
          .catch((e) => {
            if (e && e.name === 'AbortError') return
            setItems([])
            setLoading(false)
            setError(softError(e))
          })
        return () => {
          if (ctrl) ctrl.abort()
        }
      }, [query, topKind, topExact, topLimit])

      /* 内嵌浏览：目录内容就地取回来，不惊动资源管理器 */
      useEffect(() => {
        if (bp === null) {
          setBitems([])
          setBerror('')
          setBloading(false)
          return undefined
        }
        let alive = true
        setBloading(true)
        setBerror('')
        apiGet('/ls', { path: bp, sort: 'name', order: 'asc' })
          .then((d) => {
            if (!alive) return
            setBitems(Array.isArray(d && d.items) ? d.items : [])
            setBparent(d && typeof d.parent === 'string' ? d.parent : '')
            setBvirtual(Boolean(d && d.virtual))
            setBsel(0)
            setBloading(false)
          })
          .catch((e) => {
            if (!alive) return
            setBitems([])
            setBloading(false)
            setBerror(softError(e))
          })
        return () => {
          alive = false
        }
      }, [bp])

      /* 面板贴着胶囊右下角展开，并跟随滚动/缩放 */
      const measure = useCallback(() => {
        const el = rootRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const width = Math.max(400, Math.min(520, Math.round(r.width * 1.5)))
        const maxLeft = Math.max(8, window.innerWidth - width - 8)
        setBox({
          top: Math.round(r.bottom + 8),
          left: Math.max(8, Math.min(maxLeft, Math.round(r.right - width))),
          width,
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        measure()
        const onMove = () => measure()
        window.addEventListener('scroll', onMove, true)
        window.addEventListener('resize', onMove)
        return () => {
          window.removeEventListener('scroll', onMove, true)
          window.removeEventListener('resize', onMove)
        }
      }, [open, measure])

      /* 提示条 2.6 秒后自己退场 */
      useEffect(() => {
        if (!note) return undefined
        const t = setTimeout(() => setNote(''), 2600)
        return () => clearTimeout(t)
      }, [note])

      /* 拖拽投递：自己的指针拖拽（不依赖 HTML5 drag）。
         原生 drag 在弹层里并不可靠，而且 dragstart 一旦触发就会抢走 pointer 事件；
         所以行上不挂 draggable，改看 pointerdown → pointermove → pointerup。 */
      useEffect(() => {
        const ptr = { item: null, active: false, chip: null, x: 0, y: 0 }
        const attr = (el, name) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null)
        const rowOf = (t) => (t && typeof t.closest === 'function' ? t.closest('[data-es-path]') : null)
        const under = (x, y) =>
          typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null

        const onDown = (e) => {
          if (e.button !== 0 && e.button !== undefined) return
          const row = rowOf(e.target)
          if (!row || attr(row, 'data-es-hist') === '1') return
          const path = attr(row, 'data-es-path') || ''
          if (!path) return
          ptr.item = { path, name: attr(row, 'data-es-name') || baseName(path), dir: attr(row, 'data-es-dir') === '1' }
          ptr.x = e.clientX || 0
          ptr.y = e.clientY || 0
          ptr.active = false
        }

        const onMove = (e) => {
          if (!ptr.item) return
          if (!ptr.active) {
            if (Math.abs((e.clientX || 0) - ptr.x) < 5 && Math.abs((e.clientY || 0) - ptr.y) < 5) return
            ptr.active = true
            ptr.chip = makeChip(ptr.item.name)
            if (document.body && document.body.style) document.body.style.userSelect = 'none'
          }
          moveChip(ptr.chip, e.clientX || 0, e.clientY || 0)
          const host = composerHostOf(under(e.clientX || 0, e.clientY || 0))
          clearDropMarks()
          if (host) markDropHost(host)
        }

        const settle = (e, cancelled) => {
          const item = ptr.item
          const active = ptr.active
          ptr.item = null
          ptr.active = false
          killChip(ptr.chip)
          ptr.chip = null
          clearDropMarks()
          if (document.body && document.body.style) document.body.style.userSelect = ''
          if (!item || !active) return
          dragEndedAt = Date.now()
          if (cancelled) return
          const host = composerHostOf(under(e.clientX || 0, e.clientY || 0))
          if (!host) return
          if (item.dir) insertPathToComposer(host, item.path)
          else attachToComposer(item.path, item.name, host)
        }

        const onUp = (e) => settle(e, false)
        const onCancel = (e) => settle(e, true)
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('pointerup', onUp, true)
        document.addEventListener('pointercancel', onCancel, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('pointerup', onUp, true)
          document.removeEventListener('pointercancel', onCancel, true)
          killChip(ptr.chip)
          clearDropMarks()
        }
      }, [])

      /* 关掉弹层就把「浏览到哪」忘掉：否则下次点开会直接落回上次那个目录，
         用户会觉得它记性太好。搜索词和关键词都留着，只清浏览位置与选中项。 */
      useEffect(() => {
        if (open) return
        setBp(null)
        setBsel(0)
        setHsel(0)
      }, [open])

      /* 点击外部关闭 */
      useEffect(() => {
        if (!open) return undefined
        const onDown = (e) => {
          const t = e && e.target
          const a = rootRef.current
          const b = popRef.current
          if (t && a && a.contains(t)) return
          if (t && b && b.contains(t)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open])

      /** 在弹层里打开目录（顺带通知侧栏面板，若它恰好也开着）。 */
      function openDir(path) {
        const p = typeof path === 'string' ? path : ''
        setBp(p)
        setBsel(0)
        setOpen(true)
        navBus.request(p)
        measure()
        if (inputRef.current) inputRef.current.focus()
      }

      /** 返回上一级；已在虚拟根时退回搜索态。 */
      function leaveDir() {
        if (bp === null) {
          setOpen(false)
          return
        }
        if (bvirtual || !bparent) setBp(null)
        else openDir(bparent)
      }

      /** 记一条关键词：去重（大小写无关）、保序、最多 HIST_MAX 条。 */
      function commitHistory(text) {
        const t = String(text || '').trim()
        if (!t) return
        setHistory((prev) => {
          const k = t.toLowerCase()
          const next = [t, ...prev.filter((x) => String(x).toLowerCase() !== k)].slice(0, HIST_MAX)
          saveHistory(next)
          return next
        })
      }

      /** 删掉一条历史（保留剩余项的选中位置）。 */
      function dropHistory(text) {
        setHistory((prev) => {
          const next = prev.filter((x) => x !== text)
          saveHistory(next)
          setHsel((i) => Math.max(0, Math.min(i, next.length - 1)))
          return next
        })
      }

      /** 点历史项 = 拿它重新搜一次。 */
      function useHistory(text) {
        const t = String(text || '')
        setQ(t)
        setQuery(t)
        setBp(null)
        setHsel(0)
        setOpen(true)
        if (inputRef.current) inputRef.current.focus()
      }

      function clearHistory() {
        setHistory([])
        saveHistory([])
        setHsel(0)
        setOpen(false)
        setHistExpanded(false)
      }

      /** 把本机文件喂进宿主对话输入框：取字节 → 造 File → 塞隐藏 input → 触发 change。 */
      async function attachToComposer(path, name, host) {
        const target =
          (host && host.querySelector && host.querySelector('input[type="file"][multiple]')) || lastFileInput()
        if (!target) {
          setError('找不到对话输入框，先打开一个会话')
          return
        }
        const label = name || baseName(path)
        try {
          const res = await fetch(API + '/blob?path=' + encodeURIComponent(path), { credentials: 'same-origin' })
          if (!res.ok) {
            let msg = ''
            try {
              const j = await res.json()
              msg = j && j.error ? j.error : ''
            } catch {
              /* 不是 JSON 就用状态码兜底 */
            }
            // 401/403 是宿主层没放行（登录态过期 / 插件还没重启到新代码），不是文件的问题。
            if (res.status === 401 || res.status === 403) {
              throw new Error('宿主没放行这次请求（登录态过期或插件还没加载完），刷新页面再试')
            }
            throw new Error(msg || '读不到文件（HTTP ' + res.status + '）')
          }
          const blob = await res.blob()
          const file = new File([blob], label, { type: blob.type || 'application/octet-stream' })
          const dt = new DataTransfer()
          dt.items.add(file)
          target.files = dt.files
          target.dispatchEvent(new Event('change', { bubbles: true }))
          /* 宿主 onPickFiles 一进来就 e.target.value = ''，files 会被清空；
             还留着说明这次 change 没人接（输入框被禁用 / 正在发消息），别谎报成功。 */
          if (target.files && target.files.length > 0) {
            try {
              target.value = ''
            } catch {
              /* 少数浏览器不给改 value，忽略 */
            }
            setError('输入框没接住这个文件（可能正在发送或附件被禁用），稍后再试')
            setNote('')
            return
          }
          setError('')
          setNote('已加入对话：' + label)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }

      /* 目录拖进来当不了附件：直接把绝对路径写进 composer，等于手打一行路径 */
      function insertPathToComposer(host, path) {
        const text = String(path || '')
        if (!text) return
        let editor = null
        try {
          /* host 可能是可编辑区本身，也可能是包着它的容器，两种情况都要认 */
          if (host && host.getAttribute && host.getAttribute('contenteditable') === 'true') editor = host
          else if (host && host.querySelector) editor = host.querySelector('[contenteditable="true"]')
        } catch {
          editor = null
        }
        if (!editor) {
          setError('找不到对话输入框，先打开一个会话')
          return
        }
        try {
          if (typeof editor.focus === 'function') editor.focus()
          const sel = window.getSelection ? window.getSelection() : null
          if (sel && document.createRange) {
            const range = document.createRange()
            range.selectNodeContents(editor)
            range.collapse(false)
            sel.removeAllRanges()
            sel.addRange(range)
          }
          const done =
            typeof document.execCommand === 'function'
              ? document.execCommand('insertText', false, text + ' ')
              : false
          if (!done) throw new Error('execCommand 拒绝插入')
          setError('')
          setNote('已插入目录路径：' + baseName(path))
        } catch {
          setError('插不进输入框，已把路径复制到剪贴板')
          setNote('')
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text)
          } catch {
            /* 剪贴板也可能被拒；下面用提示条把路径带出来 */
          }
          setNote(text)
        }
      }

      async function act(it, reveal) {
        if (!it) return
        /* 历史行不是文件：点一下就拿这个词重搜 */
        if (it.__hist) {
          useHistory(it.name)
          return
        }
        if (!it.path) return
        commitHistory(q)
        if (reveal) {
          try {
            await apiPost('/reveal', { path: it.path })
            setOpen(false)
            setError('')
          } catch (e) {
            setError(e && e.message ? e.message : String(e))
          }
          return
        }
        /* 目录：直接在本弹层里展开，绝不弹资源管理器 */
        if (it.isDir) {
          openDir(it.path)
          setError('')
          return
        }
        try {
          await apiPost('/open', { path: it.path })
          setOpen(false)
          setError('')
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }

      function onKeyDown(e) {
        const browsing = bp !== null
        const hist = !browsing && q.trim() === '' && historyItems.length > 0
        const list = browsing ? bitems : hist ? historyItems : items
        const n = list.length
        const cur = browsing ? bsel : hist ? hsel : sel
        const put = browsing ? setBsel : hist ? setHsel : setSel
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setOpen(true)
          if (n) put(Math.min(n - 1, cur + 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (n) put(Math.max(0, cur - 1))
        } else if (e.key === 'Enter') {
          if (!n) {
            /* 一条结果都没有也按了 Enter：至少把这个词记下来，下次点开能重搜 */
            if (!browsing && !hist && q.trim()) commitHistory(q)
            return
          }
          e.preventDefault()
          act(list[Math.min(cur, n - 1)], e.ctrlKey || e.metaKey)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          if (browsing) setBp(null)
          else if (open) setOpen(false)
          else setQ('')
        } else if (e.key === 'Backspace' && browsing && !q) {
          e.preventDefault()
          leaveDir()
        }
      }

      const browsing = bp !== null
      const showHistory = !browsing && q.trim() === '' && historyItems.length > 0
      const showing = open && (q.trim().length > 0 || browsing || showHistory)
      const totalText = total == null ? '…' : total.toLocaleString('zh-CN')
      const list = browsing ? bitems : showHistory ? historyItems : items
      const curSel = browsing ? bsel : showHistory ? hsel : sel
      const putSel = browsing ? setBsel : showHistory ? setHsel : setSel
      const busy = browsing ? bloading : loading
      const problem = browsing ? berror : error
      const mode = browsing ? 'browse' : showHistory ? 'history' : 'search'

      /* 面包屑：此电脑 › 盘符 › … › 当前目录 */
      const crumbs = (() => {
        const out = [{ label: '此电脑', path: '' }]
        if (!bp) return out
        const segs = String(bp).split(/[\\/]+/).filter(Boolean)
        let acc = ''
        segs.forEach((s, i) => {
          if (i === 0 && /^[A-Za-z]:$/.test(s)) acc = s + '\\'
          else acc = acc.endsWith('\\') ? acc + s : acc + '\\' + s
          out.push({ label: s, path: acc })
        })
        return out
      })()

      return h(
        'div',
        {
          className: 'esh-root',
          ref: rootRef,
          'data-open': showing ? '1' : '0',
        },

        h('span', { className: 'esh-ico' }, h(IconSearch, { size: 13 })),

        h('input', {
          className: 'esh-input',
          ref: inputRef,
          type: 'text',
          value: q,
          placeholder: '搜索本机文件',
          spellCheck: false,
          autoComplete: 'off',
          'aria-label': '搜索本机文件',
          onChange: (e) => {
            setQ(e.target.value)
            setOpen(true)
            /* 一动手打字就回到搜索态，不再霸着目录 */
            if (browsing) setBp(null)
          },
          onFocus: () => {
            if (q.trim() || browsing || history.length) setOpen(true)
          },
          onKeyDown,
        }),

        busy ? h('span', { className: 'esh-spin', 'aria-hidden': 'true' }) : null,

        q
          ? h(
              'button',
              {
                className: 'esh-clear',
                type: 'button',
                title: '清空',
                onClick: () => {
                  setQ('')
                  setQuery('')
                  setItems([])
                  if (!browsing) setOpen(false)
                  if (inputRef.current) inputRef.current.focus()
                },
              },
              h(IconX, { size: 11 }),
            )
          : null,

        showing
          ? h(
              'div',
              {
                className: 'esh-pop',
                ref: popRef,
                'data-mode': mode,
                'data-expanded': mode === 'history' && histExpanded ? '1' : '0',
                /* 历史态只是几个关键词，用不着跟搜索结果一样宽：
                   408px 里空一大片，看着就臃肿 */
                style: {
                  top: box.top + 'px',
                  left: box.left + 'px',
                  width: (mode === 'history' ? HIST_WIDTH : box.width) + 'px',
                },
              },

              browsing
                ? h(
                    'div',
                    { className: 'esh-crumbbar' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'esh-crumb',
                        title: bvirtual ? '回到搜索结果' : '上一级',
                        onClick: leaveDir,
                      },
                      bvirtual ? '‹ 搜索' : '‹ 上一级',
                    ),
                    crumbs.map((c, i) =>
                      h(
                        React.Fragment,
                        { key: 'c' + i },
                        i ? h('span', { className: 'esh-crumbsep' }, '›') : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'esh-crumb',
                            'data-last': i === crumbs.length - 1 ? '1' : '0',
                            title: c.path || '此电脑',
                            onClick: () => {
                              if (i < crumbs.length - 1) openDir(c.path)
                            },
                          },
                          c.label,
                        ),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'esh-pop-head' },
                    showHistory
                      ? h(
                            React.Fragment,
                            null,
                            h('span', { className: 'esh-pill' }, '最近搜索'),
                            h('span', null, '· ' + history.length + ' 条'),
                            h('span', { className: 'esh-spacer' }),
                            histMore
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'esh-hist-more',
                                    title: histExpanded ? '收起到 8 条' : `展开全部 ${history.length} 条`,
                                    'data-on': histExpanded ? '1' : '0',
                                    onMouseDown: (e) => e.preventDefault(),
                                    onClick: () => setHistExpanded((v) => !v),
                                  },
                                  histExpanded ? '收起' : `展开 ${history.length - HIST_COLLAPSED}`,
                                )
                              : null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'esh-hist-clear',
                                title: '清空搜索历史',
                                onMouseDown: (e) => e.preventDefault(),
                                onClick: clearHistory,
                              },
                              '清空',
                            ),
                          )
                        : h(
                            React.Fragment,
                            null,
                            h('span', { className: 'esh-pill' }, totalText),
                            h('span', null, '项命中'),
                            h('span', { className: 'esh-spacer' }),
                            elapsedMs != null ? h('span', null, elapsedMs + ' ms') : null,
                            cached ? h('span', { className: 'esh-pill', 'data-tone': 'ok' }, '缓存') : null,
                          ),
                  ),

              /* 筛选条：类型 / 精确整词 / 条数 —— 只影响搜索态 */
              !browsing && !showHistory && query
                ? h(
                    'div',
                    { className: 'esh-tools' },
                    h(
                      'div',
                      { className: 'esh-seg' },
                      [
                        { v: '', label: '全部' },
                        { v: 'file', label: '文件' },
                        { v: 'dir', label: '文件夹' },
                      ].map((o) =>
                        h(
                          'button',
                          {
                            key: o.v || 'all',
                            type: 'button',
                            'data-on': topKind === o.v ? '1' : '0',
                            onMouseDown: (e) => e.preventDefault(),
                            onClick: () => setTopKind(o.v),
                          },
                          o.label,
                        ),
                      ),
                    ),
                    h('span', { className: 'esh-spacer' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'esh-exact',
                        'data-on': topExact ? '1' : '0',
                        title: '只看整个名字就是这个词的（不是包含）',
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: () => setTopExact((v) => !v),
                      },
                      '精确',
                    ),
                    h(
                      'select',
                      {
                        className: 'esh-sel',
                        title: '显示条数',
                        value: String(topLimit),
                        onChange: (e) => setTopLimit(Number(e.target.value)),
                      },
                      TOP_LIMITS.map((n) => h('option', { key: n, value: String(n) }, `${n} 条`)),
                    ),
                  )
                : null,

              /* 浏览态也走这条：错误不再塞在 head 分支里，切换模式也不会把它弄丢。
                 黄色=环境不具备（没装/没开 Everything），红色=真的出错了 */
              errMsg(error)
                ? h('div', { className: 'esh-note', 'data-tone': errSoft(error) ? 'warn' : 'bad' }, errMsg(error))
                : null,

              note ? h('div', { className: 'esh-note' }, h(IconPlus, { size: 12 }), note) : null,

              h(
                'div',
                { className: 'esh-list' },
                list.map((it, i) =>
                  h(
                    'div',
                    {
                      key: it.__hist ? 'h' + i : it.path || 'r' + i,
                      className: 'esh-row',
                      'data-sel': i === curSel ? '1' : '0',
                      'data-hist': it.__hist ? '1' : '0',
                      /* 指针拖拽靠这三个属性认行；不用 HTML5 draggable（它和 pointer 抢事件） */
                      'data-es-path': it.__hist ? '' : it.path || '',
                      'data-es-name': it.__hist ? '' : it.name || '',
                      'data-es-dir': it.isDir ? '1' : '0',
                      title: it.__hist ? '点一下重新搜：' + it.name : it.isDir ? '拖到输入框 = 插入路径：' + it.path : '拖到输入框 = 加附件：' + it.path,
                      onMouseEnter: () => putSel(i),
                      onClick: (e) => {
                        /* 刚拖完那一下别当成点击 */
                        if (Date.now() - dragEndedAt < 400) {
                          if (e.preventDefault) e.preventDefault()
                          if (e.stopPropagation) e.stopPropagation()
                          return
                        }
                        act(it, e.ctrlKey || e.metaKey)
                      },
                      /* 右键：历史行不是文件，没有可打开的东西 */
                      onContextMenu: it.__hist
                        ? undefined
                        : (e) => {
                            putSel(i)
                            esxOpenMenu(e, [
                              { label: it.isDir ? '在面板中打开' : '用默认程序打开', onPick: () => act(it, false) },
                              { label: '在资源管理器中定位', onPick: () => act(it, true) },
                              { label: '复制路径', onPick: () => esxCopyText(it.path) },
                            ])
                          },
                    },
                    h(
                      'span',
                      {
                        className: 'esh-row-ico',
                        'data-dir': it.isDir ? '1' : '0',
                        'data-hist': it.__hist ? '1' : '0',
                      },
                      it.__hist
                        ? h(IconClock, { size: 14 })
                        : it.isDir
                          ? h(IconFolder, { size: 15 })
                          : h(IconFile, { size: 15 }),
                    ),
                    h(
                      'span',
                      { className: 'esh-row-main' },
                      h(
                        'span',
                        { className: 'esh-row-name' },
                        browsing || it.__hist ? it.name : highlight(it.name, query),
                      ),
                      /* 浏览态不写第二行：文件夹/类型交给右侧那格，
                         行高直接砍半，弹层看着轻一些 */
                      it.__hist
                        ? null
                        : browsing
                          ? null
                          : h('span', { className: 'esh-row-path' }, it.parent || ''),
                    ),
                    /* 历史行只给一个「删掉这条」：以前只能整体清空，
                       想只去掉一个打错的词就得把全部记录一起丢 */
                    it.__hist
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'esh-row-del',
                            title: '从历史里删掉这一条',
                            'aria-label': '删除这条历史',
                            onMouseDown: (e) => e.preventDefault(),
                            onClick: (e) => {
                              e.stopPropagation()
                              dropHistory(it.name)
                            },
                          },
                          h(IconX, { size: 10 }),
                        )
                      : null,
                    it.isDir || it.__hist
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'esh-row-add',
                            title: '加到对话（也可以直接拖到输入框）',
                            onMouseDown: (e) => e.preventDefault(),
                            onClick: (e) => {
                              e.stopPropagation()
                              attachToComposer(it.path, it.name)
                            },
                          },
                          h(IconPlus, { size: 12 }),
                        ),
                    /* 悬停才现形的「定位」「复制」 —— 和右键菜单同一套动作 */
                    it.__hist
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'esh-row-act',
                            title: '在资源管理器中定位',
                            onMouseDown: (e) => e.preventDefault(),
                            onClick: (e) => {
                              e.stopPropagation()
                              act(it, true)
                            },
                          },
                          h(IconTarget, { size: 11 }),
                        ),
                    it.__hist
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'esh-row-act',
                            title: '复制路径',
                            onMouseDown: (e) => e.preventDefault(),
                            onClick: (e) => {
                              e.stopPropagation()
                              esxCopyText(it.path)
                            },
                          },
                          h(IconCopy, { size: 11 }),
                        ),
                    browsing && it.isDir
                      ? h('span', { className: 'esh-row-size' }, '文件夹')
                      : it.isDir || it.__hist
                        ? null
                        : h('span', { className: 'esh-row-size' }, fmtSize(it.size)),
                  ),
                ),
                !problem && !list.length && !busy
                  ? h(
                      'div',
                      { className: 'esh-empty' },
                      browsing ? '这个文件夹是空的' : '没有匹配项，换个更短的关键词试试',
                    )
                  : null,
                /* 真故障才补一行大字；软提示（没装/没开 Everything）上面那条黄条已经说清了，别重复 */
                problem && browsing && !errSoft(problem)
                  ? h('div', { className: 'esh-empty' }, '打不开这个位置')
                  : null,
                busy ? h('div', { className: 'esh-empty' }, '正在读取目录…') : null,
              ),

              h(
                'div',
                { className: 'esh-foot' },
                h('span', null, h('kbd', { className: 'esh-key' }, '↑↓'), '选择'),
                h('span', { className: 'esh-dot' }, '·'),
                h('span', null, h('kbd', { className: 'esh-key' }, '↵'), browsing ? '进入' : showHistory ? '重搜' : '打开'),
                /* 历史态没有「定位」这个动作，别把一组按不动的键摆在底栏占地方 */
                showHistory
                  ? null
                  : [
                      h('span', { className: 'esh-dot', key: 'd2' }, '·'),
                      h('span', { key: 'loc' }, h('kbd', { className: 'esh-key' }, 'Ctrl↵'), '定位'),
                    ],
                h('span', { className: 'esh-spacer' }),
                browsing || showHistory ? null : h('span', { className: 'esh-hint' }, '右键更多 · 拖入输入框即加附件'),
                h('span', null, h('kbd', { className: 'esh-key' }, 'Esc'), browsing ? '返回' : '关闭'),
              ),
            )
          : null,
      )
    }

    /* -------------------------------------------- 开始界面（Hero）搜索入口 */

    /**
     * 宿主没有 hero 专用槽位（`conversation.hero` 不存在，`hero.options` 又是
     * session scope 且只在有会话时渲染），所以只能按 DOM 找开始界面那一行，
     * 再用 createPortal 把入口塞进去。选择器按命中概率从高到低兜底。
     */
    const HERO_ANCHORS = [
      '[data-dsh-hero-workspace-row]',
      '[data-conversation-hero]',
      '[class*="heroWorkspaceRow" i]',
      '[class*="hero" i][class*="workspace" i][class*="row" i]',
    ]

    function findHeroRow() {
      for (let i = 0; i < HERO_ANCHORS.length; i++) {
        try {
          const el = document.querySelector(HERO_ANCHORS[i])
          if (el) return el
        } catch {
          /* 个别选择器写法在旧内核里会抛，跳过 */
        }
      }
      return null
    }

    /** 被 margin-left:auto 顶到右边的「选项」元素：入口要插在它前面，才不会被甩到行尾。 */
    function isAutoPushed(el) {
      if (!el || !el.getAttribute) return false
      if (/heroOptions/i.test(String(el.className || ''))) return true
      try {
        return window.getComputedStyle(el).marginLeft === 'auto'
      } catch {
        return false
      }
    }

    function placeChip(row, el) {
      const kids = row.children || []
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]
        if (k === el) continue
        if (!isAutoPushed(k)) continue
        row.insertBefore(el, k)
        return
      }
      row.appendChild(el)
    }

    /**
     * 页面上还有没有「开始界面」的痕迹。用来区分两种找不到 hero 行的情况：
     *  - 有 hero 痕迹但选择器没命中 → 宿主改了类名，退化成右下角浮标；
     *  - 一点 hero 痕迹都没有 → 已经在会话里了，会话头本来就有搜索栏，不显示浮标。
     */
    function heroishPresent() {
      try {
        return Boolean(
          document.querySelector('[class*="heroWorkspaceRow" i]') ||
            document.querySelector('[data-dsh-hero-workspace-row]'),
        )
      } catch {
        return false
      }
    }

    /** 开始界面里的浮窗本体：输入即搜，键盘可选，Enter 打开、Ctrl+Enter 定位。 */
    function HeroSearchWin({ onClose }) {
      const [q, setQ] = useState('')
      const [query, setQuery] = useState('')
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(null)
      const [elapsedMs, setElapsedMs] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [sel, setSel] = useState(0)
      const [kind, setKind] = useState('')
      const [exact, setExact] = useState(false)

      const inputRef = useRef(null)
      const abortRef = useRef(null)
      const countRef = useRef(null)

      useEffect(() => {
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }, [])

      useEffect(() => {
        const t = setTimeout(() => setQuery(q.trim()), 140)
        return () => clearTimeout(t)
      }, [q])

      useEffect(() => {
        if (abortRef.current) {
          try {
            abortRef.current.abort()
          } catch {
            /* 已经结束了 */
          }
        }
        if (countRef.current) {
          try {
            countRef.current.abort()
          } catch {
            /* 同上 */
          }
        }
        if (!query) {
          setItems([])
          setTotal(null)
          setElapsedMs(null)
          setLoading(false)
          setError('')
          return undefined
        }
        const hasAbort = typeof AbortController === 'function'
        const ctrl = hasAbort ? new AbortController() : null
        const c2 = hasAbort ? new AbortController() : null
        abortRef.current = ctrl
        countRef.current = c2
        setLoading(true)
        setError('')
        apiGet(
          '/search',
          {
            q: query,
            limit: 40,
            sort: '',
            count: '0',
            kind: kind || 'all',
            wholeWord: exact ? '1' : '',
          },
          ctrl ? ctrl.signal : undefined,
        )
          .then((d) => {
            setItems(Array.isArray(d && d.items) ? d.items : [])
            setSel(0)
            setElapsedMs(typeof (d && d.elapsedMs) === 'number' ? d.elapsedMs : null)
            setLoading(false)
            apiGet(
              '/count',
              { q: query, kind: kind || 'all', wholeWord: exact ? '1' : '' },
              c2 ? c2.signal : undefined,
            )
              .then((c) => setTotal(typeof (c && c.total) === 'number' ? c.total : null))
              .catch(() => {
                /* 总数只是锦上添花，失败就不显示 */
              })
          })
          .catch((e) => {
            if (e && e.name === 'AbortError') return
            setItems([])
            setLoading(false)
            setError(softError(e))
          })
        return () => {
          if (ctrl) {
            try {
              ctrl.abort()
            } catch {
              /* 忽略 */
            }
          }
          if (c2) {
            try {
              c2.abort()
            } catch {
              /* 忽略 */
            }
          }
        }
      }, [query, kind, exact])

      const cur = items.length ? Math.max(0, Math.min(sel, items.length - 1)) : 0

      function run(it, reveal) {
        if (!it || !it.path) return
        const call = reveal ? apiPost('/reveal', { path: it.path }) : apiPost('/open', { path: it.path })
        call
          .then(() => {
            if (!reveal) onClose()
          })
          .catch((e) => setError(e && e.message ? e.message : String(e)))
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          if (e.preventDefault) e.preventDefault()
          onClose()
          return
        }
        if (e.key === 'ArrowDown') {
          if (e.preventDefault) e.preventDefault()
          if (items.length) setSel(Math.min(items.length - 1, cur + 1))
          return
        }
        if (e.key === 'ArrowUp') {
          if (e.preventDefault) e.preventDefault()
          if (items.length) setSel(Math.max(0, cur - 1))
          return
        }
        if (e.key === 'Enter') {
          if (e.preventDefault) e.preventDefault()
          run(items[cur], Boolean(e.ctrlKey || e.metaKey))
        }
      }

      return h(
        'div',
        {
          className: 'ess-win esh-root',
          role: 'dialog',
          'aria-label': '文件搜索',
          onKeyDown: onKey,
        },

        /* 标题条 */
        h(
          'div',
          { className: 'ess-head' },
          h(IconSearch, { size: 13 }),
          h('span', { className: 'ess-title' }, '文件搜索'),
          h('span', { className: 'esh-pill' }, 'Everything'),
          total != null ? h('span', null, '共 ' + total + ' 项') : null,
          elapsedMs != null ? h('span', null, '· ' + elapsedMs + ' ms') : null,
          h('span', { className: 'esh-spacer' }),
          h('kbd', { className: 'ess-kbd' }, 'Esc'),
          h(
            'button',
            { type: 'button', className: 'ess-x', title: '关闭', onClick: onClose },
            h(IconX, { size: 12 }),
          ),
        ),

        /* 输入条 */
        h(
          'div',
          { className: 'ess-ibar' },
          h(IconSearch, { size: 15 }),
          h('input', {
            ref: inputRef,
            className: 'ess-input',
            type: 'text',
            value: q,
            placeholder: '搜本机文件、文件夹…（输入即搜）',
            autoComplete: 'off',
            spellCheck: false,
            'aria-label': '搜索本机文件',
            onChange: (e) => setQ(e.target.value),
          }),
          loading ? h('span', { className: 'esh-spin' }) : null,
          q
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ess-clear',
                  title: '清空',
                  onClick: () => {
                    setQ('')
                    setQuery('')
                    if (inputRef.current && inputRef.current.focus) inputRef.current.focus()
                  },
                },
                h(IconX, { size: 10 }),
              )
            : null,
        ),

        /* 筛选条 */
        query
          ? h(
              'div',
              { className: 'esh-tools' },
              h(
                'div',
                { className: 'esh-seg' },
                [
                  { v: '', label: '全部' },
                  { v: 'file', label: '文件' },
                  { v: 'dir', label: '文件夹' },
                ].map((o) =>
                  h(
                    'button',
                    {
                      key: o.v || 'all',
                      type: 'button',
                      'data-on': kind === o.v ? '1' : '0',
                      onMouseDown: (e) => e.preventDefault(),
                      onClick: () => setKind(o.v),
                    },
                    o.label,
                  ),
                ),
              ),
              h('span', { className: 'esh-spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'esh-exact',
                  'data-on': exact ? '1' : '0',
                  title: '只看整个名字就是这个词的（不是包含）',
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => setExact((v) => !v),
                },
                '精确',
              ),
            )
          : null,

        /* 结果区 */
        h(
          'div',
          { className: 'ess-body' },
          errMsg(error)
            ? h('div', { className: 'esh-note', 'data-tone': errSoft(error) ? 'warn' : 'bad' }, errMsg(error))
            : null,
          items.length
            ? h(
                'div',
                { className: 'esh-list' },
                items.map((it, i) =>
                  h(
                    'div',
                    {
                      key: it.path || 'r' + i,
                      className: 'esh-row',
                      'data-sel': i === cur ? '1' : '0',
                      style: { cursor: 'pointer' },
                      title:
                        (it.isDir ? '点一下在资源管理器打开：' : '点一下用默认程序打开：') + (it.path || ''),
                      onMouseEnter: () => setSel(i),
                      onClick: () => run(it, false),
                      onDoubleClick: () => run(it, true),
                      onContextMenu: (e) => {
                        setSel(i)
                        esxOpenMenu(e, [
                          { label: it.isDir ? '在资源管理器中打开' : '用默认程序打开', onPick: () => run(it, false) },
                          { label: '在资源管理器中定位', onPick: () => run(it, true) },
                          { label: '复制路径', onPick: () => esxCopyText(it.path) },
                        ])
                      },
                    },
                    h(
                      'span',
                      { className: 'esh-row-ico', 'data-dir': it.isDir ? '1' : '0' },
                      h(it.isDir ? IconFolder : IconFile, { size: 14 }),
                    ),
                    h(
                      'span',
                      { className: 'esh-row-main' },
                      h('span', { className: 'esh-row-name' }, highlight(it.name || '', query)),
                      h('span', { className: 'esh-row-path' }, it.parent || ''),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'esh-row-add',
                        title: '在资源管理器里定位',
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: (e) => {
                          if (e.stopPropagation) e.stopPropagation()
                          run(it, true)
                        },
                      },
                      h(IconTarget, { size: 11 }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'esh-row-act',
                        title: '复制路径',
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: (e) => {
                          if (e.stopPropagation) e.stopPropagation()
                          esxCopyText(it.path)
                        },
                      },
                      h(IconCopy, { size: 11 }),
                    ),
                    h('span', { className: 'esh-row-size' }, it.isDir ? '文件夹' : fmtSize(it.size)),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'esh-empty' },
                loading
                  ? '正在搜索…'
                  : query
                    ? '没有匹配项，换个更短的关键词试试'
                    : '输入关键词，全盘秒级命中',
              ),
        ),

        /* 键盘提示 */
        h(
          'div',
          { className: 'esh-foot' },
          h('span', null, h('kbd', { className: 'esh-key' }, '↑↓'), '选择'),
          h('span', { className: 'esh-dot' }, '·'),
          h('span', null, h('kbd', { className: 'esh-key' }, '↵'), '打开'),
          h('span', { className: 'esh-dot' }, '·'),
          h('span', null, h('kbd', { className: 'esh-key' }, 'Ctrl↵'), '定位'),
          h('span', { className: 'esh-spacer' }),
          h('span', { className: 'esh-hint' }, '右键更多 · 双击定位 · Esc 关闭'),
        ),
      )
    }

    /**
     * 挂在 shell.overlay 上的常驻入口：找不到 hero 行就退化成右下角浮标，
     * 保证任何页面状态（含开始界面）都点得到。
     */
    function HeroSearchEntry() {
      useStylesheet()

      const [host, setHost] = useState(null)
      const [float, setFloat] = useState(false)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        let dead = false
        let chip = null
        let tries = 0
        function ensure() {
          if (dead) return
          const row = findHeroRow()
          if (row) {
            if (!chip) {
              chip = document.createElement('div')
              chip.className = 'ess-chip'
              chip.setAttribute('data-testid', 'everything-search-hero-chip')
            }
            if (chip.parentNode !== row) placeChip(row, chip)
            setFloat(false)
            setHost((prev) => (prev === chip ? prev : chip))
            return
          }
          tries += 1
          if (tries >= 3) setFloat(heroishPresent())
        }
        ensure()
        let obs = null
        try {
          obs = new MutationObserver(() => ensure())
          if (document.body) obs.observe(document.body, { childList: true, subtree: true })
        } catch {
          obs = null
        }
        const iv = setInterval(ensure, 1000)
        return () => {
          dead = true
          if (obs) obs.disconnect()
          clearInterval(iv)
          if (chip && chip.parentNode) chip.parentNode.removeChild(chip)
        }
      }, [])

      const btn = h(
        'button',
        {
          type: 'button',
          className: 'ess-chip-btn',
          'data-open': open ? '1' : '0',
          title: '搜索本机文件（Everything）',
          onClick: () => setOpen((v) => !v),
        },
        h(IconSearch, { size: 13 }),
        '文件搜索',
      )

      let rd = null
      try {
        rd = require('react-dom')
      } catch {
        rd = null
      }
      const portal = rd && typeof rd.createPortal === 'function' ? rd.createPortal : null

      const nodes = []
      if (float) {
        nodes.push(h('div', { key: 'float', className: 'ess-chip ess-chip--float' }, btn))
      } else if (host && portal) {
        nodes.push(portal(btn, host, 'es-hero-chip'))
      }

      if (open) {
        const win = h(HeroSearchWin, { onClose: () => setOpen(false) })
        const wrap = h(
          React.Fragment,
          null,
          h('div', { key: 'bd', className: 'ess-backdrop', onClick: () => setOpen(false) }),
          win,
        )
        if (portal && typeof document !== 'undefined' && document.body) {
          nodes.push(portal(wrap, document.body, 'es-hero-win'))
        } else {
          nodes.push(h('div', { key: 'win' }, wrap))
        }
      }

      if (!nodes.length) return null
      return h(React.Fragment, null, nodes)
    }

    /* -------------------------------------------------------------- 侧栏入口 */

    function PanelIcon({ size = 16 }) {
      const s = Number(size) || 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: s,
          height: s,
          'data-dsh-panel-entry': PANEL_ID,
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('circle', { cx: 6.7, cy: 6.7, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', {
          d: 'M9.9 9.9 L13.9 13.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    /* ------------------------------------------------------------------ 装配 */

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx && ctx.slots
        if (!slots || typeof slots.register !== 'function') return
        const canInject = typeof slots.inject === 'function'

        /*
         * 一个入口挂不上就跳过它，别把整块客户端拖下水。
         *
         * 槽位名（sidebar.panellist / conversation.session.header.utilities /
         * main / shell.overlay）和 inject 的调用形态都是宿主内部的约定，不是
         * 公开 API。宿主改名字、调 scope 结构、或者哪天 inject 换成别的签名，
         * 这里就会抛错 —— 而 apply 抛错是「整个插件的界面一起消失」，用户看到
         * 的是搜索栏全没了，不是一个入口没了。所以每个槽位各自兜住。
         */
        const mount = (scope, spec, Comp) => {
          const put = () => {
            try {
              return slots.register(spec, Comp)
            } catch {
              return null
            }
          }
          if (!canInject) {
            /* 只有 register 的宿主：直接挂，挂不上就算了 */
            put()
            return
          }
          try {
            slots.inject(scope, put)
          } catch {
            /* 这个 scope 不认识：放弃这一个入口，其余照旧 */
          }
        }

        mount(
          'sidebar.panellist',
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 41,
            label: () => '文件搜索',
          },
          PanelIcon,
        )

        /* 会话头右上角常驻搜索栏 */
        mount(
          'conversation.session.header.utilities',
          {
            name: 'conversation.session.header.utilities',
            id: PANEL_ID + '-topbar',
            order: 40,
            label: () => '文件搜索',
          },
          TopSearchBar,
        )

        mount(
          'main',
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({}),
          },
          App,
        )

        /*
         * 开始界面（无会话 Hero 页）入口 + 浮层搜索窗。
         * shell.overlay 是 root scope 的浮层，任何页面状态都在；
         * 内部自己按 DOM 找 hero 行做 portal，找不到就退化成右下角浮标。
         */
        mount(
          'shell.overlay',
          {
            name: 'shell.overlay',
            id: PANEL_ID + '-hero',
            order: 56,
            label: () => '文件搜索',
          },
          HeroSearchEntry,
        )
      },
    }
  },
  })
})(typeof window !== 'undefined' ? window.__ModuleLoader__ : null)
