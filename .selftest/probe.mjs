/*
 * 离线自测：不碰宿主、不重启 Harness、不改任何用户数据。
 *
 * 做法：用假的 ctx 加载 ../index.js，把 buildRoutes() 产出的 handler 挂到临时 http server
 * 上（随机端口，只监听 127.0.0.1），然后打真实 HTTP 请求，检查对抗测试报告里那几类
 * 「本该 4xx 却变 500 / 本该有响应体却断连」的语义是否已经收口。
 *
 * 运行：node .selftest/probe.mjs
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'index.js')

/* 期望值直接从源码里读，改 BUILD_TAG 不用同步改夹具（以前写死过一次，改完就假失败） */
const TAG = (readFileSync(entry, 'utf8').match(/const BUILD_TAG = '([^']+)'/) || [])[1] || ''

const mod = await import(pathToFileURL(entry).href)

const routes = []
const notes = []

const fakeWeb = {
  register(r) {
    routes.push(r)
    return () => {}
  },
}

const fakeCtx = {
  logger: { info: (m) => notes.push(String(m)) },
  inject(_deps, cb) {
    cb({ webServer: fakeWeb })
  },
  effect(fn) {
    try {
      fn()
    } catch {}
  },
}

try {
  const out = mod.apply(fakeCtx, {})
  if (out && Array.isArray(out.notes)) notes.push(...out.notes)
} catch (err) {
  console.error('apply() 抛错（这本身就是缺陷）：', (err && err.stack) || err)
  process.exit(1)
}

