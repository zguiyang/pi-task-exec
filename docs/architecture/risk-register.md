# Pi TaskExec 风险登记表

状态：审查阶段风险；概率为定性判断，未通过运行时测试量化
日期：2026-10-08

| ID | 风险 | 影响 | 当前状态/可能性 | 预防与验收 | 回滚/应对 |
|---|---|---|---|---|---|
| R1 | 新 npm 包 `@zguiyang/pi-task-exec` 已存在或被抢先注册 | 无法按指定名称发布 | **阶段 1 已查询**：`npm view` 返回 E404，当前无已发布包；E404 不构成预留或发布权利，未来仍可能被注册 | 发布前再次执行官方 npm 精确查询；若届时存在，停止并由 Supervisor 决策 | 不发布、不改用旧包名 |
| R2 | Registry ID `io.github.zguiyang/pi-task-exec` 已占用 | 无法按指定 ID 注册；名称不可被改写 | **阶段 1 已查询**：官方 Registry 精确搜索返回 HTTP 200、count 0，无匹配记录；`mcp-publisher validate` 通过；尚未实际发布 | 正式发布前再次官方精确查询；用户要求占用时停止，禁止回退旧 ID | 不发布；由 Supervisor 另行决策 |
| R3 | GitHub namespace 发布身份未认证或无权 | Registry publish 被拒绝 | **阶段 1 已确认身份**：`gh api user` 为 `zguiyang`，`gh repo view` 为 PUBLIC + ADMIN，`npm whoami` 为 `zhaoguiyang`，`npm org ls zguiyang` 为 owner；实际 Registry OAuth/OIDC 发布未尝试 | 实际发布时走 OIDC 工作流并确认 `id-token: write`；检查发布主体与仓库 | 修正身份/权限；不改 ID 绕过认证 |
| R4 | Skill 许可证不明确 | 可能无权随 npm 包再分发，产生版权风险 | **阶段 1 已解决**：JoeyZhao 确认为直接创作并持有版权，同意 MIT 再分发，无需单独 NOTICE；Skill frontmatter 已声明 `license: MIT` | 保持该授权与 frontmatter 一致；tarball 审查许可证 | 若授权或元数据变化则停止打包公开发布，保持文件不变 |
| R5 | 根 `package.json` 迁移破坏 TypeScript 输出路径 | npm bin 找不到入口，包不可运行 | 中；当前 tsconfig 使用相对其自身目录的 `src`/`dist` | 固定使用 `tsc -p mcp/tsconfig.json`；检查实际 `mcp/dist` 输出和根 bin 路径 | 恢复脚本/配置；不发布候选包 |
| R6 | 根测试脚本使用错误相对路径 | 测试导入失败或 CI 假绿 | 中；当前测试导入 `../dist`，依赖 mcp 目录位置 | 根脚本运行 `mcp/tests/*.test.mjs`；测试先构建；tarball 中执行 smoke | 修正脚本并重跑全矩阵 |
| R7 | 删除旧 CLI 时遗漏旧 bin/命令/文档引用 | 新包仍暴露旧名称或文档误导 | 高；旧字符串分散在 CLI、Host adapter、README、Skill、tests、dist | 构建前后对源码/文档/打包内容做旧名称 allowlist 扫描；只允许有明确历史语境的文档引用 | 发布前整组修正；发布后只能发新版本 |
| R8 | 旧包名或旧 Registry ID 残留到新 package/server metadata | Registry 验证失败或用户安装旧包 | 高；当前全部配置还是旧名 | 一致性脚本校验 package `name`、`mcpName`、server `name`、identifier、仓库链接 | 不发布；修复后重跑 schema 与 tarball 验收 |
| R9 | `task_*` 改名后 Skill/reference 与 MCP schema 不一致 | Agent 调用失败或错误理解工具能力 | 中高；现有 Skill 精确绑定 `pi_*`/v0.1.1 | 工具契约测试与 Skill 静态契约共用 manifest/schema；禁止保留旧 alias | 回退尚未发布的整组更改；发布后新版本同步修复 |
| R10 | 工具描述仍与 Delegation-First Skill 冲突 | 主 Agent 的委派选择不一致 | 已发现；现 MCP 描述保留“节省上下文/并行、trivial 留给 Supervisor”，Skill 允许所有已定义边界的原子任务 | CI 对统一策略短语/契约版本做静态检查；review MCP `instructions` 与工具 description | 合并前协调并修正描述；不靠 Skill 单方面覆盖 MCP 指引 |
| R11 | npm tarball 未携带完整 Skill | 用户安装 MCP 后找不到 `pi-delegate` | 高；当前 package `files` 仅含 `dist/README/LICENSE/server.json` | 根 package `files` 必须包含 `skills/pi-delegate/**`；tarball 测试断言 `SKILL.md` 和 references 存在 | 发布前修复 `files`；已发布包另发新版本 |
| R12 | Skill 安装器覆盖用户已有同名 Skill | 用户数据丢失 | 中高；已有同名目录可能由用户自行维护 | 相同内容幂等；不同内容默认拒绝；显式备份后替换；原子暂存；记录 manifest | 从备份恢复；检测到用户修改时停止，不覆盖 |
| R13 | MCP 配置安装器覆盖用户同名 Host 条目或丢失注释/其它配置 | Host 配置损坏或第三方配置丢失 | 高；当前旧 JSON/TOML 更新方式尚未覆盖跨平台冲突策略 | 解析后只编辑自有 key；同名不同内容默认停止；JSONC/TOML 保真；先备份；隔离 home 测试 | 原子恢复备份；若配置冲突不自动写 |
| R14 | Windows home/XDG/APPDATA 路径计算错误 | 写入错误位置或 Host 无法启动 MCP | 高；旧 CLI 以 `HOME` 为 home fallback，缺少 Windows 矩阵 | 用 `os.homedir()` 与 Host override；明确 `%USERPROFILE%`/`%APPDATA%`；Windows CI 端到端路径断言 | 不声明该组合支持，修复后发布；保留原配置 |
| R15 | macOS/Linux Host 路径忽略 Host 自身 XDG/配置变量 | 全局配置写入错误位置 | 中；不同 Host 采用不同默认值/override | 每个 Host 单独 adapter 和官方文档测试；优先显式环境覆盖，doctor 显示路径 | 取消写入，要求用户指定路径；不得猜测写入 |
| R16 | Zed 项目 MCP 配置未获信任时不启动 | 用户以为 MCP 安装失败或尝试重复安装 | 中；Zed 会对项目配置应用 trust/restricted mode | README 和 doctor 说明项目 trust；安装器不尝试替用户授信 | 用户在 Host UI 作信任选择；配置仍可回滚 |
| R17 | `dist/` 与 `src/` 不一致 | npm 发布旧 JS 或错误 source map | 中高；`dist/` 当前存在但被 `.gitignore` 忽略 | 发布前干净构建；CI 检查生成后 git 状态与入口；以 `prepack` 产物为准 | 删除临时生成物或重建；不手工修补发布 dist |
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
