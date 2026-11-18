/*
 * 引导态冒烟：在 vm 里把 client.js 的 bundle 跑起来，拿槽位里注册的
 * TopSearchBar 组件，模拟「聚焦搜索框」再渲染一次，断言第一屏真的画出了东西。
 * 不依赖宿主、不联网、不改任何文件。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '..', 'client.js')
const code = fs.readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    failures.push(name + (extra ? ' :: ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

/* ---------- 迷你 hooks 运行时：够把组件连渲染两次 ---------- */
const SLOTS = []
let cursor = 0
const resetHooks = () => {
  cursor = 0
}
const slot = (init) => {
  const i = cursor++
  if (!(i in SLOTS)) SLOTS[i] = typeof init === 'function' ? init() : init
  return { i, get: () => SLOTS[i], set: (v) => { SLOTS[i] = typeof v === 'function' ? v(SLOTS[i]) : v } }
}

const FakeReact = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.length > 1 ? children : children[0] }
  },
  useState(init) {
    const s = slot(init)
    return [s.get(), s.set]
  },
  useReducer(reducer, init) {
    const s = slot(init)
    return [s.get(), (a) => s.set((cur) => reducer(cur, a))]
  },
  useRef(init) {
    const s = slot({ current: init === undefined ? null : init })
    return s.get()
  },
  useEffect() {},
  useLayoutEffect() {},
  useInsertionEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useContext() {
    return {}
  },
  useSyncExternalStore(sub, get) {
    try {
      return get()
    } catch {
      return null
    }
  },
  useTransition() {
    return [false, (fn) => fn()]
  },
  useId() {
    return 'id'
  },
  memo: (c) => c,
  forwardRef: (c) => c,
  createContext: (v) => ({ Provider: 'Provider', _v: v }),
}

