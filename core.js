/* Shared, testable execution policy. No Teams requests and no credentials. */
(() => {
  'use strict'
  const kinds = new Set(['chat', 'contacts', 'activity'])

  function validateMacro (input) {
    if (!input || input.version !== 6 || !kinds.has(input.kind)) throw new Error('录制格式不兼容，请重新录制')
    if (!Array.isArray(input.actions) || (!input.actions.length && input.rowSchema !== 3) || input.actions.length > 40) throw new Error('请录制完整流程，最多 40 个后续点击')
    for (const step of [input.trigger, ...input.actions]) {
      if (!step || !['click', 'contextmenu'].includes(step.type) ||
        !Number.isFinite(step.x) || !Number.isFinite(step.y) || step.x < 0 || step.y < 0 ||
        !Number.isFinite(step.delayMs) || step.delayMs < 0 || step.delayMs > 3600000) throw new Error('录制坐标或等待时间无效，请重新录制')
    }
    if (!Number.isFinite(input.trailingDelayMs) || input.trailingDelayMs < 0 || input.trailingDelayMs > 3600000 ||
      !input.viewport || !Number.isFinite(input.viewport.width) || input.viewport.width <= 0 || !Number.isFinite(input.viewport.height) || input.viewport.height <= 0 || !Number.isFinite(input.viewport.ratio) || input.viewport.ratio <= 0) throw new Error('录制环境无效，请重新录制')
    if (input.rowSchema === 3 && (!input.rowAnchor || !input.page || typeof input.page.pathname !== 'string' || typeof input.page.hash !== 'string' || !Number.isFinite(input.trigger.rowX) || !Number.isFinite(input.trigger.rowY) || input.trigger.rowX < 0 || input.trigger.rowX > 1 || input.trigger.rowY < 0 || input.trigger.rowY > 1)) throw new Error('录制列表或相对位置无效，请重新录制')
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

  // A record-aware queue. Uncertain submissions are quarantined, never replayed.
  // Failed records get one attempt per full sweep; later rows remain reachable.
  async function runAdaptiveQueue ({ scan, execute, scroll, reset, state, signal, status, reconcile = async () => false, wait = sleep, maxPasses = 3, idleRounds = 5, maxItems = 10000 }) {
    state.issues ||= new Map()
    state.uncertainIds ||= new Set()
    let consecutiveFailures = 0
    let finalSeen = new Set()
    for (let pass = 0; pass < maxPasses; pass++) {
      assertActive(signal)
      await reset()
      await wait(500, signal)
      const attempted = new Set()
      finalSeen = new Set()
      let idle = 0
      let loadingRounds = 0
      let visited = 0
      for (;;) {
        assertActive(signal)
        if (++visited > maxItems * 4) throw new Error('扫描次数超过保护上限，已保留进度')
        const snapshot = await scan()
        if (snapshot.loading) {
          if (++loadingRounds > 40) throw new Error('列表持续加载，无法确认剩余记录，已保留进度')
          await wait(700, signal)
          continue
        }
        loadingRounds = 0
        for (const item of snapshot.items) finalSeen.add(item.id)
        if (state.issues.size + state.processed.size > maxItems) throw new Error('记录数量超过保护上限，已保留进度')
        // If a previously removed row reappears, report it instead of claiming clean.
        for (const item of snapshot.items) {
          if (state.processed.has(item.id)) {
            state.processed.delete(item.id)
            state.success = Math.max(0, state.success - 1)
            state.uncertainIds.add(item.id)
            state.failed.add(item.id)
            state.issues.set(item.id, { outcome: 'uncertain', reason: '已移除记录重新出现，需核对同步结果' })
          }
        }
        const item = snapshot.items.find(item => !attempted.has(item.id) && !state.processed.has(item.id) && !state.uncertainIds.has(item.id))
        if (!item) {
          const moved = await scroll()
          idle = moved ? 0 : idle + 1
          if (idle >= idleRounds) break
          await wait(700, signal)
          continue
        }
        idle = 0
        attempted.add(item.id)
        const previous = state.issues.get(item.id)
        if (previous?.attempts >= maxPasses) continue
        const execution = await execute(item)
        assertActive(signal)
        const result = typeof execution === 'string' ? execution : execution?.outcome
        if (execution?.fatal) throw new Error(execution.reason || '页面结构无法安全识别，已保留进度')
        state.rounds++
        if (result === 'success') {
          state.processed.add(item.id)
          state.success++
          state.failed.delete(item.id)
          state.issues.delete(item.id)
          consecutiveFailures = 0
        } else {
          const outcome = result === 'uncertain' ? result : result === 'rejected' ? result : 'failure'
          state.failed.add(item.id)
          state.issues.set(item.id, { outcome, attempts: (previous?.attempts || 0) + 1, reason: execution?.reason || '记录未确认移除' })
          if (outcome === 'uncertain') state.uncertainIds.add(item.id)
          consecutiveFailures = outcome === 'failure' ? consecutiveFailures + 1 : 0
          if (consecutiveFailures >= 5) throw new Error('连续五条记录均无法执行录制步骤，可能页面结构已改变；已保留进度')
        }
        state.skipped = state.failed.size
        state.uncertain = state.uncertainIds.size
        status(state, pass + 1, result)
        await wait(result === 'success' ? 250 : 1000, signal)
      }
    }
    // Recheck quarantined targets without sending another delete action.
    for (const id of [...state.uncertainIds]) {
      assertActive(signal)
      if (await reconcile(id, finalSeen)) {
        state.uncertainIds.delete(id); state.failed.delete(id); state.issues.delete(id)
        state.processed.add(id); state.success++
      }
    }
    state.skipped = state.failed.size
    state.uncertain = state.uncertainIds.size
    return { success: state.success, unresolved: state.failed.size, uncertain: state.uncertain }
  }

  globalThis.TeamsCleanCore = Object.freeze({ validateMacro, sleep, assertActive, runChatQueue, runFixedQueue, runAdaptiveQueue })
})()
