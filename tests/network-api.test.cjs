const test = require('node:test')
const assert = require('node:assert/strict')
require('../api-policy.js')
require('../network-api.js')
const Capture = globalThis.TeamsCleanNetworkCapture
const sourceId = '19:manual@thread.skype'
const targetId = '19:probe@thread.skype'
const sender = { tab: { id: 10 }, documentId: 'document-10' }
const request = (extra = {}) => ({ requestId: 'delete-1', tabId: 10, frameId: 0, documentId: 'document-10', initiator: 'https://teams.live.com',
  url: 'https://teams.live.com/api/groups/v1/threads/' + encodeURIComponent(sourceId), method: 'DELETE', ...extra })
function fixture (extra = {}) {
  let now = 10000
  const capture = new Capture(() => now)
  capture.begin(sender, [sourceId, targetId])
  const item = request(extra)
  capture.before(item)
  capture.headers({ ...item, requestHeaders: [{ name: 'Authentication', value: 'skypetoken=TEST-SECRET' }, { name: 'Cookie', value: 'COOKIE-SECRET' }, { name: 'X-Tracking', value: 'PRIVATE' }] })
  capture.completed({ ...item, statusCode: 200 })
  capture.stop()
  return { capture, advance: ms => { now += ms } }
}
test('浏览器捕获200仅成为待核对候选；核对后精确替换线程并保留认证', () => {
  const { capture } = fixture()
  const info = capture.status(sender)
  assert.equal(info.requiresManualAck, true)
  assert.equal(info.calibrated, false)
  assert.equal(JSON.stringify(info).includes('TEST-SECRET'), false)
  assert.throws(() => capture.prepare(sender, targetId), /先核对/)
  capture.acknowledge(sender)
  const prepared = capture.prepare(sender, targetId)
  assert.equal(prepared.request.url, 'https://teams.live.com/api/groups/v1/threads/' + encodeURIComponent(targetId))
  assert.equal(prepared.headers.authentication, 'skypetoken=TEST-SECRET')
  assert.equal(prepared.headers.cookie, undefined)
  assert.equal(prepared.headers['x-tracking'], undefined)
})
test('不得复用校准源ID、联系人标识或另一个会话类型', () => {
  const { capture } = fixture()
  capture.acknowledge(sender)
  for (const id of [sourceId, '8:live:person', '19:other@thread.v2']) assert.throws(() => capture.prepare(sender, id))
})
test('只认可对应分页与页面；其他分页、iframe、无归属Worker和外部来源不能成为候选', () => {
  for (const extra of [{ tabId: 11 }, { tabId: -1 }, { frameId: 1 }, { documentId: 'new-document' }, { initiator: 'https://example.com' }]) {
    const { capture } = fixture(extra)
    assert.throws(() => capture.status(sender), /捕获 0 条/)
  }
})
test('明确归属当前分页的Worker可校准；仍须命中该页校准前的会话ID', () => {
  const { capture } = fixture({ frameId: -1, documentId: undefined })
  assert.equal(capture.status(sender).captured, true)
  assert.throws(() => fixture({ frameId: -1, documentId: undefined, url: 'https://teams.live.com/api/groups/v1/threads/' + encodeURIComponent('19:other@thread.skype') }).capture.status(sender), /校准前聊天列表/)
})
test('另一个分页或刷新后的页面不能读取认证或执行已捕获模板', () => {
  const { capture } = fixture()
  capture.acknowledge(sender)
  assert.throws(() => capture.prepare({ ...sender, tab: { id: 11 } }, targetId), /分页已变化/)
  assert.throws(() => capture.prepare({ ...sender, documentId: 'new-document' }, targetId), /分页已变化/)
})
test('必须只捕获一次删除且属于校准前列表', () => {
  const { capture } = fixture()
  capture.run.stopped = false
  capture.before(request({ requestId: 'delete-2' }))
  capture.stop()
  assert.throws(() => capture.status(sender), /捕获 2 条/)
  const missing = fixture({ url: 'https://teams.live.com/api/groups/v1/threads/' + encodeURIComponent('19:unknown@thread.skype') }).capture
  assert.throws(() => missing.status(sender), /校准前聊天列表/)
})
test('不复用请求体、查询、跨域、POST形态，也不读取Cookie替代认证', () => {
  for (const extra of [{ requestBody: { raw: [{ bytes: new TextEncoder().encode('{}').buffer }] } }, { url: request().url + '?private=1' },
    { url: request().url.replace('teams.live.com', 'example.com') }, { method: 'POST' }]) assert.throws(() => fixture(extra).capture.status(sender))
  const { capture } = fixture()
  capture.run.requests.get('delete-1').headers = { 'content-type': 'application/json' }
  assert.throws(() => capture.status(sender), /未观察到可复用认证头/)
})
test('重定向、失败与未完成请求不能作为成功校准', () => {
  const { capture } = fixture()
  capture.redirect(request())
  capture.completed({ ...request(), statusCode: 200 })
  assert.throws(() => capture.status(sender), /未通过/)
  for (const status of [0, 401, 403, 429, 500]) {
    const c = fixture().capture
    c.completed({ ...request(), statusCode: status })
    assert.throws(() => c.status(sender), /未通过/)
  }
  const c = fixture().capture
  c.run.requests.get('delete-1').status = null
  assert.throws(() => c.status(sender), /仍未结束/)
})
test('认证失效清除校准；短时校准与五分钟空闲到期后拒绝发送', () => {
  const a = fixture()
  a.advance(120001)
  assert.throws(() => a.capture.status(sender), /过期/)
  const b = fixture()
  b.capture.acknowledge(sender)
  b.advance(300001)
  assert.throws(() => b.capture.prepare(sender, targetId), /过期/)
  const c = fixture().capture
  c.acknowledge(sender); c.prepare(sender, targetId); c.release(sender, 'auth')
  assert.throws(() => c.prepare(sender, targetId), /校准已失效/)
})
test('请求必须串行；成功执行延长活跃校准，不能用错误响应延长有效期', () => {
  const { capture, advance } = fixture()
  capture.acknowledge(sender)
  capture.prepare(sender, targetId)
  assert.throws(() => capture.prepare(sender, targetId), /上一个接口请求/)
  advance(290000)
  capture.release(sender, 'success')
  capture.prepare(sender, targetId)
  advance(1000)
  capture.release(sender, 'uncertain')
  advance(300001)
  assert.throws(() => capture.prepare(sender, targetId), /过期/)
})
