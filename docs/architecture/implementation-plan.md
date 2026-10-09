# Pi TaskExec 实施计划

状态（2026-10-09）：阶段 1–8 已实现；阶段 6–8 与选型 A 根级目录重构待 Supervisor 审查；阶段 9A（固定 Skills CLI/GitHub Skill 安装）与阶段 9B（交互 CLI/统一 setup）的基线已提交为 `a8b77e9`，09B 的隔离环境真实 Setup Smoke 已通过并完成清理；阶段 9C（统一 `pi-task-exec update`）仍在 `codex/stage-09a-skills-cli` 工作区未提交并待 Supervisor 审查，09C 的真实 `update` 安装尚未验证；`remove skill` 仍延后；阶段 10–15 未开始；npm 和 MCP Registry 均未发布。
日期：2026-10-09

本计划按依赖顺序执行。任何阶段均不得越过公开发布门槛；Registry ID 冲突时停止，不回退旧名称。阶段 1–8 已完成，阶段 6、7、8 待 Supervisor 审查；后续阶段仍须单独遵守其授权和发布门槛。

> **历史与当前权威：** 阶段 1–8 的实施记录保留当时的决策和验收；其中 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/tsconfig.json`、`package.json.files = mcp/dist/**`、`bin = ./mcp/dist/index.js`、`mcp/tests/*.test.mjs` 等路径均为迁移前历史，不是当前运行结构或待执行任务。选型 A（根 `cli/`、`mcp/`、`skills/`、`tests/`、`docs/`、根 `dist/`；根 `tsconfig.json`/`package.json`/`server.json`；薄 `bin/pi-task-exec.mjs`；不使用 npm Workspaces）已实施。阶段 10 完成前，六个现有 `pi_*` 工具名（`pi_spawn`、`pi_status`、`pi_steer`、`pi_continue`、`pi_abort`、`pi_list`）继续保留为运行时契约。下方目录迁移分解改作历史实施记录；阶段 9–15 原计划的范围和发布门槛不变。

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

## 阶段 4：MCP 构建路径迁移（历史，构建路径已被选型 A 取代）

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
- **迁移时实施快照（历史；其中旧路径不表示当前结构）**：已实现 Codex、Zed、OpenCode 的真实安装/移除适配器（`mcp/src/hosts/`）。路径解析：Codex 用户级遵循 `$CODEX_HOME`，否则 `~/.codex/config.toml`，项目级 `.codex/config.toml`；Zed 用户级：macOS/Linux 遵循 `$XDG_CONFIG_HOME/zed/settings.json`，否则 `~/.config/zed/settings.json`；Windows 使用 `%APPDATA%\Zed\settings.json`（按平台使用 win32 路径语义），项目级 `.zed/settings.json`；OpenCode 用户级遵循 `OPENCODE_CONFIG`，否则 `OPENCODE_CONFIG_DIR`/`$XDG_CONFIG_HOME` 下的 `opencode.json`，项目级 `opencode.json`；受支持的文件名仅为官方 `opencode.json`/`opencode.jsonc`，不再考虑 `config.json`。格式：Codex 使用 TOML parser（`smol-toml`）校验加字符级表区域扫描，保留无关 section、值与注释；Zed/OpenCode 使用 `jsonc-parser` 做保注释、保留无关字段的最小编辑，无法安全解析时拒绝写入。OpenCode 采用稳定 schema `mcp.<name>`、`type: "local"`、`command` 数组，不使用 `mcp.servers`。安装/移除基于严格的 pi-task-exec 受管指纹：仅当现有条目与本次将要写入的条目逐字段完全一致时才是幂等；旧版本、不同本地路径、额外或被修改的字段均为指纹漂移，add 报冲突且绝不覆盖，remove 报冲突且绝不删除。真实写入复用阶段 7 执行器与安全原语（绝对路径、根边界与符号链接保护、同目录临时文件加原子 rename、写入前备份、失败回滚）。npm 安装模式为默认，启动为 `npx -y @zguiyang/pi-task-exec@<version> mcp serve`；源码 checkout 模式必须显式传入 `--local-dev`，否则计划报 `local_dev_required` 且不写入，写入值为 `node <绝对 checkout>/mcp/dist/index.js mcp serve`，均以结构化 argv 传递、不经过 shell。真实 `.git` checkout 检测优先于 `PI_TASK_EXEC_LAUNCH_MODE`：存在 `.git` 时不能被强制为 npm 模式，避免把未发布的 checkout 表示成已发布的 npx 包；`--local-dev` 仍是写入本地 node 路径的唯一入口。项目级计划与 doctor 明确提示 Codex trusted project 与 Zed Restricted Mode 不会由本工具授予。计划 JSON/文本与 doctor 输出 host/platform、绝对配置路径、配置格式、被修改的配置 key、支持状态、备份策略、重启与 trust 要求；doctor 另报告解析状态与受管/指纹漂移状态，均不输出文件内容。绝对 `CODEX_HOME`/`OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` 覆盖被视为用户显式选择并加入执行 roots，避免通用 path_escape 失败。已新增 TOML/JSONC 与三 Host 适配器测试（隔离临时 home/cwd 与 mock 环境变量，不触碰真实用户配置）；`npm test`、`npm run build`、`npm run typecheck`、`npm pack --dry-run --json` 均通过。未发布 npm/Registry，未改动 MCP 工具名/schema 与 Worker 运行时。

## 阶段 9：通用 .agents/skills 安装器（阶段 9A/9B/9C 已实施，其余待 Supervisor 审查）

- **状态**：阶段 9A 已在 `codex/stage-09a-skills-cli` 实施：`add skill` 经固定 Vercel Skills CLI `skills@1.7.1` 从固定 GitHub 源 `https://github.com/zguiyang/pi-task-exec`（子路径 `skills/pi-delegate`）安装；release ref 为 `v${packageVersion}`，源码 checkout 使用固定 40 位提交 `f914707fa22fd658f50e059a5091440796ef39e0`；使用结构化 `spawn(shell:false)`、`--copy`/`--yes`/`--json`，关闭遥测，并在执行后校验安装文件与 lockfile 的 source/ref（非事务、不承诺回滚）。
- **阶段 9B（交互 CLI 与统一 setup）**：`setup` 默认 MCP + Skill，仅对缺失的 Agent/Scope 询问方向键选项；`add mcp`/`add skill` 也提示缺少的选择。确认菜单默认 No，`--json` 不提示，取消无副作用。统一 `setup` 使用同一 InstallPlan，分别执行 MCP 与 Skills CLI 并报告各自结果；一方失败时保留另一方成功并报告 `partial`。Skills CLI 的所有目标须通过 roots 校验；越界、符号链接、非目录目标和锁文件冲突直接拒绝，只有普通同名 Skill 目录可在明确确认后覆盖。`XDG_STATE_HOME` 是显式 global lock root。`remove skill`、事务回滚、Manifest 与自动备份管理不在本阶段范围；统一 `update` 见 9C。
- **阶段 9C（统一 `pi-task-exec update`，已实施，未提交）**：新增 `update` 命令（始终检查已安装的 MCP 与 Skill，不提供组件选择覆盖即不接受 `--target`，仅对缺失的 Agent/Scope 提示）复用既有 `InstallPlan`/`Executor`/Host adapter/固定 Skills CLI installer 接缝，不新增包管理器、manifest、备份管理器、Host adapter 或独立 update executor。仅发现已安装组件，绝不安装缺失组件：MCP 仅当同名字段可证明为受管、且唯一差异是钉住的 npm semver token 或当前 checkout 启动路径时才更新，含 env/未知字段/不同包/非 semver/改动 args 一律冲突；Skill 检测同时要求期望安装目录和 `zguiyang/pi-task-exec` 的有效 lock ref，任何不一致归属均为冲突，两者皆缺则为指向 `setup` 的无写入结果。Skill 发现阶段即把符号链接/非目录安装路径、符号链接 lockfile、不可读或畸形/不一致记录作为冲突，且在读取或 spawn 前完成，绝不跟随 lockfile 符号链接，也不允许退化成看似 no-op。release target ref 精确为 `v${packageVersion}`，checkout 使用既有固定 SHA；Skill 更新执行 `skills add <pinned target ref> --agent ... --skill ... --copy --json`，不使用 `skills update`。仅当计划中确有 release Skill 更新时，才在任何 MCP 写入前通过可注入只读 `git ls-remote` 精确校验 `refs/tags/v${packageVersion}`；缺失或不可验证时冲突整个计划且不回退 `main`，不查询 npm latest；MCP-only（Skill 缺失或已最新）与 checkout 固定 SHA 更新不受无关 tag 影响。预览展示 current/target、MCP 受管 key/path、Skill path、global/共享 scope 以及替换 Skill 可能丢失本地改动；组合更新在任何 MCP 写入之前先重检 Skill 目标并询问既有 Skill 替换的默认 No 确认，`--yes` 不能绕过，拒绝则 MCP/Skill 均无副作用；越界/符号链接/非目录/锁文件冲突在 MCP 写入前即成为整计划冲突。无任何变更的计划直接返回 no-op 并指向 `setup`，不要求用户确认。`--dry-run` 不写入、不 spawn（允许只读 tag 检查），复用 executor 的 `success`/`no-op`/`partial`/`failed` 状态，无跨组件回滚，部分成功保持非零退出。
- **阶段 9C 最小待办（隔离环境真实验收）**：Supervisor 审查并接受 9C；之后只在隔离的临时 HOME、项目目录和 npm 缓存中，针对固定 GitHub ref 实际运行一次 Skills CLI 安装与一次 `update`，重复运行检查幂等结果，并清理本阶段创建的全部资源。`remove skill` 另行拆分范围，不作为此验收的前置项。09B 的隔离真实 Setup Smoke 已完成（见验收记录），不属于 9C 待办。
- **验收记录**：9A/9B 基线已提交为 `a8b77e9`，并已在隔离的临时 HOME/项目目录/npm 缓存中真实运行一次 `setup` Skill 安装 smoke，随后完成清理；该证据不覆盖 9C `update`。阶段 9C 本地测试使用注入的 interaction、Skills CLI fake 与可注入 tag preflight，不访问真实用户目录，也不进行真实 Skills CLI 下载/安装。另在临时 HOME/项目目录用构建后的 CLI 真实运行 `update --host codex --scope project --local-dev --json`：检测到 MCP/Skill 均未安装，给出 `setup` 指引并以 `no-op` 退出，临时目录确认无文件写入并已清理；该空状态 smoke 不覆盖 Skill 实际更新。尝试读取 GitHub tags 时，本机配置的 HTTP/SOCKS 代理 `127.0.0.1:7897` 无法连接，因此未执行 9C Skills CLI 下载/安装；未创建 tag、发布 npm 包或触碰真实用户目录。根级 build、typecheck、217 项测试与 diff check 均通过。9C 仍待 Supervisor 审查，真实 `update` 安装验收尚未执行。

## 阶段 10：MCP/Skill 契约同步与工具改名

- **前置依赖**：阶段 6 命名决策，阶段 5 Skill 包装方案；2026-10-09 根级目录重构完成（修改面位于根 `mcp/tools/`、`mcp/runtime/`、根 `skills/pi-delegate/`、根 `tests/`）。
- **修改范围**：MCP 工具注册（根 `mcp/tools/`）、类型/描述、根 `skills/pi-delegate/`、references、根 README、样例、Registry description、根 `tests/` 契约测试。
- **具体任务**：将工具改为 `task_*`；统一 Delegation-First 规则；同步 profile/mode/continuation/worktree/--no-session/terminal 状态语义；定义最低 MCP 契约版本并写入机器可读兼容清单。**在阶段 10 完成前，六个现有 `pi_*` 名称（`pi_spawn`、`pi_status`、`pi_steer`、`pi_continue`、`pi_abort`、`pi_list`）继续作为运行时契约保留，不得提前改名。**
- **验收条件**：根 `dist/mcp/` 中源码注册、根 `tests/` schema、Skill/reference/示例一致；无旧 `pi_*` alias 残留（历史说明除外）；Worker 边界没有被描述为文件系统沙箱；Supervisor 保留验收责任。
- **回滚方式**：发布前可整组回退名称；不得只回退 Skill 或只回退 MCP。
- **公开发布影响**：构成新 MCP API 首发契约。
- **人工决策**：接受工具中立命名及契约版本格式。

## 阶段 11：测试和 GitHub Actions

- **前置依赖**：阶段 4、7、8、10；2026-10-09 根级目录重构完成（根 `tests/`、根 `dist/`）。阶段 9（Skill 安装器）暂停，本阶段不引入其安装测试；待阶段 9 启动后再补充。
- **修改范围**：根 `tests/{cli,mcp,hosts,skills}`、CI workflows 和发布验证脚本。
- **具体任务**：加入 MCP 单元/lifecycle/工具契约、Skill 静态契约、CLI、Host 配置、重复安装、冲突保护、三平台、Node 矩阵、Registry schema 和版本一致性验证。测试统一从根 `tests/` 通过稳定相对路径导入根 `dist/`（例如 `../../dist/cli/...`、`../../dist/mcp/...`）；MCP stdio smoke 从薄 `bin/pi-task-exec.mjs` 启动 `mcp serve`。
- **验收条件**：PR CI 无发布凭据、不自动发布；Node 版本、OS 和本地目录使用隔离环境；所有矩阵可重复；既有测试语义逐项保留（迁移前基线为 141 项，不因移动/拆分文件或改 import 而删减覆盖）。
- **回滚方式**：回退 workflow/测试；禁止为了绿灯跳过关键平台验收。
- **公开发布影响**：无。
- **人工决策**：确定 Node 最低版本，建议至少 22；Node 20 已 EOL。

## 阶段 12：npm tarball 验收

- **前置依赖**：阶段 11 全绿；许可证已确认；2026-10-09 根级目录重构完成。
- **修改范围**：仅临时构建目录与候选包。
- **具体任务**：执行 npm pack 到临时目录；检查文件清单；在干净临时 prefix 安装 tarball；从该安装目录调用真实薄 `bin/pi-task-exec.mjs`，运行 `pi-task-exec mcp serve` 的启动 smoke test；检查 Skill 可安装、依赖可解析、MCP stdio 可初始化并返回工具列表。核对 Registry `packageArguments` 逐项等于实际 CLI 参数 positional `mcp`、`serve`，且 `server.json` 不再包含 `repository.subfolder: "mcp"`。不依赖源码 checkout、npm link、`mcp/dist` 或开发机配置。
- **验收条件（选型 A 目标布局）**：tarball 包含根 `dist/**`（`dist/cli/index.js`、`dist/mcp/index.js` 等）、薄 `bin/`、完整 `skills/pi-delegate/**`（含 `SKILL.md` 与 references）、必要根文档、根 LICENSE 与根 `server.json`，npm 自动带根 `package.json`；不包含 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/README.md`、`mcp/LICENSE`、根 `tests/`、源码、node_modules、架构草稿或旧输出；不使用 npm Workspaces，不使用 `mcp/tsconfig.json`。运行时代码中没有旧产品名称；`package.json`、`server.json`、薄 bin 和当前安装说明中没有旧名称。README 的迁移历史可以保留旧项目名作为历史来源说明，不将这类历史说明判作运行时残留。已安装 tarball 中的真实 `pi-task-exec mcp serve` 成功启动 MCP；无参数不会启动服务；Registry 启动参数与通过测试的 CLI 契约完全一致。六个 `pi_*` 工具名在阶段 10 完成后应已全部改为 `task_*`；若仍为 `pi_*`，不得进入本阶段。
- **回滚方式**：丢弃未发布 tarball 和临时目录；修复后重新验收。
- **公开发布影响**：无。
- **人工决策**：Supervisor 最终包清单审阅。
- **当前验证记录（2026-10-09；不代表阶段 12 全部完成）**：根级迁移包在隔离 npm cache 中真实 `npm pack` 得到 73 个文件；实际解包检查通过，干净临时 npm prefix 安装后 CLI help/version 和 MCP stdio initialize/list-tools smoke 通过，六个当前 `pi_*` 工具均出现。阶段 12 原定依赖阶段 11，并规定阶段 10 的 `task_*` 契约完成后再做正式验收；本记录不改变这些依赖、范围或工具名，也不将当前局部验收声明为阶段 12 完成。

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
- **具体任务**：以根 `server.json` 发布 `io.github.zguiyang/pi-task-exec`；检查 `mcpName`、npm identifier、版本、repository URL 和 stdio 启动参数。**必须从 `server.json` 移除 `repository.subfolder: "mcp"`**（本仓库是单一产品根，而非 MCP 子项目），并确认该字段不再出现在发布记录中。`packages[].packageArguments` 必须与通过 tarball smoke test 的 `pi-task-exec mcp serve` 参数完全一致，即 **保持 positional arguments `["mcp", "serve"]`**，不得省略、换序、改为 flag 或使用未经测试的参数。
- **验收条件**：官方 Registry 返回该精确新 ID 和版本，包元数据对应 npm 公开版本；发布记录中无 `repository.subfolder: "mcp"`；Registry 启动参数为 positional `["mcp", "serve"]`，与公开 npm tarball 中真实 CLI 的启动入口一致。
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

## 2026-10-09 目录重构审查与实施记录（历史计划，已完成）

> **历史记录：** 本节保留选型 A 的只读审查、迁移映射、选择理由和分阶段实施拆解。根级迁移已在当前 checkout 完成；以下迁移步骤不再是待执行任务。当前结构、构建输出及打包验收状态以 README、本计划顶部状态和风险登记表 R31–R39 为准。阶段 9–15 的原实施范围保持不变。

### 迁移前只读审查结论（历史快照；迁移前路径不代表当前）

> **历史/非规范：** 以下“当前”均为选型 A 实施前的过渡状态快照，仅用于记录迁移起点，已被本节后续目标布局取代。

阶段 8 的提交为 `d996b2f`（本地 `main`，用户说明尚未推送），工作区检查干净。阶段 9 尚未开始。迁移前运行时代码与包配置采用过渡结构：`mcp/src/` 同时容纳 CLI、Host 安装器和 MCP runtime，测试在 `mcp/tests/`，TypeScript 输出在 `mcp/dist/`。`mcp/src/index.ts` 同时构建 CLI 依赖、路由参数并注册 MCP Server/工具，存在双向职责耦合；`mcp/src/cli.ts` 承担 CLI parser/command implementation，Host adapter 和计划/安全执行器也都位于当时的 MCP 模块。

迁移前的 `npm pack --dry-run --ignore-scripts --json` 因当时缓存权限错误退出，旧 checkout 中没有 `.tgz`。这一历史失败只描述选型 A 实施前的状态；它不代表当前 pack 状态。旧 manifest 和 `mcp/dist/` 文件树均为历史快照，不是当前包清单，也不得作为当前 tarball 证据。

当前按 manifest 推导的 tarball 文件树（迁移前历史）为：`package/package.json`、`package/README.md`、`package/LICENSE`、`package/server.json`、`package/mcp/README.md`、`package/mcp/LICENSE`、`package/mcp/dist/{adapters,cli,doctor,executor,identity,index,io,pi-rpc,plan,safety,skill,types,worker-manager}.{js,d.ts,js.map}`、`package/mcp/dist/hosts/{codex,jsonc,opencode,shared,toml,zed}.{js,d.ts,js.map}`，以及 `package/skills/pi-delegate/SKILL.md`、`package/skills/pi-delegate/references/mcp-contract.md`。根 `package-lock.json`、tests、源码和 node_modules 不在迁移前的 `files` 清单中。此树仅为迁移前 manifest 与旧 ignored dist 的路径推导，不代表当前包内容。当前真实 tarball 文件数与实际解包检查结果见风险登记表 R35；干净 npm prefix 安装后的完整 MCP stdio smoke 单独记录，不能由文件清单或解包 CLI help/version 替代。

### 选型 A tarball 预期（历史预测；当前以真实验收记录为准）

迁移并重新构建后，根 npm `files` 只允许包含以下路径；npm 自动带根 `package.json`：

- `package/package.json`
- `package/README.md`、`package/LICENSE`、`package/server.json`
- `package/bin/pi-task-exec.mjs`（薄启动器，仅调用 `../dist/cli/index.js`）
- `package/dist/**`：至少 `dist/cli/index.js`（CLI，含 `dist/cli/commands/`、`dist/cli/hosts/`、`dist/cli/installers/`、`dist/cli/plan/`）与 `dist/mcp/index.js`（MCP Server，含 `dist/mcp/tools/`、`dist/mcp/workers/`、`dist/mcp/rpc/`、`dist/mcp/runtime/`）
- `package/skills/pi-delegate/SKILL.md`、`package/skills/pi-delegate/references/mcp-contract.md`

必须排除：`mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/README.md`、`mcp/LICENSE`、`mcp/tsconfig.json`、根 `tests/`、根源码、架构草稿、`node_modules`、旧输出与开发机配置。`server.json` 不得再包含 `repository.subfolder: "mcp"`，`packageArguments` 保持 positional `["mcp", "serve"]`。这份预测清单只记录迁移时的预期；当前真实 tarball 检查结果见风险登记表 R35，不得以本清单代替验收。

### 迁移前路径到选定终态（选型 A）的迁移映射

| 迁移前路径 | 选定终态（选型 A） | 操作及关联更新 |
|---|---|---|
| `package.json` | `package.json` | 保留唯一根 manifest；调整 `bin`、`files`、build/test/typecheck/start/prepack scripts，不使用 Workspaces |
| `package-lock.json` | `package-lock.json` | 保持根级唯一锁文件；无 workspace 结构 |
| `server.json` | `server.json` | 保留根路径；参数仍为 `mcp serve`；移除过时 `repository.subfolder: "mcp"`，更新测试/架构说明 |
| `README.md` | `README.md` | 保留并合并现 `mcp/README.md` 有效说明；更新构建、checkout 入口、结构和 tarball 路径 |
| `LICENSE` | `LICENSE` | 保留根许可证并作为唯一包许可证来源 |
| `mcp/LICENSE` | 无（根 `LICENSE`） | 比较来源内容/归属后，不再重复分发；更新包 files 与说明 |
| `mcp/README.md` | `README.md` | 内容合并后删除重复文件；更新文档内部相对链接 |
| `mcp/docs/release-standard-baseline.md` | `docs/release-standard-baseline.md` | 移到根文档树，改正相对链接；根包是否分发此文档由 files 清单决定 |
| `mcp/.gitignore` | 无 | 删除模块忽略文件，把仍需的模式合并到根 `.gitignore` |
| `mcp/tsconfig.json` | 根 `tsconfig.json` | 重建为根配置，`rootDir: "."`、`outDir: "dist"`，include 根 `cli/**/*.ts`、`mcp/**/*.ts` |
| `mcp/src/adapters.ts` | `cli/hosts/adapters.ts` | 移动；修正所有相对 import；保持 adapter 接口与计划/doctor 类型兼容 |
| `mcp/src/cli.ts` | `cli/commands/index.ts` | 移动并重命名；CLI 主路由从 `cli/index.ts` 调用；更新 CLI tests |
| `mcp/src/doctor.ts` | `cli/commands/doctor.ts` | 移动；这是 Host/Skill 状态的 CLI doctor，不属于 MCP runtime |
| `mcp/src/executor.ts` | `cli/plan/executor.ts` | 移动；安全执行 Host 安装计划，不属于 MCP worker executor |
| `mcp/src/identity.ts` | `cli/identity.ts` 与 `mcp/runtime/identity.ts` | 按职责拆分产品/包/Skill 元数据与 MCP server 身份；禁止 MCP 导入 CLI；版本一致性由 package/server metadata test 约束 |
| `mcp/src/io.ts` | `cli/io.ts` | 移动；只供 CLI 输入输出 |
| `mcp/src/plan.ts` | `cli/plan/model.ts` | 移动并重命名；含 Host 安装计划、scope、launch spec、Skill target 规划 |
| `mcp/src/safety.ts` | `cli/plan/safety.ts` | 移动；路径边界、原子写入、备份、恢复、fingerprint 等安全原语 |
| `mcp/src/skill.ts` | `cli/installers/skill.ts` | 移动；当前 unavailable/stub installer 与后续真实 Skill installer 的接口归 CLI 安装层 |
| `mcp/src/hosts/codex.ts` | `cli/hosts/codex.ts` | 移动；改相对 import，接口和 scope 契约不变 |
| `mcp/src/hosts/zed.ts` | `cli/hosts/zed.ts` | 移动；改相对 import，接口和 scope 契约不变 |
| `mcp/src/hosts/opencode.ts` | `cli/hosts/opencode.ts` | 移动；改相对 import，接口和 scope 契约不变 |
| `mcp/src/hosts/shared.ts` | `cli/hosts/shared.ts` | 移动；改相对 import；Host 路径/安全能力仍归 adapter 层 |
| `mcp/src/hosts/jsonc.ts` | `cli/hosts/jsonc.ts` | 移动；JSONC Host config parser |
| `mcp/src/hosts/toml.ts` | `cli/hosts/toml.ts` | 移动；TOML Host config parser |
| `mcp/src/pi-rpc.ts` | `mcp/rpc/pi-rpc.ts` | 移动；更新 Worker import |
| `mcp/src/types.ts` | `mcp/workers/types.ts` | 移动；MCP Worker domain types |
| `mcp/src/worker-manager.ts` | `mcp/workers/manager.ts` | 移动并重命名；更新 MCP runtime import |
| `mcp/src/index.ts` | `mcp/index.ts` + `cli/index.ts` + `mcp/tools/*` + `mcp/runtime/*` | 拆分而非原样移动：MCP server/tool definitions 与 stdio lifecycle 留在 MCP；CLI process setup/argument routing 移至 CLI；工具按职责拆到 `mcp/tools/`；MCP 不导入 CLI |
| `mcp/tests/cli.test.mjs` | `tests/cli/cli.test.mjs` + MCP stdio smoke（实际合并在 `tests/mcp/runtime.test.mjs`） | 拆 CLI/parser/install-command tests 与 process/stdio MCP smoke；更新 dist/bin 路径 |
| `mcp/tests/installer.test.mjs` | `tests/hosts/installers.test.mjs` | 移动并改 import；保留三个真实 adapter、隔离环境、scope 和安装/移除语义 |
| `mcp/tests/fake-pi-contract.test.mjs` | `tests/mcp/fake-pi-contract.test.mjs` | 移动；更新任何 checkout fixture 路径 |
| `mcp/tests/mcp-runtime.test.mjs` | `tests/mcp/runtime.test.mjs` | 移动；导入 `dist/mcp/` 并更新 smoke fixture 路径 |
| `mcp/tests/worker-lifecycle.test.mjs` | `tests/mcp/worker-lifecycle.test.mjs` | 移动；导入 `dist/mcp/workers/`、`dist/mcp/rpc/` |
| `mcp/tests/security.test.mjs` | `tests/cli/security.test.mjs`（必要时拆 hosts 子集） | 安全原语/executor/spawnProcess 覆盖随所有权拆分；调整测试文件可读性，不删 141 项语义 |
| `mcp/tests/metadata.test.mjs` | `tests/cli/metadata.test.mjs` + `tests/skills/package-content.test.mjs` | 按 CLI/server metadata 与 Skill 包含断言拆分；根路径断言更新 |
| `mcp/tests/fixtures/fake-pi.mjs` | `tests/mcp/fixtures/fake-pi.mjs` | 移动；所有测试通过 `import.meta.url`/`fileURLToPath` 解析，不依赖 cwd |
| `skills/pi-delegate/**` | `skills/pi-delegate/**` | 不移动、不改源路径；阶段 9 从此根级资源目录读取 |
| `mcp/dist/**` | 根 `dist/cli/**`、`dist/mcp/**` | 旧 ignored 产物不搬运；删除旧输出后由根 build/prepack 重建 |
| `mcp/` | `mcp/` | 保留模块目录，但最终仅含 MCP Server、tools、workers、rpc、runtime；不得留下 CLI、tests 或 build 输出 |
| `mcp/src/` | `cli/` 与 `mcp/` | 按上表拆分所有源码后删除，不留过渡目录 |
| `mcp/tests/` | `tests/` | 按上表搬移/拆分测试后删除 |
| `mcp/dist/` | 根 `dist/` | 不搬运旧 ignored 文件；从新根配置全量重建后删除 |
| `mcp/docs/` | 根 `docs/` | 搬移其必要文档后删除旧目录 |
| 根 `.gitignore` | 根 `.gitignore` | 将 `mcp/dist/` 与 `mcp/.pi-task-exec/` 忽略项改为根 `dist/` 等实际需要的模式 |
| 根 `docs/architecture/*.md` | 同路径 | 保留并更新当前目录决策；README 的路径更新在后续实施阶段 |

选型 A 实施前，相对 TS imports 均为模块内 `./`、`../` 路径，迁移时需按新层级逐一修正；测试统一改为由 `tests/` 导入根 `dist/`。README 及 checkout 字符串中的 `mcp/dist/index.js`、`mcp/src`、`mcp/tests` 引用也属于迁移起点。旧 package `bin` 指向 `./mcp/dist/index.js`；build/typecheck 使用 `mcp/tsconfig.json`，test 使用 `mcp/tests/*.test.mjs`，start 运行 `mcp/dist/index.js`，旧 `files` 包含 `mcp/dist/**` 和 `mcp/README.md`。这些路径已由选型 A 迁到根 `dist/` 和根 tests。`server.json` 的 `packageArguments` 保持不变，迁移时只需核对启动入口并移除不再需要的 subfolder。

#### 迁移前相对导入/路径引用清单（迁移起点，非当前指令）

> **历史/非规范：** 下表逐项列出迁移前的相对导入，仅作为选型 A 迁移的起点清单，不构成当前路径指令。搬移后所有导入需按归属与新目录重算，测试只允许指向根 `dist/`，不允许再穿越到 `mcp/dist/`。

| 当前文件 | 当前相对引用 | 终态处理 |
|---|---|---|
| `mcp/src/adapters.ts` | `./plan.js`, `./identity.js`, `./hosts/codex.js`, `./hosts/opencode.js`, `./hosts/zed.js` | 改为 `cli/hosts/` 内 adapter registry 的相对引用 |
| `mcp/src/cli.ts` | `./adapters.js`, `./doctor.js`, `./identity.js`, `./io.js`, `./plan.js`, `./skill.js`, `./executor.js` | 全部改为 `cli/` 内相对路径；如拆 `commands/` 则从命令目录回到 `cli/` |
| `mcp/src/doctor.ts` | `./adapters.js`, `./plan.js`, `./skill.js`, `./identity.js` | 改为 CLI commands 到 CLI host/plan/installer/identity 的路径 |
| `mcp/src/executor.ts` | `./adapters.js`, `./io.js`, `./plan.js`, `./safety.js` | 改为 `cli/plan/` 到 CLI host/io/model/safety 的路径 |
| `mcp/src/identity.ts` | 无 | 拆为 CLI identity 与 MCP runtime identity；不建立跨层导入 |
| `mcp/src/index.ts` | `./adapters.js`, `./cli.js`, `./doctor.js`, `./io.js`, `./skill.js`, `./worker-manager.js` | 拆入口；`cli/index.ts` 调度 CLI，`mcp/index.ts` 只连接 MCP runtime 的本地模块 |
| `mcp/src/io.ts` | 无 | 保留在 CLI 层，无 import 改动 |
| `mcp/src/plan.ts` | `./adapters.js`, `./skill.js`, `./identity.js`, `./safety.js` | 改为 CLI plan 到 CLI host/installer/identity/safety 的路径 |
| `mcp/src/safety.ts` | 无仓库相对 import（含动态 `node:fs/promises`） | 移入 CLI 安全层；builtin import 不变 |
| `mcp/src/skill.ts` | `./plan.js` | 改为 CLI installer 到 CLI plan model 的路径 |
| `mcp/src/worker-manager.ts` | `./pi-rpc.js`, `./types.js`（其中 types 有第二次 `./types.js`） | 改为 MCP workers 到 `../rpc/pi-rpc.js` 和本地 worker types |
| `mcp/src/pi-rpc.ts` | `./types.js` | 改为 MCP rpc 到 `../workers/types.js` |
| `mcp/src/types.ts` | 无 | 移入 MCP workers；无仓库相对 import |
| `mcp/src/hosts/codex.ts` | `../adapters.js`, `../identity.js`, `../plan.js`, `./shared.js`, `./toml.js` | 改为 `cli/hosts/` 内 registry/model/identity/parser 路径 |
| `mcp/src/hosts/opencode.ts` | `../adapters.js`, `../identity.js`, `../plan.js`, `./jsonc.js`, `./shared.js` | 改为 `cli/hosts/` 内 registry/model/identity/parser 路径 |
| `mcp/src/hosts/shared.ts` | `../adapters.js`, `../plan.js`, `../safety.js` | 改为 CLI host 到 CLI registry/model/safety 的路径 |
| `mcp/src/hosts/zed.ts` | `../adapters.js`, `../identity.js`, `../plan.js`, `./jsonc.js`, `./shared.js` | 改为 `cli/hosts/` 内 registry/model/identity/parser 路径 |
| `mcp/src/hosts/jsonc.ts`, `mcp/src/hosts/toml.ts` | 无仓库相对 import | 移至 `cli/hosts/`；第三方 parser import 不变 |
| `mcp/tests/cli.test.mjs` | `../dist/cli.js`, `../dist/adapters.js`, `../dist/doctor.js`, `../dist/safety.js`, `../dist/skill.js`; `dist/index.js` entrypoint | 拆分后引用 `../../dist/cli/...`，stdio smoke 改为启动 `bin/pi-task-exec.mjs` |
| `mcp/tests/installer.test.mjs` | `../dist/adapters.js`, `cli.js`, `identity.js`, `hosts/jsonc.js`, `plan.js`, `skill.js`; fixture 字符串中的 `mcp/dist/index.js` | 改为 `../../dist/cli/...`；checkout 断言改为根 `dist/cli/index.js` |
| `mcp/tests/security.test.mjs` | `../dist/safety.js`, `../dist/executor.js`, `../dist/doctor.js` | 改为 `../../dist/cli/plan/...` 与 `../../dist/cli/commands/doctor.js` |
| `mcp/tests/metadata.test.mjs` | `../dist/cli.js`；运行时读取根 `package.json`、`server.json` | 改为根 dist CLI metadata 与根 package/server 断言 |
| `mcp/tests/mcp-runtime.test.mjs` | spawn `resolve(root, "dist/index.js")` | 从 `tests/mcp/` 启动薄 `bin/pi-task-exec.mjs mcp serve`；核验 JSON-RPC |
| `mcp/tests/worker-lifecycle.test.mjs` | `../dist/worker-manager.js` | 改为 `../../dist/mcp/workers/manager.js` |
| `mcp/tests/fake-pi-contract.test.mjs`, `mcp/tests/fixtures/fake-pi.mjs` | 无测试静态相对模块 import；fixture 由路径拼接使用 | 保留 fixture 解析但从 `tests/mcp/fixtures/` 计算，不依赖 cwd |

迁移起点中的 checkout 字符串断言 `join(repo, "mcp", "dist", "index.js")`（installer tests 多处）在选型 A 实施时改为 `join(repo, "dist", "cli", "index.js")`；README 的 `node mcp/dist/index.js`、`mcp/src`、`mcp/tests` 引用也已同步更新。当前 scripts、bin、files、server 路径应保持同一根级入口契约。

### 迁移分阶段实施拆解（历史记录；选型 A 已实施）

| 阶段 | 修改范围 | 验收条件 | 回滚方式 | npm tarball 影响 | 阶段 9 影响 |
|---|---|---|---|---|---|
| 1. 建立根级目录骨架 | 建立 `cli/`、`tests/`、根配置目标；先不改运行逻辑 | 所有者目录和预定产物路径清楚，无旧路径兼容承诺 | 删除空目录/撤销该提交 | 无 | 仍暂停 |
| 2. 移动 MCP runtime | `mcp/index.ts`、tools/workers/rpc/runtime；先隔离 MCP server | MCP 模块无 CLI/Host installer import；六工具契约保持 | 还原本阶段移动/拆分 | 暂不接受包 | 仍暂停 |
| 3. 移动 CLI 与 Host adapter | `cli/` 各子目录，Host adapter 全部归 CLI | CLI 功能与 host 契约完整，MCP 不含安装器 | 还原路径并保留阶段 2 的独立 MCP 边界 | 暂不接受包 | 仍暂停 |
| 4. 移动测试 | 全部测试与 fixture 到根 `tests/{cli,mcp,hosts,skills}` | 141 项既有测试语义有清单映射，所有导入定位根 dist | 恢复测试路径，源代码不动 | 无直接影响 | 仍暂停 |
| 5. 修改 TypeScript 构建配置 | 根 `tsconfig.json`，移除模块 tsconfig | 输入只含 CLI/MCP 源，输出为 `dist/cli/` 与 `dist/mcp/` | 恢复旧 tsconfig；不删除旧产物 | 构建路径改变，未接受包 | 仍暂停 |
| 6. 修改 package scripts | root build/typecheck/test/start/prepack 路径 | `test` 先 build；测试根路径；start 使用 CLI 路由 | 恢复 scripts | `prepack` 新产物布局 | 仍暂停 |
| 7. 修改 bin | 建薄 `bin/pi-task-exec.mjs` 并改 manifest bin | help/version/serve 由 CLI 入口路由，bin 无业务实现 | 恢复 bin 指向前保留旧文件 | tarball bin 路径改变 | 仍暂停 |
| 8. 修改 server.json | 保持 packageArguments；删除 subfolder | Registry schema 与 CLI 命令契约一致 | 恢复元数据行 | tarball metadata 改变 | 仍暂停 |
| 9. 修改所有 imports 和资源路径 | 源、测试、fixture、README 相对路径 | 无旧 dist/src/tests 路径；MCP/CLI 边界通过独立审查 | 按模块回退引用变更 | tarball 入口路径改变 | 仍暂停 |
| 10. 完整测试 | build/typecheck/141 项测试/MCP stdio smoke | 既有测试语义全部保留，命令契约与六工具正确 | 不通过则回到对应阶段，不进入清理 | 候选产物尚未发布 | 仍暂停 |
| 11. 真实 npm tarball 验证 | 干净 build、pack、解包、安装后运行 bin | 包含 dist/bin/Skill/文档/许可证/server；不含 tests/旧 mcp/dist；help/version/serve 正常 | 丢弃候选 tarball 与临时目录，修复重测 | **首次接受新包布局** | 通过后才可考虑开始 |
| 12. 删除旧目录 | 删除 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、旧 tsconfig/重复文档 | `rg` 无旧路径依赖；不留兼容 wrapper；完整回归通过 | 从该阶段提交回滚；根新结构仍保留 | 源包规则不变；旧路径消失 | 目录验收完成后解锁 |
| 13. 提交并推送 | 仅提交审查完成的迁移文件并推送授权分支 | diff、测试、tarball、文档和提交范围由 Supervisor 审阅 | revert commit；不做 force push | 若此前 tarball已验收则布局稳定 | 完成后独立启动阶段 9 |

选型 A 的实施保持了命令契约、adapter interface、scope、安全安装行为、六个现有 MCP tools 及 Skill 根源路径；当前仓库不保留 `mcp/src`、`mcp/tests` 或 `mcp/dist` 运行结构。阶段 9 安装器未在本轮实现。目录迁移收尾证据完成后，待 Supervisor 审查再按阶段 9 原范围决定启动；阶段 10–15 的范围、前置依赖和发布门槛不变。
