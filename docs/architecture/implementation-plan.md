# Pi TaskExec 实施计划

状态：阶段 1–5 已完成；阶段 6 已完成，待 Supervisor 审查；阶段 7 已完成，待 Supervisor 审查（提交 `bba829b`）；阶段 8、9、10 未开始；npm 和 MCP Registry 均未发布。
日期：2026-10-09

本计划按依赖顺序执行。任何阶段均不得越过公开发布门槛；Registry ID 冲突时停止，不回退旧名称。阶段 1–6 已完成，阶段 6、7 待 Supervisor 审查；后续阶段仍须单独遵守其授权和发布门槛。

## 阶段 1：许可证和命名验证

- **前置依赖**：接受本计划；可访问 npm 与 MCP Registry 查询服务；可确认 GitHub namespace 发布身份。
- **修改范围**：无仓库代码修改；外部只读查询。
- **具体任务**：精确查询 npm package `@zguiyang/pi-task-exec` 是否已存在；精确查询 MCP Registry name `io.github.zguiyang/pi-task-exec` 是否已存在；验证 namespace 发布权；向 Skill 原作者/权利人确认再分发权限及许可证。若 Registry name 被占用，停止并报告，不选择旧名。
- **验收条件**：保存官方服务查询证据；明确 package/Registry ID 可用性和发布身份；有明确 Skill 授权/许可证结论。
- **回滚方式**：不写入仓库；结束检查即可。
- **公开发布影响**：无。
- **人工决策**：必须确认 Skill 授权、目标名称及 namespace 权限。
- **阶段 1 结果（已完成）**：`npm view @zguiyang/pi-task-exec` 返回 E404（当前无已发布包，不构成预留或发布权利）；官方 MCP Registry 精确搜索返回 HTTP 200、count 0；官方 `mcp-publisher validate` 对目标 Registry name 和 npm package identifier 通过；发布身份已确认（`gh api user`=`zguiyang`、`gh repo view`=PUBLIC+ADMIN、`npm whoami`=`zhaoguiyang`、`npm org ls zguiyang`=owner）；JoeyZhao 确认 Skill 直接创作/版权、MIT 再分发、无需单独 NOTICE。尚未发布任何 npm 包或 Registry 记录；未实际执行 Registry OAuth/OIDC 发布，未来 OIDC 工作流需要 `id-token: write`。

## 阶段 2：Git 初始化和仓库基础文件

- **前置依赖**：阶段 1 名称与许可问题已解决；Supervisor 明确授权 Git 初始化。
- **修改范围**：Git 元数据及根 README、许可证/NOTICE、贡献和安全说明、忽略文件、架构文档；不修改 MCP/Skill 运行时代码。
- **具体任务**：创建新仓库基础；排除本机 `.codex/config.toml`、node_modules、生成物临时文件；决定是否跟踪 `mcp/dist/`（建议不跟踪，由 CI/build 生成）。记录两个源代码来源和 attribution。
- **验收条件**：无个人绝对路径；根文档解释产品边界、模块目录、发布和安全报告方式；源目录内容仍完整。
- **回滚方式**：未提交前恢复文件；初始化 Git 后由 Supervisor 决定是否移除 `.git`，不得自动重写历史。
- **公开发布影响**：无。
- **人工决策**：许可证边界和源历史/归属保留方式。
- **执行状态（已完成）**：仓库基础文件、Skill frontmatter、旧本机配置清理、Git 初始化及阶段 1 证据文档更正均已完成；阶段 2 已通过首个迁移基线提交完成。

## 阶段 3：根 package.json 与 lockfile 整合

