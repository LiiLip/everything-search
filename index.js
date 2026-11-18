/**
 * everything-search —— Everything 文件搜索面板（服务端）
 * ---------------------------------------------------------------------------
 * 约束（与宿主插件契约保持一致，改代码前请先读）：
 *  1) 本插件以 link: 方式装载，没有自己的 node_modules ——
 *     除 node 内置模块（node:xxx）外，不 import 任何裸包，否则宿主解析失败。
 *  2) 不改 Harness 核心源码，只通过 ctx 公开服务（webServer）注册能力。
 *  3) 服务缺失时降级记录，不抛错，避免把整个宿主带崩。
 *  4) 后端不直接读 Everything 数据库，全部走 bin/es.exe：
 *     它通过 IPC 读取正在运行的 Everything 实例索引 —— 零配置改动、无需开 HTTP Server。
 *
 * 路由前缀：/api/plugins/everything-search
 *   GET  /status                     探针：es.exe 版本 / Everything 版本 / 路径 / 预热耗时
 *   GET  /search?q=&limit=&offset=…  搜索，返回 CSV 解析后的结构化结果
 *   GET  /count?q=…                  只取命中总数（前端先画列表再补数字）
 *   GET  /ls?path=…                  内嵌文件浏览（虚拟根 = 盘符 + 常用目录）
 *   POST /open   { path }            用系统默认程序打开
 *   POST /reveal { path }            在资源管理器中选中
 *   POST /copy   { text }            把文本写进系统剪贴板（前端 clipboard API 失效时的兜底）
 *   POST /probe  { path }            批量探测路径是否还存在
 *   GET  /blob?path=…                把本地文件当附件流给前端（拖进对话用）
 *
 * 容错约定（市场版硬要求）：本机没有 Everything、Everything 没运行、版本不匹配
 * 一律以 `200 { ok:true, data:{ unavailable:true, code, reason } }` 返回，
 * 前端渲染空态 + 一句说明；只有真正的程序错误才走 500。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, statSync, promises as fsp } from 'node:fs'
import { dirname, join, isAbsolute, basename, extname, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'everything-search'

const PLUGIN_ID = 'everything-search'
const ROUTE_BASE = `/api/plugins/${PLUGIN_ID}`

/* 路由清单只在这里写一份：buildRoutes 按它排，status 按它报数，
   以前 status 里写死 routes: 8 而实际 9 条，对不上容易误判宿主加载的是旧版。 */
const ROUTE_NAMES = [
  'status',
  'search',
  'count',
  'ls',
  'open',
  'reveal',
  'copy',
  'probe',
  'blob',
]

/* 改动后改这个值，刷新 /status 就能确认宿主加载的是不是磁盘上这一版 */
const BUILD_TAG = '20261118-market-ready'

const DEFAULT_LIMIT = 80
const HARD_LIMIT = 1000
/* 8s/6s 太长：Everything 卡一下就要干等 8 秒。降到 5s/4s，
   超时不再整单失败（见 doSearch 的 usable 分支），另外几路探针照样出结果。 */
const SEARCH_TIMEOUT_MS = 5000
const COUNT_TIMEOUT_MS = 4000
/* 全部探针空手且有探针超时（Everything 冷索引时典型）→ 用这个更宽的预算整体再试一次 */
const RETRY_TIMEOUT_MS = 9000
const MAX_QUERY_LEN = 300
const LS_MAX_ENTRIES = 4000

// 同一串查询在短时间内重复命中极高（输入防抖、翻页、来回切换），加一层内存缓存。
const CACHE_TTL_MS = 60 * 1000
const CACHE_MAX = 160
const searchCache = new Map()

// Everything 默认按名称排序，'+'(0x2B) 排最前，会把 mqtt/+qt_tutorials 之类顶到前面，
// 所以「相关度」这一档必须自己做打分，不能交给 es.exe。
const SYSTEM_PATH_RE =
  /(\\program files( \(x86\))?\\|\\windows\\|\\anaconda|\\site-packages|\\node_modules\\|\\\.git\\|\\appdata\\local\\temp\\|\\programdata\\)/
const BOUNDARY_RE = /[\s\-_.()\[\]{}\\/@#+,;:'"]/

const SORTS = new Set([
  'name',
  'path',
  'size',
  'extension',
  'date-created',
  'date-modified',
  'date-accessed',
  'attributes',
  'run-count',
  'date-recently-changed',
  'date-run',
])

/* ------------------------------------------------------------------ 基础工具 */

function selfDir() {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

function tryService(ctx, key) {
  try {
    const v = ctx[key]
    if (v && typeof v === 'object') return v
    if (v) return v
  } catch {
    /* Cordis 对未在 inject 声明的服务访问会抛错，这里吞掉走 get() */
  }
  try {
    const v = typeof ctx.get === 'function' ? ctx.get(key) : null
    return v || null
  } catch {
    return null
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', Buffer.byteLength(body))
  } catch {
    /* headers 已发出时忽略 */
  }
  res.end(body)
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data })
}

function fail(res, status, error, extra) {
  const payload = { ok: false, error: String((error && error.message) || error) }
  /* 结构化字段要能透到前端：前端靠 code 区分「没装 es.exe / Everything 没运行」
     和真正的故障，光有一句 error 字符串满足不了市场版的优雅降级。 */
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (k === 'ok' || k === 'error') continue
      payload[k] = extra[k]
    }
  }
  sendJson(res, status, payload)
}

function parseQuery(url) {
  const raw = String(url || '')
  const i = raw.indexOf('?')
  const out = {}
  if (i < 0) return out
  const sp = new URLSearchParams(raw.slice(i + 1))
  for (const [k, v] of sp.entries()) out[k] = v
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve({})
      return
    }
    const MAX_BODY = 2 * 1024 * 1024
    /* 超限之后还要继续把 socket 读空：以前一超限就 req.destroy()，响应还没写出去
       连接就断了，客户端拿到的是 0 字节 + Connection was reset，连 413 都看不见。
       这里改成「只回 413、数据照收照丢」，另设一个更粗的硬上限防真·巨物。 */
    const DRAIN_LIMIT = 64 * 1024 * 1024
    let size = 0
    let over = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (over) {
        if (size > DRAIN_LIMIT) {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (size > MAX_BODY) {
        over = true
        chunks.length = 0
        reject(badReq('请求体过大（上限 2MB）', { status: 413, code: 'ES_BODY_TOO_LARGE', limit: MAX_BODY }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        /* 请求体不是 JSON 是调用方给错了，属于 400，不是插件坏了。
           以前这里 reject 裸 Error，route() 只能回 500。 */
        reject(badReq(`请求体不是合法 JSON：${err.message}`, { status: 400, code: 'ES_BAD_JSON' }))
      }
    })
    req.on('error', (err) => {
      if (over) return
      reject(err)
    })
  })
}

/**
 * 每条路由声明自己接受的方法。以前不校验：`DELETE /status` 也回 200，
 * `POST /blob` 直接把图片字节吐出去，客户端根本没法判断自己调对了没有。
 * 默认 GET|POST（大多数接口只读，少数要收 body），单条可覆盖。
 */
