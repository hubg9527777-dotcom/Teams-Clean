const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
require('../api-policy.js')
require('../core.js')
require('../network-api.js')
const P = globalThis.TeamsCleanApiPolicy
const root = path.join(__dirname, '..')

function worker () {
  const events = {}
  const store = {}
  const event = name => ({ addListener: handler => { events[name] = handler } })
  const context = vm.createContext({ importScripts: () => {}, TeamsCleanApiPolicy: P,
    TeamsCleanNetworkCapture: globalThis.TeamsCleanNetworkCapture, URL, Headers, Date, TextDecoder,
    chrome: { runtime: { id: 'extension', onMessage: event('message') },
      storage: { session: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => Object.assign(store, structuredClone(data)) } },
      webRequest: { onBeforeRequest: event('before'), onSendHeaders: event('headers'), onBeforeRedirect: event('redirect'), onCompleted: event('complete'), onErrorOccurred: event('error') } } })
  vm.runInContext(fs.readFileSync(path.join(root, 'network-observer.js'), 'utf8'), context)
  const sender = { id: 'extension', tab: { id: 10 }, frameId: 0, documentId: 'document-10', url: 'https://teams.live.com/v2/' }
  const command = (action, extra = {}, source = sender) => new Promise(resolve => {
    if (!events.message({ channel: 'teams-clean-network-v603', action, ...extra }, source, resolve)) resolve(null)
  })
  return { events, context, store, sender, command }
}

test('没有 MAIN、网页消息桥、远程脚本或多域名网络权限', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')))
  assert.deepEqual(manifest.host_permissions, ['https://teams.live.com/*'])
  assert.equal(manifest.content_scripts.some(script => script.world === 'MAIN'), false)
  assert.equal(fs.existsSync(path.join(root, 'api-main.js')), false)
  const source = fs.readFileSync(path.join(root, 'inject.js'), 'utf8')
  assert.equal(source.includes('postMessage'), false)
  assert.equal(source.includes('pageApiCommand'), false)
  assert.equal(manifest.externally_connectable, undefined)
  assert.equal(manifest.web_accessible_resources, undefined)
})

test('后台拒绝同源子框架、缺失文档标识、非本扩展、伪域名及主页面URL回退', async () => {
  const h = worker()
  for (const extra of [{ frameId: 1 }, { frameId: undefined }, { documentId: undefined }, { documentId: '' },
    { id: 'other-extension' }, { url: 'https://teams.live.com.evil.example/' }, { url: undefined, tab: { id: 10, url: 'https://teams.live.com' } }]) {
    assert.equal(await h.command('begin', {}, { ...h.sender, ...extra }), null)
  }
  assert.ok((await h.command('begin')).data)
})

test('刷新后的同一分页不能结束或读取旧文档诊断', async () => {
  const h = worker()
  await h.command('begin')
  for (const action of ['end', 'report', 'capture-status', 'ack-calibration']) {
    const reply = await h.command(action, {}, { ...h.sender, documentId: 'new-document' })
    assert.ok(reply.error)
  }
  assert.equal((await h.command('report')).data.observed, 0)
})

test('未知消息操作被拒绝，不创建会话或返回敏感模板', async () => {
  const h = worker()
  assert.equal(await h.command('unknown'), null)
  assert.equal(Object.keys(h.store).length, 0)
})

test('旧文档的网络事件不能进入新文档诊断', async () => {
  const h = worker()
  await h.command('begin')
  h.events.before({ requestId: 'old', tabId: 10, documentId: 'old-document', method: 'DELETE',
    initiator: 'https://teams.live.com', timeStamp: Date.now(), url: 'https://teams.live.com/api/groups/v1/threads/19:old@thread.skype' })
  assert.equal((await h.command('report')).data.observed, 0)
})

test('请求模板不能把认证头发往其他站点、非默认端口或同域子站点', () => {
  for (const origin of ['https://evil.example', 'https://teams.live.com:444', 'https://child.teams.live.com']) {
    assert.equal(P.matchRequest(origin + '/api/groups/v1/threads/19:one@thread.skype', 'DELETE', origin), null)
    assert.throws(() => P.requestFor({ origin, path: '/api/groups/v1/threads/19:one@thread.skype', method: 'DELETE', id: '19:one@thread.skype', body: '' }, '19:two@thread.skype'))
  }
})

test('流式响应在超过64KiB时中止读取，不无限缓存chunked正文', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start (controller) { controller.enqueue(new Uint8Array(65537)) },
    cancel () { cancelled = true }
  }))
  await assert.rejects(P.readResponse(response), /安全大小/)
  assert.equal(cancelled, true)
})

test('过大Content-Length预先拒绝；正常JSON完整解析', async () => {
  await assert.rejects(P.readResponse(new Response('{}', { headers: { 'Content-Length': '99999999' } })), /安全大小/)
  assert.equal(await P.readResponse(new Response('{"success":true}')), '{"success":true}')
})

test('超过32位的等待拆分而非溢出为立即重试，暂停仍取消等待', async () => {
  const scheduled = []
  const callbacks = []
  const context = vm.createContext({ DOMException, setTimeout: (callback, ms) => { scheduled.push(ms); callbacks.push(callback); return callbacks.length }, clearTimeout: () => {} })
  vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), context)
  let done = false
  const sleep = context.TeamsCleanCore.sleep(2147483647 + 90000).then(() => { done = true })
  assert.deepEqual(scheduled, [2147483647])
  callbacks[0]()
  assert.equal(done, false)
  assert.deepEqual(scheduled, [2147483647, 90000])
  callbacks[1](); await sleep
  const controller = new AbortController()
  const waiting = context.TeamsCleanCore.sleep(2147483648, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
})