- **前置依赖**：阶段 2 完成；新 npm 名确认可用；Skill 授权确定。
- **修改范围**：根 `package.json`、根 `package-lock.json`、必要 package 元信息；移除旧位置的 package 发布入口后由 Supervisor 审查。
- **具体任务**：设置 npm package `@zguiyang/pi-task-exec`、MCP Registry name `io.github.zguiyang/pi-task-exec`、CLI/bin `pi-task-exec`；将 `files` 指向 `mcp/dist/**`、`skills/pi-delegate/**`、根文档、`server.json` 和许可证文件；依赖只安装/锁定一次；不引入 Workspaces。
- **验收条件**：根 manifest 是唯一 npm 包权威来源；lockfile root metadata 一致；无旧包名/CLI bin 配置。
- **回滚方式**：恢复根 package 与 lockfile；不得覆盖已发布 npm 版本。
- **公开发布影响**：无，除非发布阶段获批。
- **人工决策**：最终版本号；建议 `0.2.0`，不建议当前直接 `1.0.0`。
- **执行状态（已完成）**：根 `package.json` 和 lockfile 已整合新包名、CLI bin、构建入口和打包清单。

## 阶段 4：MCP 构建路径迁移

- **前置依赖**：阶段 3 的包根已确定。
- **修改范围**：根 scripts、`mcp/tsconfig.json`（仅确有必要时）、CLI 入口路径、构建说明。
- **具体任务**：根 build 调用 `tsc -p mcp/tsconfig.json`，维持 `mcp/src` 到 `mcp/dist`；根 test 先 build，再运行 `mcp/tests/*.test.mjs`；bin 指向 `mcp/dist` 中的新入口；厘清 `prepack` 和忽略规则。
- **验收条件**：构建输出在预期路径；单测 import 相对路径有效；没有根/模块双重编译输出或遗留旧入口。
- **回滚方式**：恢复原 scripts/tsconfig 路径；未完成阶段不打包发布。
- **公开发布影响**：无。
- **人工决策**：是否将生成的 `dist` 纳入 Git；建议不纳入。

## 阶段 5：Skill 随包打包

- **前置依赖**：阶段 1 授权确认；阶段 3 根包 `files` 定义。
- **修改范围**：根 package 打包清单、Skill frontmatter/references、文档。
- **具体任务**：保留 `skills/pi-delegate/SKILL.md` 和 `references/` 原结构；不拆 Skill npm 包、不移动到 `packages/skill/`。最低 MCP 契约版本及机器可读兼容清单属于阶段 10，不属于本阶段。
- **验收条件**：真实 npm tarball 完整包含 `mcp/dist/` 和 `skills/pi-delegate/`；Skill frontmatter 与 references 验证通过；测试、`node_modules`、`.codex` 和临时文件均被排除。
- **回滚方式**：去掉打包项；在许可未确定时不发布。
- **公开发布影响**：无。
- **人工决策**：无新增决策；最低 MCP 契约版本和机器可读兼容清单留待阶段 10。
- **执行状态（已完成）**：已生成真实 npm tarball，确认完整包含 `mcp/dist/` 与 `skills/pi-delegate/`，验证 Skill frontmatter 和 references，并排除测试、`node_modules`、`.codex` 与临时文件；未冻结最低 MCP 契约版本，也未实现机器可读兼容清单。

## 阶段 6：旧 CLI 与旧标识清理

- **前置依赖**：阶段 3、4 的新包入口设计完成；工具名决策被接受。
- **修改范围**：CLI、MCP 名称常量、Host 配置 key、文档、测试和打包文件。
- **具体任务**：删除旧 bin、旧 package 名、旧 Registry name 和旧配置 key；不保留兼容 alias/wrapper/deprecated 逻辑；保留仅用于迁移来源说明的历史上下文。新 Host 配置键采用新的 CLI 名，例如 `pi-task-exec`。
- **验收条件**：全局搜索确认运行时代码与现行文档无旧名称；发布文件不含旧入口；历史记录中如需引用，有明确历史语义。
- **回滚方式**：在发布前回退代码；发布后不能重用版本，必须用新版本修复。
- **公开发布影响**：尚无用户的前提必须人工再次确认；进入公开发布即为破坏性首发契约。
- **人工决策**：确认“无线上用户、不需兼容”的发布前提。
- **执行状态（2026-10-09）**：已替换 CLI 入口为 `pi-task-exec`，仅 `mcp serve` 启动 MCP；无参数显示帮助；旧顶层命令不再路由到安装器。新身份已同步到 Host launch args、运行时名称、package/server metadata、现行 README/Skill 参考和测试。`pi_*` MCP 工具名按后续契约迁移阶段保留。npm 与 MCP Registry 未发布；提交待 Supervisor 审查。

