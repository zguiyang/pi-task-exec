# Pi TaskExec 架构决策记录

状态：架构决策历史记录；阶段 6 的 CLI 与产品标识实现由 2026-10-09 用户授权；2026-10-09 根级目录决策（选型 A）已批准
日期：2026-10-08
范围：架构与实施决策；本记录不授权修改运行时代码、Git、npm 或 MCP Registry。
当前权威目录决策：第 13 节（2026-10-09，选型 A）。第 3、4、10 节中出现的 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/tsconfig.json`、`repository.subfolder: "mcp"` 等是阶段 2–8 的迁移过渡历史，仅供记录来源，不构成当前或未来的执行指令。

## 1. 产品定位

Pi TaskExec 是供主 Agent 调用的 MCP 调度、连接和执行控制层，不是独立 Agent。它创建并管理 Pi Worker，将有边界的调查或实现任务交给 Worker；Supervisor 保留需求解释、架构决策、授权、集成、diff 审查和最终验收责任。

核心流程为：Supervisor → Pi TaskExec MCP → Pi Worker → 结构化状态/结果 → Supervisor 独立审查与验收。inspect/implement 是工具能力配置；direct/worktree 是工作目录模式。它们不是操作系统级安全沙箱。

## 2. 最终命名

| 用途 | 决策名称 |
|---|---|
| 产品 | Pi TaskExec |
| GitHub 仓库 | `zguiyang/pi-task-exec` |
| npm 包 | `@zguiyang/pi-task-exec` |
| CLI | `pi-task-exec` |
| MCP Registry ID | `io.github.zguiyang/pi-task-exec` |
| Skill | `pi-delegate` |
| Skill 目录 | `skills/pi-delegate/` |
| 首选 MCP 工具名 | `task_spawn`、`task_status`、`task_steer`、`task_continue`、`task_abort`、`task_list` |

新包名和新 Registry ID 是用户指定的目标名称。2026-10-08 阶段 1 的实际证据：`npm view @zguiyang/pi-task-exec` 返回 E404，表示该精确包名当前没有已发布包；这是当前可用性事实，不构成预留、发布权利或对未来注册的保证。官方 MCP Registry 对 `io.github.zguiyang/pi-task-exec` 的精确搜索返回 HTTP 200、count 0，无匹配记录；官方 `mcp-publisher validate` 对目标 server name 和 npm package identifier 校验通过。正式发布前仍须再次核对官方服务状态；若 `io.github.zguiyang/pi-task-exec` 届时已被占用，按用户要求停止，不回退到旧名称。

发布身份在阶段 1 已确认：`gh api user` 为 `zguiyang`，`gh repo view` 显示仓库为 PUBLIC 且当前账号为 ADMIN；`npm whoami` 为 `zhaoguiyang`，`npm org ls zguiyang` 显示该账号为 owner。尚未实际执行 Registry OAuth/OIDC 发布；未来 OIDC 发布工作流需要 `id-token: write` 权限。

## 3. npm 与 MCP Registry

迁移历史说明：本节中提到的旧 CLI alias 仅记录新产品身份替换旧身份的决定。

- 使用单一根 npm 包；`package.json`、`package-lock.json` 位于仓库根目录。名称取 `@zguiyang/pi-task-exec`，bin 仅提供 `pi-task-exec`，不提供旧 `pi-worker-mcp` alias。
- 包名和 Registry server name 不要求相同。根 `package.json` 的 `name` 与 `server.json.packages[].identifier` 必须分别填入 npm 包名；根 `package.json.mcpName` 必须精确匹配 `server.json.name`，即 `io.github.zguiyang/pi-task-exec`。
- `package.json.version`、`server.json.version` 和 `server.json.packages[].version` 必须完全一致，且为精确版本，不使用范围或 `latest`。
- `server.json` 放仓库根目录，便于根包发布、Registry 校验和 CI 版本同步。其 `repository.url` 与 `websiteUrl` 使用新仓库地址。**（历史，已被第 13 节 2026-10-09 根级目录决策取代）** 早期方案曾把 `repository.subfolder` 设为 `mcp` 指向 MCP 源码模块；现选定单一产品根布局，应从 `server.json` 移除 `repository.subfolder: "mcp"`，`packageArguments` 保持 positional `mcp`、`serve` 不变。Registry 的 generic `server.json` 规范支持 `repository.subfolder`，但本仓库不再需要该字段。
- Registry npm package entry 声明 `transport.type: "stdio"`，并通过 `packageArguments` 传入 positional arguments `mcp`、`serve`。它必须与 Host 配置和实际 CLI 完全一致；唯一明确启动契约是 `pi-task-exec mcp serve`。
- Registry ID 是独立于 npm 包名的标识。改 npm 名不会自动创建或占用 Registry ID；阶段 1 已完成 npm 精确查询、Registry 精确搜索和 namespace 发布身份确认。
- 阶段 1 证据：npm 精确查询返回 E404（当前无已发布包），MCP Registry 精确搜索返回 HTTP 200、count 0，官方 `mcp-publisher validate` 通过。这些结果只反映当前状态，正式发布前仍需再次核对；E404 不代表预留或发布权利。

## 4. 目录与构建（历史布局，已被第 13 节取代）

> **历史/非规范：** 本节的 `mcp/src/`、`mcp/tests/`、`mcp/dist/`、`mcp/tsconfig.json` 以及 `files`/测试路径描述，是阶段 2–8 的迁移过渡结构，已被 2026-10-09 根级目录决策（第 13 节，选型 A）取代。保留仅用于记录迁移来源，不构成当前或未来的执行指令；当前布局见第 13 节。

保留 MCP 和 Skill 的模块边界，不使用 npm Workspaces：

```text
.
├── package.json
├── package-lock.json
├── README.md
├── LICENSE
├── server.json
├── mcp/
│   ├── src/
│   ├── tests/
│   ├── dist/
│   ├── tsconfig.json
│   └── README.md
├── skills/
│   └── pi-delegate/
│       ├── SKILL.md
│       └── references/
├── docs/
│   └── architecture/
└── .github/workflows/
```

根 npm 包的 `files` 至少包括 `mcp/dist/**`、`skills/pi-delegate/**`、根 README、MCP README、最终确认的 LICENSE/NOTICE 和 `server.json`。不打入测试、node_modules、本机 `.codex` 配置或无关架构草稿。npm 包安装后应同时包含可运行 MCP 和完整 Skill 目录。

迁移前，`mcp/tsconfig.json` 的 `rootDir: "src"`、`outDir: "dist"` 都以 tsconfig 所在目录为基准；在 `mcp/tsconfig.json` 不移动的前提下，根脚本运行 `tsc -p mcp/tsconfig.json`，仍生成 `mcp/dist/`。当时测试以 `mcp/tests/*.test.mjs` 相对导入 `mcp/dist/`；根 test 脚本应先构建，再运行 `node --test --test-concurrency=1 mcp/tests/*.test.mjs`。迁移前要求在临时目录通过 npm tarball 实测这些相对路径。

迁移前 `prepack` 可构建 `mcp/dist/`；`files` 需包含 Skill 原目录。`dist/` 作为生成物由 build/prepack 生成；当时迁入的 `dist/` 不在该阶段删除。根包不增加 `main`/`exports`，除非明确决定对外支持程序化导入 API。

## 5. CLI 决策

迁移历史说明：本节提到的旧 CLI 命令与旧配置 key，仅用于记录退役范围。

完全退役旧 CLI 名称，不保留旧 bin、alias、wrapper、旧包名安装命令或 deprecated 过渡代码。新 CLI 命令为：

- `pi-task-exec add mcp`：为明确选择的 Host 和 scope 写入/更新 MCP 条目。
- `pi-task-exec add skill`：安装 npm 包内的 `skills/pi-delegate/`。
- `pi-task-exec setup`：预览并组合 MCP 与 Skill 安装。
- `pi-task-exec doctor`：只读检查 Node、Pi、Git、Host 配置、Skill 文件和契约版本。
- 建议增设 `pi-task-exec remove mcp|skill` 以支持显式卸载和回滚；这是新接口，不延续旧 `uninstall` 命令。
- `pi-task-exec mcp serve` 是 MCP Registry 和所有 Host 配置使用的明确服务启动入口，必须单独实现并测试。
- `pi-task-exec` 无参数时不得启动 MCP；应显示清晰帮助/错误并返回明确状态，不保留含糊的旧默认行为。

旧 CLI 中可复用的是 Host 配置路径/格式适配思路、JSON/TOML 解析边界、原子文件替换、Pi/Git 检查思路及选择参数模型。必须重写产品命名、入口与参数路由、MCP server key、包名/启动命令、用户确认与计划预览、备份/恢复/冲突处理、Windows 路径与编码处理。必须删除旧 bin `pi-worker-mcp`，以及 `serve/setup/doctor/update/uninstall/version` 旧顶层命令面；需要的功能映射到新 `mcp serve`、`setup`、`doctor`、`add`、`remove` 和 `--version`。

所有写操作都应先展示文件清单、scope、冲突和备份策略；默认只处理用户明确选定的 Host，不静默写入所有 Host。支持 `--dry-run`。新命令不复用旧配置键 `pi-worker-mcp`。

## 6. Skill 安装

第一阶段只实现通用 Agent Skills 目录，不做 Pi/Codex/Cursor 专用目录适配：

- project：`<cwd>/.agents/skills/pi-delegate/`。建议作为首次安装默认值，因为改动范围可见且随项目共享；必须说明项目/Host trust 影响。
- global：`<home>/.agents/skills/pi-delegate/`，通过 `--scope global` 显式选择。
- 始终支持 `--scope project|global` 和 `--dry-run`。交互式 setup 默认展示计划，不默认写所有 Host 或全局目录。
- 内容相同则报告已安装/无变化，保持幂等。已存在不同内容时默认停止并保留原文件，不覆盖；用户显式选择备份后替换时，生成带版本/时间标记的备份并记录安装 manifest。
- 将目录复制到同一文件系统下的临时 staging 目录，验证必需文件与兼容清单，再原子 rename；跨卷不能原子 rename 时采用备份 + 恢复策略并报告状态。
- 回滚只恢复安装器记录管理且用户未改动的版本；若检测到用户修改，停止自动恢复，保留文件并给出备份位置。
- 路径解析使用 Node `os.homedir()`，Windows 接受 `USERPROFILE`/系统 home 语义；不自行拼接 POSIX `~`，不依赖仅 `HOME`。拒绝越过目标目录的路径和符号链接替换。

Pi 官方文档列出 `~/.agents/skills/` 与 `.agents/skills/` 为通用 Agent Skills 位置；Pi 专用位置属于本阶段明确不实现的 Host 特殊适配。[Pi Skills 文档](https://pi.dev/docs/latest/skills)

## 7. MCP 工具命名

首发 MCP 协议使用以下工具名：

- `task_spawn`
- `task_status`
- `task_steer`
- `task_continue`
- `task_abort`
- `task_list`

不保留 `pi_*` 兼容 alias。产品/仓库已采用 Pi TaskExec 命名，工具 API 可表达任务调度能力而不锁死实现后端；将来增加执行后端时，名称不会隐含 Worker 必须是 Pi。该选择只中立化工具名，不代表本阶段承诺支持非 Pi 后端。

发布前必须同步更新 MCP 源码、Skill、`references/mcp-contract.md`、MCP 契约测试、README、示例、CLI 文档及 Registry 描述。工具 schema、Skill 调用方式、references 和测试必须以同一契约为准；只改其中一部分不满足验收。

旧工具名只允许出现在迁移历史说明中，不得出现在运行时协议、Registry 当前工具描述或 npm 安装后提供的文档和示例里。安装包内容需做残留扫描；只有明确标注为旧接口/迁移历史的非安装历史材料可以提及旧名。

工具描述要统一 Delegation-First 原则：任务一旦有明确目标、上下文、边界、完成检查和副作用说明，原子执行任务可委派，不以任务大小作为门槛；仍不把架构选择、歧义决策、授权或最终验收交给 Worker。迁移时删除旧 MCP 描述中“只在节省上下文或有效并行时才委派、trivial edits 留给 Supervisor”的冲突表述。

## 8. Worker 契约事实与边界

- `inspect` 只提供 `read/grep/find/ls`，不能执行 bash、测试或构建。
- `implement` 提供编辑、写入与 bash 能力；`PI_WORKER_ALLOWED_ROOTS` 与任务文本不是操作系统级写入沙箱。
- `direct` 使用原 checkout，失败可能留下部分修改；Supervisor 必须检查实际 diff。
- `worktree` 从 Git `HEAD` 创建隔离 worktree；staged、unstaged 和 untracked 内容不会自动复制。基线必须由 Supervisor 预先确认。
- `pi_continue` 语义应在新工具中保留：运行中的 Worker 接受排队 follow-up；settled Worker 可开启后续 cycle；profile 和 mode 不变；不相关任务需新 Worker。
- Pi Worker 使用 `--no-session`；状态保存在活动 MCP 进程内存中，不是跨 MCP 重启的持久会话。
- terminal Worker 不可复活；abort 不会撤销 direct 修改，也不会自动删除 worktree。
- Skill 和工具描述都应准确说明以上边界，禁止暗示 Worker 结果等于验收通过。

## 9. MCP Host 与跨平台

第一阶段支持当前已有适配器的 Codex、Zed、OpenCode，不增加其它 Host。项目级和用户级范围需要各自经过三平台验收；某 Host 若平台不支持某配置方式，则 doctor 明确报告而不是猜路径写文件。

配置路径的实现约束：

- **Codex**：用户级遵循 `$CODEX_HOME/config.toml`，未设置时取用户 home 下 `.codex/config.toml`；项目级为当前项目 `.codex/config.toml`。使用 TOML-aware 更新，保留其它 section 和注释；不能用简单正则误删相邻配置。
- **Zed**：使用 `.zed/settings.json` 项目配置；用户级路径按平台/XDG 与官方设置路径实现，并由 doctor 显示解析出的实际路径。现有代码的 macOS `~/.zed` 与其他平台 `.config/zed` 规则应重新核实，不得直接沿用成跨平台结论。Zed 官方说明项目配置文件为 `.zed/settings.json`，且未信任项目可能不会运行其 MCP 配置。[Zed MCP 文档](https://zed.dev/docs/ai/mcp) [Zed worktree trust](https://zed.dev/docs/worktree-trust)
- **OpenCode**：使用 `opencode.json(c)` 所定义的 `mcp` 配置。项目级配置写入项目根；用户级按 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME` 和各 OS 默认规则解析。官方文档允许环境变量重定向配置位置。[OpenCode config](https://dev.opencode.ai/docs/config) [OpenCode CLI 配置变量](https://docs.opencode.ai/docs/cli/)
- 在 macOS/Linux 优先尊重 Host 自身 XDG 与环境变量规则；在 Windows 正确使用 `USERPROFILE`/`APPDATA` 和 Host 提供的 override，处理盘符、UNC、反斜杠和带空格路径。进程启动字段传结构化 argv，避免 shell 转义。
- JSON 可用 AST/保注释 parser，或严格 JSON parser 并在无法安全保留 JSONC 时拒绝写入。TOML 使用 TOML parser/语法级编辑。不支持安全解析时不覆盖文件。
- 写入前保存原始内容和权限信息；使用同目录临时文件 + 原子 rename；冲突时默认不覆盖；重复运行相同版本幂等；remove 只删除本工具独有条目，保留其它 Host 配置和文件内容。
- `setup` 不替用户接受 Zed/Codex project trust，也不设置 Pi provider、凭据或默认模型。

## 10. Codex 本机配置

Phase 2 已从本新仓库删除 `mcp/.codex/config.toml`：该文件含旧 checkout 的绝对 Node 路径、旧 `dist/index.js` 路径、旧 cwd、MCP key `pi_worker` 以及旧仓库范围的 `PI_WORKER_ALLOWED_ROOTS`，不可移植，不应随新仓库迁移。该删除不修改旧源仓库；本新仓库未创建根 `.codex/`。

目前没有发现可作为新仓库默认配置的通用 Codex MCP 配置。根 `.codex/` 只有在以后需要共享、相对路径且不含本机环境值的配置时才添加；本次建议不创建根 `.codex/`。

## 11. 版本、发行与许可证

- MCP、CLI、Skill 使用一个 npm semver 发布单元；Skill 的 `metadata.version` 可以保留作 Skill 修订号，但另加机器可读兼容声明，例如 `metadata.min-mcp-contract: "1"`，并通过包内 manifest/CI 检查。
- 新发布线建议从 `0.2.0` 开始，而不是直接 `1.0.0`：包名、CLI 和工具 API 都变化，现阶段还没有完整 CI、跨平台验收或公开安装验收。升至 `1.0.0` 应由后续稳定性门槛决定。
- `0.2.0` 是建议，最终版本号须在 npm/Registry 名称可用性、实际迁移 diff 和发布策略审查后决定。
- MCP 当前许可证为 MIT。Skill 再分发授权已在阶段 1 确认：JoeyZhao 确认 Skill 为其直接创作并持有版权，同意以 MIT 再分发，且无需单独 NOTICE。Skill frontmatter 已声明 `license: MIT`，原“公开发布阻塞项”已解除。Pi Skills 标准支持 `license` frontmatter 字段。[Pi Skills 格式](https://pi.dev/docs/latest/skills)

## 12. 仍需人工决定

阶段 1 已完成：Skill 再分发许可与许可证表达方式已由 JoeyZhao 确认（直接创作/版权、MIT 再分发、无需单独 NOTICE；Skill frontmatter 已声明 `license: MIT`）；npm/Registry 精确可用性与 namespace 发布身份已核实（npm E404、Registry 精确搜索 HTTP 200/count 0、`mcp-publisher validate` 通过、发布身份已确认）。正式发布前仍需再次核对，且实际 OAuth/OIDC 发布尚未执行。

1. 接受 `task_*` MCP 工具命名与 `0.2.0` 初始版本建议。
2. 确认 `pi-task-exec remove mcp|skill` 是否纳入首期命令集。
3. 确认 Node 支持基线；Node 20 已 EOL，建议至少从 Node 22 起支持，并在 CI 覆盖 Node 22/24 及当前发布线评估。
4. 确认各 Host 在 Windows 的 MCP 配置位置和可支持范围；不得以现有代码路径推测为已支持。

## 参考资料

- [MCP Registry generic server.json](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
- [MCP Registry npm ownership verification](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx)
- [MCP Registry official requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Zed MCP](https://zed.dev/docs/ai/mcp)
- [OpenCode config](https://dev.opencode.ai/docs/config)
- [OpenCode CLI](https://docs.opencode.ai/docs/cli/)
- [Node.js release schedule](https://github.com/nodejs/Release)

## 13. 2026-10-09 目录边界复审（覆盖第 3、4 节旧布局与 `mcp` subfolder 决策）

**状态：选型 A（根级布局）已实施。** 本节记录已完成的根级结构及其依据，并取代第 3 节的 `repository.subfolder: "mcp"` 与第 4 节的旧目录/构建描述。早期 `mcp/src/`、`mcp/tests/`、`mcp/dist/` 仅为迁移历史路径，不是当前运行结构。阶段 9（Skill 安装器）尚未开始；本轮收尾验收后交由 Supervisor 审查是否启动，不与目录迁移混做。

产品由一个根 npm 包、一个 CLI 入口、MCP Server 和 Skill 组成。根目录统一管理 CLI、MCP、Skill、测试和文档；不使用 npm Workspaces。当前边界为：

```text
.
├── package.json / package-lock.json / README.md / LICENSE / server.json
├── bin/pi-task-exec.mjs
├── cli/{index.ts,commands/,hosts/,installers/,plan/}
├── mcp/{index.ts,tools/,workers/,rpc/,runtime/}
├── skills/pi-delegate/{SKILL.md,references/}
├── tests/{cli/,mcp/,hosts/,skills/}
├── docs/architecture/
└── dist/                         # 根级生成物，由 Git 忽略
```

`cli/` 只放 CLI、Host adapter、安装器、计划模型和安全执行器；`mcp/` 只放 MCP Server、工具、Worker、RPC 和运行时；`skills/` 只放 Skill；统一测试和文档分别位于根 `tests/` 与 `docs/`。不保留 `mcp/src/`、`mcp/tests/`、`mcp/dist/`，不把 CLI 放进 MCP，也不把 Host 安装器放进 MCP runtime。`bin/` 仅是薄启动器。Skill 源路径固定为 `skills/pi-delegate/`。

### 结构选型

| 方案 | 评价 | 决定 |
|---|---|---|
| A：根 `cli/`、`mcp/`、`skills/`、`tests/`、根 `dist/` | 模块职责直接可见；测试不隶属于某个模块；包路径与最终产品边界一致；Skill 安装器可从包根稳定定位 `skills/pi-delegate/`；不保留过渡 `src/` 包装层 | **推荐** |
| B：根 `src/cli/`、`src/mcp/`，其余根级 | 源码都统一在 `src/`，但与产品模块命名不一致；`dist/` 镜像层级更深；测试、Skill 源路径与产物之间需要多套约定 | 不选 |
| C：`cli/`、`mcp/` 各自保留 `src/tests`，根 `dist/` | 统一测试仍被拆散；TypeScript 输出根、测试导入和包规则更复杂；保留旧层次且不满足统一测试目录目标 | 不选 |

### 根构建、入口和分发

- 根 TypeScript 配置从 `cli/**/*.ts` 与 `mcp/**/*.ts` 编译到根 `dist/`。根 `tsconfig.json` 使用 `rootDir: "."`、`outDir: "dist"`，显式 include 两个源码目录，并排除 `tests/`、`dist/`、`node_modules/`。
- 编译产物固定为 `dist/cli/index.js`（CLI）和 `dist/mcp/index.js`（MCP Server）。CLI 的 `mcp serve` 路由调用 MCP 启动函数；MCP 模块不反向导入 CLI。正常 CLI 命令不初始化 MCP runtime。
- `bin/pi-task-exec.mjs` 只导入/调用 `../dist/cli/index.js`；根 `package.json.bin` 指向薄入口。checkout 启动参数改为 `node <checkout>/dist/cli/index.js mcp serve`；npm 安装参数仍为 `npx -y @zguiyang/pi-task-exec@<version> mcp serve`。
- 根 `build`/`prepack` 先清理根 `dist/`，再生成完整根级编译产物；不再生成或读取 `mcp/dist/`。根 `.gitignore` 忽略 `dist/`。临时副本污染测试曾确认旧文件会被原 `tsc` 构建保留并打包；现有 `build` 已增加跨平台 Node 内置清理步骤，修复后的污染重测证据记录在风险登记表 R39。
- `server.json` 仍在根目录；`packageArguments` 保持 positional `mcp`、`serve`。由于仓库是单一产品根而非 MCP 子项目，`repository.subfolder: "mcp"` 应移除。版本、npm identifier、Registry ID 约束不变。
- npm `files` 包含根 `dist/**`、薄 `bin/`、完整 `skills/pi-delegate/**`、必要根文档、许可证和 `server.json`；npm 自动带根 `package.json`。不含 `mcp/dist/**`、`mcp/README.md`、`mcp/LICENSE`、tests、源码、架构草稿、node_modules 或旧输出。
- 真实 tarball 验收分开记录包文件内容/解包检查与干净 npm prefix 安装后的完整 MCP stdio smoke；当前 73 文件 tarball 的实际解包检查及安装后 CLI/MCP initialize/list-tools 均已通过。阶段 12 仍受其原定阶段 11 与阶段 10 契约迁移前置条件约束，本轮证据不改变该计划范围。

### 测试约定

- 根 `npm test` 先构建，再运行根 `tests/`；迁移前基线为 141 项。本轮根布局回归实际为 142 项，测试源码扫描未发现 skip、todo 或 only。
- 测试从 `tests/` 通过稳定相对路径导入根 `dist/`，例如 `../../dist/cli/...`、`../../dist/mcp/...`。fake adapters 用于计划、冲突和隔离写入测试；真实 Codex、Zed、OpenCode adapters 仍使用临时 home/cwd 与 mock 环境验证格式、路径、指纹、备份/回滚。
- MCP smoke test 从薄 `bin/` 启动 `mcp serve`，经 stdio 执行 initialize/list-tools，确认六个现有 `pi_*` 工具和 JSON-RPC 响应。fake Pi 与真实 adapter 的测试边界不变。
- tarball smoke 在临时目录解包或从压缩包运行，不依赖源码 checkout、npm link、`mcp/dist` 或开发机配置。

目录迁移必须保持 `pi-task-exec mcp serve`、help/version、`add mcp`、`remove mcp`、`setup --target mcp`、`doctor` 契约；三种 Host adapter 接口与 project/global scope；dry-run、计划、冲突检测、备份、回滚、fingerprint；六个现有 `pi_*` MCP 工具；Skill 路径；根 `package.json`、根 `server.json` 和 MCP/Skill tarball 分发语义。阶段 9 只能在目录迁移、完整测试与真实 tarball 验收完成后开始。
