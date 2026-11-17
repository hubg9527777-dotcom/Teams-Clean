const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const harness = require('./dom-harness.cjs')
const packaging = require('../scripts/package.cjs')
const root = path.resolve(__dirname, '..')

test('发布标签中的命令替换、分隔符、路径和换行全部被拒绝', () => {
  for (const tag of ['v$(id)', 'v`id`', 'v6.3.1;id', 'v6.3.1\necho', 'v../../outside', 'v6.3.1 --files']) assert.throws(() => packaging.validateTag(tag, '6.3.1'))
  assert.doesNotThrow(() => packaging.validateTag('v6.3.1', '6.3.1'))
  assert.throws(() => packaging.validateTag('v6.3.0', '6.3.1'))
})

test('CI所有Action固定40位SHA，测试只读、发布隔离、不持久化令牌', () => {
  const source = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const uses = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1])
  assert.equal(uses.length, 5)
  for (const action of uses) assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
  assert.match(source, /permissions:\n  contents: read/)
  assert.match(source, /publish:\n    needs: verify/)
  assert.equal((source.match(/persist-credentials: false/g) || []).length, 2)
  assert.equal((source.match(/ref: \$\{\{ github.sha \}\}/g) || []).length, 2)
  assert.doesNotMatch(source, /run:[^\n]*\$\{\{/)
  assert.doesNotMatch(source, /pull_request_target|secrets: inherit/)
})

test('打包只包含运行文件，拒绝用符号链接夹带外部文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-clean-package-'))
  try {
    for (const name of packaging.files) fs.copyFileSync(path.join(root, name), path.join(directory, name))
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
    const archive = packaging.build({ root: directory, tag: 'v' + manifest.version })
    const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8', shell: false })
    assert.equal(listing.status, 0)
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), [...packaging.files].sort())
    fs.unlinkSync(path.join(directory, 'README.md'))
    fs.symlinkSync(path.join(root, 'README.md'), path.join(directory, 'README.md'))
    assert.throws(() => packaging.build({ root: directory, tag: 'v' + manifest.version }), /regular files/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('页面脚本无法从host.shadowRoot读取日志或修改面板控件', () => {
  const h = harness()
  assert.equal(h.document.getElementById('teams-clean-account-host').shadowRoot, null)
})

test('已知FNV-1a碰撞不会合并两个记录的身份', () => {
  const h = harness()
  const legacy = value => { let n = 2166136261; for (const character of value) n = Math.imul(n ^ character.charCodeAt(0), 16777619); return n >>> 0 }
  assert.equal(legacy('costarring'), legacy('liquid'))
  const a = h.D.identity(h.make('div', {}, 'costarring'))
  const b = h.D.identity(h.make('div', {}, 'liquid'))
  assert.notEqual(a.id, b.id)
  assert.equal(a.id, h.D.identity(h.make('div', {}, 'costarring')).id)
  assert.doesNotMatch(a.id, /costarring/)
})

for (const eventName of ['mouseover', 'pointerdown']) {
  test(`记录在${eventName}时被虚拟列表复用，后续点击必须被阻止`, async () => {
    const h = harness(); const list = h.make('div', { id: 'fixture-list', role: 'list' }); const row = h.make('div', { role: 'listitem', 'data-contact-id': 'original' }, 'Original ')
    const more = h.make('button', { 'data-tid': 'more-options' }, 'More options'); row.append(more); list.append(row); h.document.body.append(list)
    const rowAnchor = h.D.capture(row)
    const item = h.D.scan(rowAnchor).items[0]
    const macro = { version: 6, kind: 'contacts', rowSchema: 3, rowAnchor, page: { pathname: '/v2/', hash: '' }, trigger: { type: 'click', rowTarget: false, relativeToRow: true, rowX: 0.9, rowY: 0.3, delayMs: 0, control: { tid: 'more-options', label: 'More options' } }, actions: [], trailingDelayMs: 0 }
    let clicks = 0
    more.addEventListener('click', () => { clicks++ })
    const target = eventName === 'mouseover' ? row : more
    target.addEventListener(eventName, () => row.setAttribute('data-contact-id', 'recycled'))
    const result = await h.api.executeOne(macro, item)
    assert.equal(clicks, 0)
    assert.notEqual(result, 'success')
    assert.match(result.reason, /记录已改变/)
  })
}
