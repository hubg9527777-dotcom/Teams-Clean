const test = require('node:test')
const assert = require('node:assert/strict')
const harness = require('./dom-harness.cjs')

function scene (mode = 'errors') {
  const h = harness()
  const root = h.make('div', { id: 'fixture-list', role: 'list' })
  h.document.body.append(root)
  const attempts = {}
  const close = () => h.document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"]').filter(node => !node.contains(root)).forEach(node => node.remove())
  const button = (label, operation) => { const control = h.make('button', { 'data-tid': 'popup-button' }, label); control.addEventListener('click', operation); return control }
  const error = label => { close(); const layer = h.make('div', { role: 'alertdialog' }, label); layer.append(button('OK', close)); h.document.body.append(layer) }
  for (const id of ['manual', 'temporary', 'normal', 'refused']) {
    const row = h.make('div', { role: 'listitem', 'data-contact-id': id }, id + ' ')
    const more = button('More options', () => h.schedule(700, () => {
      close(); const menu = h.make('div', { role: 'menu' });
      menu.append(button('Delete', () => {
        close(); const dialog = h.make('div', { role: 'dialog' }, 'Delete this contact? ')
        dialog.append(button('Cancel', close), button('Delete', () => {
          close(); attempts[id] = (attempts[id] || 0) + 1
          h.schedule(300, () => {
            if (mode === 'errors' && id === 'temporary' && attempts[id] === 1) error('Inténtalo de nuevo más tarde')
            else if (mode === 'errors' && id === 'refused') error('Cannot delete this contact')
            else if (mode === 'uncertain' && id === 'temporary') {} // accepted click, no confirmed effect
            else row.remove()
          })
        })); h.document.body.append(dialog)
      })); h.document.body.append(menu)
    }))
    row.append(more); root.append(row)
  }
  const record = async () => {
    h.api.record(); h.user(root.children[0].children[0]); await h.clock(1500)
    h.user(h.document.querySelector('[role="menu"]').children[0]); await h.clock(200)
    h.user(h.document.querySelectorAll('[role="dialog"]').find(node => !node.contains(root)).children[1]); await h.clock(1000)
  }
  return { ...h, root, attempts, record }
}

test('实际内容脚本模型：录制→延迟菜单→确认→失败弹窗恢复→逐条核验→三遍复扫', async () => {
  const h = scene()
  await h.record(); await h.api.save()
  assert.equal(h.api.progress().success, 2)
  assert.equal(h.api.progress().unresolved, 1)
  assert.equal(h.api.progress().paused, true) // finished all sweeps; unresolved progress stays resumable
  assert.deepEqual(h.attempts, { manual: 1, temporary: 2, normal: 1, refused: 3 })
  assert.equal(h.root.children.length, 1)
  assert.equal(h.root.children[0].getAttribute('data-contact-id'), 'refused')
  assert.match(h.api.status(), /未完成 1/)
})
test('完整流程的提交无效果只隔离该条，不重复删除或虚报成功', async () => {
  const h = scene('uncertain')
  await h.record(); await h.api.save()
  assert.equal(h.api.progress().success, 2)
  assert.equal(h.api.progress().uncertain, 1)
  assert.equal(h.api.progress().paused, true)
  assert.equal(h.attempts.temporary, 1)
  assert.equal(h.root.children.length, 1)
  await h.api.resume()
  assert.equal(h.attempts.temporary, 1)
  assert.equal(h.api.progress().uncertain, 1)
})
test('录制后窗口变化仍按记录定位，拒绝使用旧屏幕坐标盲点', async () => {
  const h = scene('success')
  await h.record(); h.context.innerWidth = 1000; h.context.innerHeight = 700; h.context.devicePixelRatio = 1.25
  await h.api.save()
  assert.equal(h.api.progress().success, 3)
  assert.equal(h.root.children.length, 0)
})
test('多个相同删除按钮无法唯一判断时不随意选第一个', () => {
  const h = harness(); const menu = h.make('div', { role: 'menu' }); menu.append(h.make('button', {}, 'Delete'), h.make('button', {}, 'Delete')); h.document.body.append(menu)
  assert.equal(h.api.find({ label: 'Delete', control: { label: 'Delete' }, scope: { role: 'menu' } }), null)
})
test('同data-tid的隐藏、取消、封锁按钮不能冒充录制的删除按钮', () => {
  const h = harness()
  const step = { label: 'Delete', control: { label: 'Delete', tid: 'popup-button' } }
  for (const label of ['Cancel', 'Hide', 'Block']) assert.equal(h.api.matching(h.make('button', { 'data-tid': 'popup-button' }, label), step), false)
})
test('重复记录标识、错误列表、页面跳转时拒绝继续', async () => {
  const h = scene('success'); const row = h.root.children[0]; const anchor = h.D.capture(row)
  h.root.children[1].setAttribute('data-contact-id', 'manual')
  assert.throws(() => h.D.scan(anchor), /可区分/)
  h.root.children[1].setAttribute('data-contact-id', 'temporary')
  await h.record(); h.context.location.hash = '#other-page'; await h.api.save()
  assert.equal(h.api.progress().success, 0)
  assert.match(h.api.status(), /页面与录制时不同/)
})
test('旧录制所在列表消失时不在整个网页寻找同名删除', () => {
  const h = scene('success'); const anchor = h.D.capture(h.root.children[0]); h.root.remove()
  h.document.body.append(h.make('button', {}, 'Delete'))
  assert.throws(() => h.D.scan(anchor), /列表未找到/)
})

test('设置弹窗内的联系人列表可清理，不把承载列表的弹窗当成异常', async () => {
  const h = scene('success'); const settings = h.make('div', { role: 'dialog' }, 'Settings ')
  h.root.remove(); settings.append(h.root); h.document.body.append(settings)
  await h.record(); await h.api.save()
  assert.equal(h.api.progress().success, 3)
  assert.equal(settings.isConnected, true)
  assert.equal(h.root.children.length, 0)
})

test('分组聊天树只扫描叶子记录，不把收藏夹分组当作一条聊天', () => {
  const h = harness(); const tree = h.make('div', { id: 'fixture-list', role: 'tree' })
  const group = h.make('div', { role: 'treeitem' }, 'Favorites ')
  const a = h.make('div', { role: 'treeitem', 'data-id': 'chat-a' }, 'Chat A')
  const b = h.make('div', { role: 'treeitem', 'data-id': 'chat-b' }, 'Chat B')
  group.append(a, b); tree.append(group); h.document.body.append(tree)
  const snapshot = h.D.scan(h.D.capture(a))
  assert.equal(snapshot.items.length, 2)
  assert.equal(snapshot.items[0].element, a)
})

test('组件data-tid更新后，在当前弹层唯一的同意图控件仍能定位', () => {
  const h = harness(); const menu = h.make('div', { role: 'menu' }); const control = h.make('button', { 'data-tid': 'new-delete-button' }, 'Remove contact')
  menu.append(control); h.document.body.append(menu)
  assert.equal(h.api.find({ label: 'Delete', control: { tid: 'old-delete-button', label: 'Delete' }, scope: { role: 'menu' } }), control)
})
