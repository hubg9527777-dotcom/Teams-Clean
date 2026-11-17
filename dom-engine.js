/* Record/list anchoring. No network calls, credentials, or page script bridge. */
(() => {
  'use strict'
  const ROWS = '[role="row"], [role="listitem"], [role="treeitem"], tr, li, [data-tid="contact-item"], [data-tid="activity-item"], [data-tid="notification-item"]'
  const LAYERS = '[role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="listbox"]'
  const ACTIONS = 'button, [role="button"], [role="menuitem"], [role="option"]'
  const identityAttributes = ['data-contact-id', 'data-notification-id', 'data-event-id', 'data-item-id', 'data-message-id', 'data-mri', 'data-id', 'id']
  const text = element => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
  const attr = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ') + '"'
  const visible = element => {
    if (!element || !element.isConnected || !element.getClientRects().length) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const identities = new Map()
  function opaqueKey (value) {
    if (!identities.has(value)) {
      if (identities.size >= 40000) throw new Error('记录身份数量超过保护上限，请刷新后继续')
      identities.set(value, globalThis.crypto.randomUUID())
    }
    return identities.get(value)
  }
  function identity (element) {
    const attributes = identityAttributes.map(key => [key, element.getAttribute(key)]).filter(([, value]) => value)
    const explicit = attributes.find(([key, value]) => key !== 'id' || !/^:|^(?:radix|fluent|fui)-/i.test(value))
    // Generic data-tid identifies a component type, never an individual record.
    const label = text(element).replace(/\b(unread|read|just now)\b|未读|未讀|已读|已讀/gi, '').replace(/\b\d+\s*(?:seconds?|minutes?|hours?|days?)\s+ago\b|\bhace\s+\d+\s+(?:segundos?|minutos?|horas?|d[ií]as?)\b|\d+\s*(?:秒|分钟|分鐘|小时|小時|天)前/gi, '').replace(/\s+/g, ' ').trim()
    if (!explicit && !label) return null
    const value = explicit ? explicit.join(':') : label
    return { id: opaqueKey(JSON.stringify(['record', value])), signature: opaqueKey(JSON.stringify(['signature', value, label])) }
  }
  function rowFor (element) {
    if (!element?.closest || element.closest('[role="menu"]')) return null
    let row = element.closest(ROWS)
    if (!row) {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const rect = node.getBoundingClientRect()
        if (node.matches(ACTIONS) || rect.height < 24 || rect.height > 240 || rect.width < 120) continue
        const siblings = [...(node.parentElement?.children || [])].filter(other => other.tagName === node.tagName && other.getAttribute('data-tid') === node.getAttribute('data-tid') && identity(other))
        if (siblings.length >= 2 || /(?:contact|activity|notification).*(?:item|row|card)/i.test(node.getAttribute('data-tid') || '')) { row = node; break }
      }
    }
    if (!row || row.matches('[role="columnheader"], [role="rowheader"]') || row.querySelector('th, [role="columnheader"]')) return null
    if (row.getBoundingClientRect().height > 320 || row.closest('nav, [role="navigation"], header')) return null
    if (row && identity(row)) return row
    return null
  }
  function selectorFor (element) {
    if (element.id && document.querySelectorAll('[id=' + attr(element.id) + ']').length === 1) return '[id=' + attr(element.id) + ']'
    const tid = element.getAttribute('data-tid')
    if (tid && document.querySelectorAll('[data-tid=' + attr(tid) + ']').length === 1) return '[data-tid=' + attr(tid) + ']'
    const parts = []
    let node = element
    for (let depth = 0; node && node !== document.body && depth < 16; depth++, node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      const siblings = [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName)
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')')
    }
    if (node !== document.body) throw new Error('列表结构过深，无法建立可靠定位')
    return 'body > ' + parts.join(' > ')
  }
  function capture (row) {
    if (!row) throw new Error('请从列表中一条记录的右键或更多按钮开始录制')
    const role = row.getAttribute('role')
    const semantic = role && ['row', 'listitem', 'treeitem'].includes(role)
    const rowSelector = semantic ? '[role=' + attr(role) + ']' : ['TR', 'LI'].includes(row.tagName) ? row.tagName.toLowerCase() : ':scope > ' + row.tagName.toLowerCase()
    let root = row.parentElement
    const collection = row.parentElement.closest('[role="list"], [role="tree"], [role="grid"], [role="table"], [role="feed"], table, tbody, ul, ol')
    if (!rowSelector.startsWith(':scope') && collection && collection !== document.body && collection.getBoundingClientRect().height <= innerHeight * 3) root = collection
    if (!root || root === document.body || root === document.documentElement || root.closest('nav, [role="navigation"]')) throw new Error('未找到独立记录列表，请从记录行重新录制')
    const anchor = { selector: selectorFor(root), rowSelector, tag: root.tagName, role: root.getAttribute('role') || '', tid: root.getAttribute('data-tid') || '' }
    const snapshot = scan(anchor)
    if (!snapshot.items.some(item => item.element === row)) throw new Error('无法可靠识别该记录行，请从记录的右键菜单重新录制')
    return anchor
  }
  function rootFor (anchor) {
    if (!anchor || typeof anchor.selector !== 'string' || anchor.selector.length > 2048 || !/^(\[role="(?:row|listitem|treeitem)"\]|(?::scope > )?[a-z]+)$/.test(anchor.rowSelector)) throw new Error('录制列表定位格式无效，请重新录制')
    const roots = [...document.querySelectorAll(anchor.selector)].filter(visible)
    if (roots.length !== 1) throw new Error('录制列表未找到或存在多个匹配，请打开录制时的列表')
    const root = roots[0]
    if (root.tagName !== anchor.tag || root === document.body || root === document.documentElement || root.closest('nav, [role="navigation"]') || (root.getAttribute('role') || '') !== anchor.role || (root.getAttribute('data-tid') || '') !== anchor.tid) throw new Error('列表结构已改变，请重新录制')
    return root
  }
  function scan (anchor) {
    const root = rootFor(anchor)
    const items = []
    const ids = new Set()
    for (const element of root.querySelectorAll(anchor.rowSelector)) {
      const layer = element.closest(LAYERS)
      if (!visible(element) || (layer && !layer.contains(root)) || element.querySelector('th, [role="columnheader"]')) continue
      // Grouped chat trees contain parent treeitems; only leaf records are targets.
      if (!anchor.rowSelector.startsWith(':scope') && element.querySelector(anchor.rowSelector)) continue
      const key = identity(element)
      if (!key) continue
      if (ids.has(key.id)) throw new Error('多条记录缺少可区分标识，无法安全逐条清理，请改从记录行的右键菜单录制')
      ids.add(key.id)
      items.push({ ...key, element, top: element.getBoundingClientRect().top })
    }
    items.sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top)
    const loading = Boolean(root.closest('[aria-busy="true"]')) || [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)
    const scrollState = []
    for (let node = root; node && node !== document.body; node = node.parentElement) scrollState.push({ element: node, top: node.scrollTop, height: node.scrollHeight })
    return { root, items, loading, scrollState }
  }
  function scrollers (root) {
    const results = new Set()
    const add = element => { if (visible(element) && element.scrollHeight > element.clientHeight + 8) results.add(element) }
    for (let node = root; node && node !== document.body; node = node.parentElement) add(node)
    for (const element of root.querySelectorAll('[role="list"], [role="tree"], [role="grid"], [data-is-scrollable="true"]')) add(element)
    return [...results]
  }
  function scroll (anchor, reset = false) {
    let moved = false
    for (const node of scrollers(rootFor(anchor))) {
      const before = node.scrollTop
      node.scrollTop = reset ? 0 : Math.min(before + Math.max(40, node.clientHeight * 0.7), node.scrollHeight - node.clientHeight)
      if (Math.abs(node.scrollTop - before) > 1) moved = true
    }
    return moved
  }
  function failureKind (value) {
    if (/try again|temporarily unavailable|temporary error|try later|network (?:error|problem)|connection (?:lost|failed|error)|timed? out|went wrong|稍后|稍後|重试|重試|网络错误|網路錯誤|int[eé]ntalo|vuelve a intent|m[aá]s tarde|error de conexi[oó]n|tente novamente|mais tarde/i.test(value)) return 'transient'
    if (/cannot (?:delete|remove)|can['’]t (?:delete|remove)|unable to (?:delete|remove)|couldn['’]t (?:delete|remove)|无法(?:删除|移除)|無法(?:刪除|移除)|不能(?:删除|刪除)|no se puede (?:eliminar|borrar)|n[aã]o (?:[eé] poss[ií]vel|foi poss[ií]vel) (?:excluir|remover)/i.test(value)) return 'rejected'
    return null
  }
  function destructive (step) {
    const value = intent(step)
    return Boolean(value && value !== 'menu')
  }
  function intent (step) {
    for (const value of [step.label, step.control?.label, step.control?.aria, step.control?.tid].filter(Boolean)) {
      if (/more options|more actions|更多|m[aá]s opciones|mais op[çc][õo]es|ellipsis|more-options/i.test(value)) return 'menu'
      if (/unblock|取消封锁|取消封鎖|desbloquear/i.test(value)) return 'unblock'
      if (/hide|隐藏|隱藏|ocultar/i.test(value)) return 'hide'
      if (/block|封锁|封鎖|阻止|bloquear/i.test(value)) return 'block'
      if (/delete|remove|删除|刪除|移除|eliminar|borrar|excluir|remover|quitar/i.test(value)) return 'delete'
      if (/dismiss|clear|清除|忽略|descartar|limpar/i.test(value)) return 'dismiss'
    }
    return ''
  }
  function enabled (element) {
    return !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]')
  }
  globalThis.TeamsCleanDom = Object.freeze({ ROWS, LAYERS, ACTIONS, identity, rowFor, capture, rootFor, scan, scroll, failureKind, destructive, intent, enabled })
})()
