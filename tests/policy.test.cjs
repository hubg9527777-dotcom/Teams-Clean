const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.join(__dirname, '..')
require('../core.js')
require('../api-policy.js')
const C = globalThis.TeamsCleanCore
const P = globalThis.TeamsCleanApiPolicy
const origin = 'https://teams.live.com'
const first = '19:first@thread.skype'
const second = '19:second@thread.skype'
const endpoint = id => `${origin}/api/mt/beta/groups/${encodeURIComponent(id)}/deleteChat`
const progress = () => ({ processed: new Set(), failed: new Set(), retries: new Map(), success: 0, skipped: 0, rounds: 0 })
const signal = () => new AbortController().signal
const instant = async (_, active) => C.assertActive(active)

test('失败聊天被跳过，后续聊天继续处理，暂停续跑仍记得跳过项', async () => {
  const state = progress()
  const items = [{ id: 'only-me' }, { id: 'normal' }]
  const calls = []
  const options = { state, signal: signal(), wait: instant, scroll: () => false, status: () => {},
    next: state => items.find(item => !state.failed.has(item.id) && !state.processed.has(item.id)),
    execute: async item => { calls.push(item.id); return item.id === 'only-me' ? 'rejected' : 'success' } }
  await C.runChatQueue(options)
  await C.runChatQueue(options)
  assert.deepEqual(calls, ['only-me', 'normal'])
  assert.equal(state.success, 1)
  assert.equal(state.skipped, 1)
})

test('定位失败最多三次即暂停，不把所有聊天盲目跳过', async () => {
  const state = progress()
  let attempts = 0
  await assert.rejects(C.runChatQueue({ state, signal: signal(), wait: instant, scroll: () => false, status: () => {},
    next: () => ({ id: 'stuck' }), execute: async () => { attempts++; return 'failure' } }), /不把定位失败/ )
  assert.equal(attempts, 3)
  assert.equal(state.skipped, 0)
})

