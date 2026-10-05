const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const crypto = require('node:crypto')
require('../core.js')
require('../api-policy.js')
const C = globalThis.TeamsCleanCore
const P = globalThis.TeamsCleanApiPolicy

// A small UI stand-in tests controller behavior without a real Teams account.
// It does not assert compatibility with Teams' rendered controls.
function harness (respond, locked = false) {
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
  const document = { documentElement: new Element(), body: new Element(), getElementById: () => null, createElement: tag => new Element(tag), querySelectorAll: () => [] }
  const messages = []
  const delays = []
  const locks = []
  const store = new Map()
  const context = vm.createContext({ document, Element, innerWidth: 1200, innerHeight: 900, devicePixelRatio: 1,
    TeamsCleanCore: { ...C, sleep: async (ms, signal) => { delays.push(ms); C.assertActive(signal) } }, TeamsCleanApiPolicy: P,
    navigator: { locks: { request: async (name, options, operation) => { locks.push({ name, options }); return operation(locked ? null : {}) } } },
    window: { addEventListener: () => {}, postMessage: message => messages.push(message) },
    chrome: { storage: { local: { get: async key => ({ [key]: store.get(key) }), set: async object => Object.entries(object).forEach(([key, value]) => store.set(key, value)) } } },
    sessionStorage: { getItem: () => 'chat', setItem: () => {} }, location: { origin: 'https://teams.live.com' },
    crypto, AbortController, DOMException, setTimeout, clearTimeout, performance, Date, console })
  let source = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8')
  source = source.replace('  init()\n})()', `
  globalThis.__test = {
    setup (items, responder, verified = true) {
      getChatItems = () => items;
      scrollChatLists = () => false;
      apiCommand = responder;
      apiReady = true; apiVerified = verified; apiFamily = 'thread.skype'; apiSourceId = '19:calibration@thread.skype';
    },
    run: resumed => startRun({ kind: 'chat', engine: 'api' }, resumed),
    probe: async id => { apiProbe = true; await startRun({ kind: 'chat', engine: 'api', targetId: id }, false); apiProbe = false; },
    snapshot: () => ({ success: state.success, skipped: state.skipped, uncertain: state.uncertain || 0, failed: [...state.failed], processed: [...state.processed], paused: Boolean(pausedMacro), busy, verified: apiVerified, ready: apiReady, status: ui.status.textContent, startDisabled: ui.start.disabled, verifyHidden: ui.verify.hidden }),
    acknowledge: () => ui.verify.listeners.click({isTrusted:true}),
    hideSetup: operation => { ui.autoHide.checked = true; hideRejectedItem = operation; },
    hideSnapshot: () => ({ hidden: [...state.hidden], rejected: [...state.rejected], phase: state.phase }),
    stop: stopRun,
    diagnosticRole,
    tamperHide: value => { ui.autoHide.checked = value },
    savedKey
  };
  init(); ui.autoHide.checked = false;
})()`)
  vm.runInContext(source, context)
  const ids = ['19:bad@thread.skype', '19:good@thread.skype', '19:last@thread.skype']
  const calls = []
  const reply = async (action, data) => { if (action === 'delete') { calls.push(data.id); return respond(data.id, calls.length) } return {} }
  context.__test.setup(ids.map(id => ({ id, element: { innerText: id, getAttribute: () => null } })), reply)
  return { api: context.__test, calls, locks, delays, setup: verified => context.__test.setup(ids.map(id => ({ id, element: { innerText: id, getAttribute: () => null } })), reply, verified) }
}

test('实际接口控制器：拒绝一条后继续，成功队列去重并正常结束', async () => {
  const h = harness(id => ({ status: id.includes('bad') ? 403 : 204, outcome: id.includes('bad') ? 'rejected' : 'success' }))
  await h.api.run(false)
  const state = h.api.snapshot()
  assert.equal(state.success, 2)
  assert.equal(state.skipped, 1)
  assert.equal(state.paused, false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.locks[0].name, 'teams-clean-v6-chat')
  assert.equal(h.locks[0].options.ifAvailable, true)
})

test('实际控制器遇到401停止，且不把认证失败记录为单项不可删除', async () => {
  const h = harness(() => ({ status: 401, outcome: 'auth' }))
  await h.api.run(false)
  const state = h.api.snapshot()
  assert.equal(h.calls.length, 1)
  assert.equal(state.skipped, 0)
  assert.equal(state.ready, false)
  assert.equal(state.paused, true)
})

test('连续三条被拒绝即暂停，避免整批无效清理', async () => {
  const h = harness(() => ({ status: 404, outcome: 'rejected' }))
  await h.api.run(false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.api.snapshot().skipped, 3)
  assert.equal(h.api.snapshot().paused, true)
  assert.match(h.api.snapshot().status, /连续三条/)
})

test('连续普通单项拒绝不会误判整条接口失效', async () => {
  const h = harness(() => ({ status: 400, outcome: 'rejected' }))
  await h.api.run(false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.api.snapshot().skipped, 3)
  assert.equal(h.api.snapshot().paused, false)
})

test('429按返回时间等待，再重试同一条，不虚增成功次数', async () => {
  const h = harness((id, count) => count === 1 ? { status: 429, outcome: 'throttled', retryMs: 90000 } : { status: 204, outcome: 'success' })
  await h.api.run(false)
  assert.equal(h.calls[0], h.calls[1])
  assert.ok(h.delays.includes(90000))
  assert.equal(h.api.snapshot().success, 3)
})

