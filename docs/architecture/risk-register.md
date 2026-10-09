# Pi TaskExec 风险登记表

状态：审查阶段风险；概率为定性判断，未通过运行时测试量化
日期：2026-10-08

> **历史与当前权威（2026-10-09 后）：** 本表 R5、R6、R11、R17 及部分正文中的 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/tsconfig.json`、`mcp/tests/*.test.mjs` 是阶段 2–8 的迁移过渡布局，已被 2026-10-09 根级目录决策（选型 A：根 `cli/`、`mcp/`、`skills/`、`tests/`、`docs/`、根 `dist/`；根配置；薄 `bin/pi-task-exec.mjs`；不使用 Workspaces）取代。这些条目仅作历史风险记录，不再作为当前执行指令；当前目录风险与验收以“2026-10-09 目录重构风险补充”（R31–R39）为准。

| ID | 风险 | 影响 | 当前状态/可能性 | 预防与验收 | 回滚/应对 |
|---|---|---|---|---|---|
| R1 | 新 npm 包 `@zguiyang/pi-task-exec` 已存在或被抢先注册 | 无法按指定名称发布 | **阶段 1 已查询**：`npm view` 返回 E404，当前无已发布包；E404 不构成预留或发布权利，未来仍可能被注册 | 发布前再次执行官方 npm 精确查询；若届时存在，停止并由 Supervisor 决策 | 不发布、不改用旧包名 |
| R2 | Registry ID `io.github.zguiyang/pi-task-exec` 已占用 | 无法按指定 ID 注册；名称不可被改写 | **阶段 1 已查询**：官方 Registry 精确搜索返回 HTTP 200、count 0，无匹配记录；`mcp-publisher validate` 通过；尚未实际发布 | 正式发布前再次官方精确查询；用户要求占用时停止，禁止回退旧 ID | 不发布；由 Supervisor 另行决策 |
| R3 | GitHub namespace 发布身份未认证或无权 | Registry publish 被拒绝 | **阶段 1 已确认身份**：`gh api user` 为 `zguiyang`，`gh repo view` 为 PUBLIC + ADMIN，`npm whoami` 为 `zhaoguiyang`，`npm org ls zguiyang` 为 owner；实际 Registry OAuth/OIDC 发布未尝试 | 实际发布时走 OIDC 工作流并确认 `id-token: write`；检查发布主体与仓库 | 修正身份/权限；不改 ID 绕过认证 |
| R4 | Skill 许可证不明确 | 可能无权随 npm 包再分发，产生版权风险 | **阶段 1 已解决**：JoeyZhao 确认为直接创作并持有版权，同意 MIT 再分发，无需单独 NOTICE；Skill frontmatter 已声明 `license: MIT` | 保持该授权与 frontmatter 一致；tarball 审查许可证 | 若授权或元数据变化则停止打包公开发布，保持文件不变 |
| R5 | 根 `package.json` 迁移破坏 TypeScript 输出路径 | npm bin 找不到入口，包不可运行 | 历史（过渡布局）；旧 tsconfig 使用相对其自身目录的 `src`/`dist` | 已被选型 A 取代：使用根 `tsconfig.json`（`rootDir: "."`、`outDir: "dist"`，输入根 `cli/`、`mcp/`），薄 `bin/pi-task-exec.mjs` 指向 `dist/cli/index.js`；见 R33 | 恢复脚本/配置；不发布候选包 |
| R6 | 根测试脚本使用错误相对路径 | 测试导入失败或 CI 假绿 | 历史（过渡布局）；旧测试导入 `../dist`，依赖 mcp 目录位置 | 已被选型 A 取代：根脚本先 build，再运行根 `tests/**/*.test.mjs`，测试通过 `../../dist/...` 导入；MCP smoke 从薄 `bin/` 启动；见 R37 | 修正脚本并重跑全矩阵 |
| R7 | 删除旧 CLI 时遗漏旧 bin/命令/文档引用 | 新包仍暴露旧名称或文档误导 | 高；旧字符串分散在 CLI、Host adapter、README、Skill、tests、dist | 构建前后对源码/文档/打包内容做旧名称 allowlist 扫描；只允许有明确历史语境的文档引用 | 发布前整组修正；发布后只能发新版本 |
| R8 | 旧包名或旧 Registry ID 残留到新 package/server metadata | Registry 验证失败或用户安装旧包 | 高；当前全部配置还是旧名 | 一致性脚本校验 package `name`、`mcpName`、server `name`、identifier、仓库链接 | 不发布；修复后重跑 schema 与 tarball 验收 |
| R9 | `task_*` 改名后 Skill/reference 与 MCP schema 不一致 | Agent 调用失败或错误理解工具能力 | 中高；现有 Skill 精确绑定 `pi_*`/v0.1.1 | 工具契约测试与 Skill 静态契约共用 manifest/schema；禁止保留旧 alias | 回退尚未发布的整组更改；发布后新版本同步修复 |
| R10 | 工具描述仍与 Delegation-First Skill 冲突 | 主 Agent 的委派选择不一致 | 已发现；现 MCP 描述保留“节省上下文/并行、trivial 留给 Supervisor”，Skill 允许所有已定义边界的原子任务 | CI 对统一策略短语/契约版本做静态检查；review MCP `instructions` 与工具 description | 合并前协调并修正描述；不靠 Skill 单方面覆盖 MCP 指引 |
| R11 | npm tarball 未携带完整 Skill | 用户安装 MCP 后找不到 `pi-delegate` | 高；过渡期 `files` 曾以 `mcp/dist/**` 与 `mcp/README.md` 为主 | 选型 A 下根 package `files` 必须包含根 `dist/**`、薄 `bin/`、`skills/pi-delegate/**`、必要根文档、LICENSE 和 `server.json`；tarball 测试断言 `SKILL.md` 和 references 存在 | 发布前修复 `files`；已发布包另发新版本 |
| R12 | Skill 安装器覆盖用户已有同名 Skill | 用户数据丢失 | 中高；已有同名目录可能由用户自行维护 | 相同内容幂等；不同内容默认拒绝；显式备份后替换；原子暂存；记录 manifest | 从备份恢复；检测到用户修改时停止，不覆盖 |
| R13 | MCP 配置安装器覆盖用户同名 Host 条目或丢失注释/其它配置 | Host 配置损坏或第三方配置丢失 | 高；当前旧 JSON/TOML 更新方式尚未覆盖跨平台冲突策略 | 解析后只编辑自有 key；同名不同内容默认停止；JSONC/TOML 保真；先备份；隔离 home 测试 | 原子恢复备份；若配置冲突不自动写 |
| R14 | Windows home/XDG/APPDATA 路径计算错误 | 写入错误位置或 Host 无法启动 MCP | 高；旧 CLI 以 `HOME` 为 home fallback，缺少 Windows 矩阵 | 用 `os.homedir()` 与 Host override；明确 `%USERPROFILE%`/`%APPDATA%`；Windows CI 端到端路径断言 | 不声明该组合支持，修复后发布；保留原配置 |
| R15 | macOS/Linux Host 路径忽略 Host 自身 XDG/配置变量 | 全局配置写入错误位置 | 中；不同 Host 采用不同默认值/override | 每个 Host 单独 adapter 和官方文档测试；优先显式环境覆盖，doctor 显示路径 | 取消写入，要求用户指定路径；不得猜测写入 |
| R16 | Zed 项目 MCP 配置未获信任时不启动 | 用户以为 MCP 安装失败或尝试重复安装 | 中；Zed 会对项目配置应用 trust/restricted mode | README 和 doctor 说明项目 trust；安装器不尝试替用户授信 | 用户在 Host UI 作信任选择；配置仍可回滚 |
| R17 | `dist/` 与源码不一致 | npm 发布旧 JS 或错误 source map | 中高；过渡期 `mcp/dist/` 存在但被忽略；选型 A 下由根 `dist/` 生成物取代 | 发布前从根 build/prepack 干净构建；CI 检查生成后 git 状态与入口；以 `prepack` 产物为准 | 删除临时生成物或重建；不手工修补发布 dist |
| R18 | Node 最低版本声明仍停留在 `>=20` | 支持已 EOL Node，安全维护和依赖兼容风险 | 已知：Node 20 于 2026-04-30 EOL | 人工确认基线；建议至少 Node 22；CI 覆盖最低与当前支持线 | 以新版本更新 engines；不得宣称未经验证的版本支持 |
| R19 | 缺少跨平台 CI | Windows/Mac/Linux 文件系统行为差异无法发现 | 已发现；无 GitHub Actions、无跨平台测试 | 增加 OS × Node 矩阵；配置和 skill 安装都用临时目录 | 发布阻断，直到关键矩阵通过 |
| R20 | `server.json` 与根 package 版本不一致 | Registry 校验失败或 Registry 指向不同包代码 | 中；当前 server/package 版本同为 0.1.1，但无自动检查 | CI 验证 package version、`server.json.version`、`packages[].version` 完全相同且精确 | 发布前修正；npm 已发版则停 Registry 发布并发新版本 |
| R21 | `mcpName` 未与 Registry server name 同步 | Registry npm ownership verification 失败 | 高；根包迁移会修改 package name，需同步 `mcpName` | CI 比较 `mcpName === server.json.name`；Registry validate | 不发布；修正 metadata |
| R22 | npm 包或 Registry ID 查重不可达时被误判为空闲 | 名称冲突、注册失败，或不合规地擅自换名 | **阶段 1 已获得官方结果**：npm `view` 返回 E404，Registry 精确搜索返回 HTTP 200、count 0；E404/count 0 仍不等于预留 | 将当前结果仅作为“当前无发布/无记录”证据；发布前再次官方查询并要求明确结果 | 不发布、不回退旧名；若届时结果变化则停止并人工核实 |
| R23 | 旧仓库退役时历史、tag、release、issue、PR 或关键提交信息备份不完整 | 无法追溯旧发布内容、讨论和来源 | 未来风险；旧仓库当前必须保留 | 最终阶段逐仓库导出 tags、releases、issues、PR、关键提交信息；逐项核对并验证备份可读 | 暂停删除；补齐并再次验证备份 |
| R24 | `.codex/config.toml` 的本机绝对路径混入新仓库 | 泄露本机目录、指向旧 checkout、Worker allowed root 错误 | **阶段 2 已移除**：已从本新仓库删除 `mcp/.codex/config.toml`（含旧 checkout 绝对路径、旧 cwd、旧 `PI_WORKER_ALLOWED_ROOTS`）；未创建根 `.codex/`；旧源仓库未修改 | 不纳入新 Git/包；根 `.codex` 无通用内容则不创建；CI 扫描旧 checkout 路径以防重新引入 | 在授权实施阶段从 Git 迁移范围排除；不修改旧源仓库 |
| R25 | MCP 工具改为 `task_*` 被误解为支持任意执行后端 | 产品承诺超过当前 Pi 实现 | 中 | 文档表明命名中立不等于多后端支持；backend 抽象列为未来决策 | 修正文档，不在本阶段扩张实现范围 |
| R26 | Node CLI 用 shell 拼接带空格/特殊字符的路径 | Windows/用户目录路径启动失败或命令注入面扩大 | 中 | Host config 用结构化 command/args；不经 shell 拼接；路径含空格测试 | 回滚写入配置；用安全 argv 生成修复 |
| R27 | Registry `packageArguments` 与实际 CLI 启动入口不一致 | Registry 安装器或 Host 启动时显示 help、参数报错或启动错误模式 | 中高；新入口尚未实现 | 唯一启动契约固定为 `pi-task-exec mcp serve`；验证 Registry positional args 为 `mcp`、`serve`；与 Host 配置共用测试期望 | 停止 Registry 发布；修正 metadata/CLI 并重跑 tarball smoke |
| R28 | CLI 无参数行为导致 Host 启动错误 | Host 省略参数或调用默认 bin 时可能退出、显示交互或意外启动服务 | 中；新 CLI 尚未实现 | 无参数必须只显示清晰帮助/错误，不启动 MCP；所有 Host/Registry 必须显式调用 `mcp serve`；加入无参数测试 | 修复 CLI 与 Host 配置；阻断发布直到 Host smoke 通过 |
| R29 | MCP 工具名只改了一部分 | MCP schema、Skill、references、测试与示例调用名称不一致，导致工具不可发现/不可调用 | 中高；改名涉及多个文件面 | 使用 `task_*` 单一契约清单；CI 检查源码、Skill、references、README、示例、测试和 Registry 描述；npm tarball 扫描旧名 | 发布前整组回退/修正；发布后通过新版本同步修复，不加旧 alias |
| R30 | 旧 GitHub 仓库或本地旧目录早于公开 npm/Registry/安装验收被删除 | 迁移失败时失去源码、发布记录、issues、PR 和恢复依据 | 高后果；目前要求旧项目保持不动 | 删除只允许在实施计划最终阶段；新仓库、npm、Registry、CLI、Skill、公开安装验收全部通过，备份验证、迁移说明发布且 Supervisor 最终确认后依序删除远端仓库和本地目录 | 若尚未删除，立即停止；已删除只能尝试用经验证备份重建，元数据恢复可能不完整 |

阶段 1（命名、身份、Skill 许可）已完成，以下原阻塞项已解除：

1. Skill 再分发许可已由 JoeyZhao 确认（直接创作/版权、MIT 再分发、无需单独 NOTICE），Skill frontmatter 已声明 `license: MIT`。
2. `@zguiyang/pi-task-exec` 当前无已发布包（`npm view` 返回 E404）；E404 仅表示当前状态，不是预留或发布权利。
3. Registry ID `io.github.zguiyang/pi-task-exec` 当前无匹配记录（官方精确搜索 HTTP 200、count 0），`mcp-publisher validate` 通过；发布身份已确认（`gh api user`/`gh repo view`、`npm whoami`/`npm org ls`）。实际 OAuth/OIDC 发布未执行，未来 OIDC 工作流需要 `id-token: write`。若正式发布时 ID 已被占用，停止，不回退旧名。

仍待完成、维持未验证的发布前工作：

4. Windows Host 配置路径和跨平台 CI 尚未实施或验证。
5. `task_*` 工具契约、根 package 构建路径和 tarball 内容尚未实现、测试。
6. 尚无任何 npm 包或 Registry 记录实际发布；发布需单独人工授权并再次核对官方状态。

## 2026-10-09 目录重构风险补充

当前目录是迁移过渡结构，不代表最终产品边界。阶段 9 必须等待本目录重构完成、根级测试通过及真实 tarball 验收后再开始。

| ID | 风险 | 影响 | 当前证据/可能性 | 预防与验收 | 回滚/应对 |
|---|---|---|---|---|---|
| R31 | 把 `mcp/src/index.ts` 原样搬到 `mcp/index.ts`，CLI 仍与 MCP server 初始化耦合 | help/version 初始化 MCP runtime；MCP 模块继续依赖 CLI、Host adapters 和 Skill installer，目录虽变但边界未变 | 高；当前 index 同时构建 CLI deps、路由 `mcp serve` 并注册工具 | 将 CLI 路由、MCP Server/tool registration、stdio lifecycle 拆分；MCP 不导入 CLI；正常 CLI 命令不初始化 runtime | 回退到阶段 2 拆分前，保留上一组可工作的目录提交；不以 wrapper 掩盖耦合 |
| R32 | Host adapter 或安装计划留在 `mcp/` | MCP runtime 仍承载用户配置写入能力，职责边界和测试归属模糊 | 高；adapter、doctor、plan、executor、safety 当前全在 `mcp/src` | adapter/安装器/计划模型/安全执行器均归 `cli/`；MCP 仅含 server/tools/workers/rpc/runtime；检查 import graph | 还原到最近的完整阶段提交并修正移动映射 |
| R33 | 单根 TypeScript 编译错误生成双层或多层意外输出 | `bin`、server startup、source maps、tarball 入口不匹配 | 中高；旧 config 的 `rootDir: src` 与 `outDir: dist` 相对 `mcp/tsconfig.json`，旧产物是 `mcp/dist` | 根配置显式输入 `cli/`、`mcp/`，`rootDir: .`、`outDir: dist`；构建后断言 `dist/cli/index.js` 与 `dist/mcp/index.js` | 清理候选生成物并修复 tsconfig/scripts；不发布错误布局 |
| R34 | CLI 到 MCP 的启动反向依赖或静态耦合扩散 | CLI 普通命令加载 MCP runtime，或 MCP server 依赖 CLI 才能工作 | 中；当前 `mcp/src/index.ts` 静态导入 CLI | 用薄 bin → CLI router → MCP 启动函数的单向关系；明确 MCP 模块可独立构建；help/version smoke 不启动 server | 恢复最后通过 smoke 的入口实现，重做启动边界 |
| R35 | package `files` 遗留 `mcp/dist`、遗漏根 `dist`/`bin` 或 Skill references | tarball 缺入口或 Skill，或混入过渡产物/测试 | 高；当前 `files` 明确包含 `mcp/dist/**` 与 `mcp/README.md` | 从干净构建验证 tarball 解包清单，断言根 dist、bin、Skill、文档、LICENSE、server.json 均完整，旧 mcp 路径和 tests 不存在 | 丢弃 tarball；修正唯一根 manifest 后重 pack，不发布 |
| R36 | `server.json` 留着 `repository.subfolder: "mcp"` | Registry 仓库路径把单产品仓库误标为 MCP 子项目 | 中；当前 server metadata 有该字段 | 根仓库定位后删除该字段；`packageArguments` 仍严格为 positional `mcp`、`serve`；schema/CLI smoke 联合验收 | 恢复 metadata 并暂停 Registry 操作，核对规范后再改 |
| R37 | 移动测试时只保留总数，丢失语义或 fake/real adapter 边界 | 141 项通过的表象掩盖覆盖削弱 | 中高；当前 CLI、Host installer、runtime、worker、security、metadata tests 混放于 `mcp/tests` | 为每项现有断言记录目标文件；fake adapters 继续用于计划/冲突场景，真实 adapters 继续用隔离 home/cwd；根测试先 build | 恢复原测试用例并分模块修正，不得删除失败用例作为迁移手段 |
| R38 | Skill 安装器阶段 9 在新源码路径稳定前启动 | 安装器引用旧 `mcp/dist`/资源路径，造成重复返工或旧边界继续延长 | 高；Skill 安装仍未实现，当前设计要求包内定位 `skills/pi-delegate/` | 暂停阶段 9；目录重构、141 项回归和真实 tarball验收结束后，以 `skills/pi-delegate/` 为唯一源路径再实施 | 暂停阶段 9并回到已通过的目录重构提交；不保留旧资源路径兼容逻辑 |
| R39 | 把 ignored `mcp/dist` 当作可迁移的权威产物 | stale JS 与新 source layout 不一致，导致错误测试或打包 | 中高；`mcp/dist` 当前在工作区存在但被忽略；本次 pack dry-run 因 npm cache 权限错误未运行成功，仓库中无 `.tgz` | 不搬运旧 dist；根 build 从源码生成全新 dist；pack 必须由干净构建重新产生并解包核验 | 删除候选 ignored 输出后重新构建；保留源码和 lockfile，不修改 npm cache 权限 |

在阶段 11 真实 tarball 验收之前，当前 `files` 只能用于推断声明包路径，不能作为已验证实际包文件清单。任何验收被 npm cache 或环境权限阻断时，记录为未验证并换用授权的临时缓存/干净环境；不得把历史 tarball 结果代替本次新布局证据。