## 阶段 7：新 CLI 实现

- **前置依赖**：阶段 3、6 完成；命令行为和确认模型已定。
- **修改范围**：CLI 模块及专用测试。
- **具体任务**：实现 `add mcp`、`add skill`、`setup`、`doctor`、建议的 `remove mcp|skill`、`mcp serve` 与 `--version`；加入显式 Host/scope、计划预览、dry-run、冲突提示和备份策略。将 `pi-task-exec mcp serve` 定义为 MCP Host 配置与 Registry entry 唯一明确的服务启动入口，并单独实现和测试该命令路由。
- **验收条件**：默认不修改所有 Host；用户可看到写入文件和覆盖行为；无参数时只显示清晰帮助/错误并返回明确状态，绝不能启动 MCP，也不能复现含糊的旧 CLI 默认行为；取消交互不写文件。
- **回滚方式**：移除新 CLI 改动，保留 MCP Worker 运行时代码。
- **公开发布影响**：无。
- **人工决策**：是否纳入 remove 命令及非交互式默认行为。
- **执行状态（2026-10-09）**：已实现纯解析器/路由 + 共享计划模型（operation/target/host/scope/resolved paths/creates/updates/removals/conflicts/backups/warnings/unsupported/dryRun，JSON 稳定且不包含配置密钥或文件内容）+ 可独立测试的计划执行器；Host 适配器接口（id/displayName/supportedPlatforms/supportedScopes/config 路径解析/读取/写入/条目规划/条目移除/doctor 检查）已注册 Codex、Zed、OpenCode，但阶段 8 前真实安装/移除一律标记为不支持，不沿用 `hosts.ts` 的 install/uninstall、不推测未验证路径、不写未知配置，接口可注入以便测试使用受支持的 fake adapter；Skill 通过类型化安装器 seam 报告 pending/unavailable，不写入。`add/remove mcp` 与包含 MCP 的 `setup` 强制显式 `--host`/`--scope`，`add/remove skill` 强制显式 `--scope`，`setup` 强制 `--target mcp|skill|both`；支持 `--help`/`--version`/`--dry-run`/`--yes`/`--json`，未知或畸形参数非零退出，无参数只显示帮助，`--version` 只输出包版本，未实现 `--all-hosts`。dry-run 与真实执行复用同一计划生成器，显示绝对路径，任何冲突阻止整体操作，执行前按 base hash 重新校验；`--yes` 仅在打印计划后跳过确认；doctor 只读并报告 Node/Pi/Git/包版本/平台/Host 适配器支持与配置检查/Skill 目标状态/版本契约，进程检查使用结构化 `spawn(command,args)` 且不打印密钥。已加入路径越界与符号链接边界、同目录临时文件 + 原子 rename、写入前备份、保留权限、失败回滚备份、安全创建、同内容幂等、拒绝不同用户内容、仅对显式受管且哈希未变的文件移除、受管内容漂移时不做自动回滚等安全原语及测试。`pi-task-exec mcp serve` 仍是唯一服务启动入口，六个 MCP 工具与 Worker 运行时未改动。

## 阶段 8：MCP 多平台安装适配

- **前置依赖**：阶段 7 命令接口；各 Host 官方配置路径与 scope 已核实。
- **修改范围**：Host adapter、配置解析依赖（如需要）、安装测试。
- **具体任务**：支持 macOS/Linux/Windows；首批 Host 为 Codex、Zed、OpenCode。实现 Host-specific home/XDG/APPDATA 环境解析；JSON/JSONC 与 TOML 安全合并；原子写入、备份、幂等、冲突停止和受控 remove。
- **验收条件**：在三平台按用户级/项目级场景验证实际路径；保留无关配置和编码；格式无法安全解析时拒绝写入；绝不修改同名用户配置。
- **回滚方式**：恢复备份中的原文件；测试使用隔离 home/cwd，不触碰真实用户配置。
- **公开发布影响**：无。
- **人工决策**：Host/平台的支持边界；若某组合不可验证，明确不支持。

## 阶段 9：通用 .agents/skills 安装器

