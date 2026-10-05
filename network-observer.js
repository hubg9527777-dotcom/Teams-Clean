/* Read-only network observation. Diagnostics contain no credentials. */
importScripts('api-policy.js', 'network-api.js')
const capture = new globalThis.TeamsCleanNetworkCapture()
const P = globalThis.TeamsCleanApiPolicy
const KEY = 'teams-clean-network-diagnostic-v603'
const LIMIT_MS = 120000
const urls = ['https://teams.live.com/*']
let chain = Promise.resolve()
function sequential (work) {
  const result = chain.then(work)
  chain = result.catch(() => {})
  return result
}
const read = async () => (await chrome.storage.session.get(KEY))[KEY] || null
const write = data => chrome.storage.session.set({ [KEY]: data })
function senderAllowed (sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
    typeof sender.documentId !== 'string' || !sender.documentId || sender.documentId.length > 256) return false
  try { return new URL(sender.url).origin === 'https://teams.live.com' } catch (_) { return false }
}
function activeFor (run, details) {
  if (!run || run.stopped || details.timeStamp < run.startedAt || details.timeStamp > run.startedAt + LIMIT_MS) return false
  if (details.tabId === run.tabId) return !details.documentId || details.documentId === run.documentId
  // Worker traffic may have no tab ID. It is diagnostic-only and cannot
  // become a deletion template or be asserted to belong to this account.
  if (details.tabId !== -1) return false
  try { return new URL(details.initiator).origin === 'https://teams.live.com' } catch (_) { return false }
}
function publicReport (run) {
  if (!run) return { observed: 0, unassigned: 0, requests: [], note: '尚未开始网络诊断' }
  return { observed: run.observed, unassigned: run.unassigned, truncated: run.truncated,
    requests: run.requests.map(({ requestId, ...item }) => item),
    note: '仅包含受支持微软域名的修改请求元数据；未归属分页的 Worker 请求可能来自其他分页，不能用于自动删除' }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== 'teams-clean-network-v603' || !senderAllowed(sender) ||
    !['begin', 'end', 'report', 'capture-status', 'ack-calibration', 'prepare-delete', 'release-delete', 'keepalive', 'cancel-capture'].includes(message.action)) return false
  sequential(async () => {
    const run = await read()
    if (message.action === 'capture-status') return capture.status(sender)
    if (message.action === 'ack-calibration') return capture.acknowledge(sender)
    if (message.action === 'prepare-delete') return capture.prepare(sender, message.id)
    if (message.action === 'release-delete') { capture.release(sender, message.outcome); return { released: true } }
    if (message.action === 'keepalive') { capture.owned(sender); return { alive: true } }
    if (message.action === 'cancel-capture') { capture.owned(sender); capture.clear(); return { cancelled: true } }
    if (message.action === 'begin') {
      if (run && !run.stopped && Date.now() < run.startedAt + LIMIT_MS && run.tabId !== sender.tab.id) throw new Error('另一个分页正在做网络诊断，请先结束那页的校准')
      const next = { tabId: sender.tab.id, documentId: sender.documentId, startedAt: Date.now(), stopped: false, observed: 0, unassigned: 0, truncated: false, requests: [] }
      capture.begin(sender, message.ids)
      await write(next)
      return publicReport(next)
    }
    if (!run || run.tabId !== sender.tab.id || run.documentId !== sender.documentId) throw new Error('当前页面没有网络诊断会话，请重新校准')
    if (message.action === 'end') capture.owned(sender)
    if (message.action === 'end') { capture.stop(); run.stopped = true; await write(run); return publicReport(run) }
    if (message.action === 'report') return publicReport(run)
    throw new Error('未知诊断操作')
  }).then(data => sendResponse({ data })).catch(error => sendResponse({ error: error.message, pending: Boolean(error.pending), notSent: message.action === 'prepare-delete' }))
  return true
})

chrome.webRequest.onBeforeRequest.addListener(details => {
  const item = P.diagnosticRequest(details.url, details.method)
  if (!item) return
  sequential(async () => {
    const run = await read()
    if (!activeFor(run, details)) return
    capture.before(details)
    run.observed++
    if (details.tabId === -1) run.unassigned++
    let bodyKeys = []
    const body = details.requestBody
    if (body?.formData) bodyKeys = P.schema(Object.fromEntries(Object.keys(body.formData).map(key => [key, null])))
    else if (body?.raw?.length === 1 && body.raw[0].bytes?.byteLength <= 65536) {
      bodyKeys = P.schema(new TextDecoder().decode(body.raw[0].bytes))
    }
    const context = details.frameId === 0 ? 'top-page' : details.frameId === -1 ? 'tab-worker' : Number.isInteger(details.frameId) ? 'subframe' : 'unspecified'
    const record = { ...item, requestId: details.requestId, elapsedMs: Math.round(details.timeStamp - run.startedAt), source: details.tabId === -1 ? 'worker-unassigned' : 'this-tab', context, bodyKeys }
    if (run.requests.length >= 60) { run.requests.shift(); run.truncated = true }
    run.requests.push(record)
    await write(run)
  }).catch(() => {})
}, { urls }, ['requestBody'])

chrome.webRequest.onSendHeaders.addListener(details => {
  sequential(async () => capture.headers(details)).catch(() => {})
}, { urls: ['https://teams.live.com/api/groups/*'] }, ['requestHeaders'])
chrome.webRequest.onBeforeRedirect.addListener(details => {
  sequential(async () => capture.redirect(details)).catch(() => {})
}, { urls: ['https://teams.live.com/api/groups/*'] })

function finished (details, failed) {
  sequential(async () => {
    capture.completed(details, failed)
    const run = await read()
    if (!run || details.timeStamp > run.startedAt + LIMIT_MS || run.startedAt > details.timeStamp) return
    const record = run.requests.find(item => item.requestId === details.requestId)
    if (!record || details.tabId !== run.tabId && details.tabId !== -1 ||
      details.documentId && details.tabId === run.tabId && details.documentId !== run.documentId) return
    record.status = failed ? 0 : details.statusCode
    record.networkError = Boolean(failed)
    await write(run)
  }).catch(() => {})
}
chrome.webRequest.onCompleted.addListener(details => finished(details, false), { urls })
chrome.webRequest.onErrorOccurred.addListener(details => finished(details, true), { urls })
