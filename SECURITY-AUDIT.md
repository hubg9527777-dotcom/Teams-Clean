# Teams Clean 安全审核与修复报告

审核日期：2026-11-17。审核基线：本会话工作目录中的 **6.3.0**，修复交付版本：**6.3.1**。

本次以工作树实际文件为准，保留之前已有的未提交修改；没有把整个 Git diff 都归为本次安全修复。基线 Git HEAD 为 `4f21abb`，基线文件 SHA-256 清单另行保留。未修改 `/Users/lee2/Documents/Teams-Clean` 原目录，没有提交或推送 Git，也没有操作真实 Teams 账号中的记录。

## 1. 项目概况与审核边界

| 项目 | 结果 |
| --- | --- |
| 产品类型 | Chrome / Edge Manifest V3 扩展，服务于个人 Teams 网页版 |
| 语言 / 框架 | 原生 JavaScript；隔离内容脚本、Service Worker、DOM 操作，无 UI 框架 |
| 运行代码 | `core.js`、`dom-engine.js`、`api-policy.js`、`inject.js`、`network-api.js`、`network-observer.js` |
| 包管理器 / 依赖清单 | 没有 package.json、各类包锁、requirements、go.mod、Cargo.toml、pom.xml、Podfile；不人为生成空依赖清单 |
| 应用第三方直接 / 间接依赖 | 0 / 0；Node 测试使用内置模块与本项目模块 |
| CI 直接 Action | 3 个；原来只记录浮动大版本，没有历史运行时解析出的精确版本 |
| 本地验证环境 | Node.js 26.4.0，macOS；CI 配置仍测试 Node 22 最新补丁分支 |
| 系统构建工具 | Apple 修订的 Info-ZIP Zip 3.0、UnZip 6.00；只创建本项目白名单 ZIP 或列出自建测试包，不解压外来归档 |
| 基线文件 / 历史 | 基线工作树 26 个文件；当前可达 Git 历史 3 个提交、21 个不同 blob；额外检查本仓库 Git config |
| 验证结果 | 100 项测试通过；JS 语法、工作流 YAML、实际 ZIP 构建和归档完整性检查通过 |

逐文件覆盖生产代码、manifest、发布配置、测试与测试夹具、文档、忽略规则、既有扫描 JSON 和原始二进制字符串。新增的构建/扫描脚本及测试也已审查。`security-regression.jpg` 与旧 `security-scan.json` 属于旧版本证据，不能作为本版验收结论。

不在本次范围：其他相邻项目、只读 sources、微软服务端实现、微软组织/租户策略、浏览器本体的全部 CVE、远端不可达或已删除的 Git 对象。二进制扫描没有 OCR，不能保证发现图片像素中的文字。真实浏览器安装、真实 Teams 删除验收、GitHub 云端发布未执行；本轮不声称完成了渗透测试或获得任何安全认证。

## 2. 依赖清单与漏洞核查

### 2.1 全部 CI 直接依赖

已逐个检索官方仓库、发布记录、GitHub Advisory Database / OSV 相关结果。涉及大版本升级时已先询问，用户选择“升级并固定 SHA”。以下 SHA 来自各官方仓库对应发布的提交链接，不使用镜像提交替代。

| 依赖 | 基线引用 | 修复后实际固定版本 / 提交 | 核查结果 |
| --- | --- | --- | --- |
| actions/checkout | `@v4` | v7.0.1 · `3d3c42e5aac5ba805825da76410c181273ba90b1` | 使用官方固定提交，禁用凭据持久化；未确认此项目存在可归属的直接包 CVE |
| actions/setup-node | `@v4` | v7.1.0 · `949feb2413d6458794dcd2491c4babbbce0c15c1` | 官方发布包含 brace-expansion 安全更新；关闭本项目不需要的包管理器缓存 |
| softprops/action-gh-release | `@v2` | v3.0.4 · `8a0cd651e5b2365bd640854a3fa5dfc70e4875f3` | 官方声明 v2.6.2 是 v2 最后版本且停止支持；经确认迁移至 Node 24 Action 系列 |