if (!routes.length) {
  console.error('没注册到任何路由，夹具失败')
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const r = routes.find((x) => x.kind === 'exact' && x.path === url.pathname)
  if (!r) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: 'no route', path: url.pathname }))
    return
  }
  Promise.resolve(r.handler(req, res)).catch((e) => {
    try {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    } catch {}
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const BASE = `http://127.0.0.1:${port}/api/plugins/everything-search`

let pass = 0
let fail = 0
const failures = []

const check = (name, cond, detail) => {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} :: ${detail}`)
    console.log(`  FAIL  ${name}  <-- ${detail}`)
  }
}

const req = async (method, path, { body, headers } = {}) => {
  const init = { method, headers: { ...(headers || {}) } }
  if (body !== undefined) {
    init.body = body
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json'
  }
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json, headers: res.headers }
}

console.log(`\n夹具就绪：${routes.length} 条路由，端口 ${port}`)
console.log(`插件 notes：${notes.join(' | ') || '(空)'}\n`)

/* ---------------------------------------------- F-1 非 JSON body 应 400 而不是 500 */
console.log('[F-1] 非 JSON body')
for (const p of ['/open', '/reveal', '/copy']) {
  const r = await req('POST', p, { body: 'this is not json {' })
  check(
    `POST ${p} 非 JSON → 400 + ES_BAD_JSON`,
    r.status === 400 && r.json && r.json.ok === false && r.json.code === 'ES_BAD_JSON',
    `status=${r.status} body=${r.text.slice(0, 160)}`,
  )
}

/* ---------------------------------------------- F-2 超大 body 应有响应体（413） */
console.log('\n[F-2] 超大 body（2.5MB）')
{
  const big = 'x'.repeat(2.5 * 1024 * 1024)
  let r = null
  try {
    r = await req('POST', '/open', { body: big })
  } catch (err) {
    check('POST /open 2.5MB → 有响应体且 413', false, `连接层就断了：${(err && err.message) || err}`)
  }
  if (r) {
    check(
      'POST /open 2.5MB → 413 + ES_BODY_TOO_LARGE + 有响应体',
      r.status === 413 && r.json && r.json.ok === false && r.json.code === 'ES_BODY_TOO_LARGE',
      `status=${r.status} bytes=${r.text.length} body=${r.text.slice(0, 160)}`,
    )
  }
}

/* ---------------------------------------------- F-3 控制字符 path */
console.log('\n[F-3] path 含控制字符')
{
  const r = await req('GET', '/ls?path=' + encodeURIComponent('C:\\a\u0000b'))
  check(
    '/ls?path=C:\\a\\0b → 400 + ES_BAD_PATH',
    r.status === 400 && r.json && r.json.ok === false && r.json.code === 'ES_BAD_PATH',
    `status=${r.status} body=${r.text.slice(0, 200)}`,
  )
}
{
  const r = await req('GET', '/search?q=' + encodeURIComponent('\u0000bad'))
  const d = r.json && r.json.data
  check(
    '/search?q=<NUL>bad → 200 且不回显 Node 内部报错',
    r.status === 200 &&
      d &&
      !/without null bytes|must be a string/i.test(String(d.reason || '')),
    `status=${r.status} body=${r.text.slice(0, 220)}`,
  )
}

/* ---------------------------------------------- 405 方法白名单 */
console.log('\n[405] 方法白名单')
{
  const r = await req('DELETE', '/status')
  check(
    'DELETE /status → 405 + ES_METHOD + Allow 头',
    r.status === 405 && r.json && r.json.code === 'ES_METHOD' && !!r.headers.get('allow'),
    `status=${r.status} allow=${r.headers.get('allow')} body=${r.text.slice(0, 120)}`,
  )
}
{
  const r = await req('GET', '/open?path=' + encodeURIComponent('C:\\'))
  check('GET /open → 405（只收 POST）', r.status === 405 && r.json && r.json.code === 'ES_METHOD', `status=${r.status}`)
}
{
  const r = await req('POST', '/search?q=a', { body: '{}' })
  check('POST /search → 405（只收 GET）', r.status === 405 && r.json && r.json.code === 'ES_METHOD', `status=${r.status}`)
}
{
  const r = await req('POST', '/probe?path=' + encodeURIComponent('C:\\'))
  check('POST /probe → 仍允许（GET+POST）', r.status !== 405, `status=${r.status}`)
}
{
  const r = await req('POST', '/blob?path=' + encodeURIComponent('C:\\'))
  check(
    'POST /blob → 405 + ES_METHOD（裸 route 也收口了）',
    r.status === 405 && r.json && r.json.code === 'ES_METHOD',
    `status=${r.status} body=${r.text.slice(0, 120)}`,
  )
}

/* ---------------------------------------------- 404 目标不存在 */
console.log('\n[404] 打开/定位不存在的路径')
{
  const miss = 'C:\\__no_such_path_xyz_' + Date.now()
  const r = await req('POST', '/open', { body: JSON.stringify({ path: miss }) })
  check(
    'POST /open 不存在的路径 → 404 + ES_ENOENT',
    r.status === 404 && r.json && r.json.code === 'ES_ENOENT',
    `status=${r.status} body=${r.text.slice(0, 160)}`,
  )
}
{
  const miss = 'C:\\__no_such_path_xyz_' + Date.now()
  const r = await req('POST', '/reveal', { body: JSON.stringify({ path: miss }) })
  check(
    'POST /reveal 不存在的路径 → 404 + ES_ENOENT',
    r.status === 404 && r.json && r.json.code === 'ES_ENOENT',
    `status=${r.status} body=${r.text.slice(0, 160)}`,
  )
}
{
  const r = await req('GET', '/blob?path=' + encodeURIComponent('C:\\__no_such_file_xyz.bin'))
  check('GET /blob 不存在的文件 → 404 + ES_ENOENT', r.status === 404 && r.json && r.json.code === 'ES_ENOENT', `status=${r.status}`)
}

/* ---------------------------------------------- 正常路径仍然 OK */
console.log('\n[OK] 正常请求不被误伤')
{
  const r = await req('GET', '/status')
  const d = r.json && r.json.data
  check('GET /status → 200 + ok', r.status === 200 && r.json && r.json.ok === true, `status=${r.status}`)
  check('status.build 是新 BUILD_TAG', d && d.build === TAG, `build=${d && d.build}`)
  check('status.routes === 9', d && d.routes === 9, `routes=${d && d.routes}`)
}
{
  const r = await req('GET', '/search?q=')
  const d = r.json && r.json.data
  check(
    'GET /search?q= 空查询 → 200 + empty-query 空态',
    r.status === 200 && d && (d.note === 'empty-query' || d.unavailable === true),
    `status=${r.status} body=${r.text.slice(0, 200)}`,
  )
}
{
  const r = await req('GET', '/ls')
  const d = r.json && r.json.data
  check(
    'GET /ls 无 path → 200 + 虚拟根列表',
    r.status === 200 && d && Array.isArray(d.items),
    `status=${r.status} items=${d && d.items && d.items.length}`,
  )
}
{
  const r = await req('GET', '/blob?path=' + encodeURIComponent('C:\\Windows\\win.ini'))
  const ct = r.headers.get('content-type') || ''
  const isBytes = r.status === 200 && !ct.includes('application/json')
  const isMissing = r.status === 404
  check('GET /blob 真实文件 → 字节流（或环境里没这文件时 404）', isBytes || isMissing, `status=${r.status} ct=${ct}`)
}

/* ---------------------------------------------- 汇总 */
console.log(`\n===== ${pass} pass / ${fail} fail =====`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(' - ' + f)
}
server.close()
process.exit(fail ? 1 : 0)
