const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const crypto = require('node:crypto')
require('../core.js'); require('../api-policy.js'); require('../network-api.js')
const C = globalThis.TeamsCleanCore
const P = globalThis.TeamsCleanApiPolicy
const root = path.join(__dirname, '..')

function harness (responseFactory = () => new Response(null, { status: 200 }), extraIds = []) {
  const events = {}
  const storage = {}
  const sender = { id: 'test-extension', tab: { id: 10 }, documentId: 'document-10', frameId: 0, url: 'https://teams.live.com/v2/' }
  const event = name => ({ addListener: callback => { events[name] = callback } })
  const worker = vm.createContext({ importScripts: () => {}, TeamsCleanApiPolicy: P, TeamsCleanNetworkCapture: globalThis.TeamsCleanNetworkCapture,
    Headers, URL, TextDecoder, Date, chrome: { runtime: { id: sender.id, onMessage: event('message') },
      storage: { session: { get: async key => ({ [key]: structuredClone(storage[key]) }), set: async value => Object.assign(storage, structuredClone(value)) } },
      webRequest: { onBeforeRequest: event('before'), onSendHeaders: event('headers'), onBeforeRedirect: event('redirect'), onCompleted: event('complete'), onErrorOccurred: event('error') } } })
  vm.runInContext(fs.readFileSync(path.join(root, 'network-observer.js'), 'utf8'), worker)
  class Element {
    constructor (tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true }
    append (...children) { for (const child of children) { child.parentElement = this; this.children.push(child); if (this.tagName === 'select' && !this.value) this.value = child.value } }
    attachShadow () { this.shadowRoot = new Element(); return this.shadowRoot }
    setAttribute (key, value) { this.attributes[key] = value }
    getAttribute (key) { return this.attributes[key] || null }
    addEventListener (key, handler) { this.listeners[key] = handler }
    querySelectorAll () { return [] }
    contains (target) { return this === target || this.children.some(child => child.contains(target)) }
  }
  const document = { documentElement: new Element(), body: new Element(), getElementById: () => null, createElement: tag => new Element(tag), querySelectorAll: () => [], elementFromPoint: () => { throw new Error('接口模式不得调用鼠标坐标') } }
  const sourceId = '19:manual@thread.skype'
  const probeId = '19:probe@thread.skype'
  let items = [sourceId, probeId, '19:last@thread.skype', ...extraIds].map(id => ({ id, element: { innerText: '普通聊天', getAttribute: () => null } }))
  const calls = []
  const pageMessages = []
  const copies = []
  const timers = new Map()
  let manualDetails
  const context = vm.createContext({ document, Element, innerWidth: 1200, innerHeight: 900, devicePixelRatio: 1, crypto, AbortController, DOMException, Date,
    setTimeout, clearTimeout, setInterval: operation => { timers.set(1, operation); return 1 }, clearInterval: id => timers.delete(id), performance,
    location: { origin: 'https://teams.live.com' }, sessionStorage: { getItem: () => 'chat', setItem: () => {} },
    TeamsCleanApiPolicy: P, TeamsCleanCore: { ...C, sleep: async (ms, signal) => C.assertActive(signal) },
    window: { addEventListener: () => {}, postMessage: message => pageMessages.push(message) },
    navigator: { locks: { request: async (name, options, operation) => operation({}) }, clipboard: { writeText: async value => copies.push(value) } },
    fetch: async (url, options) => { calls.push({ url, options }); return responseFactory(url, options) },
    chrome: { runtime: { sendMessage: (message, reply) => events.message(message, sender, reply) }, storage: { local: { get: async () => ({}), set: async () => {} } } },
    fixtureItems: () => items,
    fixturePage: async action => {
      if (action === 'arm') return { calibration: {} }
      if (action === 'finish') throw new Error('网页观察0，无法校准')
      return { calibration: null, calibrated: false, hooks: { fetch: true, xhr: true }, observation: { observed: 0, matched: 0, accepted: 0, rejected: 0, requests: [] } }
    } })
  let source = fs.readFileSync(path.join(root, 'inject.js'), 'utf8')
  source = source.replace('  init()\n})()', `
  getChatItems = fixtureItems;
  scrollChatLists = () => false;
  globalThis.__test = {
    untrustedClick: name => ui[name].listeners.click({isTrusted:false}),
    click: name => ui[name].listeners.click({isTrusted:true}),
    snapshot: () => ({ ready: apiReady, manual: apiManualAck, verified: apiVerified, transport: apiTransport, calibration: apiCalibration, hidden: state.hidden.size, phase: state.phase, success: state.success, uncertain: state.uncertain || 0, startDisabled: ui.start.disabled, probeDisabled: ui.probe.disabled, verifyHidden: ui.verify.hidden, status: ui.status.textContent, steps: ui.steps.textContent }),
    run: resumed => startRun({kind:'chat',engine:'api'}, resumed), stop: stopRun,
    export: exportDiagnostics
  };
  init()
})()`)
  vm.runInContext(source, context)
  function manual (extra = {}) {
    const details = { url: 'https://teams.live.com/api/groups/v1/threads/' + encodeURIComponent(sourceId), requestId: 'manual-delete', tabId: 10, frameId: 0,
      documentId: sender.documentId, initiator: 'https://teams.live.com', method: 'DELETE', timeStamp: Date.now(), ...extra }
    events.before(details)
    events.headers({ ...details, requestHeaders: [{ name: 'Authentication', value: 'skypetoken=SECRET-FOR-TEST' }, { name: 'Cookie', value: 'NOT-STORED' }] })
    manualDetails = details
    if (!extra.pending) events.complete({ ...details, statusCode: 200 })
    items = items.filter(item => item.id !== sourceId)
  }
  return { api: context.__test, manual, completeManual: () => events.complete({ ...manualDetails, statusCode: 200 }), calls, pageMessages, copies, storage, timers, sender, probeId, reclaim: () => vm.runInContext('capture.clear()', worker) }
}