function route(path, fn, methods) {
  const allow = (Array.isArray(methods) && methods.length ? methods : ['GET', 'POST']).map((m) => String(m).toUpperCase())
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        const method = String(req.method || 'GET').toUpperCase()
        if (allow.indexOf(method) < 0) {
          res.statusCode = 405
          try {
            res.setHeader('Allow', allow.join(', '))
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
          } catch {
            /* headers 已发出时忽略 */
          }
          res.end(JSON.stringify({ ok: false, error: `${method} 不被支持，允许：${allow.join(', ')}`, code: 'ES_METHOD' }))
          return
        }
        const query = parseQuery(req.url)
        const body = await readBody(req)
        const out = await fn({ req, query, body })
        ok(res, out)
      } catch (err) {
        /* 可降级的「环境不具备」走 200 + unavailable，前端按空态渲染；
           真正的 bug 才回到 500，别把两类混成一片红字。 */
        if (err && err.soft) {
          ok(res, {
            unavailable: true,
            code: err.code || 'ES_UNAVAILABLE',
            reason: String((err && err.message) || err),
            items: [],
            total: null,
            ...(err.extra || {}),
          })
          return
        }
        /* 参数/路径问题回 4xx：前端可以区分「你给的路径不对」和「插件坏了」。 */
        if (err && err.status >= 400 && err.status < 500) {
          fail(res, err.status, err, err.extra)
          return
        }
        fail(res, 500, err)
      }
    },
  }
}

/* ------------------------------------------------ 可降级错误（市场版硬要求） */
/**
 * 装上插件 ≠ 装了 Everything。缺 es.exe、Everything 没运行、版本太老这些
 * 属于「功能暂不可用」，不是故障：它们不该变成 500 + 前端一片红字。
 *
 * SoftError 用来表达这一类，route() 会把它翻成
 * `200 { ok:true, data:{ unavailable:true, code, reason } }`，
 * 前端照常渲染空列表 + 一句说明，其余功能（浏览目录、打开、复制）不受影响。
 */
class SoftError extends Error {
  constructor(message, code, extra) {
    super(message)
    this.name = 'SoftError'
    this.soft = true
    this.code = code || 'ES_UNAVAILABLE'
    this.extra = extra && typeof extra === 'object' ? extra : {}
  }
}

const soft = (message, code, extra) => new SoftError(message, code, extra)

/**
 * 参数不合法（缺 path、路径过长、平台不支持…）属于 400，不是 500。
 * 以前这些地方一律 throw Error，被 route() 包成 500，前端就得靠字符串猜。
 */
class BadInput extends Error {
  constructor(message, extra) {
    super(message)
    this.name = 'BadInput'
    const e = extra && typeof extra === 'object' ? extra : {}
    /* 403 没权限 / 404 路径没了，都是用户能理解的输入问题，可由 extra.status 指定 */
    const st = Number(e.status)
    this.status = Number.isFinite(st) && st >= 400 && st < 500 ? st : 400
    this.extra = e
  }
}

const badReq = (message, extra) => new BadInput(message, extra)

/* ------------------------------------------------------- es.exe 执行与解码 */

let cachedEsPath = null

function resolveEsPath(config) {
  const candidates = []
  if (config && typeof config.esPath === 'string' && config.esPath.trim()) {
    candidates.push(config.esPath.trim())
  }
  candidates.push(join(selfDir(), 'bin', 'es.exe'))
  candidates.push(join(selfDir(), 'es.exe'))
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        cachedEsPath = c
        return c
      }
    } catch {
      /* ignore */
    }
  }
  return candidates[0] || null
}

/* ------------------------------------- Everything 没在跑时，自动把它拉起来 */
/**
 * es.exe 只是 Everything 的 IPC 客户端，主程序一关它就报
 * `Error 8: Everything IPC window not found`（退出码 8）。
 * 这里在第一次撞上这种情况时尝试拉起一次 Everything（托盘最小化），
 * 拉起来再重试查询；同一个进程里并发只启动一次。
 */
const EVERYTHING_EXE_CANDIDATES = [
  'C:\\Program Files\\Everything\\Everything.exe',
  'C:\\Program Files (x86)\\Everything\\Everything.exe',
]

/* 注册表里能找到安装位置的三个位置（Uninstall 项的 InstallLocation/DisplayIcon
   和 App Paths 的默认值），装到 D 盘、绿色版解压到别处都靠它们兜住。 */
const REG_EVERYTHING_KEYS = [
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything', 'InstallLocation'],
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything', 'DisplayIcon'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything', 'InstallLocation'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything', 'DisplayIcon'],
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe', ''],
  ['HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe', ''],
]

/** DisplayIcon 常带 `,0` 这样的图标索引后缀，去掉才是路径 */
function stripIconIndex(v) {
  const s = String(v || '').trim().replace(/^"|"$/g, '')
  const i = s.lastIndexOf(',')
  if (i > 2 && /^\d+$/.test(s.slice(i + 1).trim())) return s.slice(0, i).trim().replace(/^"|"$/g, '')
  return s
}

function asExePath(p) {
  const s = stripIconIndex(p)
  if (!s) return ''
  if (/^[A-Za-z]:[\\/]/.test(s)) return s
  return ''
}

/**
 * 从注册表读 Everything 的安装路径。同步 spawn reg.exe（几十毫秒），
 * 只在启动时和第一次失败时调用，不进热路径；任何异常都返回空数组。
 */
function everythingFromRegistry() {
  const out = []
  if (process.platform !== 'win32') return out
  for (const [key, name] of REG_EVERYTHING_KEYS) {
    let text = ''
    try {
      const args = name ? ['query', key, '/v', name] : ['query', key, '/ve']
      const r = spawnSync('reg.exe', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      })
      text = String((r && (r.stdout || '')) || '')
    } catch {
      continue
    }
    /* reg query 输出形如 `    InstallLocation    REG_SZ    C:\Program Files\Everything`
       —— 取 REG_SZ / REG_EXPAND_SZ 后面那一段，忽略大小写与前导空白。 */
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line)
      if (!m) continue
      if (name && m[1].trim().toLowerCase() !== name.toLowerCase()) continue
      const raw = m[2].trim()
      /* InstallLocation 是目录，补上文件名；否则当文件路径处理 */
      const isDir = !/\.exe$/i.test(stripIconIndex(raw))
      const p = isDir ? join(stripIconIndex(raw).replace(/[\\/]+$/, ''), 'Everything.exe') : asExePath(raw)
      if (p) out.push(p)
    }
  }
  return out
}

/** PATH 和其它常见安装位：where、环境变量、es.exe 同目录 */
function everythingFromEnv() {
  const out = []
  if (process.platform !== 'win32') return out
  try {
    const r = spawnSync('where.exe', ['Everything.exe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
      const p = line.trim()
      if (p && /\.exe$/i.test(p)) out.push(p)
    }
  } catch {
    /* ignore */
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.ProgramData]) {
    if (!base) continue
    out.push(join(base, 'Everything', 'Everything.exe'))
    out.push(join(base, 'Programs', 'Everything', 'Everything.exe'))
  }
  /* 绿色版常见做法：Everything.exe 和 es.exe 摆在一起 */
  try {
    out.push(join(selfDir(), 'Everything.exe'))
    out.push(join(selfDir(), '..', 'Everything', 'Everything.exe'))
  } catch {
    /* ignore */
  }
  return out
}

