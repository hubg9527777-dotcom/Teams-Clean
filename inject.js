(() => {
  'use strict'
  const Core = globalThis.TeamsCleanCore
  const names = { chat: '聊天', contacts: '联络人', activity: '活动' }
  const STEP_APPEAR_TIMEOUT_MS = 15000
  let running = false
  let busy = false
  let activeController = null
  let recorder = null
  let activeMacro = null
  let pausedMacro = null
  let state = freshState()
  let ui
  const history = []
  const isolatedFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null

  function freshState () {
    return { processed: new Set(), failed: new Set(), retries: new Map(), success: 0, skipped: 0, rounds: 0, rejected: new Set(), hidden: new Set(), uncertainIds: new Set(), phase: 'delete', hideSubmitted: new Set() }
  }

  function init () {
    if (document.getElementById('teams-clean-account-host')) return
    const host = document.createElement('div')
    host.id = 'teams-clean-account-host'
    host.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;font-family:Segoe UI,Arial,sans-serif;max-width:calc(100vw - 24px)'
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = '#steps{white-space:pre-line;line-height:1.6;margin-top:8px;padding:7px;background:#f4f6fb;border-radius:4px;max-height:28vh;overflow:auto}:host([data-working="true"]) #steps,:host([data-working="true"]) label{display:none} .panel{box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);padding:9px;background:#fff;color:#242424;border:1px solid #ccc;border-radius:8px;box-shadow:0 2px 10px #0002;font-size:12px}.tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}button,select{height:30px;padding:0 10px;border-radius:5px;border:1px solid #ccc;font:inherit;font-size:12px;max-width:100%}button{cursor:pointer;background:#eee}button:disabled{cursor:default;opacity:.55}#start{background:#107c10;color:#fff}#stop{background:#d13438;color:#fff}#status{font-size:12px;margin-top:7px;overflow-wrap:anywhere;line-height:1.5}details{font-size:12px;margin-top:6px;max-height:38vh;overflow:auto}p{line-height:1.6}pre{max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}textarea{box-sizing:border-box;width:100%;font:11px monospace;margin-top:6px}:host([data-working="true"]) .panel{width:210px}:host([data-working="true"]) .tools>:not(#stop),:host([data-working="true"]) details,:host([data-working="true"]) #diagnostics{display:none!important}:host([data-working="true"]) #status{max-height:38px;overflow:hidden}'

    const panel = document.createElement('div')
    panel.className = 'panel'
    const tools = document.createElement('div')
    tools.className = 'tools'
    const mode = document.createElement('select')
    mode.setAttribute('aria-label', '手动选择清理区域')
    for (const [value, text] of Object.entries(names)) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      mode.append(option)
    }
    mode.value = sessionStorage.getItem('teams-clean-kind-v6') || 'contacts'
    if (!names[mode.value]) mode.value = 'contacts'
    const action = createButton('action', '录制操作')
    const start = createButton('start', '开始清理')
    const engine = document.createElement('select')
    engine.setAttribute('aria-label', '聊天清理方式')
    for (const [value, label] of [['api', '接口（实验）'], ['macro', '录制后备']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; engine.append(option)
    }
    const calibrate = createButton('calibrate', '校准接口')
    const probe = createButton('probe', '选取验证目标')
    const verify = createButton('verify', '已核对，启用批量')
    verify.hidden = true
    const stop = createButton('stop', '暂停')
    const continueButton = createButton('continue', '继续执行')
    const status = document.createElement('div')
    status.id = 'status'
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = '接口支持说明 / 运行日志'
    const explanation = document.createElement('p')
    explanation.textContent = 'v6.0.5：聊天接口直接发送删除请求，不回放鼠标操作；先手动校准一条，再核对接口单条删除，最后批量。仅通过浏览器层捕获当前同源 Groups DELETE 的认证头（临时保留在扩展内存，脱敏诊断不包含令牌）。个人 Teams 未提供公开 Graph 聊天删除支持，此处仍是私有接口。联络人、活动保留录制坐标和间隔，分别开分页并手动选择用途。校准在当前分页内存保留，后台休眠不会清空；刷新或认证失效时需要重新校准。'
    const log = document.createElement('pre')
    const diagnose = createButton('diagnose', '复制诊断')
    const diagnostics = document.createElement('textarea')
    diagnostics.id = 'diagnostics'
    diagnostics.readOnly = true
    diagnostics.rows = 6
    diagnostics.hidden = true
    details.append(summary, explanation, log)
    tools.append(mode, engine, calibrate, probe, verify, action, start, stop, continueButton)
    tools.append(diagnose)
    const hideLabel = document.createElement('label')
    const autoHide = document.createElement('input')
    autoHide.type = 'checkbox'; autoHide.checked = true
    const hideText = document.createElement('span'); hideText.textContent = '删除结束后隐藏明确无法删除的聊天'
    hideLabel.append(autoHide, hideText)
    const steps = document.createElement('div')
    steps.id = 'steps'
    steps.setAttribute('aria-live', 'polite')
    panel.append(tools, hideLabel, steps, status, details, diagnostics)
    shadow.append(style, panel)
    document.documentElement.append(host)
    ui = { host, mode, engine, calibrate, probe, verify, action, start, stop, continueButton, status, log, details, diagnose, diagnostics, steps, autoHide, hideLabel }
    onUser(action, 'click', event => recorder ? finishRecordingAndRun(event) : startRecording(event))
    onUser(start, 'click', async () => {
      try {
        if (apiMode()) {
          const preserve = Boolean(pausedMacro) || (apiVerified && (state.success > 0 || state.failed.size > 0 || state.hidden.size > 0))
          if (apiProbeSucceeded && !apiVerified) apiVerified = true
          return startRun({ kind: 'chat', engine: 'api' }, preserve)
        }
        const key = savedKey(mode.value)
        const saved = (await chrome.storage.local.get(key))[key]
        if (!saved) return setStatus('该区域还没有录制，请先录制一条完整操作')
        if (recorder || busy) return
        await startRun(saved, false)
      } catch (error) { setStatus(error.message) }
    })
    onUser(diagnose, 'click', exportDiagnostics)
    onUser(calibrate, 'click', handleCalibration)
    onUser(probe, 'click', handleProbe)
    onUser(verify, 'click', handleAcknowledgement)
    onUser(engine, 'change', () => { pausedMacro = null; setRunningUi(); setStatus('已切换聊天方式，请按该方式校准或录制') })
    onUser(stop, 'click', stopRun)
    onUser(continueButton, 'click', () => pausedMacro && startRun(pausedMacro, true))
    onUser(autoHide, 'change', () => { if (pausedMacro) state.autoHide = autoHide.checked })
    onUser(mode, 'change', () => {
      sessionStorage.setItem('teams-clean-kind-v6', mode.value)
      pausedMacro = null
      setRunningUi()
      setStatus(`${names[mode.value]}：请先手动打开对应页面，录制或执行已存录制`)
    })
    if (typeof MutationObserver === 'function') new MutationObserver(() => { if (apiCalibration) updateSteps() }).observe(document.body, { childList: true, subtree: true })
    window.addEventListener('keydown', event => {
      if (event.isTrusted && event.key === 'Escape' && (running || recorder || apiCalibration)) stopRun()
    }, true)
    setRunningUi()
    setStatus(apiMode() ? 'v6.0.5：按面板三步操作。接口删除优先，结束后再隐藏明确被拒绝的记录。' : 'v6.0.5：选择用途后录制；暂停不会自动恢复。录制时的手动删除会立即生效。')
  }

  function createButton (id, text) {
    const button = document.createElement('button')
    button.id = id
    button.textContent = text
    return button
  }

  function onUser (control, name, handler) {
    control.addEventListener(name, event => {
      if (event?.isTrusted !== true || control.disabled) return
      return handler(event)
    })
  }

  function savedKey (kind) { return `teams-clean-macro-v6-${kind}` }
  function viewport () { return { width: innerWidth, height: innerHeight, ratio: devicePixelRatio } }

  function startRecording (event) {
    if (busy || recorder) return
    pausedMacro = null
    ui.details.open = false
    recorder = { kind: ui.mode.value, trigger: null, actions: [], viewport: viewport(), lastEventTime: event.timeStamp }
    recorder.onMouseDown = event => {
      if (!event.isTrusted || isExtensionEvent(event) || ![0, 2].includes(event.button)) return
      if (recorder.actions.length >= 40) { cancelRecording(); setStatus('超过 40 个后续点击，请录制较短流程'); return }
      const step = recordedMouseStep(event)
      step.delayMs = recordedDelay(event.timeStamp - recorder.lastEventTime)
      recorder.lastEventTime = event.timeStamp
      if (!recorder.trigger) {
        const row = recorder.kind === 'chat' ? chatRowFor(event.target) : null
        const rect = row?.getBoundingClientRect()
        recorder.trigger = { ...step, relativeToRow: Boolean(rect), x: rect ? Math.round(event.clientX - rect.left) : step.x, y: rect ? Math.round(event.clientY - rect.top) : step.y }
      } else recorder.actions.push(step)
    }
    window.addEventListener('mousedown', recorder.onMouseDown, true)
    ui.action.textContent = '保存并执行'
    setRunningUi()
    setStatus(`正在录制${names[recorder.kind]}：请完整删除一条（包含确认），再点“保存并执行”；暂停可取消录制`)
  }

  function cancelRecording () {
    if (recorder) window.removeEventListener('mousedown', recorder.onMouseDown, true)
    recorder = null
    ui.action.textContent = '录制操作'
    setRunningUi()
  }

  async function finishRecordingAndRun (event) {
    const recorded = recorder
    cancelRecording()
    const macro = { version: 6, rowSchema: 2, kind: recorded.kind, trigger: recorded.trigger, actions: recorded.actions, trailingDelayMs: recordedDelay(event.timeStamp - recorded.lastEventTime), viewport: recorded.viewport }
    try {
      Core.validateMacro(macro)
      if (macro.kind === 'chat' && !macro.trigger.relativeToRow) throw new Error('聊天后备必须从聊天列表的一行开始录制，请重新录制')
      const key = savedKey(macro.kind)
      await chrome.storage.local.set({ [key]: macro })
      if (!busy && !recorder) await startRun(macro, false)
    } catch (error) { setStatus(error.message) }
  }

  function assertEnvironment (macro) {
    Core.assertActive(activeController?.signal)
    const current = viewport()
    if (current.width !== macro.viewport.width || current.height !== macro.viewport.height || current.ratio !== macro.viewport.ratio) throw new Error('窗口大小或缩放已改变，已暂停；请恢复录制时的大小或重新录制')
  }

  async function startRun (macro, resumed) {
    if (busy || recorder) return
    try { if (macro.engine !== 'api') Core.validateMacro(macro) } catch (error) { setStatus(error.message); return }
    if (macro.engine !== 'api' && macro.kind === 'chat' && macro.rowSchema !== 2) return setStatus('聊天录制行坐标已修复，请重新录制一条普通聊天；联络人和活动录制可保留')
    if (macro.kind !== ui.mode.value) return setStatus('录制用途与当前选择不一致，请重新选择')
    busy = true
    running = true
    activeMacro = macro
    activeController = new AbortController()
    const signal = activeController.signal
    if (!resumed) { state = freshState(); state.autoHide = Boolean(ui.autoHide.checked) }
    pausedMacro = null
    ui.details.open = false
    setRunningUi()
    setStatus(resumed ? '正在继续执行，请用“暂停”停止' : '正在执行，请用“暂停”停止')
    try {
      if (!navigator.locks) throw new Error('此浏览器不支持分页互斥，请使用新版 Chrome / Edge')
      await navigator.locks.request(`teams-clean-v6-${macro.kind}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('另一个分页正在执行同一区域，请先暂停那个分页')
        Core.assertActive(signal)
        if (macro.engine === 'api') { await runApiChat(macro, signal) }
        else if (macro.kind === 'chat') {
          await Core.runChatQueue({
            next: progress => getChatItems().find(item => !progress.failed.has(item.id) && !progress.processed.has(item.id)),
            execute: async item => {
              assertEnvironment(macro)
              const result = await replayOne(macro, item.element)
              if (result !== 'success') return result
              return verifyChatRemoved(item)
            },
            scroll: scrollChatLists,
            state, signal,
            status: (progress, item, result, reason) => setStatus(`聊天：界面移除已确认 ${progress.success}，明确拒绝 ${progress.skipped}；${result === 'success' ? '完成' : reason || '当前步骤未完成'}`)
          })
          setStatus(`聊天扫描结束：界面移除已确认 ${state.success}，跳过 ${state.skipped}。仅覆盖本次加载到的列表，请刷新核对。`)
        } else {
          await Core.runFixedQueue({ execute: async () => { assertEnvironment(macro); return replayOne(macro, null) }, state, signal,
            status: progress => setStatus(`${names[macro.kind]}：已回放 ${progress.rounds} 轮（轮数不等于已删除条数）`) })
        }
        activeMacro = null
      })
    } catch (error) {
      pausedMacro = macro
      setStatus(error.name === 'AbortError' ? `已暂停；成功响应/界面确认 ${state.success}，结果待核对 ${state.uncertain || 0}；点击“继续清理（保留进度）”恢复接口任务；录制任务点击“继续执行”` : `${error.message}；任务已暂停`)
    } finally {
      running = false
      busy = false
      activeController = null
      setRunningUi()
    }
  }

  function stopRun () {
    if (apiCalibration) { calibrationSerial++; stopNetworkHeartbeat(); networkCommand('end').then(() => networkCommand('cancel-capture')).catch(() => {}); apiCalibration = false; apiCommand('cancel').catch(() => {}); setStatus('已取消接口校准'); setRunningUi(); return }
    if (recorder) { cancelRecording(); setStatus('已取消录制；以前保存的录制仍保留'); return }
    if (!busy) return
    running = false
    pausedMacro = activeMacro
    activeController?.abort()
    setStatus('正在暂停，等待当前步骤退出…')
    setRunningUi()
  }

  function setRunningUi () {
    if (!ui) return
    const isApi = apiMode()
    ui.host.setAttribute('data-working', busy ? 'true' : 'false')
    ui.diagnose.disabled = busy || Boolean(recorder) || apiCalibration
    ui.mode.disabled = busy || Boolean(recorder) || apiCalibration
    ui.engine.style.display = ui.mode.value === 'chat' ? '' : 'none'
    ui.engine.disabled = busy || Boolean(recorder) || apiCalibration
    ui.calibrate.style.display = isApi ? '' : 'none'
    ui.calibrate.textContent = apiCalibration ? '2. 手动删除成功，验证一条' : '1. 开始校准'
    ui.calibrate.disabled = busy || Boolean(recorder)
    ui.probe.style.display = 'none'
    ui.probe.textContent = apiVerified || apiProbeSucceeded ? '4. 单条已完成' : probeTarget ? '4. 用接口删除这条' : '4. 选择验证聊天'
    ui.probe.disabled = busy || !apiReady || apiCalibration || apiVerified || apiProbeSucceeded || Boolean(pausedMacro?.targetId)
    ui.verify.style.display = 'none'
    ui.verify.disabled = busy || apiCalibration || (!apiManualAck && !apiProbeSucceeded)
    ui.verify.textContent = apiManualAck ? '3. 确认手动删除成功' : '5. 已核对，启用批量'
    ui.action.style.display = isApi ? 'none' : ''
    ui.action.disabled = busy
    ui.start.textContent = isApi && pausedMacro ? '继续清理（保留进度）' : isApi ? apiVerified ? '开始清理' : '3. 验证成功，开始清理' : '开始清理'
    ui.start.disabled = busy || Boolean(recorder) || apiCalibration || (isApi && (!apiReady || (!apiVerified && !apiProbeSucceeded)))
    ui.stop.style.display = busy || recorder || apiCalibration ? '' : 'none'
    ui.stop.textContent = recorder || apiCalibration ? '取消录制/校准' : '暂停'
    ui.continueButton.style.display = !isApi && !busy && pausedMacro ? '' : 'none'
    ui.hideLabel.style.display = isApi ? '' : 'none'
    ui.autoHide.disabled = busy || apiCalibration
    updateSteps()
  }

  async function replayOne (macro, row) {
    assertEnvironment(macro)
    const failure = getVisibleFailureDialog()
    if (failure) return handleFailureDialog(failure)
    if (row) { row.scrollIntoView({ block: 'center' }); await nextPaint() }
    await delay(macro.trigger.delayMs)
    const target = await targetAtMacroPoint(macro, row)
    if (!target) return macroFailure('trigger', '首次点击未匹配录制控件（请重新录制；诊断将报告命中的节点）', macro.trigger, row)
    await dispatchRecordedAction(target, replayPointForTrigger(target, macro, row), { ...macro.trigger, isTrigger: true })
    for (let stepIndex = 0; stepIndex < macro.actions.length; stepIndex++) {
      const recordedStep = macro.actions[stepIndex]
      const step = normalizeRecordedStep(recordedStep)
      await delay(step.delayMs)
      assertEnvironment(macro)
      const dialog = getVisibleFailureDialog()
      if (dialog) return handleFailureDialog(dialog)
      const action = await waitForRecordedStep(step, STEP_APPEAR_TIMEOUT_MS)
      assertEnvironment(macro)
      const lateDialog = getVisibleFailureDialog()
      if (lateDialog) return handleFailureDialog(lateDialog)
      if (!action) return macroFailure(`step-${stepIndex + 1}`, `第 ${stepIndex + 1} 个后续步骤未出现或未匹配；可能菜单未打开或页面忽略脚本事件`, step, row)
      await dispatchRecordedAction(action, replayPointForAction(action, step), step)
    }
    await delay(macro.trailingDelayMs)
    const finalFailure = await waitForFailureDialog(650)
    if (finalFailure) return handleFailureDialog(finalFailure)
    if (!await waitForFixedPositionToSettle(macro, 10000)) throw new Error('菜单或确认弹窗长时间未关闭，请手动检查')
    return 'success'
  }

  async function handleFailureDialog (dialog) {
    closeFailureDialog(dialog)
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(100)
      if (!getVisibleFailureDialog()) return 'rejected'
    }
    throw new Error('失败弹窗无法关闭，请手动点击确定后继续')
  }

  async function verifyChatRemoved (item) {
    for (let attempt = 0; attempt < 100; attempt++) {
      Core.assertActive(activeController.signal)
      const dialog = getVisibleFailureDialog()
      if (dialog) return handleFailureDialog(dialog)
      if (!getChatItems().some(current => current.id === item.id)) return 'success'
      await delay(100)
    }
    throw new Error('点击已完成，但未确认该聊天从列表移除，请检查后继续')
  }

  async function dispatchRecordedAction (target, point, step) {
    assertEnvironment(activeMacro)
    if (!target?.isConnected || (!isVisible(target) && !(step.isTrigger && hoverControlAvailable(target)))) throw new Error('点击前控件已消失，请检查后继续')
    dispatchMouseMove(target, point)
    return isRightMouseAction(step) ? dispatchRightClick(target, point) : dispatchLeftClick(target, point)
  }
  let localNetworkTemplate = null
  let calibrationSerial = 0
  let apiTransport = 'network'
  let apiManualAck = false
  let apiProbeSucceeded = false
  let apiProbeId = ''
  let lastNetworkResult = null
  let networkHeartbeat = null
  let networkDeadline = 0
  let calibrationIssue = null
  let apiCalibration = false
  let apiReady = false
  let apiVerified = false
  let apiFamily = ''
  let apiSourceId = ''
  let probeTarget = null
  let apiProbe = false

  function apiMode () { return ui.mode.value === 'chat' && ui.engine.value === 'api' }
  function apiCandidates () {
    return getChatItems().filter(item => TeamsCleanApiPolicy.chatId(item.id) && item.id !== apiSourceId && item.id !== apiProbeId && item.id.split('@')[1] === apiFamily)
  }

  async function handleCalibration () {
    if (busy || recorder) return
    for (const control of [ui.calibrate, ui.mode, ui.engine, ui.start, ui.probe, ui.verify]) control.disabled = true
    const serial = ++calibrationSerial
    try {
      if (!apiCalibration) {
        pausedMacro = null
        localNetworkTemplate = null
        apiTransport = 'network'
        apiReady = false
        apiVerified = false
        apiManualAck = false
        apiProbeSucceeded = false
        apiProbeId = ''
        lastNetworkResult = null
        calibrationIssue = null
        probeTarget = null
        ui.verify.hidden = true
        await networkCommand('begin', { ids: getChatItems().map(item => item.id) })
        networkDeadline = Date.now() + 120000
        if (serial !== calibrationSerial) return
        apiCalibration = true
        startNetworkHeartbeat()
        setStatus('下一步：手动删除且只删除一条普通聊天，确认列表已移除，再点击“2. 手动删除成功，验证一条”；这会通过接口删除面板所示的另一条聊天。校准时不会自动批量删除。')
      } else {
        await networkCommand('end')
        apiCalibration = false
        const info = await networkCommand('capture-status')
        if (serial !== calibrationSerial) return
        apiFamily = info.template?.family || ''
        apiSourceId = info.sourceId || ''
        apiManualAck = true
        ui.verify.hidden = false
        await handleAcknowledgement()
        if (serial !== calibrationSerial || !apiReady) return
        await handleProbe()
      }
    } catch (error) {
      calibrationIssue = error.message
      apiCalibration = Boolean(error.pending)
      apiReady = false
      apiManualAck = false
      ui.verify.hidden = true
      if (!apiCalibration) { await networkCommand('end').catch(() => {}); stopNetworkHeartbeat() }
      const count = networkDiagnostic?.observed
      setStatus(`${error.message}${Number.isFinite(count) ? `；浏览器观察 ${count} 条修改请求` : ''}；请点击“复制诊断”`)
    } finally { setRunningUi() }
  }

  async function handleAcknowledgement () {
    if (busy || apiCalibration) return
    if (apiManualAck) {
      ui.verify.disabled = true
      try {
        if (apiTransport === 'network') {
          const info = await networkCommand('ack-calibration')
          localNetworkTemplate = info.executionTemplate || null
          if (!localNetworkTemplate) throw new Error('未取得分页内校准模板，请重新校准')
          stopNetworkHeartbeat()
        }
        apiManualAck = false
        apiReady = true
        ui.verify.hidden = true
        probeTarget = chooseProbeTarget()
        networkDeadline = Date.now() + 300000
        setStatus(probeTarget ? `正在自动接口验证：${shortText(getOwnVisibleText(probeTarget.element))}。完成后核对列表，再点第3步。` : '没有可验证聊天；请滚动加载普通聊天后重新校准。')
      } catch (error) {
        apiReady = false
        apiManualAck = false
        ui.verify.hidden = true
        setStatus(`${error.message}；请回到第1步重新校准`)
      } finally { setRunningUi() }
      return
    }
    if (!apiReady || !apiProbeSucceeded) return
    apiVerified = true
    ui.verify.hidden = true
    setRunningUi()
    setStatus('已核对单条删除。点击“开始清理”；暂停后点击“继续清理（保留进度）”。')
  }

  function updateSteps () {
    if (!ui.steps) return
    if (!apiMode()) {
      ui.steps.textContent = recorder ? '当前：完整手动删除一条，包含确认。\n下一步：点击“保存并执行”，会立即回放后续记录。' : `录制步骤：\n1. 手动打开${names[ui.mode.value]}列表，保持窗口大小和缩放。\n2. 点击“录制操作”，完整手动删除一条。\n3. 点击“保存并执行”，立即开始回放。\n已有录制：点击“开始清理”。停止：点击“暂停”；恢复：点击“继续执行”。`
      return
    }
    const preview = getChatItems().find(item => TeamsCleanApiPolicy.chatId(item.id) && !/只有我|only me|just me/i.test(getOwnVisibleText(item.element)))
    const next = busy ? (state.phase === 'hide' ? '当前：删除阶段已结束，正在隐藏明确被拒绝的记录。' : '当前：接口删除中。') : pausedMacro ? '当前：已暂停；点击继续清理，保留删除和隐藏进度。' : apiCalibration ? `当前：手动删除一条普通聊天，确认成功后点第2步。接口将验证剩余列表中的一条；当前候选：${preview ? shortText(getOwnVisibleText(preview.element)) : '请滚动列表加载普通聊天'}` : apiVerified ? '当前：可开始清理。' : apiProbeSucceeded ? '当前：核对刚才接口验证的聊天确实移除，再点第3步。' : '当前：点第1步开始校准。'
    ui.steps.textContent = `1. 开始校准 → 手动删除一条普通聊天。\n2. 确认手动删除成功 → 自动接口验证另一条。\n3. 核对接口验证成功 → 开始清理。\n接口直接发删除请求。先尝试删除全部已加载聊天，再隐藏明确被拒绝的记录。不会按“只有我”名称直接隐藏。\n${next}`

  }

  function stopNetworkHeartbeat () {
    if (networkHeartbeat !== null) clearInterval(networkHeartbeat)
    networkHeartbeat = null
  }
  function startNetworkHeartbeat () {
    stopNetworkHeartbeat()
    if (typeof setInterval !== 'function') return
    networkHeartbeat = setInterval(() => {
      if ((!apiCalibration && apiTransport !== 'network') || !apiMode() || Date.now() > networkDeadline) { stopNetworkHeartbeat(); return }
      networkCommand('keepalive').catch(() => {
        stopNetworkHeartbeat()
        if (apiTransport === 'network' && !localNetworkTemplate && !busy) {
          apiReady = false; apiManualAck = false; apiVerified = false; ui.verify.hidden = true
          setRunningUi(); setStatus('浏览器层校准已失效，请回到第1步重新校准')
        }
      })
    }, 20000)
  }

  function apiCommand (action, data = {}) {
    if (action === 'delete') return sendNetworkDelete(data.id)
    if (action === 'cancel') return Promise.resolve({ cancelled: true })
    if (action === 'status') return Promise.resolve({})
    return Promise.reject(new Error('未知接口操作'))
  }

  async function sendNetworkDelete (id) {
    if (!isolatedFetch) { const error = new Error('当前环境不支持独立接口请求'); error.notSent = true; throw error }
    let prepared
    try { prepared = localNetworkTemplate
      ? { request: TeamsCleanApiPolicy.requestFor(localNetworkTemplate, id), headers: localNetworkTemplate.headers }
      : await networkCommand('prepare-delete', { id }) } catch (error) { error.notSent = true; throw error }
    const controller = new AbortController()
    const abort = () => controller.abort()
    const parentSignal = activeController?.signal
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted) controller.abort()
    const timeout = setTimeout(abort, 25000)
    let outcome = 'uncertain'
    try {
      const response = await isolatedFetch(prepared.request.url, { method: prepared.request.method, headers: prepared.headers,
        body: prepared.request.body, credentials: 'include', redirect: 'error', signal: controller.signal })
      const text = response.status === 200 ? await TeamsCleanApiPolicy.readResponse(response) : ''
      if (response.status !== 200) await response.body?.cancel().catch(() => {})
      outcome = TeamsCleanApiPolicy.result(response.status, text)
      lastNetworkResult = { status: response.status, outcome, responseKeys: TeamsCleanApiPolicy.schema(text) }
      if (outcome === 'success') networkDeadline = Date.now() + 300000
      return { status: response.status, outcome, retryMs: TeamsCleanApiPolicy.retryAfter(response.headers.get('Retry-After')) }
    } catch (_) { lastNetworkResult = { status: 0, outcome: 'uncertain', responseKeys: [] }; return { status: 0, outcome: 'uncertain', retryMs: 0 } }
    finally {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', abort)
      if (!localNetworkTemplate) await networkCommand('release-delete', { outcome }).catch(() => {})
      if (outcome === 'auth') localNetworkTemplate = null
    }
  }

  function chooseProbeTarget () {
    const candidates = apiCandidates()
    return candidates.find(item => !/只有我|only me|just me/i.test(getOwnVisibleText(item.element))) || candidates[0] || null
  }

  async function handleProbe () {
    if (busy || !apiReady || apiCalibration || recorder) return
    if (apiVerified || apiProbeSucceeded || pausedMacro?.targetId) return
    if (!probeTarget) {
      probeTarget = chooseProbeTarget()
      setStatus(probeTarget ? `单条验证将删除：${shortText(getOwnVisibleText(probeTarget.element))}；点击“4. 用接口删除这条”执行。` : '当前没有同类型聊天 ID，请滚动聊天列表后重试')
      setRunningUi()
      return
    }
    const item = apiCandidates().find(candidate => candidate.id === probeTarget.id)
    if (!item) { probeTarget = null; setStatus('指定验证聊天已不在当前列表，请重新选取'); setRunningUi(); return }
    apiProbe = true
    await startRun({ kind: 'chat', engine: 'api', targetId: item.id }, false)
    apiProbe = false
    setRunningUi()
  }

  async function runApiChat (macro, signal) {
    if (!apiReady || apiCalibration) throw new Error('请先校准一次实际成功的聊天删除')
    if (!apiVerified && !apiProbe) throw new Error('请完成第2步接口单条验证，核对聊天确实移除后再点击第3步')
    if (state.phase === 'hide' && !macro.targetId) return runHideRejected(signal)
    let emptyRounds = 0
    let consecutiveRejected = 0
    const cancel = () => { apiCommand('cancel').catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      for (;;) {
        Core.assertActive(signal)
        const item = apiCandidates().find(candidate => (!macro.targetId || macro.targetId === candidate.id) && !state.failed.has(candidate.id) && !state.processed.has(candidate.id))
        if (!item) {
          if (macro.targetId) throw new Error('指定验证聊天已移除或当前未加载，请重新选择目标')
          const moved = scrollChatLists()
          emptyRounds = moved ? 0 : emptyRounds + 1
          if (emptyRounds >= 5) {
            const incompatible = getChatItems().filter(candidate => !TeamsCleanApiPolicy.chatId(candidate.id) || candidate.id.split('@')[1] !== apiFamily).length
            setStatus(`接口队列结束：返回成功 ${state.success}，跳过 ${state.skipped}，结果待核对 ${state.uncertain || 0}；当前另有 ${incompatible} 条未适配类型。请刷新核对，仅覆盖已加载的列表。`)
            if (state.autoHide && state.rejected.size && !state.uncertainIds.size) { state.phase = 'hide'; await runHideRejected(signal) }
            return
          }
          await delay(500)
          continue
        }
        emptyRounds = 0
        let response
        for (let attempt = 0; attempt < 4; attempt++) {
          Core.assertActive(signal)
          setStatus(`接口处理中：${shortText(item.id)}；成功响应 ${state.success}，跳过 ${state.skipped}`)
          try { response = await apiCommand('delete', { id: item.id }) } catch (error) {
            if (error.notSent) throw new Error(`未发送删除请求：${error.message}`)
            response = { outcome: 'uncertain', status: 0 }
          }
          if (signal.aborted) {
            if (response.outcome === 'success') { state.processed.add(item.id); state.success++ }
            else if (!['rejected', 'throttled', 'auth'].includes(response.outcome)) { state.failed.add(item.id); state.uncertainIds.add(item.id); state.uncertain = (state.uncertain || 0) + 1 }
            Core.assertActive(signal)
          }
          if (response.outcome !== 'throttled') break
          if (attempt === 3) throw new Error('连续四次限流，已暂停；请稍后继续')
          const seconds = Math.ceil(response.retryMs / 1000)
          setStatus(`Teams 限流，按服务端要求等待 ${seconds} 秒；可随时暂停`)
          await delay(response.retryMs)
        }
        if (response.outcome === 'success') {
          state.processed.add(item.id)
          state.success++
          consecutiveRejected = 0
          if (macro.targetId) {
            probeTarget = null
            apiProbeSucceeded = true
            apiProbeId = item.id
            ui.verify.hidden = true
            setStatus('接口验证返回成功。请核对刚才指定聊天确实移除，再点击“3. 验证成功，开始清理”。刷新整个网页需要重新校准。')
            return
          }
        } else if (response.outcome === 'auth') {
          localNetworkTemplate = null
          apiReady = false
          apiVerified = false
          throw new Error('认证失效（401），请刷新并重新校准；不会把所有聊天标记为不可删除')
        } else if (response.outcome === 'rejected') {
          state.failed.add(item.id)
          state.skipped++
          if ([200, 400, 403, 409, 422].includes(response.status)) state.rejected.add(item.id)
          consecutiveRejected = [404, 410].includes(response.status) ? consecutiveRejected + 1 : 0
          setStatus(`服务端拒绝 HTTP ${response.status}，已跳过 ${shortText(item.id)}；成功 ${state.success}，跳过 ${state.skipped}`)
          if (macro.targetId) throw new Error('单条验证被拒绝，不能启用批量；请改选普通聊天重新校准')
          if (consecutiveRejected >= 3) throw new Error('连续三条返回 404/410，可能是接口发生变化，已暂停；请重新校准')
        } else {
          state.failed.add(item.id)
          state.uncertainIds.add(item.id)
          state.uncertain = (state.uncertain || 0) + 1
          throw new Error(`请求结果无法确认（HTTP ${response.status}）；当前聊天不自动重发，请先在 Teams 核对，再继续其他记录`)
        }
        await delay(1000)
      }
    } finally { signal.removeEventListener('abort', cancel) }
  }
  // Only a completed delete rejection enters this phase. Names never decide eligibility.
  async function runHideRejected (signal) {
    for (const list of document.querySelectorAll('[data-tid*="chat-list"], [role="tree"], .fui-Tree')) {
      if (isVisible(list) && list.scrollHeight > list.clientHeight + 8) list.scrollTop = 0
    }
    await delay(200)
    let emptyRounds = 0
    for (;;) {
      Core.assertActive(signal)
      const item = getChatItems().find(candidate => state.rejected.has(candidate.id) && !state.hidden.has(candidate.id))
      if (!item) {
        const moved = scrollChatLists()
        emptyRounds = moved ? 0 : emptyRounds + 1
        if (emptyRounds >= 5) {
          state.phase = 'done'
          const remaining = state.rejected.size - state.hidden.size
          setStatus(`清理结束：批量删除成功响应 ${state.success}，隐藏界面确认 ${state.hidden.size}，拒绝删除但未确认隐藏 ${remaining}，结果待核对 ${state.uncertain || 0}。仅覆盖已加载且接口适配的聊天，请刷新核对。`)
          return
        }
        await delay(500)
        continue
      }
      emptyRounds = 0
      setStatus(`删除阶段已结束；正在隐藏无法删除的聊天：${shortText(getOwnVisibleText(item.element))}；隐藏已确认 ${state.hidden.size}`)
      if (state.hideSubmitted.has(item.id)) throw new Error('这条聊天已发送隐藏点击但未确认移除，请手动核对；不会重复点击')
      await hideRejectedItem(item, signal)
      state.hidden.add(item.id)
      state.hideSubmitted.delete(item.id)
      await delay(300)
    }
  }

  function exactHideAction (root) {
    return [...root.querySelectorAll('button, [role="menuitem"], [role="button"]')]
      .find(element => !isExtensionElement(element) && isVisible(element) && /^(隐藏|隱藏|隐藏聊天|隱藏聊天|hide|hide chat)$/i.test(getOwnVisibleText(element)))
  }

  async function hideRejectedItem (item, signal) {
    Core.assertActive(signal)
    item.element.scrollIntoView({ block: 'nearest' })
    revealTarget(item.element, item.element)
    await nextPaint()
    const rect = item.element.getBoundingClientRect()
    dispatchRightClick(item.element, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    let action = null
    for (let attempt = 0; attempt < 50; attempt++) {
      Core.assertActive(signal)
      const menus = [...document.querySelectorAll('[role="menu"]')].filter(isVisible)
      if (menus.length === 1) action = exactHideAction(menus[0])
      if (action) break
      await delay(100)
    }
    if (!action) throw new Error('未找到这条聊天右键菜单的“隐藏”，请手动核对界面后继续；未点击其他菜单项')
    Core.assertActive(signal)
    const point = action.getBoundingClientRect()
    state.hideSubmitted.add(item.id)
    dispatchLeftClick(action, { x: point.left + point.width / 2, y: point.top + point.height / 2 })
    let absent = 0
    let confirmedDialog = false
    for (let attempt = 0; attempt < 100; attempt++) {
      // A pause after the click may leave a completed hide; preserve its result first.
      if (!getChatItems().some(current => current.id === item.id)) {
        if (++absent >= 2 || item.element.isConnected === false) { state.hidden.add(item.id); state.hideSubmitted.delete(item.id); return }
      } else absent = 0
      Core.assertActive(signal)
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(isVisible)
      if (!confirmedDialog && dialogs.length === 1) {
        const confirm = exactHideAction(dialogs[0])
        if (confirm) {
          confirmedDialog = true
          const box = confirm.getBoundingClientRect()
          dispatchLeftClick(confirm, { x: box.left + box.width / 2, y: box.top + box.height / 2 })
        }
      }
      await delay(100)
    }
    throw new Error('已点击隐藏，但未确认聊天从列表移除；请手动核对，不会计为成功或重复点击')
  }

  function dispatchMouseMove (target, point) {
    if (!running || !target || typeof target.dispatchEvent !== 'function') return false
    dispatchPointerIfSupported(target, 'pointermove', point, -1, 0)
    target.dispatchEvent(mouseEvent('mousemove', point, -1, 0))
    return true
  }

  function mouseActionType (event) {
    return event.button === 2 ? 'contextmenu' : 'click'
  }

  function isRightMouseAction (step) {
    return step?.type === 'contextmenu' || step?.button === 2
  }

  function dispatchLeftClick (target, point) {
    if (!running || !target || typeof target.dispatchEvent !== 'function') return false
    dispatchPointerIfSupported(target, 'pointerdown', point, 0, 1)
    target.dispatchEvent(mouseEvent('mousedown', point, 0, 1))
    dispatchPointerIfSupported(target, 'pointerup', point, 0, 0)
    target.dispatchEvent(mouseEvent('mouseup', point, 0, 0))
    target.dispatchEvent(mouseEvent('click', point, 0, 0))
    return true
  }

  function dispatchRightClick (target, point) {
    if (!running || !target || typeof target.dispatchEvent !== 'function') return false
    dispatchPointerIfSupported(target, 'pointerdown', point, 2, 2)
    target.dispatchEvent(mouseEvent('mousedown', point, 2, 2))
    dispatchPointerIfSupported(target, 'pointerup', point, 2, 0)
    target.dispatchEvent(mouseEvent('mouseup', point, 2, 0))
    target.dispatchEvent(mouseEvent('contextmenu', point, 2, 0))
    return true
  }

  function mouseEvent (type, point, button, buttons) {
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button,
      buttons,
      clientX: Number.isFinite(point?.x) ? point.x : 0,
      clientY: Number.isFinite(point?.y) ? point.y : 0
    })
  }

  function dispatchPointerIfSupported (target, type, point, button, buttons) {
    if (typeof PointerEvent !== 'function') return
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'mouse',
      isPrimary: true,
      button,
      buttons,
      clientX: point.x,
      clientY: point.y
    }))
  }

  function macroPoint (macro, row) {
    if (macro.trigger.relativeToRow && row) {
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.left + macro.trigger.x), y: Math.round(rect.top + macro.trigger.y) }
    }
    return { x: macro.trigger.x, y: macro.trigger.y }
  }

  async function targetAtMacroPoint (macro, row = null) {
    if (row && macro.trigger.relativeToRow) {
      row.scrollIntoView({ block: 'nearest' })
      await nextPaint()
      if (!running) return null
    }
    let point = macroPoint(macro, row)
    let target = pageElementFromPoint(point.x, point.y)
    if (!target || !isVisible(target)) return null
    const rowCandidate = row || interactionRowFor(target)
    revealTarget(target, rowCandidate)
    await nextPaint()
    if (!running) return null
    point = macroPoint(macro, row)
    target = pageElementFromPoint(point.x, point.y)
    if (!target || !isVisible(target)) return null
    if (!macro.trigger.relativeToRow && macro.trigger.type === 'contextmenu') return target
    const direct = interactiveControlFor(target)
    if (!macro.trigger.control) return direct || target
    const step = { control: macro.trigger.control, label: macro.trigger.control.label }
    if (direct && (!row || row.contains(direct)) && matchesRecordedControl(direct, step)) return direct
    return findMatchingTriggerControl(rowCandidate || target, macro.trigger.control, point)
  }

  function interactionRowFor (element) {
    return element?.closest?.('tr, [role="row"], [role="listitem"], [data-tid*="contact"], [data-tid*="people"], [data-tid*="chat-list-item"]') || null
  }

  function interactiveControlFor (element) {
    return element?.closest?.('button, [role="button"], [role="menuitem"], [role="option"]') || element?.closest?.('[data-tid]') || null
  }

  function findMatchingTriggerControl (origin, control, point) {
    const root = origin instanceof Element ? origin : null
    if (!root) return null
    const candidates = [...root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [data-tid]')]
      .filter(element => hoverControlAvailable(element) || isVisible(element))
      .filter(element => !isExtensionElement(element))
      .filter(element => matchesRecordedControl(element, { control, label: control.label }))
      .sort((a, b) => distanceToPoint(a, point) - distanceToPoint(b, point))
    return candidates[0] || null
  }

  function distanceToPoint (element, point) {
    const rect = element.getBoundingClientRect()
    return Math.hypot(rect.left + rect.width / 2 - point.x, rect.top + rect.height / 2 - point.y)
  }

  function revealTarget (target, row) {
    row?.scrollIntoView({ block: 'nearest' })
    const subject = row || target
    if (!subject || typeof subject.dispatchEvent !== 'function') return false
    subject.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    subject.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    subject.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    return true
  }

  async function waitForRecordedStep (step, timeoutMs) {
    const attempts = Math.ceil(timeoutMs / 100)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!running) return null
      // 菜单和确认框的位置会随窗口、缩放和列表滚动而改变。弹层内优先
      // 以录制的控件特征定位，坐标只作为找不到控件时的后备。
      const action = step.scope
        ? findRecordedAction(step)
        : actionAtRecordedPoint(step) || findRecordedAction(step)
      if (getVisibleFailureDialog()) return null
      if (action) return action
      await delay(100)
    }
    return null
  }

  function actionAtRecordedPoint (step) {
    if (!Number.isFinite(step.x) || !Number.isFinite(step.y) || step.x < 0 || step.y < 0) return null
    const target = pageElementFromPoint(step.x, step.y)
    const action = target?.closest?.('button, [role="button"], [role="menuitem"], [role="option"], [data-tid]') || target
    if (!action || !isVisible(action) || isExtensionElement(action)) return null
    // 当 Teams 未给弹层加 role 时仍允许坐标后备，但必须同时命中录制的
    // 控件特征或文字，不能把同一坐标上的其他按钮误当成“删除”。
    if (!matchesRecordedControl(action, step) &&
      (!step.label || getOwnVisibleText(action).toLocaleLowerCase() !== step.label.toLocaleLowerCase())) return null
    return action
  }

  async function waitForFixedPositionToSettle (macro, timeoutMs) {
    const startedAt = performance.now()
    while (running && performance.now() - startedAt < timeoutMs) {
      const point = macroPoint(macro, null)
      const target = pageElementFromPoint(point.x, point.y)
      const transientUi = [...document.querySelectorAll('[role="menu"], [role="dialog"], [aria-modal="true"], [role="listbox"]')]
        .filter(isVisible)
      if (target && transientUi.length === 0) {
        await delay(350)
        return true
      }
      await delay(100)
    }
    return false
  }

  function findRecordedAction (step) {
    const scope = findRecordedScope(step.scope)
    // 录制要求菜单/对话框时，弹层未出现就继续等待，不能查找页面其他按钮。
    if (step.scope && !scope) return null
    const candidates = [...(scope || document).querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [data-tid]')]
      .filter(isVisible)
      .filter(element => !isExtensionElement(element))
      .filter(element => matchesRecordedControl(element, step))
      .sort((a, b) => scoreRecordedControl(b, step) - scoreRecordedControl(a, step))
    if (candidates[0]) return candidates[0]

    // Teams 可能在小版本更新后改变 data-tid 或 aria 标签。仍限制在录制时
    // 的弹层内按按钮文字找，确保是“当前菜单的删除”，不是页面其他同名按钮。
    const textMatch = findExactAction(step.label, scope || document)
    if (textMatch) return textMatch

    // 旧录制没有控件特征时，仍保留坐标兼容；只接受可交互的祖先节点。
    if (!step.control) {
      const coordinateTarget = pageElementFromPoint(step.x, step.y)
      const interactive = coordinateTarget?.closest?.('button, [role="button"], [role="menuitem"], [role="option"], [data-tid]')
      if (interactive && isVisible(interactive) && !isExtensionElement(interactive)) return interactive
    }
    return null
  }

  function findRecordedScope (scope) {
    if (!scope) return null
    const scopes = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')]
      .filter(isVisible)
      .filter(element => scope.role ? element.getAttribute('role') === scope.role || (scope.modal && element.getAttribute('aria-modal') === 'true') : true)
    return scopes.sort((a, b) => scopeSimilarity(b, scope) - scopeSimilarity(a, scope))[0] || null
  }

  function scopeSimilarity (element, scope) {
    const text = getAccessibleText(element).toLocaleLowerCase()
    let score = 0
    if (scope.label && text.includes(scope.label.toLocaleLowerCase())) score += 30
    if (scope.role && element.getAttribute('role') === scope.role) score += 10
    if (scope.modal && element.getAttribute('aria-modal') === 'true') score += 10
    return score
  }

  function matchesRecordedControl (element, step) {
    const control = step.control
    if (!control) return step.label && getOwnVisibleText(element).toLocaleLowerCase() === step.label.toLocaleLowerCase()
    if (control.tid && element.getAttribute('data-tid') === control.tid) return true
    if (control.aria && element.getAttribute('aria-label') === control.aria) return true
    if (control.label && getOwnVisibleText(element).toLocaleLowerCase() === control.label.toLocaleLowerCase()) return true
    return false
  }

  function scoreRecordedControl (element, step) {
    const control = step.control || {}
    let score = 0
    if (control.tid && element.getAttribute('data-tid') === control.tid) score += 100
    if (control.aria && element.getAttribute('aria-label') === control.aria) score += 80
    if (control.label && getOwnVisibleText(element).toLocaleLowerCase() === control.label.toLocaleLowerCase()) score += 40
    const rect = element.getBoundingClientRect()
    if (Number.isFinite(step.relativeX) && Number.isFinite(step.relativeY)) {
      const dx = (rect.left + rect.width * step.relativeX) - (rect.left + rect.width / 2)
      const dy = (rect.top + rect.height * step.relativeY) - (rect.top + rect.height / 2)
      score -= Math.hypot(dx, dy) / 100
    }
    return score
  }

  function replayPointForStep (element, step) {
    const rect = element.getBoundingClientRect()
    const relativeX = Number.isFinite(step.relativeX) ? step.relativeX : 0.5
    const relativeY = Number.isFinite(step.relativeY) ? step.relativeY : 0.5
    return {
      x: Math.round(rect.left + Math.max(0.08, Math.min(relativeX, 0.92)) * rect.width),
      y: Math.round(rect.top + Math.max(0.08, Math.min(relativeY, 0.92)) * rect.height)
    }
  }

  function replayPointForAction (element, step) {
    const recordedTarget = actionAtRecordedPoint(step)
    if (recordedTarget === element || recordedTarget?.contains?.(element) || element.contains?.(recordedTarget)) {
      return { x: step.x, y: step.y }
    }
    return replayPointForStep(element, step)
  }

  function findExactAction (label, root = document) {
    if (!label || !root || typeof root.querySelectorAll !== 'function') return null
    const wanted = label.toLocaleLowerCase()
    const matches = [...root.querySelectorAll('button, [role="button"], [role="menuitem"], [data-tid], div, span')]
      .filter(isVisible)
      .filter(element => getOwnVisibleText(element).toLocaleLowerCase() === wanted)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
    const match = matches[0]
    return match?.closest('button, [role="button"], [role="menuitem"], [data-tid*="menu"], [data-tid*="delete"], [data-tid*="remove"]') || match || null
  }

  function recordedMouseStep (event) {
    const control = recordedControlForEvent(event)
    const target = event.target instanceof Element ? event.target : null
    const element = interactiveControlFor(target) || target
    const rect = element?.getBoundingClientRect()
    const scopeElement = element?.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')
    let label = ''
    for (const node of event.composedPath()) {
      if (node instanceof Element) {
        const text = getOwnVisibleText(node)
        if (text && text.length <= 80) {
          label = text
          if (node.matches('button, [role="button"], [role="menuitem"]')) break
        }
      }
    }
    return {
      type: mouseActionType(event),
      button: event.button,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      label,
      control,
      scope: scopeElement ? {
        role: scopeElement.getAttribute('role') || '',
        modal: scopeElement.getAttribute('aria-modal') === 'true',
        label: getAccessibleText(scopeElement).slice(0, 160)
      } : null,
      relativeX: rect?.width ? (event.clientX - rect.left) / rect.width : 0.5,
      relativeY: rect?.height ? (event.clientY - rect.top) / rect.height : 0.5
    }
  }

  function recordedControlForEvent (event) {
    const target = event.target instanceof Element ? event.target : null
    const control = interactiveControlFor(target) || target
    return control ? {
      tid: control.getAttribute('data-tid') || '',
      aria: control.getAttribute('aria-label') || '',
      label: getOwnVisibleText(control).slice(0, 120)
    } : null
  }

  function normalizeRecordedStep (step) {
    if (typeof step === 'string') return { label: step, x: -1, y: -1, delayMs: 300 }
    return { ...step, type: step.type || (step.button === 2 ? 'contextmenu' : 'click'), delayMs: recordedDelay(step.delayMs) }
  }

  function recordedDelay (value) {
    // 回放完整保留录制间隔；不再把长时间操作截断为固定上限。
    return Math.max(0, Number.isFinite(value) ? Math.round(value) : 300)
  }

  function getVisibleFailureDialog () {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(isVisible)
      .find(dialog => /无法删除|無法刪除|不能删除|不能刪除|cannot delete|can't delete|try again|稍后再试|稍後再試/i.test(getAccessibleText(dialog))) || null
  }

  async function waitForFailureDialog (timeoutMs) {
    const attempts = Math.ceil(timeoutMs / 100)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!running) return null
      const dialog = getVisibleFailureDialog()
      if (dialog) return dialog
      await delay(100)
    }
    return null
  }

  function closeFailureDialog (dialog) {
    const okay = ['确定', '確定', 'ok'].map(label => findExactAction(label, dialog)).find(Boolean)
    if (okay && dialog.contains(okay)) {
      const rect = okay.getBoundingClientRect()
      dispatchLeftClick(okay, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    }
    else {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    }
  }

  function getChatItems () {
    const items = new Map()
    const candidates = document.querySelectorAll('[id*="chat-list-item_"], [data-tid*="chat-list-item"]')
    for (const candidate of candidates) {
      const element = chatRowFor(candidate) || candidate
      if (!isVisible(element) || isOwnAccountItem(element)) continue
      const raw = [element.id, element.getAttribute('data-tid'), candidate.id, candidate.getAttribute('data-tid')].filter(Boolean).join(' ')
      let id = raw.match(/(?:title-)?chat-list-item_([^\s"'<>]+)/)?.[1] || stableElementId(element)
      try { id = decodeURIComponent(id) } catch (_) {}
      if (id && !items.has(id)) items.set(id, { id, element })
    }
    return [...items.values()].sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top)
  }

  function chatRowFor (element) {
    if (!(element instanceof Element)) return null
    const row = element.closest('[role="treeitem"], [role="listitem"], .fui-TreeItem, [data-tid="chat-list-item"], [data-tid="chat-list-item-container"]')
    if (row) return row
    // A title span or ellipsis button is not the row. Look for their smallest
    // shared container, never use a whole tree/list as one chat item.
    let current = element.closest('[data-tid*="chat-list-item"]') || element
    for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
      if (current.matches('[role="tree"], [role="list"]')) break
      if (current.querySelector('[id*="title-chat-list-item_"]') && current.querySelector('button, [role="button"]')) return current
    }
    return null
  }

  function stableElementId (element) {
    return [element.id, element.getAttribute('data-tid'), element.getAttribute('aria-label'), getAccessibleText(element).slice(0, 200)].filter(Boolean).join('|')
  }

  function isOwnAccountItem (element) {
    const label = getAccessibleText(element)
    return /[（(](?:您|你|you)[)）]/i.test(label) || /\bmy account\b|我的帳號|我的账号|你的個人資料|你的个人资料/i.test(label)
  }

  function isExtensionEvent (event) {
    return event.composedPath().includes(ui?.host)
  }

  function isExtensionElement (element) {
    return element === ui?.host || ui?.host?.contains(element)
  }

  function getOwnVisibleText (element) {
    return (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
  }

  function getAccessibleText (element) {
    return [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-tid'), element.innerText, element.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  function isVisible (element) {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  }

  function scrollChatLists () {
    let moved = false
    for (const element of document.querySelectorAll('[data-tid*="chat-list"], [role="tree"], .fui-Tree')) {
      if (!isVisible(element) || element.scrollHeight <= element.clientHeight + 8) continue
      const before = element.scrollTop
      element.scrollTop = Math.min(before + element.clientHeight * 0.8, element.scrollHeight - element.clientHeight)
      if (element.scrollTop > before + 1) moved = true
    }
    return moved
  }

  function setStatus (message) {
    if (!ui) return
    ui.status.textContent = message
    ui.status.title = message
    history.push(`${new Date().toLocaleTimeString()} ${message}`)
    if (history.length > 80) history.shift()
    ui.log.textContent = history.join('\n')
  }

  function shortText (text) { return text.length > 34 ? `${text.slice(0, 31)}…` : text }
  function delay (ms) { return Core.sleep(ms, activeController?.signal) }
  // requestAnimationFrame can suspend indefinitely in a background tab.
  function nextPaint () { return delay(40) }
  let lastMacroDiagnostic = null
  let networkDiagnostic = null

  function pageElementFromPoint (x, y) {
    const previous = ui?.host?.style.pointerEvents || ''
    if (ui) ui.host.style.pointerEvents = 'none'
    try { return document.elementFromPoint(x, y) } finally { if (ui) ui.host.style.pointerEvents = previous }
  }

  function hoverControlAvailable (element) {
    if (!(element instanceof Element) || !element.matches('button, [role="button"]') || element.disabled || element.getAttribute('aria-disabled') === 'true') return false
    const rect = element.getBoundingClientRect()
    return getComputedStyle(element).display !== 'none' && rect.width > 0 && rect.height > 0
  }

  function replayPointForTrigger (target, macro, row) {
    const point = macroPoint(macro, row)
    const rect = target.getBoundingClientRect()
    if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return point
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  function macroFailure (stage, reason, step, row) {
    const point = stage === 'trigger' ? macroPoint(activeMacro, row) : { x: step.x, y: step.y }
    const hit = pageElementFromPoint(point.x, point.y)
    const known = new Set(['删除', '刪除', '删除聊天', '刪除聊天', 'delete', 'delete chat', '确定', '確定', 'ok', '更多', '更多选项', '更多選項', 'more options', '取消', 'cancel', 'remove', '移除'])
    const label = String(step.control?.label || step.label || '').toLowerCase()
    lastMacroDiagnostic = { stage, reason, point, expectedLabel: known.has(label) ? label : '{label}',
      hitTag: ['BUTTON', 'DIV', 'SPAN', 'LI', 'UL', 'SVG', 'PATH', 'INPUT', 'A'].includes(hit?.tagName?.toUpperCase()) ? hit.tagName.toUpperCase() : hit ? '{tag}' : null,
      hitRole: diagnosticRole(hit),
      rowRole: diagnosticRole(row), rowConnected: Boolean(row?.isConnected),
      visibleMenus: [...document.querySelectorAll('[role="menu"], [role="dialog"], [aria-modal="true"]')].filter(isVisible).length }
    return { outcome: 'failure', fatal: true, reason }
  }

  function diagnosticRole (element) {
    const role = element?.getAttribute?.('role')
    return !role ? null : ['button', 'menuitem', 'row', 'listitem', 'treeitem', 'menu', 'dialog', 'alertdialog', 'option', 'listbox', 'tree'].includes(role) ? role : '{role}'
  }

  function networkCommand (action, data = {}) {
    if (!chrome.runtime?.sendMessage) return Promise.reject(new Error('浏览器网络诊断不可用；请确认新版扩展已完整加载'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('浏览器接口桥接超时，请重新加载扩展后刷新页面'); error.notSent = action === 'prepare-delete'; reject(error) }, 8000)
      chrome.runtime.sendMessage({ channel: 'teams-clean-network-v603', action, ...data }, response => {
        clearTimeout(timer)
        const error = chrome.runtime.lastError?.message || response?.error
        if (error) { const failure = new Error(error); failure.pending = Boolean(response?.pending); failure.notSent = Boolean(response?.notSent || action === 'prepare-delete'); reject(failure) }
        else { if (['begin', 'end', 'report'].includes(action)) networkDiagnostic = response?.data || null; resolve(response?.data) }
      })
    })
  }

  async function exportDiagnostics () {
    if (busy || recorder || apiCalibration) return
    const page = await apiCommand('status').catch(() => ({ unavailable: true }))
    const network = await networkCommand('report').catch(() => ({ unavailable: true, note: '请完成一次接口校准后再导出网络诊断' }))
    const macro = activeMacro || pausedMacro
    const data = { version: '6.0.5', kind: ui.mode.value, mode: ui.engine.value,
      viewport: viewport(), recording: macro && macro.engine !== 'api' ? { kind: macro.kind, rowSchema: macro.rowSchema || null, triggerType: macro.trigger.type, stepCount: macro.actions.length, viewport: macro.viewport } : null,
      transport: apiTransport, calibrationIssue, lastNetworkResult, macroFailure: lastMacroDiagnostic, page: { hooks: page.hooks || null, observation: page.observation || null, diagnostic: page.diagnostic || null }, network }
    const text = JSON.stringify(data, null, 2)
    ui.diagnostics.value = text
    ui.diagnostics.hidden = false
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable')
      await navigator.clipboard.writeText(text)
      setStatus('脱敏诊断已复制；请把这段文字发给我，不需要原始网络日志')
    } catch (_) {
      ui.diagnostics.focus?.()
      ui.diagnostics.select?.()
      setStatus('脱敏诊断已显示并选中，请复制下方文本发给我')
    }
  }

  init()
})()