没有发现上述包名称为仿冒包的证据。checkout / setup-node 仍维护，不能仅因基线引用 v4 就把整个项目标为停止维护。action-gh-release 的 **v2 系列**停止支持有官方明示，不等于 v3 项目停止维护。

### 2.2 已核实的 High 级上游公告

`brace-expansion`：**GHSA-3jxr-9vmj-r5cp / CVE-2026-13149**，GitHub Reviewed 标为 High，影响连续非扩展花括号模式的展开时间，可能造成拒绝服务。

| 公告影响范围 | 公告修复版本 |
| --- | --- |
| `< 1.1.16` | 1.1.16 |
| `>= 2.0.0, < 2.1.2` | 2.1.2 |
| `>= 3.0.0, < 5.0.7` | 5.0.7 |

官方 setup-node issue #1596 明确提到上游 **v7.0.0** 的锁中存在 1.1.13、2.1.1；这不是本项目原来浮动 `@v4` 的已证实实际版本，不能混为一谈。v7.1.0 的官方发布说明包含将 brace-expansion override 更新至 5.0.8 的修复，但本轮没能完整取回该 Action 的锁文件与 dist bundle，故不把发布说明里的 override 当作所有打包实例的逐项实测版本。

**实际可利用性：待确认。** 项目自身不引入 brace-expansion，不接受外部 glob 作为业务输入；工作流 Node 版本是固定字符串，修复后显式关闭包管理器缓存。未找到可把不可信括号模式传入受影响功能的完整路径，这是基于本项目配置的推断，不是对上游全部代码的不可达证明。已选择带官方修复记录的 setup-node v7.1.0，并固定提交；仍需在可联网 CI 中补做完整传递依赖 / bundle 扫描。

### 2.3 工具交叉核对与限制

- 本地有 npm，但本项目没有 npm 依赖清单或锁，`npm audit` 不适用；没有为了运行命令而制造空包文件。
- 本地未提供 gitleaks、trufflehog、Semgrep、OSV Scanner、pip-audit、govulncheck、actionlint。Cargo 虽存在，但项目不是 Rust，不能据此运行无意义的 cargo audit。
- GitHub 上游锁文件、部分安全公告列表和原始文件访问受环境限制；本地直接联网解析也失败。**没有获得完整机器可验证的 CI 传递依赖清单，不能宣称全部上游依赖“零漏洞”。**
- 本地没有第三方包锁，所以“本地锁中的关键间接依赖实际版本”为空。远端 Action 传递依赖的实际全量版本标记为待确认，以上只列已核实的公告和官方版本信息。
- 系统 zip/unzip 为 Apple 修订版，不能仅凭上游版本号推断 Apple 是否已修补某个 CVE。本项目不处理外来 ZIP 解压；构建输入与归档条目另有白名单验证。系统安全补丁由操作系统维护。

## 3. 问题汇总

位置以修复后的文件为主；必要时列出 6.3.0 基线行号。严重性是本项目场景评级，并不自动沿用上游 CVSS。A08 属于安全边界加固，未证明当前浏览器条件下外部可达。共处理 **9 项问题或加固项：High 1、Medium 6、Low 2；未确认 Critical 问题。**