test('结果不确定时暂停，继续后不重复删除那条记录', async () => {
  const h = harness((id, count) => count === 1 ? { status: 0, outcome: 'uncertain' } : { status: 204, outcome: 'success' })
  await h.api.run(false)
  assert.equal(h.api.snapshot().uncertain, 1)
  assert.equal(h.api.snapshot().paused, true)
  await h.api.run(true)
  assert.equal(h.calls.filter(id => id === h.calls[0]).length, 1)
  assert.equal(h.api.snapshot().success, 2)
})

test('没有单条验证就不能批量执行；核对按钮只在验证成功后显示', async () => {
  const h = harness(() => ({ status: 204, outcome: 'success' }))
  h.setup(false)
  await h.api.run(false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.api.snapshot().startDisabled, true)
  await h.api.probe('19:good@thread.skype')
  assert.equal(h.calls.length, 1)
  assert.equal(h.api.snapshot().verifyHidden, true)
  assert.equal(h.api.snapshot().startDisabled, false)
  assert.equal(h.api.snapshot().verified, false)
  h.api.acknowledge()
  assert.equal(h.api.snapshot().verified, true)
  assert.equal(h.api.snapshot().startDisabled, false)
})

test('同类分页锁被占用时不发出删除请求', async () => {
  const h = harness(() => ({ status: 204, outcome: 'success' }), true)
  await h.api.run(false)
  assert.equal(h.calls.length, 0)
  assert.match(h.api.snapshot().status, /另一个分页/)
})

test('三个区域使用不同录制键，不覆盖另一区域的数据', () => {
  const h = harness(() => ({ status: 204, outcome: 'success' }))
  const keys = ['chat', 'contacts', 'activity'].map(h.api.savedKey)
  assert.equal(new Set(keys).size, 3)
})

test('先删除全部，包括可删除的只有我；结束后才隐藏明确拒绝的记录', async () => {
  const order = []
  const h = harness(id => { order.push('delete:' + id); return { status: id.includes('bad') ? 400 : 204, outcome: id.includes('bad') ? 'rejected' : 'success' } })
  let items = ['19:bad@thread.skype', '19:good@thread.skype', '19:last@thread.skype'].map(id => ({id, element: {innerText:'只有我', getAttribute:()=>null}}))
  h.api.setup(items, async (action, data) => { if(action !== 'delete') return {}; order.push('delete:' + data.id); return {status:data.id.includes('bad')?400:204,outcome:data.id.includes('bad')?'rejected':'success'} })
  h.api.hideSetup(async item => { order.push('hide:' + item.id); items.splice(items.findIndex(candidate => candidate.id === item.id), 1) })
  await h.api.run(false)
  assert.deepEqual(order, ['delete:19:bad@thread.skype','delete:19:good@thread.skype','delete:19:last@thread.skype','hide:19:bad@thread.skype'])
  assert.equal(h.api.snapshot().success, 2)
  assert.equal(h.api.hideSnapshot().hidden.length, 1)
})

test('未知结果隔离后继续删除其他聊天，不自动进入隐藏', async () => {
  let count = 0
  const h = harness(() => (++count === 1 ? {status:0,outcome:'uncertain'} : {status:400,outcome:'rejected'}))
  let hides = 0
  h.api.hideSetup(async () => { hides++; throw new Error('不应隐藏') })
  await h.api.run(false); await h.api.run(true)
  assert.equal(hides, 0)
  assert.equal(h.api.snapshot().uncertain, 1)
})

test('隐藏阶段暂停后继续：保留删除进度，只重试未提交的隐藏', async () => {
  const h = harness(id => ({ status: id.includes('bad') ? 400 : 204, outcome: id.includes('bad') ? 'rejected' : 'success' }))
  let attempts = 0
  h.api.hideSetup(async () => { attempts++; throw new Error('菜单未出现，未提交隐藏') })
  await h.api.run(false)
  assert.equal(h.api.snapshot().paused, true)
  assert.equal(h.api.hideSnapshot().phase, 'hide')
  assert.equal(h.calls.length, 3)
  await h.api.run(true)
  assert.equal(h.calls.length, 3)
  assert.equal(attempts, 2)
  assert.equal(h.api.snapshot().success, 2)
})

test('脱敏诊断不复制页面任意role属性中的私密值', () => {
  const h = harness(() => ({status:204,outcome:'success'}))
  assert.equal(h.api.diagnosticRole({ getAttribute: () => 'PRIVATE-CONTACT-OR-TOKEN' }), '{role}')
  assert.equal(h.api.diagnosticRole({ getAttribute: () => 'menuitem' }), 'menuitem')
  assert.equal(h.api.diagnosticRole({ getAttribute: () => null }), null)
})

test('执行期间网页修改隐藏勾选框不能改变已确认的本轮配置', async () => {
  const h = harness(() => ({status:204,outcome:'success'}))
  const items = [{id:'19:bad@thread.skype', element:{innerText:'无法删除',getAttribute:()=>null}}]
  h.api.setup(items, async () => { h.api.tamperHide(false); return {status:400,outcome:'rejected'} })
  h.api.hideSetup(async () => { items.splice(0,1) })
  await h.api.run(false)
  assert.equal(h.api.hideSnapshot().hidden.length, 1)
})
