# Pi TaskExec

Pi TaskExec 通过 MCP 将明确的编码任务委派给本地 [Pi](https://pi.dev) 工作进程，让主智能体专注于规划、决策与评审，减少在不同智能体之间切换和手动复制上下文的麻烦。

这个项目源于作者自己的工作方式：使用不同的模型或订阅计划，分别承担规划评审和具体执行。如果你也有多个 AI 编码订阅或模型资源，可以尝试用这种分工更充分地利用它们，并减少执行细节对主智能体上下文的占用。

作者仍在验证这种方式对上下文占用、总 token 消耗和实际费用的影响，目前不保证一定更省。它首先解决作者自己的协作问题，也希望能帮助有类似需求的人。欢迎尝试，并通过 [Issue](https://github.com/zguiyang/pi-task-exec/issues) 分享使用体验、不同意见和改进建议。

[English](README.md) | [简体中文](README.zh-CN.md)

## 核心能力

- 在本地 Pi 上执行任务，并使用 Pi 本地配置的默认模型。
- 完整的工作进程生命周期：spawn、status、steer、continue、abort、list。
- 只读 `inspect` 与可读写的 `implement` 能力配置。
- `direct` 就地修改或隔离的 `worktree` 工作目录模式。
- 面向 Codex、Zed、OpenCode 的统一 MCP + `pi-delegate` Skill 安装。

## 环境要求

- Node.js >= 22.20
- 已安装并配置好的 [`pi`](https://pi.dev) 可执行文件
- 使用 `worktree` 模式时需要 Git

## 快速开始

在要配置的项目中运行统一安装：

```sh
npx -y @zguiyang/pi-task-exec@latest setup
```

命令会提示选择宿主与作用域，打印 MCP 与 Skill 的写入计划并请求确认。也可以
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
- 委派策略：[skills/pi-delegate/SKILL.md](skills/pi-delegate/SKILL.md)
- 许可证：[LICENSE](LICENSE)

---

[English](README.md) | [简体中文](README.zh-CN.md)
