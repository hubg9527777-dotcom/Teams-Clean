// Dependency-free packaging. Ref names are data, never shell source.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const files = Object.freeze(['manifest.json', 'core.js', 'dom-engine.js', 'api-policy.js', 'inject.js', 'network-api.js', 'network-observer.js', 'icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE'])

function validateTag (tag, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) || version.split('.').some(part => Number(part) > 65535)) throw new Error('Invalid extension version')
  if (tag !== `v${version}`) throw new Error('Release tag must exactly match v + manifest version')
}

function regularFile (root, name) {
  const file = path.join(root, name)
  if (!fs.lstatSync(file).isFile() || path.dirname(fs.realpathSync(file)) !== root) throw new Error('Package inputs must be regular files inside the project root')
  return file
}

function build ({ root = path.resolve(__dirname, '..'), tag = process.env.GITHUB_REF_NAME } = {}) {
  root = fs.realpathSync(root)
  const manifestText = fs.readFileSync(regularFile(root, 'manifest.json'), 'utf8')
  let manifest
  try { manifest = JSON.parse(manifestText) } catch (_) { throw new Error('Invalid manifest JSON') }
  validateTag(tag, manifest.version)
  for (const name of files) regularFile(root, name)
  const declared = [...manifest.content_scripts.flatMap(script => script.js || []), manifest.background.service_worker]
  if (declared.some(name => !files.includes(name))) throw new Error('Manifest declares an unpackaged script')
  const output = path.join(root, 'dist')
  if (fs.existsSync(output) && (!fs.lstatSync(output).isDirectory() || fs.realpathSync(output) !== output)) throw new Error('Unsafe output directory')
  fs.mkdirSync(output, { recursive: true })
  const archive = path.join(output, `Teams-Clean-v${manifest.version}.zip`)
  if (fs.existsSync(archive)) {
    if (!fs.lstatSync(archive).isFile()) throw new Error('Unsafe existing archive')
    fs.unlinkSync(archive) // Never retain stale entries from a prior ZIP.
  }
  const result = spawnSync('zip', ['-X', '-q', archive, ...files], { cwd: root, encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) throw new Error('ZIP packaging failed; verify that zip is installed')
  return archive
}

module.exports = { files, validateTag, build }
if (require.main === module) {
  try { console.log(build()) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
