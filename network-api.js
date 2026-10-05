/* Browser-observed legacy DELETE adapter. Credentials stay in extension memory. */
(() => {
  'use strict'
  const P = globalThis.TeamsCleanApiPolicy
  class Capture {
    constructor (now = () => Date.now()) { this.now = now; this.run = null }
    begin (sender, ids) {
      if (typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('缺少页面归属，不能校准')
      if (this.run?.leased && this.now() < this.run.leaseUntil) throw new Error('上一个接口请求仍在处理，请先暂停并等待退出')
      this.run = { tabId: sender.tab.id, documentId: sender.documentId, until: this.now() + 120000,
        ids: new Set((Array.isArray(ids) ? ids : []).slice(0, 2000).filter(P.chatId)),
        requests: new Map(), stopped: false, ready: false, leased: false }
    }
    owned (sender) {
      const run = this.run
      if (!run || run.tabId !== sender.tab.id || !run.documentId || run.documentId !== sender.documentId) throw new Error('接口校准已失效或分页已变化，请重新校准')
      if (this.now() > run.until) { this.run = null; throw new Error('接口校准已过期，请重新校准') }
      return run
    }
    belongs (details) {
      const run = this.run
      if (run && this.now() > run.until) { this.run = null; return false }
      if (!run || run.stopped || details.tabId !== run.tabId) return false
      if (details.documentId && details.documentId !== run.documentId) return false
      // An assigned dedicated Worker may have frameId -1. Its tab and
      // calibration-list chat ID still have to match. Unassigned tabId -1
      // and other frames never become templates.
      if (details.frameId !== undefined && ![0, -1].includes(details.frameId)) return false
      try { return new URL(details.initiator).origin === 'https://teams.live.com' } catch (_) { return false }
    }
    before (details) {
      if (!this.belongs(details)) return
      const match = P.matchRequest(details.url, details.method, 'https://teams.live.com')
      // The user's diagnostic proves this route. Do not infer other services,
      // POST bodies, query parameters or Cookie authentication here.
      if (!match || match.adapter !== 'legacy-groups') return
      if (this.run.requests.size >= 60) { this.run.overflow = true; return }
      const body = details.requestBody
      const empty = !body || (!body.error && !body.formData && (!body.raw || body.raw.every(item => item.bytes?.byteLength === 0)))
      this.run.requests.set(details.requestId, { ...match, body: '', empty,
        eligible: this.run.ids.has(match.id), headers: null, status: null, rejected: false })
    }
    headers (details) {
      if (!this.belongs(details)) return
      const request = this.run.requests.get(details.requestId)
      if (!request) return
      const headers = P.safeHeaders((details.requestHeaders || []).filter(item => typeof item.value === 'string').map(item => [item.name, item.value]))
      request.headers = headers
    }
    completed (details, failed = false) {
      const run = this.run
      if (run && this.now() > run.until) { this.run = null; return }
      if (!run) return
      const request = run.requests.get(details.requestId)
      if (!request || details.tabId !== run.tabId) return
      request.status = failed ? 0 : details.statusCode
      request.rejected = request.rejected || failed || ![200, 204].includes(details.statusCode)
    }
    redirect (details) {
      const request = this.run?.requests.get(details.requestId)
      if (request) request.rejected = true
    }
    stop () { if (this.run) this.run.stopped = true }
    candidate (sender) {
      const run = this.owned(sender)
      if (!run.stopped) throw new Error('请先结束校准')
      const requests = [...run.requests.values()]
      if (run.overflow) throw new Error('捕获删除请求过多，请仅删除一条后重新校准')
      if (requests.length !== 1) throw new Error(`浏览器层捕获 ${requests.length} 条历史删除请求；必须手动只删除一条普通聊天后重新校准`)
      const item = requests[0]
      if (!item.eligible) throw new Error('捕获的会话未出现在校准前聊天列表，不能确定对应目标，请重新校准')
      if (!item.empty) throw new Error('当前历史删除包含请求体，尚未适配，不能复用')
      if (item.status === null) { const error = new Error('浏览器层删除请求仍未结束，请稍等后重新结束校准'); error.pending = true; throw error }
      if (item.rejected) throw new Error(`浏览器层删除未通过（HTTP ${item.status}），请重新校准`)
      if (!item.headers || !['authorization', 'authentication', 'x-skypetoken', 'skypetoken'].some(key => item.headers[key])) throw new Error('未观察到可复用认证头，请复制诊断；不会读取 Cookie 或猜测令牌')
      return item
    }
    status (sender) {
      const item = this.candidate(sender)
      return { captured: true, calibrated: Boolean(this.run.ready), requiresManualAck: !this.run.ready,
        sourceId: item.id, template: { method: item.method, path: P.redactedPath(item), adapter: item.adapter, family: item.id.split('@')[1] } }
    }
    acknowledge (sender) {
      this.candidate(sender)
      this.run.ready = true
      this.run.until = this.now() + 300000
      return { ...this.status(sender), executionTemplate: { ...this.candidate(sender), headers: { ...this.candidate(sender).headers } } }
    }
    prepare (sender, id) {
      const item = this.candidate(sender)
      const run = this.run
      if (!run.ready) throw new Error('请先核对手动删除确实成功')
      if (run.leased && this.now() < run.leaseUntil) throw new Error('上一个接口请求尚未退出')
      const request = P.requestFor(item, id)
      run.leased = true
      run.leaseUntil = this.now() + 35000
      return { request, headers: { ...item.headers } }
    }
    release (sender, outcome) {
      const run = this.owned(sender)
      run.leased = false
      if (outcome === 'success') run.until = this.now() + 300000
      if (outcome === 'auth') this.run = null
    }
    clear () { this.run = null }
  }
  globalThis.TeamsCleanNetworkCapture = Capture
})()