- **前置依赖**：阶段 5、7；Skill 许可明确。
- **修改范围**：Skill 安装器、CLI 测试、安装 manifest 格式。
- **具体任务**：实现 `.agents/skills/pi-delegate` 的 project/global scope；使用 Node home API；dry-run、同内容幂等、差异冲突默认拒绝、显式备份升级、原子 staging/rename 与回滚检查。
- **验收条件**：macOS/Linux/Windows 路径测试通过；不会覆盖不同内容的同名 Skill；备份和恢复只操作管理器记录且未被用户修改的文件。
- **回滚方式**：根据 manifest 恢复旧目录；有用户修改则停止并保留现场。
- **公开发布影响**：无。
- **人工决策**：项目级是否作为交互式默认值；global 必须可显式选择。

## 阶段 10：MCP/Skill 契约同步与工具改名

- **前置依赖**：阶段 6 命名决策，阶段 5 Skill 包装方案。
- **修改范围**：MCP 工具注册、类型/描述、Skill、reference、README、样例、Registry description、契约测试。
- **具体任务**：将工具改为 `task_*`；统一 Delegation-First 规则；同步 profile/mode/continuation/worktree/--no-session/terminal 状态语义；定义最低 MCP 契约版本并写入机器可读兼容清单。
- **验收条件**：源码注册、测试 schema、Skill/reference/示例一致；无旧 alias；Worker 边界没有被描述为文件系统沙箱；Supervisor 保留验收责任。
- **回滚方式**：发布前可整组回退名称；不得只回退 Skill 或只回退 MCP。
- **公开发布影响**：构成新 MCP API 首发契约。
- **人工决策**：接受工具中立命名及契约版本格式。

## 阶段 11：测试和 GitHub Actions

- **前置依赖**：阶段 4、7、8、9、10。
- **修改范围**：测试、CI workflows 和发布验证脚本。
- **具体任务**：加入 MCP 单元/lifecycle/工具契约、Skill 静态契约、CLI、Host 配置、Skill 安装、重复安装、冲突保护、三平台、Node 矩阵、Registry schema 和版本一致性验证。
- **验收条件**：PR CI 无发布凭据、不自动发布；Node 版本、OS 和本地目录使用隔离环境；所有矩阵可重复。
- **回滚方式**：回退 workflow/测试；禁止为了绿灯跳过关键平台验收。
- **公开发布影响**：无。
- **人工决策**：确定 Node 最低版本，建议至少 22；Node 20 已 EOL。

## 阶段 12：npm tarball 验收

- **前置依赖**：阶段 11 全绿；许可证已确认。
- **修改范围**：仅临时构建目录与候选包。
- **具体任务**：执行 npm pack 到临时目录；检查文件清单；在干净临时 prefix 安装 tarball；从该安装目录调用真实 bin，运行 `pi-task-exec mcp serve` 的启动 smoke test；检查 Skill 可安装、依赖可解析、MCP stdio 可初始化并返回工具列表。核对 Registry `packageArguments` 逐项等于实际 CLI 参数 `mcp serve`。
- **验收条件**：MCP 和 Skill 均在 tarball 中；运行时代码中没有旧产品名称；`package.json`、`server.json`、bin 和当前安装说明中没有旧名称；tarball 不包含旧 CLI 入口、旧 bin、旧 package metadata 或旧 Registry metadata。README 的迁移历史可以保留旧项目名作为历史来源说明，不将这类历史说明判作运行时残留。已安装 tarball 中的真实 `pi-task-exec mcp serve` 成功启动 MCP；无参数不会启动服务；Registry 启动参数与通过测试的 CLI 契约完全一致。
- **回滚方式**：丢弃未发布 tarball 和临时目录；修复后重新验收。
- **公开发布影响**：无。
- **人工决策**：Supervisor 最终包清单审阅。

## 阶段 13：npm 发布

- **前置依赖**：阶段 1 名称可用；阶段 12 验收；人工授权发布。
- **修改范围**：公开 npm package。
- **具体任务**：发布用户确认的精确版本；记录 tarball integrity/provenance；确认新 CLI 与新包名可从公开 npm 安装。
- **验收条件**：公开包版本/文件与候选 tarball 一致；安装运行及 Skill 文件校验成功。
- **回滚方式**：npm 已发布版本不可覆盖；停止后续 Registry 发布，发布修正版新版本并按需弃用坏版本。
- **公开发布影响**：是，必须人工授权。
- **人工决策**：明确版本与发布批准。