test('暂停立即中断长录制等待', async () => {
  const controller = new AbortController()
  const start = Date.now()
  const pending = C.sleep(60000, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(Date.now() - start < 200)
})

test('执行中暂停后不计成功，也不执行下一条', async () => {
  const state = progress()
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(C.runChatQueue({ state, signal: controller.signal, wait: instant, scroll: () => false, status: () => {},
    next: () => ({ id: 'pending' }), execute: async () => { calls++; controller.abort(); return 'success' } }), { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.equal(state.success, 0)
})

test('联络人和活动固定轨迹被拒绝时停止，不猜测下一条位置', async () => {
  const state = progress()
  let calls = 0
  await assert.rejects(C.runFixedQueue({ state, signal: signal(), wait: instant, status: () => {},
    execute: async () => { calls++; return 'rejected' } }), /无法安全跳过/)
  assert.equal(calls, 1)
  assert.equal(state.rounds, 0)
})

test('固定轨迹成功只记录回放轮数，找不到目标连续三次停止', async () => {
  const state = progress()
  let calls = 0
  await assert.rejects(C.runFixedQueue({ state, signal: signal(), wait: instant, status: () => {},
    execute: async () => ++calls <= 2 ? 'success' : 'failure' }), /连续三次/)
  assert.equal(calls, 5)
  assert.equal(state.rounds, 2)
  assert.equal(state.success, 0)
})

test('两个独立分类队列的进度不互相覆盖', async () => {
  const a = progress(); const b = progress()
  const run = state => C.runFixedQueue({ state, signal: signal(), wait: instant, maxRounds: 2, status: () => {}, execute: async () => 'success' })
  const results = await Promise.allSettled([run(a), run(b)])
  assert.ok(results.every(item => item.status === 'rejected'))
  assert.equal(a.rounds, 2); assert.equal(b.rounds, 2)
  a.rounds = 9; assert.equal(b.rounds, 2)
})

test('录制数据损坏或过长时拒绝执行', () => {
  const step = { type: 'click', x: 20, y: 30, delayMs: 150 }
  const valid = { version: 6, kind: 'activity', trigger: step, actions: [step], trailingDelayMs: 100, viewport: { width: 1000, height: 800, ratio: 1 } }
  assert.equal(C.validateMacro(valid), valid)
  assert.throws(() => C.validateMacro({ ...valid, actions: [] }))
  assert.throws(() => C.validateMacro({ ...valid, actions: Array(41).fill(step) }))
  assert.throws(() => C.validateMacro({ ...valid, trigger: { ...step, delayMs: Infinity } }))
  assert.throws(() => C.validateMacro({ ...valid, version: 4 }))
})

test('只接受聊天 ID，排除联系人 MRI 和任意网址', () => {
  assert.equal(P.chatId(first), true)
  for (const value of ['8:live:someone', 'live:someone', '19:bad/path@thread.skype', 'http://example.com', '19:first@unknown']) assert.equal(P.chatId(value), false)
  assert.ok(P.matchRequest(endpoint(first), 'POST', origin))
  assert.equal(P.matchRequest(endpoint(first).replace(origin, 'https://evil.example'), 'POST', origin), null)
  assert.equal(P.matchRequest(endpoint(first) + '?token=secret', 'POST', origin), null)
  assert.equal(P.matchRequest(endpoint(first), 'GET', origin), null)
})

test('请求模板只替换目标 ID，保留已验证的请求语义', () => {
  const template = { ...P.matchRequest(endpoint(first), 'POST', origin), body: P.bodyTemplate(JSON.stringify({ threadId: first, extra: { chatId: first } }), first) }
  const request = P.requestFor(template, second)
  assert.equal(request.url, endpoint(second))
  assert.equal(request.method, 'POST')
  assert.deepEqual(JSON.parse(request.body), { threadId: second, extra: { chatId: second } })
  assert.throws(() => P.requestFor(template, '19:second@thread.v2'), /尚未校准/)
  assert.throws(() => P.requestFor(template, first))
})

test('请求体涉及另一聊天、联系人或非 JSON 时拒绝模板', () => {
  assert.throws(() => P.bodyTemplate(JSON.stringify({ threadId: second }), first))
  assert.throws(() => P.bodyTemplate(JSON.stringify({ mri: '8:live:person' }), first))
  assert.throws(() => P.bodyTemplate('not-json', first))
})

test('204 是成功；200 中的业务错误、未知结构和异步 202 不误报成功', () => {
  assert.equal(P.result(204), 'success')
  assert.equal(P.result(200, '{}'), 'success')
  assert.equal(P.result(200, '{"success":true}'), 'success')
  assert.equal(P.result(200, '{"success":false}'), 'rejected')
  assert.equal(P.result(200, '{"error":{"code":"Failure"}}'), 'rejected')
  assert.equal(P.result(200, '{"data":"unknown"}'), 'unknown')
  assert.equal(P.result(200, '<html>login</html>'), 'unknown')
  assert.equal(P.result(202, '{}'), 'unknown')
})

test('认证、单项拒绝、限流、服务端故障分类准确', () => {
  assert.equal(P.result(401), 'auth')
  assert.equal(P.result(403), 'rejected')
  assert.equal(P.result(404), 'rejected')
  assert.equal(P.result(429), 'throttled')
  assert.equal(P.result(503), 'server')
})

test('按 Retry-After 秒数和 HTTP 日期等待，不擅自缩短', () => {
  assert.equal(P.retryAfter('90'), 90000)
  assert.equal(P.retryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000)
  assert.equal(P.retryAfter(null), 5000)
})

test('不转发 Cookie、Host 或任意第三方头', () => {
  const headers = P.safeHeaders({ Authorization: 'Bearer test-secret', Cookie: 'secret-cookie', Host: 'evil.example', 'X-Tracking': 'private', 'X-SkypeToken': 'test-skype' })
  assert.equal(headers.authorization, 'Bearer test-secret')
  assert.equal(headers['x-skypetoken'], 'test-skype')
  assert.equal(headers.cookie, undefined)
  assert.equal(headers.host, undefined)
  assert.equal(headers['x-tracking'], undefined)
})

const legacyEndpoint = id => `${origin}/api/groups/v1/threads/${encodeURIComponent(id)}`

test('v1.0.2 历史 Groups 路径只接受当前成功校准的 DELETE 形态', () => {
  const matched = P.matchRequest(legacyEndpoint(first), 'DELETE', origin)
  assert.equal(matched.adapter, 'legacy-groups')
  assert.equal(matched.prefix, '/api/groups/v1/')
  assert.equal(P.redactedPath(matched), '/api/groups/v1/threads/{chatId}')
  assert.equal(P.matchRequest(legacyEndpoint(first), 'POST', origin), null)
  assert.equal(P.matchRequest(legacyEndpoint(first).replace(origin, 'https://example.com'), 'DELETE', origin), null)
  assert.equal(P.matchRequest(legacyEndpoint(first) + '?token=private', 'DELETE', origin), null)
})

test('历史接口精确替换线程路径末尾，不错替换 threads 或版本段', () => {
  for (const suffix of ['', '/']) {
    const template = { ...P.matchRequest(legacyEndpoint(first) + suffix, 'DELETE', origin), body: '' }
    const request = P.requestFor(template, second)
    assert.equal(request.url, legacyEndpoint(second) + suffix)
    assert.equal(request.method, 'DELETE')
    assert.equal(request.body, undefined)
  }
})