| 编号 | 类别 | 严重级别 | 位置 | 状态 |
| --- | --- | --- | --- | --- |
| A01 | 代码 / CI 标签注入 | High | 基线 `.github/workflows/release.yml:28`；现 `scripts/package.cjs:8` | 已修复 |
| A02 | 代码 / CI 权限和凭据暴露面 | Medium | `.github/workflows/release.yml:8`、`:37` | 已修复 |
| A03 | 依赖 / 浮动 Action 与停止支持系列 | Medium | `.github/workflows/release.yml:18`、`:23`、`:61` | 已修复；大版本升级已获确认 |
| A04 | 代码 / 本地认证模板绕过空闲期限 | Medium | `inject.js:599`、`inject.js:619` | 已修复 |
| A05 | 代码 / 记录行复用导致目标校验与点击分离 | Medium | `inject.js:309`、`inject.js:444` | 已修复 |
| A06 | 代码 / 面板内部 DOM 可被宿主直接改动 | Medium | `inject.js:28` | 已修复直接开放访问；宿主 UI 风险仍需关注 |
| A07 | 代码 / 32 位去重摘要碰撞 | Low | `dom-engine.js:15`；`inject.js:100` | 已修复 |
| A08 | 代码 / 消息来源协议与 tabId 加固 | Low | `network-observer.js:16` | 已修复（防御加固） |
| A09 | 代码 / 打包跟随符号链接及旧归档残留 | Medium | 基线发布脚本；现 `scripts/package.cjs:13`、`:19` | 已修复 |
| D01 | 依赖 / brace-expansion 上游 High 公告 | High（上游） | 远端 CI Action 内置依赖，不属于应用运行依赖 | 建议关注；原引用实际版本与可利用性待确认，已选含官方修复记录的版本 |
| K01 | 密钥 / 扫描核查 | Low（核查项，非已发现漏洞） | 工作树、Git config、21 个历史 blob、构建归档 | 未发现真实凭据；测试假值已识别 |

## 4. 已修复问题的利用条件、改动与验证

### A01：标签名直接进入 Shell

原发布脚本把 `${{ github.ref_name }}` 直接拼入 `run`。例如 `v$(id)` 符合允许的标签前缀，Shell 会把它解析为命令替换。利用需要能触发标签发布流程，不是匿名网络攻击；在分支保护与标签权限分离的仓库中尤其需要关注，可能导致 runner 命令执行或发布产物被改动。

修复：标签通过 `env` 传入 Node，只接受与 manifest 完全一致的 `v版本号`；调用 zip 使用 `spawnSync` 参数数组和 `shell:false`，不拼接输入为脚本。回归测试覆盖命令替换、反引号、分隔符、路径、换行和版本不一致的拒绝。

### A02：测试过程持有发布写权限，checkout 默认持久化令牌

基线在整个 workflow 赋予 `contents:write`，测试和打包也在该权限范围内；checkout 未关闭凭据持久化。若运行脚本或依赖被控制，影响范围可扩大到仓库写入与令牌使用。

修复：默认 `contents:read`，测试在 verify job，只有依赖 verify 成功的 publish job 获得写权限；两个 checkout 均显式使用同一 `github.sha` 且 `persist-credentials:false`，避免标签移动产生验证/发布目标差异。添加超时，关闭无用缓存。YAML 解析与结构测试通过；未实际触发 GitHub 发布。

### A03：浮动引用和停止支持的发布 Action

基线 `@v4` / `@v2` 可随上游标签移动，运行的代码不具备本地记录的固定身份。发布 Action v2 停止维护另有官方证据。风险条件是上游引用变化、账号或发布链被控制，或旧系列后续不再获得修复。

修复：先取得用户的大版本升级决定，再选择官方 checkout v7.0.1、setup-node v7.1.0、action-gh-release v3.0.4 的完整提交 SHA；未使用臆造版本。配置只用原来已有的 3 个 Action，没有引入新的第三方 Action。精确 SHA 的静态回归检查通过。全量内部依赖扫描仍按 D01 保留待确认。

### A04：内存中的模板副本绕过后台过期检查

后台 Capture 有空闲期限，但内容脚本拿到模板副本后可直接 fetch，基线发送前没有检查该副本是否过期。利用/触发条件是页面持续打开、校准成功后长时间闲置，再发起清理；实际会使用超过预期时限的授权材料。

修复：发送前验证 deadline；过期清空本地模板、禁用就绪状态并报告“未发送”。增加到期清除计时器，仅成功使用才延长保留时间；401 同样清除。浏览器后台计时可能节流，因此计时器只是补充，发送前时间检查才是硬限制。新增测试确认过期后没有新增删除请求。

### A05：等待和鼠标事件之间发生虚拟行复用

基线仅在步骤早期核对记录，之后经过滚动、等待、悬停和多段鼠标事件，原 Element 可能已代表另一条记录。无需恶意代码也可能由虚拟列表更新触发；若宿主 DOM 被控制，风险更明显。可能点到错误目标，破坏“未知项不重发”等保护。

