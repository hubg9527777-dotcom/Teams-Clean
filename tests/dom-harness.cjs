// Small isolated DOM model, not a rendering engine or a Teams compatibility test.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
module.exports = function harness () {
  let now = 0
  const later = []
  const clock = async ms => { now += ms; for (let i = 0; i < later.length;) { if (later[i].due <= now) { const task = later.splice(i, 1)[0]; task.fn() } else i++ } }
  class Event {
    constructor (type, values = {}) { Object.assign(this, { type, isTrusted: false, button: 0, clientX: 0, clientY: 0, timeStamp: now }, values) }
    preventDefault () {}
    composedPath () { return this.path || [] }
  }
  function matches (node, selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part.startsWith(':scope > ')) part = part.slice(9)
      const tag = part.match(/^[a-z][\w-]*/i)?.[0]
      if (tag && node.tagName !== tag.toUpperCase()) return false
      const cls = part.match(/\.([\w-]+)/)?.[1]
      if (cls && !(node.className || '').split(' ').includes(cls)) return false
      const id = part.match(/^#([\w-]+)/)?.[1]
      if (id && node.id !== id) return false
      for (const match of part.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
        const actual = node.getAttribute(match[1])
        if (actual == null || (match[2] === '=' && actual !== match[3]) || (match[2] === '*=' && !actual.includes(match[3]))) return false
      }
      return Boolean(tag || cls || id || part.startsWith('['))
    })
  }
  class Element {
    constructor (tag = 'div') { this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; this.listeners = {}; this._text = ''; this.hidden = false; this.disabled = false; this.value = ''; this.scrollTop = 0; this.clientHeight = 260; this._scrollHeight = 260 }
    get id () { return this.attributes.id || '' }
    set id (value) { this.attributes.id = value }
    get textContent () { return this._text + this.children.map(child => child.textContent).join(' ') }
    set textContent (value) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = String(value) }
    get innerText () { return this.textContent }
    get isConnected () { return this === document.documentElement || Boolean(this.parentElement?.isConnected) }
    get scrollHeight () { return this._scrollHeight }
    set scrollHeight (value) { this._scrollHeight = value }
    append (...nodes) { for (const node of nodes) { if (typeof node === 'string') this._text += node; else { node.parentElement = this; this.children.push(node); if (this.tagName === 'SELECT' && !this.value) this.value = node.value } } }
    remove () { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null } }
    attachShadow ({ mode = 'open' } = {}) { const shadow = new Element(); shadow.parentElement = this; this.shadowRoot = mode === 'closed' ? null : shadow; return shadow }
    setAttribute (key, value) { this.attributes[key] = String(value) }
    getAttribute (key) { return this.attributes[key] ?? null }
    matches (selector) { return matches(this, selector) }
    closest (selector) { for (let node = this; node instanceof Element; node = node.parentElement) if (node.matches(selector)) return node; return null }
    querySelectorAll (selector) { const result = []; const direct = selector.startsWith(':scope > '); const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); if (!direct) visit(child) } }; visit(this); return result }
    querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
    contains (node) { return node === this || this.children.some(child => child.contains(node)) }
    addEventListener (type, handler, capture = false) { (this.listeners[type] ||= []).push({ handler, capture }) }
    removeEventListener (type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(item => item.handler !== handler) }
    dispatchEvent (event) {
      event.target ||= this
      const route = []; for (let node = this; node; node = node.parentElement) route.push(node)
      route.push(document, window); event.path = route
      for (const node of [...route].reverse()) for (const entry of node.listeners?.[event.type] || []) if (entry.capture) entry.handler(event)
      for (const node of route) for (const entry of node.listeners?.[event.type] || []) if (!entry.capture) entry.handler(event)
      return true
    }
    getBoundingClientRect () {
      const row = this.closest('[role="listitem"]')
      if (row) { const top = 80 + row.parentElement.children.indexOf(row) * 68 - row.parentElement.scrollTop; return this.tagName === 'BUTTON' ? { left: 440, top, width: 120, height: 32, right: 560, bottom: top + 32 } : { left: 20, top, width: 560, height: 68, right: 580, bottom: top + 68 } }
      if (this.matches('[role="menu"], [role="dialog"], [role="alertdialog"]') || this.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return { left: 160, top: 330, width: 160, height: 45, right: 320, bottom: 375 }
      if (this.id === 'fixture-list') return { left: 20, top: 80, width: 560, height: 260, right: 580, bottom: 340 }
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    }
    getClientRects () { if (!this.isConnected) return []; for (let node = this; node instanceof Element; node = node.parentElement) if (node.hidden || node.style.display === 'none') return []; return [this.getBoundingClientRect()] }
    scrollIntoView () {}
  }
  const document = { listeners: {}, createElement: tag => new Element(tag),
    querySelectorAll: selector => document.documentElement.querySelectorAll(selector),
    querySelector: selector => document.querySelectorAll(selector)[0] || null,
    getElementById: id => document.querySelectorAll('[id="' + id + '"]')[0] || null,
    dispatchEvent: () => true,
    elementFromPoint: (x, y) => [...document.querySelectorAll('button, div, li')].reverse().find(element => { const r = element.getBoundingClientRect(); return element.getClientRects().length && r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }) || null }
  document.documentElement = new Element('html'); document.body = new Element('body'); document.documentElement.append(document.body)
  const window = new Element('window')
  const storage = {}
  const context = vm.createContext({ document, window, Element, MouseEvent: Event, PointerEvent: Event, KeyboardEvent: Event,
    crypto: require('node:crypto').webcrypto,
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, location: { origin: 'https://teams.live.com', pathname: '/v2/', hash: '' },
    sessionStorage: { getItem: () => 'contacts', setItem: () => {} },
    chrome: { storage: { local: { get: async key => ({ [key]: storage[key] }), set: async data => Object.assign(storage, data) } } },
    navigator: { locks: { request: async (_, __, operation) => operation({}) } },
    getComputedStyle: element => ({ display: element.style.display || 'block', visibility: element.style.visibility || 'visible' }),
    AbortController, DOMException, performance: { now: () => now }, setTimeout, clearTimeout, console, Date })
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context)
  load('core.js'); load('dom-engine.js'); load('api-policy.js')
  context.TeamsCleanCore = { ...context.TeamsCleanCore, sleep: async (ms, signal) => { context.TeamsCleanCore.assertActive(signal); await clock(ms); context.TeamsCleanCore.assertActive(signal) } }
  let source = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8')
  source = source.replace('  init()\n})()', `
    globalThis.fixtureApi = { record: () => startRecording({timeStamp:performance.now()}), save: () => finishRecordingAndRun({timeStamp:performance.now()}),
      status: () => ui.status.textContent, stop: stopRun, resume: () => pausedMacro && startRun(pausedMacro, true),
      executeOne: async (macro,item) => { running=true; activeMacro=macro; activeController=new AbortController(); try{return await executeRecordedItem(macro,item)}finally{running=false;activeController=null} },
      progress: () => ({success:state.success, unresolved:state.failed.size, uncertain:state.uncertainIds.size, paused:Boolean(pausedMacro), rounds:state.rounds}),
      matching: matchesRecordedControl, find: findRecordedAction, step: recordedMouseStep };
    init()
  })()`)
  vm.runInContext(source, context)
  const make = (tag, attrs = {}, label = '') => { const node = new Element(tag); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); node.textContent = label; return node }
  const user = element => { const r = element.getBoundingClientRect(); const fields = { isTrusted: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; element.dispatchEvent(new Event('pointerdown', fields)); element.dispatchEvent(new Event('click', fields)) }
  return { document, context, api: context.fixtureApi, D: context.TeamsCleanDom, make, user, clock, schedule: (ms, fn) => later.push({ due: now + ms, fn }), storage }
}