let everythingBoot = null

function resolveEverythingExe(config) {
  const fromCfg =
    config && typeof config.everythingPath === 'string' ? config.everythingPath.trim() : ''
  /* 顺序：显式配置 → 注册表（装 D 盘/非默认目录靠它）→ where + 环境变量 → 两条默认位。
     每一项都可能抛（权限、reg 不存在），逐个 try 掉，最后统一返回 null 而不是炸。 */
  const stages = [
    () => (fromCfg ? [fromCfg] : []),
    everythingFromRegistry,
    everythingFromEnv,
    () => EVERYTHING_EXE_CANDIDATES,
  ]
  for (const stage of stages) {
    let list = []
    try {
      list = stage() || []
    } catch {
      continue
    }
    for (const p of list) {
      try {
        if (p && existsSync(p)) return p
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/** 退出码 8 = IPC 窗口找不到，也就是 Everything 主程序没在运行 */
function ipcDownOf(res) {
  return !!res && res.ok === true && res.code === 8
}

/* --------------------------------------------------------------- 启动预热 */
/**
 * 宿主刚起来时的第一搜要 10 秒以上：es.exe 自身冷、系统文件缓存空、
 * Everything 端结果页要从磁盘读。这里在注册路由后立刻空转两次，把这几笔
 * 一次性成本放到用户打字之前付掉；失败不影响功能，只是为了首查快。
 */
let warmPromise = null
let warmState = { at: 0, ms: 0, ok: false, steps: [] }

function warmUp(esPath, config) {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    const t = Date.now()
    const steps = []
    let ok = false
    try {
      let v = await runEs(esPath, ['-get-everything-version'], 4000)
      steps.push({ step: 'version', ms: v.ms || 0, ok: !!(v.ok && v.code === 0) })
      ok = !!(v.ok && v.code === 0)
      /* 主程序没跑（IPC exit 8）时立刻把它拉起来：这一步在宿主启动期做，
         用户第一次搜索就不用再等那 6 秒的启动握手。 */
      if (!ok && ipcDownOf(v)) {
        const boot = await ensureEverything(esPath, config)
        steps.push({ step: 'boot', ms: Date.now() - t, ok: !!boot.started })
        if (boot.started) {
          v = await runEs(esPath, ['-get-everything-version'], 4000)
          steps.push({ step: 'version2', ms: v.ms || 0, ok: !!(v.ok && v.code === 0) })
          ok = !!(v.ok && v.code === 0)
        }
      }
      if (ok) {
        const s = await runEs(esPath, ['-n', '1', 'a'], 4000)
        steps.push({ step: 'search', ms: s.ms || 0, ok: !!s.ok })
        const c = await runEs(esPath, ['-get-result-count', 'a'], 4000)
        steps.push({ step: 'count', ms: c.ms || 0, ok: !!c.ok })
      }
    } catch {
      /* 预热失败无所谓 */
    }
    warmState = { at: Date.now(), ms: Date.now() - t, ok, steps }
    return warmState
  })()
  return warmPromise
}


function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitIpcUp(esPath, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    /* 注意用 -get-everything-version：-version 只报 es.exe 自己的版本，不走 IPC，
       主程序没跑也会 exit 0，拿它探活永远「已就绪」。 */
    const probe = await runEs(esPath, ['-get-everything-version'], 1500)
    if (probe.ok && probe.code === 0 && String(probe.text || '').trim()) return true
    await sleep(180)
  }
  return false
}

async function ensureEverything(esPath, config) {
  if (everythingBoot) return everythingBoot
  const exe = resolveEverythingExe(config)
  if (!exe) return { started: false, reason: '找不到 Everything.exe' }
  everythingBoot = (async () => {
    try {
      const child = spawn(exe, ['-minimized'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch (err) {
      return { started: false, reason: `启动 Everything 失败：${err.message}` }
    }
    const up = await waitIpcUp(esPath, 6000)
    return { started: up, reason: up ? '' : 'Everything 已启动，但 IPC 还没就绪' }
  })()
  try {
    return await everythingBoot
  } finally {
    everythingBoot = null
  }
}

/** es.exe 输出是 GBK(cp936) 原始字节，必须显式解码，否则中文全成乱码 */
function decodeGbk(buf) {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

/**
 * 统一的 es.exe 调用：永不抛错，超时必杀。
 * 之前实测：查询以 - 开头会让 es.exe 挂起不返回，所以这里一定有硬超时。
 */
function runEs(esPath, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!esPath || !existsSync(esPath)) {
      resolve({ ok: false, error: `找不到 es.exe：${esPath || '(空)'}` })
      return
    }
    let child
    try {
      child = spawn(esPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, error: `启动 es.exe 失败：${err.message}` })
      return
    }
    const outBufs = []
    const errBufs = []
    let settled = false
    const t0 = Date.now()
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload && payload.ms != null ? payload : { ...payload, ms: Date.now() - t0 })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `es.exe 超时（${timeoutMs}ms）没有返回` })
    }, timeoutMs)

    child.stdout.on('data', (d) => outBufs.push(d))
    child.stderr.on('data', (d) => errBufs.push(d))
    child.on('error', (err) => finish({ ok: false, error: `es.exe 运行失败：${err.message}` }))
    child.on('close', (code) => {
      const text = decodeGbk(Buffer.concat(outBufs))
      const stderr = decodeGbk(Buffer.concat(errBufs)).trim()
      finish({ ok: true, code, text, stderr })
    })
  })
}

/* ------------------------------------------------------------------ CSV 解析 */

function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQ = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') {
      inQ = true
      i += 1
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (c === '\r') {
      i += 1
      continue
    }
    if (c === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      i += 1
      continue
    }
    field += c
    i += 1
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 0 && r.some((x) => x !== ''))
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v == null ? '' : v), 10)
  return Number.isFinite(n) ? n : fallback
}