修复：每次点击前验证同一个 Element 仍连接、可见、位于原列表，并保持原记录身份和内容签名；悬停后及鼠标事件阶段重复校验。控件因正常事件处理移出 DOM 后，不再向已移除控件补发剩余事件。回归测试覆盖 mouseover 与 pointerdown 时被复用的情况，确认后续 click 未发生。

### A06：open Shadow DOM 暴露内部控件

宿主页面脚本可以通过 `host.shadowRoot` 读取内部日志或改动 mode、engine 等控件；下一次真实用户点击可能依据被改动的状态执行。前提是宿主脚本能运行；没有发现普通聊天文字能直接造成 XSS 的证据，也没有证据说明旧面板暴露了 API 令牌。

修复：改为 closed Shadow DOM，扩展通过隔离世界内保留的引用操作控件。原有 `isTrusted` 入口限制保留，模型回归确认 `host.shadowRoot === null`。**closed 不构成完整安全沙箱**，网页仍可移除或遮挡宿主节点；彻底隔离需要独立扩展页面/侧栏，见后续选项。

### A07：FNV-1a 32 位标识用于去重与续跑比较

不同显示文本可以产生相同摘要；已知 `costarring` / `liquid` 是本实现的碰撞样例。当前同屏重复检测通常会保守停止，但跨扫描可能造成误隔离、跳过或续跑判断错误；这是可用性/完整性风险，不是“加密被破解”。

修复：记录和签名使用精确字符串作为文档内 Map 键，再映射到浏览器原生 `crypto.randomUUID()` 的不透明标识；不把姓名作为导出诊断 ID。映射设数量上限。续跑宏直接比较完整序列化内容，移除短摘要比较。已知碰撞回归验证两条身份不同，同一输入身份稳定。

### A08：来源 URL 仅比较 origin

相同 origin 不等于一定是 HTTPS URL；例如 blob URL 也可能拥有同一 origin。基线也只检查 tabId 为整数。当前 manifest 没有开启 blob 来源回退，未证明这能被外部页面实际利用，不把它报告为已证实越权。

加固：额外要求 HTTPS、无 URL 用户凭据、tabId 非负；继续检查扩展 ID、顶层 frame、documentId 和精确 Teams origin。增加 blob URL、负 tabId 等拒绝用例。没有扩大权限。

### A09：固定文件名不等于文件内容来源受限

基线 zip 命令可能跟随被提交为符号链接的文件，例如把白名单内 README 指向仓库之外的本地文件；重复更新已有 ZIP 还可能保留不再需要的旧条目。前提是源码或构建目录可被改动，可能导致构建产物带入机密内容。

修复：所有输入必须为项目根目录中的普通文件，拒绝符号链接；输出目录与既有归档也检查类型，每次删除旧归档后重新创建。JSON 格式错误使用固定错误说明，不回显 manifest 原文。白名单仅含 11 个运行/说明文件，不包含测试、扫描输出、密钥、Git 元数据或旧截图。测试实际构建并列出条目、验证外部符号链接被拒绝；另作 CRC 和 manifest 脚本完整性核验。

## 5. 密钥、凭据与本地隐私

工作树、可达 Git blob 与本仓库 Git config 中，未发现可信的硬编码 API key、真实 JWT、GitHub/AWS/OpenAI 凭据、私钥块、带密码的连接串或私人 webhook。扫描有 4 条命中，分别是同一测试行中两个假值在工作树和历史中的重复；已人工核对为测试夹具，没有把命中原文写入扫描 JSON。

`.env` / `.env.local` / `.env.production`、私钥扩展名和 HAR 已被忽略；没有发现这些敏感路径被 Git 跟踪。`.env.example` 可被跟踪，但项目没有真实环境凭据配置，因此没有添加无用途的空模板，也没有要求轮换未发现的密钥。如后续确认真实密钥曾提交或泄露，应在平台作废并重新生成，删除代码不能撤销旧密钥。