## 阶段 14：MCP Registry 发布

- **前置依赖**：阶段 1 确认 ID 空闲/namespace 权限；阶段 13 npm 已成功；`server.json` validate 通过。
- **修改范围**：官方 MCP Registry 新记录。
- **具体任务**：以根 `server.json` 发布 `io.github.zguiyang/pi-task-exec`；检查 `mcpName`、npm identifier、版本、repository URL/subfolder 和 stdio 启动参数。`packages[].packageArguments` 必须与通过 tarball smoke test 的 `pi-task-exec mcp serve` 参数完全一致，即 positional arguments `mcp`、`serve`，不得省略、换序或使用未经测试的参数。
- **验收条件**：官方 Registry 返回该精确新 ID 和版本，包元数据对应 npm 公开版本；Registry 启动参数与公开 npm tarball 中真实 CLI 的启动入口一致。
- **回滚方式**：如发布内容错误，暂停推广并按 Registry 支持流程更正或标记状态；名称不能通过新版本改名，禁止回退旧 ID。
- **公开发布影响**：是，必须人工授权。
- **人工决策**：明确 Registry 发布批准。

## 阶段 15：旧仓库和本地旧项目退役（整个迁移流程的最后一步）

- **前置依赖**：新 GitHub 仓库、npm 包、MCP Registry、CLI、Skill，以及从公开 npm tarball 的安装与启动验收全部通过；迁移说明已发布；旧仓库备份已验证；Supervisor 已审阅全部证据并作出最终确认。任何一项未通过或未确认，都不得进入删除操作。
- **修改范围**：两个旧 GitHub 远端仓库及对应两个本地旧项目目录。删除它们是整个迁移流程的最后一步；在此之前不得删除、清空、重命名或以不可逆方式处置任何旧仓库/本地目录。
- **具体任务**：按顺序执行：①备份两个旧仓库的全部 tags、releases、issues、PR 和关键提交信息，并验证备份可读取；②发布迁移说明，明确新仓库/npm/Registry/CLI/Skill 地址；③由 Supervisor 检查公开安装验收、备份和迁移说明并最终确认；④删除两个旧 GitHub 远端仓库；⑤确认远端删除结果后，删除两个本地旧项目目录。可在删除前将备份归档或设为只读，但这只是删除前的保护措施，不是最终退役目标。
- **验收条件**：备份清单完整且可访问；迁移说明公开可读；Supervisor 明确确认；两个旧远端仓库已删除；随后两个本地旧项目目录已删除。没有这些前置证据时，不得声称迁移退役完成。
- **回滚方式**：远端删除后只能依靠已验证备份重建仓库，GitHub issues/PR 等元数据可能无法完整恢复；本地删除后从独立备份恢复。删除前必须确认备份范围及恢复责任人。
- **公开发布影响**：会使旧仓库 URL、issues、PR、releases 和 tags 不再通过原仓库服务访问；仅可在所有验收通过和 Supervisor 最终确认后执行。
- **人工决策**：Supervisor 的最终确认是强制门槛。当前阶段不删除旧仓库或本地旧目录。

## 发布前硬性门槛

1. npm 新包名已用官方 npm 查询确认可注册。
2. Registry 新 ID 已用官方精确查询确认未占用，且发布身份已验证。若占用，停止并报告。
3. Skill 再分发许可明确；否则不得 npm 发布。
4. tarball 包含 Skill、无旧名称运行时残留，且三平台安装策略有证据。
5. CI、Registry schema 和 package/server/Skill 版本检查全部通过。
6. 从公开 npm tarball 安装后，`pi-task-exec mcp serve` 真实启动 smoke test 通过；无参数不启动 MCP；Registry `packageArguments` 与该 CLI 启动协议完全一致。
7. 旧远端和本地项目只能在阶段 15 删除；在前置公开验收、备份、迁移说明和 Supervisor 最终确认前，任何人不得执行删除。
