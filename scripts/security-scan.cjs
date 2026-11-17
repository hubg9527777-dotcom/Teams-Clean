// Read-only heuristic secret inventory. Never emit a matched credential value.
// This supplements manual review; it is not a replacement for gitleaks/OSV.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['openai-style-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['opaque-auth-token', /\b(?:Bearer\s+|skypetoken=)[A-Za-z0-9_+./=-]{32,}/g],
  ['credential-url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/[^\s/'"<>:]+:[^\s/'"<>@]+@[^\s'"<>]+/gi],
  ['webhook', /https:\/\/(?:hooks\.slack\.com\/services|(?:discord(?:app)?\.com)\/api\/webhooks)\/[^\s'"<>]+/gi],
  ['credential-assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|authentication|password|passwd|passphrase|token|secret)\s*['"]?\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi]
]
const fixtureSentinels = ['SECRET-FOR-TEST', 'NOT-STORED', 'Bearer test-secret', 'test-skype', 'Bearer test-token', 'skypetoken=test-secret', 'skypetoken=network-secret']
const results = []
let workingFiles = 0
function inspect (buffer, file, source) {
  const text = buffer.toString('utf8')
  for (const [rule, expression] of rules) {
    expression.lastIndex = 0
    for (const match of text.matchAll(expression)) {
      const fixture = rule === 'credential-assignment' && fixtureSentinels.some(value => match[0].includes(value))
      results.push({ source, file, line: text.slice(0, match.index).split('\n').length, rule, classification: fixture ? 'known-test-fixture' : 'review-required' })
    }
  }
}
function walk (directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile()) { workingFiles++; inspect(fs.readFileSync(file), path.relative(root, file), 'working-tree') }
  }
}
walk(root)
let historicalBlobs = 0
let historyAvailable = true
let gitConfigScanned = false
try {
  const configPath = execFileSync('git', ['rev-parse', '--git-path', 'config'], { cwd: root, encoding: 'utf8' }).trim()
  inspect(fs.readFileSync(path.resolve(root, configPath)), '.git/config', 'local-git-config')
  gitConfigScanned = true
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  for (const item of objects) {
    const space = item.indexOf(' '); const id = space < 0 ? item : item.slice(0, space)
    if (!/^[a-f0-9]{40,64}$/.test(id)) continue
    const kind = execFileSync('git', ['cat-file', '-t', id], { cwd: root, encoding: 'utf8' }).trim()
    if (kind !== 'blob') continue
    historicalBlobs++
    inspect(execFileSync('git', ['cat-file', 'blob', id], { cwd: root, maxBuffer: 16 * 1024 * 1024 }), (space < 0 ? '{unnamed}' : item.slice(space + 1)) + '@' + id.slice(0, 12), 'reachable-git-history')
  }
} catch (_) { historyAvailable = false }
const ignoreChecks = Object.fromEntries(['.env', '.env.local', '.env.production', '.env.example', 'sample.pem', 'sample.key', 'sample.har'].map(file => [file, spawnSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: root }).status === 0]))
let trackedSensitivePaths = []
try { trackedSensitivePaths = execFileSync('git', ['ls-files', '--', '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.har'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch (_) {}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'Project working files including raw binary strings; local Git config and reachable Git blobs. Excludes other .git internals, node_modules and dist. No OCR; no remote/deleted Git objects. ZIP entries require separate artifact inspection.', workingFiles, historicalBlobs, historyAvailable, gitConfigScanned, trackedSensitivePaths, ignoreChecks, candidates: results, reviewRequired: results.filter(item => item.classification === 'review-required').length }, null, 2))