校准认证仅保留在扩展内存，不写 Chrome storage、诊断 JSON 或日志；请求头采用白名单，Cookie 不复制。录制宏则包含按钮文字、aria 标签、弹窗摘要和定位信息，可能带有联系人姓名，存于 `chrome.storage.local`。这是现有录制功能的隐私成本，不是加密存储；本次没有擅自删除录制或改变保留策略。

诊断使用 textContent / textarea 展示，未发现将页面文字送入 innerHTML、eval、Function 或动态远程脚本的生产路径。内存日志可能包含目标名称，已减少页面直接访问面板的机会，仍应谨慎共享完整运行截图。

## 6. 逐文件与攻击面复核

| 文件 / 区域 | 复核内容与结论 |
| --- | --- |
| manifest.json | 仅 storage、webRequest；host_permissions 和注入范围限定 Teams HTTPS 单站点；无 MAIN、外部可连接入口或公开资源；版本升至 6.3.1 |
| api-policy.js | 精确请求来源、路径、方法、ID 与会话类型验证；禁止重定向；头白名单；响应大小限制和保守业务结果判定；没有新增修改 |
| network-api.js | tab/document 归属、单条手动校准、认证头保留在内存、单请求租约及有效期；未发现对任意 endpoint 的代理执行入口 |
| network-observer.js | 来源校验和消息动作白名单，串行状态修改；只观察限定 URL；脱敏元数据进入 session storage；补充 A08 |
| core.js | 格式与数量校验、可取消等待、有限重试、未知结果隔离及扫描上限；无网络或凭据处理；本次没有改业务队列 |
| dom-engine.js | DOM 选择器属性转义、单列表锚定、叶子记录、按钮语义限制；修复短摘要碰撞；仍依赖 Teams 页面结构 |
| inject.js | 可信用户入口、隔离 fetch、内存认证与诊断输出、录制点击；修复 A04/A05/A06，保持删除/隐藏区分 |
| scripts/package.cjs | 新增，无第三方包；版本/路径/输入类型校验，shell:false，固定文件清单 |
| scripts/security-scan.cjs | 新增，只读扫描，不输出凭据值；受控 git 子进程参数数组；明确启发式覆盖限制 |
| 所有 tests/*.cjs | 检查内置模块与夹具；vm 只运行本仓库源码用于测试，不是生产动态执行入口；新增安全负例 |
| browser-fixture.html | 只有假数据和本地脚本，内联测试脚本不被扩展生产包加载；未冒充真实 Teams 验收 |
| 发布 YAML | 无 pull_request_target；固定 Action SHA、相同发布提交、只读验证与隔离发布权限；解析通过 |
| README / CHANGELOG / LICENSE / 生成输出 | 更新使用、兼容性、验证限制和每项变更；MIT 许可证保留；旧审核输出不作为新证据 |
| PNG / JPG | 原始字节字符串纳入扫描，非 OCR；生产 ZIP 仅含 icon.png，不含旧截图 |

SQL/NoSQL、服务端模板、上传服务、反序列化执行、数据库鉴权、桌面 IPC、nodeIntegration/WebView 和 CORS 服务配置在本项目不存在，不能强行套用为已发现漏洞。SSRF/开放重定向的关键边界是请求模板的固定 HTTPS origin 和 `redirect:error`，已有对应负例。没有关闭 TLS、硬编码 IV/盐或自行实现密码学算法的生产代码；原 FNV 仅作标识，已移除。

## 7. 验证记录与具体文件变更

| 验证 | 结果 / 边界 |
| --- | --- |
| `node --test tests/*.test.cjs` | 100/100 通过，较基线增加 8 个安全用例；扩展协议负例也扩充 |
| `node --check` | 生产脚本、Node 脚本和测试脚本语法验证通过 |
| 工作流 YAML | Ruby 标准 YAML 解析通过，并核对默认权限与 publish 的依赖关系；不是 GitHub 云端执行结果 |
| `GITHUB_REF_NAME=v6.3.1 node scripts/package.cjs` | 实际构建成功；固定 11 个条目；CRC 与声明脚本存在性检查通过 |
| 密钥扫描 | 当前工作文件、Git config、21 个历史 blob；没有待人工核对的真实凭据候选；产物另作检查 |
| `git diff --check` | 通过；原有修改保留 |
| 真实账号 / 发布 | 未执行真实删除、浏览器安装验收或云端发布；没有推送代码或发布新版本 |

业务代码改动集中在 inject.js、dom-engine.js、network-observer.js；core.js、api-policy.js、network-api.js 的已有逻辑保留。发布配置、manifest 版本、忽略规则及上述新脚本配套修改；tests/dom-harness.cjs 模拟 closed Shadow DOM 与原生随机标识，network-ui / security 测试补充过期及来源负例，hardening.test.cjs 新增打包与点击时序用例。README、CHANGELOG 和本报告说明原因；test-results 与扫描 JSON 是本轮生成证据。

## 8. 开发者决定、剩余风险与后续建议

大版本升级已经按用户选择执行，没有未获确认的大版本或功能删改。本次未发现需要实际轮换的密钥。以下是建议关注的后续选项，本轮未擅自改变产品行为：

| 后续事项 | 可选方案 | 建议与理由 |
| --- | --- | --- |
| UI 信任隔离 | 保留当前注入面板；或迁移为独立扩展页面 / 侧栏 | 本版保留流程；若要抵御宿主页面完全受控，应评估独立 UI，涉及界面、兼容性和权限取舍 |
| 录制隐私保留 | 持久保留；加手动清除；或会话到期自动清除 | 建议后续加入可见的清除入口；自动删除会影响免重复录制体验，应先确定策略 |
| SPA 账号切换 | 用户切换后重新校准；或识别真实账号变化后自动失效 | 本版先要求切换后重新校准；可靠自动账号绑定需要真实 Teams 页面证据，当前标为待确认 |
| CI 完整 SCA | 获取固定 SHA 的全部锁文件与 bundle；再运行专业扫描器 | 优先补齐 D01 证据，避免把发布说明误当成全量依赖审计 |
| GitHub 发布 | 先在测试仓库/草稿发布验证新 Action 与产物 | 本地构建通过不能替代云端权限、runner 和新大版本集成验收 |
| Teams 实测 | 用可删除的测试账号验证联系人、活动和聊天各一轮 | 模型测试能检验控制逻辑，不能保证 Teams 最新页面结构、脚本事件与同步行为 |

私有接口会变化，微软仍可拒绝删除；UI 中移除、隐藏、对方副本与服务端留存并不等价。自动化无法防止同步源或新消息让条目重新出现。不能承诺“永不受更新影响”或“全部记录物理销毁”。

## 9. 主要证据来源

以下均为官方项目或官方文档；查询时间为审核日。搜索结果不足、原始文件不可达之处已标为待确认，未用第三方镜像推断已安装版本。

1. [GitHub：脚本注入](https://docs.github.com/en/actions/concepts/security/script-injections)
2. [GitHub：安全使用与完整 SHA 固定](https://docs.github.com/en/actions/reference/security/secure-use)
3. [checkout 官方 v7.0.1 提交](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)
4. [setup-node 官方 v7.1.0 提交](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1)
5. [action-gh-release 官方 v3.0.4 提交](https://github.com/softprops/action-gh-release/commit/8a0cd651e5b2365bd640854a3fa5dfc70e4875f3)
6. [发布 Action 的 v2 停止支持说明](https://github.com/softprops/action-gh-release/blob/master/README.md)
7. [GitHub Reviewed：GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)
8. [setup-node 上游 issue #1596](https://github.com/actions/setup-node/issues/1596) 与 [修复 PR #1599](https://github.com/actions/setup-node/pull/1599)
9. [setup-node 官方发布记录](https://github.com/actions/setup-node/releases)
10. [Chrome：内容脚本与隔离世界](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
11. [Chrome：扩展存储](https://developer.chrome.com/docs/extensions/reference/api/storage)

报告结论：已完成可取得源码和本地证据范围内的审核与安全修复；未确认 Critical 问题，标签注入 High 问题已修复。**远端 Action 完整传递依赖扫描、真实 Teams 验收和 GitHub 云端发布仍待完成，本报告不等于“全链路零风险”。**
