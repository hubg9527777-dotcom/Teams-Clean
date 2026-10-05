/* Shared, testable execution policy. No Teams requests and no credentials. */
(() => {
  'use strict'
  const kinds = new Set(['chat', 'contacts', 'activity'])

  function validateMacro (input) {
    if (!input || input.version !== 6 || !kinds.has(input.kind)) throw new Error('录制格式不兼容，请重新录制')
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 40) throw new Error('请录制完整流程，最多 40 个后续点击')
    for (const step of [input.trigger, ...input.actions]) {
      if (!step || !['click', 'contextmenu'].includes(step.type) ||
        !Number.isFinite(step.x) || !Number.isFinite(step.y) || step.x < 0 || step.y < 0 ||
        !Number.isFinite(step.delayMs) || step.delayMs < 0 || step.delayMs > 3600000) throw new Error('录制坐标或等待时间无效，请重新录制')
    }
    if (!Number.isFinite(input.trailingDelayMs) || input.trailingDelayMs < 0 || input.trailingDelayMs > 3600000 ||
      !input.viewport || !Number.isFinite(input.viewport.width) || input.viewport.width <= 0 || !Number.isFinite(input.viewport.height) || input.viewport.height <= 0 || !Number.isFinite(input.viewport.ratio) || input.viewport.ratio <= 0) throw new Error('录制环境无效，请重新录制')
    return input
  }

  function sleep (ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('已暂停', 'AbortError'))
      if (!Number.isFinite(ms) || ms < 0) return reject(new Error('等待时间无效'))
      let remaining = ms
      let timer
      const abort = () => { clearTimeout(timer); reject(new DOMException('已暂停', 'AbortError')) }
      const schedule = () => {
        const chunk = Math.min(remaining, 2147483647)
        remaining -= chunk
        timer = setTimeout(() => {
          if (remaining > 0) schedule()
          else { signal?.removeEventListener('abort', abort); resolve() }
        }, chunk)
      }
      schedule()
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  function assertActive (signal) {
    if (signal?.aborted) throw new DOMException('已暂停', 'AbortError')
  }

  // A queue item is retried a bounded number of times. Failed items are excluded
  // until the user explicitly starts a new run, including across pause/resume.
  async function runChatQueue ({ next, execute, scroll, state, signal, status, wait = sleep, maxRetries = 3 }) {
    let emptyRounds = 0
    for (;;) {
      assertActive(signal)
      const item = next(state)
      if (!item) {
        const moved = scroll()
        emptyRounds = moved ? 0 : emptyRounds + 1
        if (emptyRounds >= 5) return
        await wait(500, signal)
        continue
      }
      emptyRounds = 0
      const execution = await execute(item)
      const result = typeof execution === 'string' ? execution : execution?.outcome
      assertActive(signal)
      if (execution?.fatal) throw new Error(execution.reason || '录制控件无法匹配，已暂停')
      if (result === 'success') {
        state.processed.add(item.id)
        state.success++
        state.retries.delete(item.id)
      } else if (result === 'rejected') {
        state.failed.add(item.id)
        state.skipped++
      } else {
        const count = (state.retries.get(item.id) || 0) + 1
        state.retries.set(item.id, count)
        if (count >= maxRetries) {
          throw new Error(`当前聊天连续三次未完成操作，已暂停，不把定位失败当作“不可删除”：${execution?.reason || '请检查录制步骤及页面响应'}`)
        } else await wait(500 * count, signal)
      }
      status(state, item, result, execution?.reason || '')
    }
  }

  async function runFixedQueue ({ execute, state, signal, status, wait = sleep, maxRetries = 3, maxRounds = 1000 }) {
    let failures = 0
    while (state.rounds < maxRounds) {
      assertActive(signal)
      const execution = await execute()
      const result = typeof execution === 'string' ? execution : execution?.outcome
      assertActive(signal)
      if (execution?.fatal) throw new Error(execution.reason || '录制控件无法匹配，已暂停')
      if (result === 'rejected') throw new Error('页面拒绝当前记录的删除；固定坐标无法安全跳过，请手动处理后继续')
      if (result !== 'success') {
        failures++
        if (failures >= maxRetries) throw new Error('连续三次未完成录制步骤，已暂停；请检查列表是否已空或重新录制')
        await wait(500 * failures, signal)
        continue
      }
      failures = 0
      state.rounds++
      status(state)
    }
    throw new Error('已完成 1000 轮回放，请检查当前页面后再开始新任务')
  }

  globalThis.TeamsCleanCore = Object.freeze({ validateMacro, sleep, assertActive, runChatQueue, runFixedQueue })
})()