test('三步复现网页观察0/浏览器200：第2步自动验证，第3步核对并开始，不派发鼠标', async () => {
  const h = harness()
  assert.equal(h.api.snapshot().startDisabled, true)
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate')
  assert.equal(h.api.snapshot().transport, 'network')
  assert.equal(h.api.snapshot().manual, false)
  assert.equal(h.api.snapshot().ready, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.api.snapshot().verified, false)
  assert.equal(h.api.snapshot().startDisabled, false)
  await h.api.click('start')
  assert.equal(h.api.snapshot().verified, true)
  assert.equal(h.api.snapshot().success, 1)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].url.endsWith(encodeURIComponent(h.probeId)), true)
  assert.equal(h.calls[0].options.method, 'DELETE')
  assert.equal(h.calls[0].options.headers.authentication, 'skypetoken=SECRET-FOR-TEST')
  assert.equal(h.calls[0].options.credentials, 'include')
  assert.equal(h.calls[0].options.redirect, 'error')
  assert.equal(h.calls[0].options.headers.cookie, undefined)
  assert.equal(h.pageMessages.length, 0)
  assert.equal(JSON.stringify(h.storage).includes('SECRET-FOR-TEST'), false)
  assert.equal(JSON.stringify(h.storage).includes(h.probeId), false)
  await h.api.export()
  for (const value of ['SECRET-FOR-TEST', 'NOT-STORED', h.probeId, 'manual-delete']) assert.equal(h.copies[0].includes(value), false)
  assert.ok(h.api.snapshot().steps.includes('直接发删除请求'))
})

test('网页合成点击无法校准、确认或开始清理', async () => {
  const h = harness()
  await h.api.untrustedClick('calibrate')
  assert.equal(h.api.snapshot().calibration, false)
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate')
  assert.equal(h.calls.length, 1)
  await h.api.untrustedClick('start')
  assert.equal(h.calls.length, 1)
  assert.equal(h.api.snapshot().verified, false)
  await h.api.click('start')
  assert.equal(h.calls.length, 2)
})