function clampInt(v, min, max, fallback) {
  const n = toInt(v, fallback)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* ------------------------------------------------------------- 搜索参数装配 */

function normalizeQuery(raw) {
  /* 控制字符必须先处理掉：\0 之类塞进 spawn 的 args 会让 Node 直接抛
     `The argument 'args[N]' must be a string without null bytes`，
     错误信息一路透到搜索框里，用户看到的是 Node 内部报错。 */
  const hadControl = /[\u0000-\u001f\u007f]/.test(String(raw == null ? '' : raw))
  const q = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (q.length > MAX_QUERY_LEN) return { query: q.slice(0, MAX_QUERY_LEN), note: 'query-truncated' }
  return { query: q, note: hadControl ? 'query-sanitized' : null }
}

/**
 * 以 - 或 / 开头的搜索串会被 es.exe 当成开关（实测会挂起不返回）。
 * 用双引号包起来让 es 按字面文本处理；同时外层调用始终有硬超时兜底。
 */
function escapeQueryForEs(q) {
  if (!q) return q
  if (q.startsWith('-') || q.startsWith('/')) return `"${q.replace(/"/g, '""')}"`
  return q
}

const COLUMN_ARGS = [
  '-size',
  '-date-modified',
  '-attributes',
  '-date-format',
  '1', // ISO-8601，避免本地化日期
  '-size-format',
  '1', // 纯字节整数
  '-no-digit-grouping',
]

function filterArgs(params) {
  const out = []
  const kind = String(params.kind || 'all')
  if (kind === 'dir') out.push('/ad')
  else if (kind === 'file') out.push('/a-d')
  if (params.matchPath) out.push('-p')
  if (params.matchCase) out.push('-i')
  if (params.wholeWord) out.push('-w')
  return out
}

function sortArgs(params) {
  const sort = String(params.sort || '')
  if (!SORTS.has(sort)) return []
  return ['-sort', sort, String(params.order || 'desc') === 'asc' ? '-sort-ascending' : '-sort-descending']
}

function buildSearchArgs(params, overrides = {}) {
  const limit = clampInt(
    overrides.limit != null ? overrides.limit : params.limit,
    1,
    HARD_LIMIT,
    DEFAULT_LIMIT,
  )
  const offset = clampInt(
    overrides.offset != null ? overrides.offset : params.offset,
    0,
    1000000,
    0,
  )
  const args = ['-csv', '-n', String(limit)]
  if (offset > 0) args.push('-o', String(offset))
  args.push(...COLUMN_ARGS, ...filterArgs(params), ...sortArgs(params))
  args.push('-timeout', '5000')

  const raw = overrides.query != null ? overrides.query : params.query
  const q = escapeQueryForEs(raw)
  if (params.regex) args.push('-r', q)
  else if (q) args.push(q)

  return { args, limit, offset }
}

/** 只取总数：不带 -csv，避免把表头一并解析进 parseInt。 */
function buildCountArgs(params) {
  const args = ['-timeout', '5000', ...filterArgs(params)]
  const q = escapeQueryForEs(params.query)
  if (params.regex) args.push('-r', q)
  else if (q) args.push(q)
  args.push('-get-result-count')
  return args
}

/* ------------------------------------------------------- 相关度打分与融合 */

/**
 * 打分维度（从大到小）：
 *   文件名全等 > 文件名前缀 > 文件名子串（词边界再加分） > 仅路径命中
 *   短文件名 > 长文件名；目录层级浅 > 深；桌面/文档/下载 加分；系统/依赖目录降分。
 */
function scoreItem(item, qLower) {
  const name = String(item.name || '').toLowerCase()
  const full = String(item.path || '').toLowerCase()
  const n = qLower.length || 1
  let s = 0

  if (name === qLower) {
    s += 1200
  } else if (name.startsWith(qLower)) {
    s += 760
    if (name.length - n <= 4) s += 60
  } else {
    const at = name.indexOf(qLower)
    if (at > 0) {
      s += 330
      if (BOUNDARY_RE.test(name.charAt(at - 1))) s += 90
      if (at + n === name.length) s += 70
    } else if (full.indexOf(qLower) >= 0) {
      s += 60
    }
  }

  // 短名优先：40 字符以上不再加分
  s += Math.max(0, 40 - name.length) * 2.5

  // 路径层级：越浅越靠前。深度超过 6 层开始重罚 ——
  // 否则 D:\ti\...\systemc-2.3.3\src\sysc\packages\qt 这种同名深目录
  // 会靠「文件名全等」的 1200 分把真正的文件全挤出去。
  const depth = full.split('\\').length - 1
  s += Math.max(0, 26 - depth * 3)
  if (depth > 6) s -= (depth - 6) * 70

  // 同分时文件优先于目录：搜「qt」多半想找文件，而不是一串同名文件夹
  s += item.isDir ? 0 : 30

  if (full.includes('\\desktop\\')) s += 150
  else if (full.includes('\\documents\\')) s += 110
  else if (full.includes('\\downloads\\')) s += 100

  if (SYSTEM_PATH_RE.test(full)) s -= 90
  return s
}

function rankItems(items, q) {
  const qLower = String(q || '').toLowerCase()
  if (!qLower || items.length < 2) return items
  const scored = items.map((it, i) => ({ it, i, s: scoreItem(it, qLower) }))
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return scored.map((x) => x.it)
}

/**
 * 目录 / 文件交错：mix 视图里同名目录太多（搜 qt 时一屏全是 include/qt），
 * 每两个目录后补一个文件，保证首屏一定有文件；文件自身顺序不动。
 */
function interleaveKinds(ranked, limit) {
  const files = ranked.filter((i) => !i.isDir)
  if (!files.length) return ranked
  const quota = Math.min(files.length, Math.max(1, Math.round(limit / 3)))
  const emitted = new Set()
  const out = []
  let nextFile = 0
  let dirRun = 0
  for (const it of ranked) {
    if (emitted.has(it)) continue
    if (it.isDir) {
      out.push(it)
      emitted.add(it)
      dirRun += 1
      if (dirRun >= 2 && nextFile < quota) {
        const f = files[nextFile]
        if (f && !emitted.has(f)) {
          out.push(f)
          emitted.add(f)
        }
        nextFile += 1
        dirRun = 0
      }
    } else {
      out.push(it)
      emitted.add(it)
      const f = files[nextFile]
      if (f && f === it) nextFile += 1
      dirRun = 0
    }
  }
  return out
}

function mergeUnique(groups) {
  const seen = new Set()
  const out = []
  for (const g of groups) {
    for (const it of g) {
      const key = String(it.path || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(it)
    }
  }
  return out
}

function isRelevanceSort(params) {
  return !SORTS.has(String(params.sort || ''))
}

/** 只有「纯净词」才适合再加 wfn: 探针，带空格或 Everything 语法符的查询会失控。 */
function canUseExactProbe(params) {
  const q = String(params.query || '')
  if (!q || q.length > 64) return false
  if (params.regex || params.matchPath || params.wholeWord) return false
  return !/[\s:<>|"]/.test(q)
}

/* --------------------------------------------------------------- 缓存封装 */

function cacheKeyOf(params, extra) {
  return JSON.stringify([
    params.query,
    params.sort || '',
    params.order || '',
    params.kind || 'all',
    !!params.matchPath,
    !!params.matchCase,
    !!params.wholeWord,
    !!params.regex,
    params.limit,
    params.offset,
    extra || '',
  ])
}

function cacheGet(key) {
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    searchCache.delete(key)
    return null
  }
  // 命中即刷新 LRU 位置
  searchCache.delete(key)
  searchCache.set(key, hit)
  return hit.value
}

function cachePut(key, value) {
  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value
    if (oldest !== undefined) searchCache.delete(oldest)
  }
  searchCache.set(key, { ts: Date.now(), value })
}

/**
 * 判断这份输出到底是不是我们认得的那张表。
 * `-csv` 是 es.exe 1.1.0 之后才有的开关：再老一点的版本会把这几个参数当查询词、
 * 或者干脆忽略，回来的东西可能不带表头、也可能压根不是 CSV。这种时候编个空列表
 * 糊过去最糟 —— 用户看到「没搜到」，其实是版本不匹配。
 */
function csvLooksUsable(text) {
  const head = String(text || '').split(/\r?\n/, 1)[0] || ''
  if (!head) return false
  const lower = head.toLowerCase()
  return lower.includes('filename') && lower.includes(',')
}

function mapRows(text) {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map((x) => x.trim().toLowerCase())
  const idx = (label) => header.indexOf(label.toLowerCase())
  const iSize = idx('Size')
  const iDate = idx('Date Modified')
  const iAttr = idx('Attributes')
  const iName = idx('Filename')

  const items = []
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]
    const filePath = iName >= 0 ? cells[iName] : cells[cells.length - 1]
    if (!filePath) continue
    const attrs = iAttr >= 0 ? String(cells[iAttr] || '').trim() : ''
    const isDir = attrs.toUpperCase().includes('D')
    const sizeRaw = iSize >= 0 ? String(cells[iSize] || '').trim() : ''
    const size = sizeRaw === '' ? 0 : Number.parseInt(sizeRaw, 10) || 0
    const mtime = iDate >= 0 ? String(cells[iDate] || '').trim() : ''
    let ext = ''
    try {
      ext = isDir ? '' : extname(filePath).replace(/^\./, '').toLowerCase()
    } catch {
      ext = ''
    }
    let fileName = filePath
    let parent = ''
    try {
      fileName = basename(filePath)
      parent = dirname(filePath)
    } catch {
      /* 路径异常时按整串展示 */
    }
    items.push({
      path: filePath,
      name: fileName,
      parent,
      ext,
      isDir,
      size,
      mtime,
      attrs,
    })
  }
  return items
}

