const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
require('../api-policy.js')
require('../core.js')
require('../network-api.js')
const P = globalThis.TeamsCleanApiPolicy
const C = globalThis.TeamsCleanCore

function observer () {
  const handlers = {}
  const storage = {}
  let now = 1000000
  const event = name => ({ addListener: callback => { handlers[name] = callback } })
  const sender = { frameId:0, documentId:'document-10', id: 'test-extension', tab: { id: 10 }, url: 'https://teams.live.com/v2/' }
  const context = vm.createContext({ importScripts: () => {}, TeamsCleanApiPolicy: P, URL, TextDecoder,
    Date: { now: () => now }, Headers, TeamsCleanNetworkCapture: globalThis.TeamsCleanNetworkCapture, chrome: { runtime: { id: sender.id, onMessage: event('message') },
      storage: { session: { get: async key => ({ [key]: structuredClone(storage[key]) }), set: async value => Object.assign(storage, structuredClone(value)) } },
      webRequest: { onBeforeRequest: event('before'), onSendHeaders: event('headers'), onBeforeRedirect: event('redirect'), onCompleted: event('complete'), onErrorOccurred: event('error') } } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'network-observer.js'), 'utf8'), context)
  const command = (action, source = sender) => new Promise(resolve => {
    const accepted = handlers.message({ channel: 'teams-clean-network-v603', action }, source, resolve)
    if (!accepted) resolve(null)
  })
  const request = (extra = {}) => handlers.before({ requestId: String(now++), timeStamp: now, tabId: 10,
    initiator: 'https://teams.live.com', method: 'POST', url: 'https://client-s.gateway.messenger.live.com/v1/users/private-user/conversations/private-chat/properties?token=secret-query', ...extra })
  return { command, request, handlers, storage, advance: ms => { now += ms } }
}

test('诊断只保留域名、脱敏路径和结构，不输出查询值、正文值或私密键', () => {
  const item = P.diagnosticRequest('https://teams.live.com/api/private-user/delete?token=secret-query', 'POST', 204)
  const keys = P.schema(JSON.stringify({ chatId: 'private-chat', 'private-key': { name: 'private-name', value: 'secret-token' } }))
  const report = JSON.stringify({ item, keys })
  for (const secret of ['private-user', 'secret-query', 'private-chat', 'private-key', 'private-name', 'secret-token']) assert.equal(report.includes(secret), false)
  assert.ok(keys.includes('chatId'))
  assert.ok(keys.includes('{field}'))
  assert.equal(P.diagnosticRequest('https://teams.live.com.evil.example/api/delete', 'POST'), null)
  assert.equal(P.diagnosticRequest('https://teams.live.com/api/delete', 'GET'), null)
})

test('网络观察只有校准期间生效，结束后不增加请求；完成事件保留状态', async () => {
  const h = observer()
  h.request()
  await h.command('begin')
  h.request({ requestId: 'known', requestBody: { raw: [{ bytes: new TextEncoder().encode('{"chatId":"private-chat","name":"private-name"}').buffer }] } })
  h.handlers.complete({ tabId:10, documentId:'document-10', requestId: 'known', timeStamp: 1000010, statusCode: 204 })
  const report = (await h.command('end')).data
  assert.equal(report.observed, 1)
  assert.equal(report.requests[0].status, 204)
  assert.equal(report.requests[0].source, 'this-tab')
  h.request()
  assert.equal((await h.command('report')).data.observed, 1)
  for (const secret of ['private-chat', 'private-name', 'secret-query', 'known']) assert.equal(JSON.stringify(report).includes(secret), false)
})

test('其他分页请求不混入；无分页 Worker 明确标记，非 Teams 来源忽略', async () => {
  const h = observer()
  await h.command('begin')
  h.request({ tabId: 11 })
  h.request({ tabId: -1, initiator: 'https://example.com' })
  h.request({ tabId: -1 })
  const report = (await h.command('report')).data
  assert.equal(report.observed, 1)
  assert.equal(report.unassigned, 1)
  assert.equal(report.requests[0].source, 'worker-unassigned')
  assert.match(report.note, /不能用于自动删除/)
})

test('诊断最多120秒、60条；会话归属校验阻止其他来源读取', async () => {
  const h = observer()
  await h.command('begin')
  for (let n = 0; n < 62; n++) h.request()
  const report = (await h.command('report')).data
  assert.equal(report.requests.length, 60)
  assert.equal(report.truncated, true)
  assert.equal(await h.command('report', { id: 'test-extension', tab: { id: 10 }, url: 'https://example.com' }), null)
  assert.match((await h.command('report', { frameId:0, documentId:'document-10', id: 'test-extension', tab: { id: 11 }, url: 'https://teams.live.com' })).error, /当前页面/)
  h.advance(120001)
  h.request()
  assert.equal((await h.command('report')).data.observed, 62)
})

test('录制定位错误立即暂停，只执行一次且不增加跳过或成功', async () => {
  const state = { processed: new Set(), failed: new Set(), retries: new Map(), skipped: 0, success: 0 }
  let calls = 0
  await assert.rejects(C.runChatQueue({ next: () => ({ id: 'chat' }), scroll: () => false, state,
    execute: async () => { calls++; return { outcome: 'failure', fatal: true, reason: '更多按钮未匹配' } }, status: () => {}, wait: async () => {} }), /更多按钮未匹配/)
  assert.equal(calls, 1)
  assert.equal(state.skipped, 0)
  assert.equal(state.success, 0)
  assert.equal(state.failed.size, 0)
})

test('联络人和活动定位错误同样立即暂停，不累计虚假回放轮数', async () => {
  const state = { rounds: 0 }
  let calls = 0
  await assert.rejects(C.runFixedQueue({ state, execute: async () => { calls++; return { outcome: 'failure', fatal: true, reason: '菜单未出现' } }, status: () => {}, wait: async () => {} }), /菜单未出现/)
  assert.equal(calls, 1)
  assert.equal(state.rounds, 0)
})
