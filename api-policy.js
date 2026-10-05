(() => {
  'use strict'
  function chatId (value) {
    return typeof value === 'string' && /^19:[A-Za-z0-9_=:+.-]+@(?:thread\.(?:skype|v2|tacv2)|unq\.gbl\.spaces)$/.test(value) && value.length < 1000
  }

  function matchRequest (url, method, origin) {
    if (origin !== 'https://teams.live.com' || typeof method !== 'string') return null
    let parsed
    try { parsed = new URL(url, origin) } catch (_) { return null }
    if (parsed.origin !== origin || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null
    // This adapter is enabled only after a real successful manual deletion.
    // It does not assert that this undocumented endpoint still exists.
    const middleTier = parsed.pathname.match(/^\/api\/mt\/(beta|v\d+(?:\.\d+)?)\/groups\/([^/]+)\/deleteChat\/?$/)
    const legacyGroups = parsed.pathname.match(/^\/api\/groups\/(v\d+)\/threads\/([^/]+)\/?$/)
    const match = middleTier || legacyGroups
    const normalizedMethod = method.toUpperCase()
    if (!match || parsed.search || (middleTier ? !['POST', 'DELETE'].includes(normalizedMethod) : normalizedMethod !== 'DELETE')) return null
    let id
    try { id = decodeURIComponent(match[2]) } catch (_) { return null }
    if (!chatId(id)) return null
    const trailingSlash = parsed.pathname.endsWith('/')
    const idIndex = parsed.pathname.split('/').length - (middleTier ? (trailingSlash ? 3 : 2) : (trailingSlash ? 2 : 1))
    return { id, method: normalizedMethod, prefix: middleTier ? `/api/mt/${match[1]}/` : `/api/groups/${match[1]}/`,
      path: parsed.pathname, origin: parsed.origin, adapter: middleTier ? 'middle-tier' : 'legacy-groups', idIndex }
  }

  function bodyTemplate (text, sourceId) {
    if (!text) return ''
    if (text.length > 65536) throw new Error('请求体过大，不能安全校准')
    let parsed
    try { parsed = JSON.parse(text) } catch (_) { throw new Error('请求体不是 JSON，请提供脱敏诊断以适配') }
    const check = value => {
      if (typeof value === 'string' && /^(?:19:|8:live:)/.test(value) && value !== sourceId) throw new Error('请求体包含其他会话或用户标识，不能套用到其他聊天')
      if (typeof value === 'string' && value !== sourceId && (value.includes(sourceId) || value.includes(encodeURIComponent(sourceId)))) throw new Error('请求体包含嵌入式聊天标识，不能安全替换')
      if (Array.isArray(value)) value.forEach(check)
      else if (value && typeof value === 'object') {
        if (Object.keys(value).some(key => key.includes(sourceId) || key.includes(encodeURIComponent(sourceId)))) throw new Error('请求体键包含聊天标识，不能安全替换')
        Object.values(value).forEach(check)
      }
    }
    check(parsed)
    return JSON.stringify(parsed)
  }

  function replaceBody (text, sourceId, targetId) {
    if (!text) return undefined
    const replace = value => {
      if (value === sourceId) return targetId
      if (Array.isArray(value)) return value.map(replace)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
      return value
    }
    return JSON.stringify(replace(JSON.parse(text)))
  }

  function requestFor (template, targetId) {
    if (!chatId(targetId) || !chatId(template.id) || template.id === targetId) throw new Error('聊天 ID 无效或是校准时已删除的记录')
    if (targetId.split('@')[1] !== template.id.split('@')[1]) throw new Error('该会话类型尚未校准，请单独校准同类型聊天')
    const verified = matchRequest(template.origin + template.path, template.method, template.origin)
    if (!verified || verified.id !== template.id) throw new Error('接口模板无效，请重新校准')
    const before = template.path.split('/')
    before[verified.idIndex] = encodeURIComponent(targetId)
    return { url: template.origin + before.join('/'), method: template.method, body: replaceBody(template.body, template.id, targetId) }
  }

  function result (status, text = '') {
    if (status === 204) return 'success'
    if (status === 200) {
      if (!text.trim()) return 'success'
      let body
      try { body = JSON.parse(text) } catch (_) { return 'unknown' }
      if (body?.error || (Array.isArray(body?.errors) && body.errors.length) || body?.success === false || body?.isSuccess === false || /^(?:error|failed|failure)$/i.test(body?.status || '')) return 'rejected'
      // Unknown 200 payloads are not guessed to be success.
      if (body && typeof body === 'object' && !Array.isArray(body) && (Object.keys(body).length === 0 || body.success === true || body.isSuccess === true)) return 'success'
      return 'unknown'
    }
    if (status === 401) return 'auth'
    if ([400, 403, 404, 409, 410, 422].includes(status)) return 'rejected'
    if (status === 429) return 'throttled'
    if (status >= 500) return 'server'
    return 'unknown'
  }

  function retryAfter (value, now = Date.now()) {
    if (!value) return 5000
    const seconds = Number(value)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
    return Number.isFinite(ms) ? Math.max(1000, ms) : 5000
  }

  async function readResponse (response, limit = 65536) {
    if (Number(response.headers?.get('content-length')) > limit) {
      await response.body?.cancel().catch(() => {})
      throw new Error('响应超出安全大小限制，结果待核对')
    }
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return text + decoder.decode()
        bytes += chunk.value.byteLength
        if (bytes > limit) {
          await reader.cancel().catch(() => {})
          throw new Error('响应超出安全大小限制，结果待核对')
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally { reader.releaseLock() }
  }

  function safeHeaders (headers) {
    const allowed = /^(?:authorization|authentication|x-skypetoken|skypetoken|content-type|accept|clientinfo|x-ms-client-version|x-ms-user-agent)$/i
    return Object.fromEntries([...new Headers(headers).entries()].filter(([key]) => allowed.test(key)))
  }

  function redactedPath (template) {
    return template.prefix + (template.adapter === 'legacy-groups' ? 'threads/{chatId}' : 'groups/{chatId}/deleteChat')
  }

  function microsoftHost (host) {
    return ['teams.live.com', 'skype.com', 'messenger.live.com', 'teams.microsoft.com', 'teams.cloud.microsoft'].some(domain => host === domain || host.endsWith('.' + domain))
  }

  const routeWords = new Set(['api', 'mt', 'beta', 'groups', 'deleteChat', 'chats', 'conversations', 'conversation', 'threads', 'thread', 'delete', 'remove', 'leave', 'users', 'ME', 'me', 'messages', 'message', 'properties', 'members', 'contacts', 'people', 'activities', 'notifications', 'feed', 'hideForUser', 'deleteForMe', 'deleteConversation', 'batch', '$batch', 'operations', 'command', 'commands'])
  const fieldWords = new Set(['id', 'chatId', 'threadId', 'conversationId', 'properties', 'members', 'user', 'users', 'name', 'value', 'status', 'success', 'isSuccess', 'error', 'errors', 'code', 'message', 'data', 'result', 'results', 'requests', 'responses', 'method', 'url', 'body', 'headers', 'operation', 'action', 'isDeleted', 'isHidden', 'deleted', 'hidden', 'clearedhistory', 'consumptionhorizon', 'lastMessageId', 'isFavorite', 'isRead', 'favorite', 'enabled'])

  function schema (input) {
    let value = input
    if (typeof input === 'string') {
      if (input.length > 65536) return ['{large-body}']
      try { value = JSON.parse(input) } catch (_) { return input ? ['{non-json}'] : [] }
    }
    const keys = new Set()
    function visit (item, depth) {
      if (depth > 4 || keys.size >= 30) return
      if (Array.isArray(item)) { item.slice(0, 3).forEach(part => visit(part, depth + 1)); return }
      if (!item || typeof item !== 'object') return
      for (const [key, child] of Object.entries(item)) {
        keys.add(fieldWords.has(key) ? key : '{field}')
        visit(child, depth + 1)
      }
    }
    visit(value, 0)
    return [...keys]
  }

  function diagnosticRequest (url, method, status = null, origin = 'https://teams.live.com') {
    let parsed
    try { parsed = new URL(url, origin) } catch (_) { return null }
    method = String(method).toUpperCase()
    if (parsed.protocol !== 'https:' || !microsoftHost(parsed.hostname) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null
    const route = parsed.pathname.split('/').map(part => routeWords.has(part) || /^v\d+(?:\.\d+)?$/.test(part) || part === '' ? part : '{segment}').join('/')
    const queryKeys = [...new Set([...parsed.searchParams.keys()].map(key => fieldWords.has(key) ? key : '{field}'))]
    return { method, host: parsed.hostname, path: route, queryKeys, status }
  }

  globalThis.TeamsCleanApiPolicy = Object.freeze({ chatId, matchRequest, bodyTemplate, requestFor, result, retryAfter, readResponse, safeHeaders, redactedPath, microsoftHost, schema, diagnosticRequest })
})()