async function doSearch(esPath, params, config) {
  const started = Date.now()
  const relevance = isRelevanceSort(params)
  const limit = clampInt(params.limit, 1, HARD_LIMIT, DEFAULT_LIMIT)
  const offset = clampInt(params.offset, 0, 1000000, 0)
  const wantCount = params.count !== false && params.count !== '0' && params.count !== 0

  const key = cacheKeyOf(params, wantCount ? 'c' : '')
  const cached = cacheGet(key)
  if (cached) return { ...cached, cached: true, elapsedMs: Date.now() - started }

  // 相关度模式：宽命中池多取一些候选（否则重排的池子太小，桌面 QT 仍进不来），
  // 分页统一在内存里做 —— 这样翻页不会把上一页已经排好的名次打乱。
  const poolLimit = relevance
    ? Math.min(HARD_LIMIT, Math.max(120, (offset + limit) * 2))
    : limit
  const broad = buildSearchArgs(params, { limit: poolLimit, offset: relevance ? 0 : offset })

  const runProbes = async (searchMs = SEARCH_TIMEOUT_MS, countMs = COUNT_TIMEOUT_MS) => {
    const probes = [runEs(esPath, broad.args, searchMs)]

    // 并行补一路「全名精确匹配」：es.exe 里 wfn:QT 只需 137ms，
    // 而且能直接把名字就叫 QT 的目录捞出来，绕开默认名称序的 '+' 干扰。
    if (relevance && canUseExactProbe(params)) {
      const exact = buildSearchArgs(params, {
        limit: Math.min(HARD_LIMIT, Math.max(60, limit)),
        offset: 0,
        query: `wfn:${params.query}`,
      })
      probes.push(runEs(esPath, exact.args, searchMs))
    }

    // 再补一路「只要文件」：es.exe 默认按名称序返回，名字正好叫 qt 的目录会把
    // 候选池灌满（实测 200 条里 195 个目录、只有 5 个文件），真正的文件全被挤在外面。
    // 多一次并行 spawn（≈100ms 地板）换回文件的覆盖面，值。
    if (relevance && String(params.kind || 'all') === 'all' && canUseExactProbe(params)) {
      const filesOnly = buildSearchArgs(
        { ...params, kind: 'file' },
        { limit: Math.min(HARD_LIMIT, Math.max(80, limit)), offset: 0 },
      )
      probes.push(runEs(esPath, filesOnly.args, searchMs))
    }

    const countPromise = wantCount
      ? runEs(esPath, buildCountArgs(params), countMs)
      : Promise.resolve(null)

    const [results, countRes] = await Promise.all([Promise.all(probes), countPromise])
    return { results, countRes }
  }

  let { results, countRes } = await runProbes()
  let autoStarted = false

  // Everything 主程序被关掉时 es.exe 报 exit 8；这时拉起一次再重试，
  // 让「关掉 Everything」不至于直接变成「搜不出东西」。
  if (ipcDownOf(results[0]) || ipcDownOf(countRes)) {
    const boot = await ensureEverything(esPath, config)
    if (boot.started) {
      autoStarted = true
      ;({ results, countRes } = await runProbes())
    }
    if (ipcDownOf(results[0]) || ipcDownOf(countRes)) {
      /* 这不是故障，是「本机没有可用的 Everything」——市场版必须走空态，
         而不是 500。code 让前端把「没装」「没运行」「刚启动」分开提示。 */
      throw soft(
        boot.started
          ? 'Everything 刚启动，索引还没就绪，稍等一下再搜'
          : `Everything 没在运行${boot.reason ? `（${boot.reason}）` : ''}，请先打开 Everything 再搜索`,
        boot.started ? 'ES_NOT_READY' : 'ES_NOT_RUNNING',
        { query: params.query, unavailable: true },
      )
    }
  }

  let groups = results.filter((r) => r && r.ok && r.text).map((r) => mapRows(r.text))
  /* 全部探针都没带回行、而且其中有探针是「超时/出错」而非「确实没匹配」→ 用更宽预算重试一次。
     冷启动时 es.exe 常常在 5s 里交不出东西，这一次重试能把「首查空白」救回来。 */
  if (!groups.some((g) => g.length > 0) && results.some((r) => r && !r.ok)) {
    ;({ results, countRes } = await runProbes(RETRY_TIMEOUT_MS, RETRY_TIMEOUT_MS))
    groups = results.filter((r) => r && r.ok && r.text).map((r) => mapRows(r.text))
  }
  /* 主探针被超时砍掉时，只要还有别的探针带回行，就照常给结果，不整单失败 */
  const usable = groups.some((g) => g.length > 0)
  const first = results[0]
  /* 有输出、但解析不出一行：多半不是「真的没有匹配」，而是这个 es.exe 不认 -csv。
     版本不匹配时它会把一坨非 CSV 的文本吐回来，mapRows 只好全部丢掉，
     于是界面上写「没有找到」——比报错更难查。这里点明是版本问题。 */
  if (!usable) {
    const spoke = results.find((r) => r && r.ok && String(r.text || '').trim())
    if (spoke && !csvLooksUsable(spoke.text)) {
      throw soft(
        '这个 es.exe 的版本太老，不支持插件需要的 -csv 输出。更新 Everything（含命令行 es.exe）后就能用',
        'ES_ES_TOO_OLD',
        { query: params.query, unavailable: true },
      )
    }
  }
  /* es.exe 在、但这次一个字都没查出来：超时、参数不被这个版本支持（版本不匹配）、
     索引正在重建——对用户来说都是「暂时搜不到」，给空态 + 一句说明，
     别抛 500 让整个面板变红。 */
  if (!usable && (!first || !first.ok)) {
    throw soft((first && first.error) || 'es.exe 查询失败', 'ES_QUERY_FAILED', { query: params.query })
  }
  let items = relevance ? rankItems(mergeUnique(groups), params.query) : groups[0] || []
  if (relevance) {
    // 混合视图别让同名目录把首屏吃光：连续两个目录就补一个文件进来。
    if (String(params.kind || 'all') === 'all') items = interleaveKinds(items, limit)
    items = items.slice(offset, offset + limit)
  }

  let total = null
  if (countRes && countRes.ok) {
    const text = String(countRes.text || '').trim()
    const line = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || ''
    const n = Number.parseInt(line, 10)
    if (Number.isFinite(n)) total = n
  }

  const out = {
    items,
    total,
    limit,
    offset,
    elapsedMs: Date.now() - started,
    /* 每路探针各自的耗时（ms），慢的时候一眼看出是 es.exe 冷还是 count 拖的 */
    probeMs: results.map((r) => (r && r.ms) || 0),
    countMs: countRes ? countRes.ms || 0 : 0,
    query: params.query || '',
    relevance,
    hasMore: total != null ? offset + items.length < total : items.length >= limit,
  }
  if (autoStarted) out.autoStarted = true
  cachePut(key, out)
  return out
}

