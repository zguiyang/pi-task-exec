# Pi TaskExec

Pi TaskExec 让主智能体按需通过 MCP 将边界明确的调查、分析、实现或验证任务交给本地 [Pi](https://pi.dev) 工作进程。委派收益不足时，主智能体可以直接完成任务。

这个项目源于作者自己的工作方式：使用不同的模型或订阅计划，分别承担规划评审和具体执行。如果你也有多个 AI 编码订阅或模型资源，可以尝试用这种分工更充分地利用它们，并减少执行细节对主智能体上下文的占用。

作者仍在验证这种方式对上下文占用、总 token 消耗和实际费用的影响，目前不保证一定更省。它首先解决作者自己的协作问题，也希望能帮助有类似需求的人。欢迎尝试，并通过 [Issue](https://github.com/zguiyang/pi-task-exec/issues) 分享使用体验、不同意见和改进建议。

[English](README.md) | [简体中文](README.zh-CN.md)

## 核心能力

- 在本地 Pi 上执行任务，默认使用 Pi 本地配置的模型，也可按 Worker 指定 `model` 和 `thinking`。
- 完整的工作进程生命周期：spawn、带界等待的 status、steer、continue、取消（`pi_abort`）、释放（`pi_release`），以及 list。
- 只读 `inspect`（默认）与可读写的 `implement` 能力配置。
- 工作目录由 Supervisor 指定；MCP 仅做授权校验，绝不创建 worktree 或分支。
- 面向 Codex、Zed、OpenCode 的统一 MCP + `pi-delegate` Skill 安装。

## 环境要求

- Node.js >= 22.20
- 已安装并配置好的 [`pi`](https://pi.dev) 可执行文件

## 快速开始

在要配置的项目中运行统一安装：

```sh
npx -y @zguiyang/pi-task-exec@latest setup
```

> v0.3.1 是当前已发布版本；此工作区正在准备采用按需委派策略的 v0.3.2。v0.3.0 的
> 工作进程接口变更仍然适用；如果从 v0.2.2 升级，请先阅读
> [v0.3.0 迁移说明](docs/usage.md#version-compatibility-v030)。

命令会提示选择宿主与作用域，打印 MCP 与 Skill 的写入计划并请求确认。
`pi-delegate` Skill 会从本仓库（`skills/pi-delegate`）按匹配的发布标签，
经固定版本 Skills CLI `skills@1.7.1` 安装。也可以
预先指定选项（仍需确认）：

```sh
npx -y @zguiyang/pi-task-exec@latest setup --host codex --scope project
```

完成后重启宿主，按提示授予项目信任，并在宿主内确认 `pi_list` 可用。

## 命令

```sh
npx -y @zguiyang/pi-task-exec@latest update
npx -y @zguiyang/pi-task-exec@latest doctor
npx -y @zguiyang/pi-task-exec@latest doctor --probe
```

`update` 会替换受管 MCP 条目与 Skill 文件，之前配置的自定义设置需要重新
提供。`doctor` 为只读检查；`--probe` 仅检查包运行时，绝不创建工作进程。

## 了解更多

- 完整使用参考：[docs/usage.md](docs/usage.md)
- v0.3.2 发布准备：[docs/release-v0.3.2.md](docs/release-v0.3.2.md)
- v0.3.1 发布说明：[docs/release-v0.3.1.md](docs/release-v0.3.1.md)
- v0.2.2 → v0.3.0 迁移：[docs/usage.md](docs/usage.md#version-compatibility-v030)
- 委派策略：[skills/pi-delegate/SKILL.md](skills/pi-delegate/SKILL.md)
- 许可证：[LICENSE](LICENSE)

---

[English](README.md) | [简体中文](README.zh-CN.md)