test('过大成功正文暂停为待核对，不能进入隐藏或反复重发', async () => {
  let count = 0
  const h = harness(() => (++count === 1 ? new Response('{}') : new Response('x'.repeat(65537))))
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate')
  await h.api.click('start')
  assert.equal(h.api.snapshot().uncertain, 1)
  assert.equal(h.api.snapshot().hidden, 0)
  await h.api.click('start')
  assert.equal(h.calls.length, 2)
})

test('手动请求不归属当前分页时不能启用确认或发送接口请求', async () => {
  const h = harness()
  await h.api.click('calibrate'); h.manual({ tabId: -1 }); await h.api.click('calibrate')
  assert.equal(h.api.snapshot().ready, false)
  assert.equal(h.api.snapshot().verifyHidden, true)
  assert.equal(h.api.snapshot().startDisabled, true)
  assert.equal(h.calls.length, 0)
})

test('先结束但响应未完成时仍保留第2步；完成后再结束可继续而不另删一条', async () => {
  const h = harness()
  await h.api.click('calibrate'); h.manual({ pending: true }); await h.api.click('calibrate')
  assert.equal(h.api.snapshot().calibration, true)
  assert.equal(h.api.snapshot().startDisabled, true)
  h.completeManual()
  await h.api.click('calibrate')
  assert.equal(h.api.snapshot().manual, false)
  assert.equal(h.api.snapshot().transport, 'network')
  assert.equal(h.calls.length, 1)
})

test('接口401在验证阶段停止，不开放批量', async () => {
  const h = harness(() => new Response(null, { status: 401 }))
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate'); await h.api.click('verify'); await h.api.click('probe')
  assert.equal(h.calls.length, 1)
  assert.equal(h.api.snapshot().ready, false)
  assert.equal(h.api.snapshot().startDisabled, true)
  assert.equal(h.api.snapshot().verified, false)
})

test('未知200响应不能直接开放批量，明确要求核对', async () => {
  const h = harness(() => new Response('{"unknown":{"value":"SECRET-IN-RESPONSE"}}', { status: 200 }))
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate'); await h.api.click('verify'); await h.api.click('probe')
  assert.equal(h.api.snapshot().uncertain, 1)
  assert.equal(h.api.snapshot().verified, false)
  assert.equal(h.api.snapshot().startDisabled, true)
  await h.api.click('verify')
  assert.equal(h.api.snapshot().verified, false)
  await h.api.export()
  assert.equal(h.copies[0].includes('SECRET-IN-RESPONSE'), false)
  assert.equal(JSON.parse(h.copies[0]).lastNetworkResult.outcome, 'unknown')
})

test('验证请求等待时暂停：保留待核对状态，不误开放批量', async () => {
  const h = harness((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })))
  await h.api.click('calibrate'); h.manual()
  const operation = h.api.click('calibrate')
  for (let round = 0; round < 4; round++) await new Promise(setImmediate)
  assert.equal(h.calls.length, 1)
  h.api.stop(); await operation
  assert.equal(h.api.snapshot().uncertain, 1)
  assert.equal(h.api.snapshot().startDisabled, true)
})

test('批量暂停后后台校准丢失：继续仍执行剩余记录，既不重发待核对请求也不清空进度', async () => {
  let count = 0
  const h = harness((url, options) => {
    count++
    if (count === 3) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
    return new Response(null, { status: 200 })
  }, ['19:waiting@thread.skype', '19:remaining@thread.skype'])
  await h.api.click('calibrate'); h.manual(); await h.api.click('calibrate')
  const operation = h.api.click('start')
  for (let round = 0; round < 5; round++) await new Promise(setImmediate)
  assert.equal(h.calls.length, 3)
  h.api.stop(); await operation
  assert.equal(h.api.snapshot().success, 1)
  assert.equal(h.api.snapshot().uncertain, 1)
  h.reclaim()
  await h.api.click('start')
  assert.equal(h.api.snapshot().success, 2)
  assert.equal(h.api.snapshot().uncertain, 1)
  assert.equal(h.calls.length, 4)
  assert.equal(new Set(h.calls.map(call => call.url)).size, 4)
})
