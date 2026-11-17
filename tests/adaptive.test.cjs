const test = require('node:test')
const assert = require('node:assert/strict')
require('../core.js')
require('../dom-engine.js')
const C = globalThis.TeamsCleanCore
const D = globalThis.TeamsCleanDom
const progress = () => ({ processed: new Set(), failed: new Set(), success: 0, skipped: 0, rounds: 0 })
function queue (items, execute, extra = {}) {
  const state = progress()
  const calls = []
  let resets = 0
  const options = { state, scan: () => ({ items: items.map(id => ({ id })) }),
    execute: async item => { calls.push(item.id); return execute(item, items, calls) },
    reset: () => { resets++ }, scroll: () => false, status: () => {}, wait: async (_, signal) => C.assertActive(signal), ...extra }
  return { state, calls, run: () => C.runAdaptiveQueue(options), resets: () => resets }
}
const remove = (item, items) => { items.splice(items.indexOf(item.id), 1); return 'success' }

test('逐条队列只统计确认移除，三遍完整复扫', async () => {
  const h = queue(['a', 'b', 'c'], remove)
  assert.deepEqual(await h.run(), { success: 3, unresolved: 0, uncertain: 0 })
  assert.deepEqual(h.calls, ['a', 'b', 'c'])
  assert.equal(h.resets(), 3)
})
test('单项拒绝不阻塞其他记录，下一遍重试后收尾', async () => {
  const h = queue(['bad', 'good'], (item, items, calls) => item.id === 'bad' && calls.filter(id => id === 'bad').length === 1 ? 'rejected' : remove(item, items))
  await h.run()
  assert.deepEqual(h.calls, ['bad', 'good', 'bad'])
  assert.equal(h.state.success, 2)
  assert.equal(h.state.skipped, 0)
})
test('永久拒绝最多每遍一次，三次后仍报告未完成', async () => {
  const h = queue(['a', 'b'], (item, items) => item.id === 'a' ? 'rejected' : remove(item, items))
  const result = await h.run()
  assert.equal(h.calls.filter(id => id === 'a').length, 3)
  assert.deepEqual(result, { success: 1, unresolved: 1, uncertain: 0 })
})
test('结果不明确的提交不重放，其他记录继续', async () => {
  const h = queue(['a', 'b'], (item, items) => item.id === 'a' ? 'uncertain' : remove(item, items))
  assert.deepEqual(await h.run(), { success: 1, unresolved: 1, uncertain: 1 })
  assert.deepEqual(h.calls, ['a', 'b'])
})
test('最后整遍扫描未再出现的待核对项可确认，确认过程不发点击', async () => {
  const h = queue(['a', 'b'], (item, items) => { const result = remove(item, items); return item.id === 'a' ? 'uncertain' : result }, { reconcile: async (id, seen) => !seen.has(id) })
  assert.deepEqual(await h.run(), { success: 2, unresolved: 0, uncertain: 0 })
  assert.equal(h.calls.length, 2)
})
test('已移除记录重新出现时撤回成功计数，不再次删除', async () => {
  const items = ['a']
  let resets = 0
  const h = queue(items, remove, { reset: () => { if (++resets === 2) items.push('a') } })
  assert.deepEqual(await h.run(), { success: 0, unresolved: 1, uncertain: 1 })
  assert.equal(h.calls.length, 1)
})
test('定位失败可重试，但连续五条结构性失败会停止无效扫描', async () => {
  const h = queue(['a', 'b', 'c', 'd', 'e', 'f'], () => ({ outcome: 'failure', reason: '找不到更多按钮' }))
  await assert.rejects(h.run(), /连续五条/)
  assert.equal(h.calls.length, 5)
  assert.equal(h.state.success, 0)
})
test('未知弹层无法取消时停止，不能继续点到其他记录', async () => {
  const h = queue(['a', 'b'], () => ({ outcome: 'failure', fatal: true, reason: '未知弹层' }))
  await assert.rejects(h.run(), /未知弹层/)
  assert.equal(h.calls.length, 1)
})
test('等待或执行中暂停立即中断，不启动下一项', async () => {
  const controller = new AbortController()
  const h = queue(['a', 'b'], () => { controller.abort(); return 'success' }, { signal: controller.signal })
  await assert.rejects(h.run(), { name: 'AbortError' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.state.success, 0)
})
test('延迟加载和分页滚动的新记录会进入队列', async () => {
  const items = ['a']
  let delivered = false
  const h = queue(items, remove, { scroll: () => { if (!delivered) { delivered = true; items.push('late'); return true } return false } })
  await h.run()
  assert.deepEqual(h.calls, ['a', 'late'])
})
test('录制单击删除支持零后续步骤，但仍验证行定位与相对坐标', () => {
  const step = { type: 'click', x: 20, y: 30, rowX: 0.5, rowY: 0.5, delayMs: 0 }
  const macro = { version: 6, rowSchema: 3, kind: 'activity', trigger: step, actions: [], rowAnchor: {}, page: { pathname: '/', hash: '' }, trailingDelayMs: 0, viewport: { width: 100, height: 100, ratio: 1 } }
  assert.equal(C.validateMacro(macro), macro)
  assert.throws(() => C.validateMacro({ ...macro, trigger: { ...step, rowX: NaN } }))
  assert.throws(() => C.validateMacro({ ...macro, page: null }))
})
test('中文英文西语葡语错误分类；确认删除弹窗不能误作失败', () => {
  for (const label of ['Try again later', '稍後重試', 'Inténtalo de nuevo', 'Tente novamente']) assert.equal(D.failureKind(label), 'transient')
  for (const label of ['Cannot delete', '無法刪除', 'No se puede eliminar', 'Não é possível excluir']) assert.equal(D.failureKind(label), 'rejected')
  assert.equal(D.failureKind('Delete this contact?'), null)
  assert.equal(D.failureKind('Remove notification?'), null)
})
test('删除/隐藏/封锁意图不混用，支持多语种', () => {
  assert.equal(D.intent({ label: 'Delete' }), D.intent({ label: 'Eliminar' }))
  assert.notEqual(D.intent({ label: 'Delete' }), D.intent({ label: 'Hide' }))
  assert.notEqual(D.intent({ label: 'Block' }), D.intent({ label: 'Unblock' }))
  assert.equal(D.destructive({ label: '更多选项' }), false)
  assert.equal(D.destructive({ label: 'Dismiss' }), true)
})
test('禁用与inert控件不可点击', () => {
  const control = { disabled: false, getAttribute: () => null, closest: () => null }
  assert.equal(D.enabled(control), true)
  assert.equal(D.enabled({ ...control, disabled: true }), false)
  assert.equal(D.enabled({ ...control, getAttribute: () => 'true' }), false)
  assert.equal(D.enabled({ ...control, closest: () => ({}) }), false)
})
test('身份不使用通用data-tid，诊断标识不暴露联系人正文', () => {
  const row = label => ({ getAttribute: key => key === 'data-tid' ? 'contact-item' : null, textContent: label })
  assert.notEqual(D.identity(row('Alice')).id, D.identity(row('Bob')).id)
  assert.ok(!D.identity(row('Private person')).id.includes('Private'))
  assert.equal(D.identity(row('Unread Alice')).id, D.identity(row('Read Alice')).id)
})

test('列表加载过程中不执行操作，加载结束后才清理', async () => {
  const items = ['a']; let loading = 3
  const h = queue(items, remove, { scan: () => ({ items: items.map(id => ({ id })), loading: loading-- > 0 }) })
  await h.run()
  assert.equal(h.state.success, 1)
})

test('持续加载不能误报列表已经清空', async () => {
  const h = queue([], remove, { scan: () => ({ items: [], loading: true }) })
  await assert.rejects(h.run(), /列表持续加载/)
  assert.equal(h.state.success, 0)
})