/* ---------- 宿主的最小投影 ---------- */
const storage = new Map()
const noop = () => {}
const fakeDocument = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  body: { appendChild: noop, removeChild: noop },
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop }),
  createTextNode: () => ({}),
  documentElement: { style: { setProperty: noop } },
}
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  document: fakeDocument,
  navigator: { platform: 'Win32', userAgent: 'smoke' },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  fetch: () => Promise.reject(new Error('offline smoke')),
  React: FakeReact,
  HTMLElement: class {},
  Element: class {},
  Node: class {},
  CustomEvent: class {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox

let factory = null
sandbox.window.__ModuleLoader__ = {
  load: (mod) => {
    factory = typeof mod === 'function' ? mod : mod.factory
    return {}
  },
  require: (n) => (n === 'react' ? FakeReact : {}),
}

console.log('== bundle ==================================================')
const ctx = vm.createContext(sandbox)
let threw = null
try {
  vm.runInContext(code, ctx, { filename: 'client.js' })
} catch (e) {
  threw = e
}
check('bundle 在 vm 里执行不抛', !threw, threw && threw.message)
check('拿到 factory', typeof factory === 'function')

if (factory) {
  const mod = factory((n) => (n === 'react' ? FakeReact : {}))
  check('factory 返回带 apply 的模块', !!(mod && typeof mod.apply === 'function'))
  check('inject 声明了 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))

  const registered = []
  const appCtx = {
    slots: {
      inject: (scope, put) => {
        try {
          put()
        } catch (e) {
          /* 宿主里 scope 不认识就是抛，这里模拟真实行为 */
          throw e
        }
      },
      register: (spec, Comp) => {
        registered.push({ spec, Comp })
        return 'dispose'
      },
    },
    logger: { warn: noop, info: noop, error: noop },
    effect: () => noop,
  }
  let applyThrew = null
  try {
    mod.apply(appCtx)
  } catch (e) {
    applyThrew = e
  }
  check('apply() 不抛', !applyThrew, applyThrew && applyThrew.message)
  check('注册了 4 个入口', registered.length === 4, 'got ' + registered.length)

  const top = registered.find((r) => r.spec.name === 'conversation.session.header.utilities')
  check('顶栏搜索栏已注册', !!top)

  if (top) {
    const render = () => {
      resetHooks()
      return top.Comp({})
    }
    let el = null
    let renderThrew = null
    try {
      el = render()
    } catch (e) {
      renderThrew = e
    }
    check('首次渲染不抛', !renderThrew, renderThrew && (renderThrew.stack || renderThrew.message))

    const collect = (node, out) => {
      if (node == null || node === false) return out
      if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node))
        return out
      }
      if (Array.isArray(node)) {
        node.forEach((n) => collect(n, out))
        return out
      }
      if (node.children !== undefined) collect(node.children, out)
      return out
    }
    const findProp = (node, key, out) => {
      if (node == null || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        node.forEach((n) => findProp(n, key, out))
        return out
      }
      if (node.props && typeof node.props[key] === 'function') out.push(node.props[key])
      if (node.children !== undefined) findProp(node.children, key, out)
      return out
    }

    const before = collect(el, [])
    check('未聚焦时弹层是关的（只有输入框）', !before.includes('还没有搜索记录'))

    const focuses = findProp(el, 'onFocus', [])
    check('输入框挂了 onFocus', focuses.length >= 1)
    let focusThrew = null
    try {
      focuses[0]({ target: {} })
    } catch (e) {
      focusThrew = e
    }
    check('onFocus 不抛', !focusThrew, focusThrew && focusThrew.message)

    let after = []
    let afterThrew = null
    try {
      after = collect(render(), [])
    } catch (e) {
      afterThrew = e
    }
    check('聚焦后重渲染不抛', !afterThrew, afterThrew && (afterThrew.stack || afterThrew.message))
    const flat = after.join(' | ')
    check('空历史时聚焦会弹出「尚未搜索」', flat.includes('尚未搜索'), flat.slice(0, 160))
    check('引导标题出现', flat.includes('还没有搜索记录'), flat.slice(0, 160))
    check('引导说明出现', flat.includes('最多保存 50 条'))
    check('5 个示例词都在', ['图片', '文档', '代码', '今天改的', '大文件'].every((t) => flat.includes(t)))
    check('引导态没有「项命中」这种假技术文案', !flat.includes('项命中'), flat.slice(0, 200))
    check('引导态底栏不摆「定位」', !flat.includes('定位'))
    check('引导态底栏保留 Esc', flat.includes('Esc'))

    /* ---------- 场景二：有历史时仍然是「最近搜索」，不能被引导态抢走 ---------- */
    SLOTS.length = 0
    resetHooks()
    storage.set('es:history:v1', JSON.stringify(['alpha', 'beta', 'ALPHA', '  ', 'gamma']))
    let el2 = null
    let threw2 = null
    try {
      el2 = render()
    } catch (e) {
      threw2 = e
    }
    check('有历史时首屏不抛', !threw2, threw2 && (threw2.stack || threw2.message))
    const f2 = findProp(el2, 'onFocus', [])
    if (f2.length) f2[0]({ target: {} })
    const flat2 = collect(render(), []).join(' | ')
    check('有历史时弹出「最近搜索」', flat2.includes('最近搜索'), flat2.slice(0, 160))
    check('有历史时不再显示引导文案', !flat2.includes('还没有搜索记录'))
    /* 输入 ['alpha','beta','ALPHA','  ','gamma'] → 大小写去重 + 丢空串 → 3 条 */
    check('历史去重 + 丢空串生效（alpha/beta/gamma，3 条）', flat2.includes('· 3 条') && !flat2.includes('ALPHA'), flat2.slice(0, 200))
    check('历史底栏有「重搜」', flat2.includes('重搜'))
  }
}

console.log('============================================================')
console.log(`${pass} pass / ${fail} fail`)
if (fail) {
  console.log('\nfailures:')
  failures.forEach((f) => console.log(' - ' + f))
  process.exit(1)
}