/* -------------------------------------------------------- 各路由的实现体 */

function buildRoutes(config) {
  const esPathFor = () => cachedEsPath || resolveEsPath(config)

  const statusRoute = route(`${ROUTE_BASE}/status`, async () => {
    const esPath = esPathFor()
    const exists = !!esPath && existsSync(esPath)
    let esVersion = null
    let everythingVersion = null
    let ipcRunning = null
    let error = null
    if (!exists) {
      error = `找不到 es.exe：${esPath || '(未配置)'}`
    } else {
      const v1 = await runEs(esPath, ['-version'], 4000)
      if (v1.ok) esVersion = (v1.text || '').trim() || null
      else error = v1.error
      const v2 = await runEs(esPath, ['-get-everything-version'], 4000)
      if (v2.ok) everythingVersion = (v2.text || '').trim() || null
      /* exit 8 = IPC 窗口找不到 → Everything 主程序没在运行（搜索会失败，但浏览/打开不受影响） */
      ipcRunning = v2.ok ? !ipcDownOf(v2) : false
    }
    return {
      esPath,
      exists,
      esVersion,
      everythingVersion,
      ipcRunning,
      everythingExe: resolveEverythingExe(config),
      error,
      platform: process.platform,
      /* 前端要拼「文档/桌面/下载」这类带用户目录的查询串，用户名不能写死。 */
      home: homedir(),
      plugin: PLUGIN_ID,
      routeBase: ROUTE_BASE,
      /* 用于确认宿主加载的是不是磁盘上这一版（改代码后刷新 status 看这个值） */
      build: BUILD_TAG,
      routes: ROUTE_NAMES.length,
      /* 启动预热的实测耗时，排查「第一次搜很慢」时先看这里 */
      warm: warmState,
    }
  }, ['GET'])

  const paramsFromQuery = (query) => ({
    query: (normalizeQuery(query.q) || {}).query || '',
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
    order: query.order,
    kind: query.kind,
    matchPath: query.matchPath === '1' || query.matchPath === 'true',
    matchCase: query.matchCase === '1' || query.matchCase === 'true',
    wholeWord: query.wholeWord === '1' || query.wholeWord === 'true',
    regex: query.regex === '1' || query.regex === 'true',
    count: query.count,
  })

  const searchRoute = route(`${ROUTE_BASE}/search`, async ({ query }) => {
    const esPath = esPathFor()
    /* bin/es.exe 是插件自带的，正常一定在；不在说明包被拆了。
       这仍然是「环境不具备」，不该让搜索框报 500。 */
    if (!esPath || !existsSync(esPath)) {
      throw soft(`找不到 es.exe：${esPath || '(未配置)'}`, 'ES_NO_ES', {
        query: (normalizeQuery(query.q) || {}).query || '',
      })
    }

    const { query: q, note } = normalizeQuery(query.q)
    if (!q) {
      return { items: [], total: 0, elapsedMs: 0, query: '', hasMore: false, note: note || 'empty-query' }
    }

    const params = { ...paramsFromQuery(query), query: q }
    const out = await doSearch(esPath, params, config)
    if (note) out.note = note
    return out
  }, ['GET'])

  // 总数是 180ms 级的全量扫描，单独开一条路由，让前端先把结果画出来再补数字。
  const countRoute = route(`${ROUTE_BASE}/count`, async ({ query }) => {
    const esPath = esPathFor()
    if (!esPath || !existsSync(esPath)) {
      throw soft(`找不到 es.exe：${esPath || '(未配置)'}`, 'ES_NO_ES', {
        query: (normalizeQuery(query.q) || {}).query || '',
      })
    }

    const { query: q } = normalizeQuery(query.q)
    if (!q) return { total: 0, query: '' }

    const key = `count:${cacheKeyOf({ ...paramsFromQuery(query), query: q }, '')}`
    const cached = cacheGet(key)
    if (cached != null) return { total: cached, query: q, cached: true }

    const res = await runEs(esPath, buildCountArgs({ ...paramsFromQuery(query), query: q }), COUNT_TIMEOUT_MS)
    /* 总数只是锦上添花：拿不到就给 null，让前端不显示数字，
       没必要把整次搜索标记成失败。 */
    if (!res.ok) throw soft(res.error || '总数查询失败', 'ES_COUNT_FAILED', { query: q })

    const line =
      String(res.text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() || ''
    const n = Number.parseInt(line, 10)
    const total = Number.isFinite(n) ? n : null
    if (total != null) cachePut(key, total)
    return { total, query: q }
  }, ['GET'])

  const checkPath = (p) => {
    const raw = typeof p === 'string' ? p.trim() : ''
    if (!raw) throw badReq('缺少 path 参数')
    if (raw.length > 32000) throw badReq('path 过长')
    if (/[\u0000-\u001f]/.test(raw)) throw badReq('path 含非法控制字符')
    return raw
  }

  /* ----------------------------------------- 内嵌文件浏览器（不另开窗口） */

  const normalizeDir = (raw) => {
    let p = String(raw || '').trim()
    if (!p) return ''
    /* 控制字符必须先挡：\0 传进 fsp.stat 会让 Node 抛 ERR_INVALID_ARG_VALUE
       （TypeError），不是 ENOENT，下面按 err.code 分流的写法接不住它，最后变成 500。
       这里统一按「路径不合法」回 400。 */
    if (/[\u0000-\u001f]/.test(p)) {
      throw badReq('path 含非法控制字符', { code: 'ES_BAD_PATH' })
    }
    // 允许传 D:/a/b 这种正斜杠形式
    if (process.platform === 'win32') {
      p = p.replace(/\//g, '\\')
      if (/^[a-zA-Z]:$/.test(p)) p += '\\'
      return p
    }
    return p
  }

  const listDrives = () => {
    if (process.platform !== 'win32') return [{ name: '/', path: '/', kind: 'drive' }]
    const out = []
    for (let i = 67; i <= 90; i += 1) {
      const letter = String.fromCharCode(i)
      const root = `${letter}:\\`
      try {
        if (existsSync(root)) out.push({ name: letter + ':', path: root, kind: 'drive' })
      } catch {
        /* ignore */
      }
    }
    for (let i = 65; i <= 66; i += 1) {
      const letter = String.fromCharCode(i)
      const root = `${letter}:\\`
      try {
        if (existsSync(root)) out.unshift({ name: letter + ':', path: root, kind: 'drive' })
      } catch {
        /* ignore */
      }
    }
    return out
  }

  const listShortcuts = () => {
    const home = homedir()
    const cands = [
      ['桌面', join(home, 'Desktop')],
      ['下载', join(home, 'Downloads')],
      ['文档', join(home, 'Documents')],
      ['图片', join(home, 'Pictures')],
      ['主目录', home],
    ]
    const out = []
    for (const [label, p] of cands) {
      try {
        if (p && existsSync(p)) out.push({ name: label, path: p, kind: 'shortcut' })
      } catch {
        /* ignore */
      }
    }
    return out
  }

  const typeLabelOf = (item) => {
    if (item.isDir) return '文件夹'
    const ext = String(item.ext || '').replace(/^\./, '').toLowerCase()
    if (!ext) return '文件'
    return `${ext.toUpperCase()} 文件`
  }

  const listRoute = route(`${ROUTE_BASE}/ls`, async ({ query }) => {
    const wantPath = normalizeDir(query.path)

    // 空路径 = 「此电脑」虚拟根：盘符 + 快捷入口
    if (!wantPath) {
      const items = [...listShortcuts(), ...listDrives()].map((r) => ({
        name: r.name,
        path: r.path,
        parent: '',
        ext: '',
        size: 0,
        mtime: null,
        isDir: true,
        kind: r.kind,
        type: '文件夹',
      }))
      return { path: '', parent: null, virtual: true, items, total: items.length, truncated: false }
    }

    let dirPath = wantPath
    let focus = null
    let st = null
    try {
      st = await fsp.stat(dirPath)
    } catch (err) {
      const code = (err && err.code) || ''
      /* 路径没了/没权限是用户可理解的输入问题，不是插件坏了：给 404/403，
         前端可以顺手退回上一级，而不是弹一句「服务器错误」。 */
      if (code === 'ENOENT') throw new BadInput(`路径不存在：${dirPath}`, { path: dirPath, code: 'ES_ENOENT', status: 404 })
      if (code === 'EACCES' || code === 'EPERM') throw new BadInput(`没有权限访问：${dirPath}`, { path: dirPath, code: 'ES_EACCES', status: 403 })
      /* EINVAL / ENAMETOOLONG / ERR_INVALID_ARG_VALUE（不合法路径、超长、含 NUL）
         都是「这个路径不能查」，不是插件故障。 */
      if (code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE') {
        throw new BadInput(`路径不合法：${dirPath}`, { path: dirPath, code: 'ES_EINVAL' })
      }
      throw err
    }
    if (!st.isDirectory()) {
      focus = dirPath
      dirPath = dirname(dirPath)
    }

    let dirents = []
    try {
      dirents = await fsp.readdir(dirPath, { withFileTypes: true })
    } catch (err) {
      const code = (err && err.code) || ''
      if (code === 'EACCES' || code === 'EPERM') {
        throw new BadInput(`没有权限访问：${dirPath}`, { path: dirPath, code: 'ES_EACCES', status: 403 })
      }
      if (code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE') {
        throw new BadInput(`路径不合法：${dirPath}`, { path: dirPath, code: 'ES_EINVAL' })
      }
      throw err
    }

    const truncated = dirents.length > LS_MAX_ENTRIES
    if (truncated) dirents = dirents.slice(0, LS_MAX_ENTRIES)

    const items = await Promise.all(
      dirents.map(async (d) => {
        const full = join(dirPath, d.name)
        let isDir = d.isDirectory()
        let size = 0
        let mtime = null
        try {
          const s = await fsp.stat(full)
          isDir = s.isDirectory()
          size = isDir ? 0 : s.size
          mtime = new Date(s.mtimeMs).toISOString()
        } catch {
          /* 无权限读取属性时仍然列出条目 */
        }
        const ext = isDir ? '' : extname(d.name).toLowerCase()
        return {
          name: d.name,
          path: full,
          parent: dirPath,
          ext,
          size,
          mtime,
          isDir,
          kind: 'entry',
        }
      }),
    )

    const sortKey = String(query.sort || 'name')
    const desc = String(query.order || 'asc').toLowerCase() === 'desc'
    // 目录恒在前，只在同类型内比较
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let r = 0
      if (sortKey === 'size') r = (a.size || 0) - (b.size || 0)
      else if (sortKey === 'date' || sortKey === 'date-modified') r = String(a.mtime || '').localeCompare(String(b.mtime || ''))
      else if (sortKey === 'type') r = String(typeLabelOf(a)).localeCompare(String(typeLabelOf(b)), 'zh-Hans-CN')
      if (r === 0) r = String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      return desc ? -r : r
    })

    for (const it of items) it.type = typeLabelOf(it)

    const root = parsePath(dirPath).root
    const atRoot = root && dirPath.replace(/[\\/]+$/, '') === root.replace(/[\\/]+$/, '')
    const parent = atRoot ? '' : dirname(dirPath)

    return {
      path: dirPath,
      parent,
      focus,
      virtual: false,
      items,
      total: items.length,
      truncated,
    }
  }, ['GET'])

  /* 打开/定位前先确认东西还在：explorer.exe 对不存在的路径不报错，
     进程照样以 0 退出，于是接口返回「已打开」，用户等半天什么也没弹出来。 */
  const requireExisting = (target) => {
    let exists = false
    try {
      exists = existsSync(target)
    } catch {
      /* NUL 之类同步 API 会抛，按不存在处理 */
    }
    if (!exists) throw new BadInput(`路径不存在：${target}`, { path: target, code: 'ES_ENOENT', status: 404 })
    return target
  }

  const openRoute = route(`${ROUTE_BASE}/open`, async ({ body }) => {
    const target = checkPath(body && body.path)
    if (process.platform !== 'win32') throw badReq('仅支持 Windows', { code: 'ES_PLATFORM' })
    requireExisting(target)
    const child = spawn('explorer.exe', [target], { detached: true, windowsHide: false, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { opened: target }
  }, ['POST'])

  const revealRoute = route(`${ROUTE_BASE}/reveal`, async ({ body }) => {
    const target = checkPath(body && body.path)
    if (process.platform !== 'win32') throw badReq('仅支持 Windows', { code: 'ES_PLATFORM' })
    requireExisting(target)
    const child = spawn('explorer.exe', ['/select,', target], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    return { revealed: target }
  }, ['POST'])

  /**
   * 兜底复制：浏览器侧 navigator.clipboard 在非安全上下文、页面失焦、或被宿主
   * iframe 策略拦掉时会直接抛错，此时把文本交给 PowerShell 写剪贴板。
   * 文本通过环境变量传入，避免路径里的引号 / 百分号 / 反斜杠在命令行上被吃掉。
   */
  const copyRoute = route(`${ROUTE_BASE}/copy`, async ({ body }) => {
    const text = body && typeof body.text === 'string' ? body.text : ''
    if (!text) throw badReq('缺少 text 参数')
    if (text.length > 32000) throw badReq('文本过长')
    if (process.platform !== 'win32') throw badReq('仅支持 Windows', { code: 'ES_PLATFORM' })

    await new Promise((resolve, reject) => {
      let done = false
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:ES_COPY_TEXT'],
        {
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, ES_COPY_TEXT: text },
        },
      )
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          child.kill()
        } catch (_) {}
        /* 剪贴板写不进去多半是被别的进程占着（RDP、剪贴板管理器），
           属于「这次办不成」而不是插件坏了：走 soft，前端还能退回 navigator.clipboard。 */
        reject(soft('写入剪贴板超时', 'ES_CLIPBOARD', { unavailable: true }))
      }, 8000)
      child.on('error', (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(soft(`写剪贴板失败：${(err && err.message) || err}`, 'ES_CLIPBOARD', { unavailable: true }))
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(soft(`Set-Clipboard 退出码 ${code}`, 'ES_CLIPBOARD', { unavailable: true }))
      })
    })

    return { copied: text.length }
  }, ['POST'])

  const probeRoute = route(`${ROUTE_BASE}/probe`, async ({ query }) => {
    const target = typeof query.path === 'string' ? query.path : ''
    if (!target) return { exists: false }
    if (/[\u0000-\u001f]/.test(target)) return { exists: false }
    try {
      const st = statSync(target)
      return {
        exists: true,
        isDir: st.isDirectory(),
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      }
    } catch {
      return { exists: false }
    }
  })

  /* ------------------------------------------------------------------ 取字节 */

  /*
   * 把本机文件直出成浏览器能用的字节流。
   * 用途：把搜索结果拖进对话输入框时，前端要先拿到 File 才能喂给宿主的附件链路。
   * 注意这条路由不走 route() 的 JSON 信封，自己写 header，自己 pipe。
   */
  const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }

  /** 单文件上限：够塞大源码包和 PPT，又不至于把内存拖死。 */
  const MAX_BLOB_BYTES = 512 * 1024 * 1024

  const mimeOf = (filePath) => MIME_BY_EXT[String(extname(filePath) || '').toLowerCase()] || 'application/octet-stream'

  /** Content-Disposition 的 ASCII 兜底名（中文名走 filename*）。 */
  const asciiName = (name) => String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'

  const blobRoute = {
    kind: 'exact',
    path: `${ROUTE_BASE}/blob`,
    handler: async (req, res) => {
      /* 这条不走 route() 包装：成功时要回字节流而不是 JSON 信封。
         代价是 405 / 400 都得自己写，所以统一带上 ok 字段，别让客户端遇到裸文本。 */
      const method = String(req.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405
        try {
          res.setHeader('Allow', 'GET, HEAD')
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
        } catch {
          /* headers 已发出时忽略 */
        }
        res.end(JSON.stringify({ ok: false, error: `${method} 不被支持，允许：GET, HEAD`, code: 'ES_METHOD' }))
        return
      }
      const query = parseQuery(req.url)
      const target = typeof query.path === 'string' ? query.path : ''
      if (!target) {
        sendJson(res, 400, { ok: false, error: 'path 不能为空', code: 'ES_BAD_PATH' })
        return
      }
      if (/[\u0000-\u001f]/.test(target)) {
        sendJson(res, 400, { ok: false, error: 'path 含非法控制字符', code: 'ES_BAD_PATH' })
        return
      }
      if (!isAbsolute(target)) {
        sendJson(res, 400, { ok: false, error: '必须是绝对路径', code: 'ES_BAD_PATH' })
        return
      }
      let st = null
      try {
        st = statSync(target)
      } catch {
        sendJson(res, 404, { ok: false, error: `找不到文件：${target}`, code: 'ES_ENOENT' })
        return
      }
      if (st.isDirectory()) {
        sendJson(res, 400, { ok: false, error: '这是一个文件夹，不能当附件', code: 'ES_EINVAL' })
        return
      }
      if (!st.isFile()) {
        sendJson(res, 400, { ok: false, error: '不是普通文件，取不了字节', code: 'ES_EINVAL' })
        return
      }
      if (st.size > MAX_BLOB_BYTES) {
        const mb = Math.round(st.size / (1024 * 1024))
        sendJson(res, 413, { ok: false, error: `文件太大（${mb} MB），单文件上限 512 MB`, code: 'ES_BODY_TOO_LARGE' })
        return
      }
      const name = basename(target)
      res.writeHead(200, {
        'content-type': mimeOf(target),
        'content-length': String(st.size),
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(target)
      stream.on('error', () => {
        try {
          res.destroy()
        } catch {
          /* 已经断了就算了 */
        }
      })
      stream.pipe(res)
    },
  }

  return [
    statusRoute,
    searchRoute,
    countRoute,
    listRoute,
    openRoute,
    revealRoute,
    copyRoute,
    probeRoute,
    blobRoute,
  ]
}

/* ---------------------------------------------------------------- 插件入口 */

export function apply(ctx, config = {}) {
  const disposers = []
  const notes = []
  let registered = 0

  const registerRoutes = (web) => {
    if (!web || typeof web.register !== 'function') {
      notes.push('webServer 服务不可用，路由未注册')
      return
    }
    for (const r of buildRoutes(config)) {
      try {
        const d = web.register(r)
        if (typeof d === 'function') disposers.push(d)
        registered += 1
      } catch (err) {
        notes.push(`注册路由 ${r.path} 失败：${(err && err.message) || err}`)
      }
    }
    notes.push(`已注册 ${registered} 条路由，前缀 ${ROUTE_BASE}`)
    try {
      ctx.logger?.info?.(`[everything-search] 已注册 ${registered} 条路由 → ${ROUTE_BASE}`)
    } catch {
      /* ignore */
    }
    /* 首查提速：趁用户还没开始打字，先把 es.exe / IPC / Everything 结果页预热一遍 */
    try {
      void warmUp(resolveEsPath(config), config)
    } catch {
      /* ignore */
    }
  }

  // 宿主冷启动时 webServer 往往还没就绪，必须用 inject 声明依赖，
  // 否则会静默跳过注册 —— 表现为「界面能渲染、所有接口 404」。
  try {
    ctx.inject(['webServer'], (host) => {
      const web = host && host.webServer ? host.webServer : tryService(ctx, 'webServer')
      registerRoutes(web)
    })
  } catch (err) {
    notes.push(`inject(webServer) 不可用，回退 tryService：${(err && err.message) || err}`)
    registerRoutes(tryService(ctx, 'webServer'))
  }

  try {
    ctx.effect(
      () => () => {
        for (const d of disposers.splice(0)) {
          try {
            d()
          } catch {
            /* ignore */
          }
        }
      },
      'everything-search:dispose',
    )
  } catch {
    /* 老宿主没有 effect 时忽略 */
  }

  return { notes }
}
