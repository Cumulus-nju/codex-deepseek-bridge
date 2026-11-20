# Codex ↔ DeepSeek Harness Bridge

本地桥接器让 Codex 派发阶段任务，由 DeepSeek Harness 执行并交回结果。派发会立即返回 `job_id`，执行成功后进入 `awaiting_review`，由 Codex 或用户查看产物、独立验证，再记录评估。

## 配置

需要 Node.js 和已配置好模型凭据的 DeepSeek Harness。无界面模式已在 Harness `0.1.1-rc.2` 上验证；测试和 Windows 可见模式使用 Node.js 24 与 PowerShell 7。可见模式另需 `@deepseek-harness-tui/dsh-tui`，已验证版本为 `0.10.1`。

1. 将 `config.example.json` 复制为 `config.json`，把示例路径换为本机的绝对路径。`dshBin` 指向 `dsh` 的 JavaScript 入口，`dshHome` 指向 Harness 配置目录，`allowedRoots` 填允许派发任务的现有工作区，`stateDir` 用于保存任务和日志。
2. 运行 `node ./bridge.mjs list` 检查配置。需要注册到 Codex 时，将下面的路径换成克隆目录的绝对路径，运行注册命令。

```powershell
codex mcp add deepseek-bridge -- node '<clone>/bridge.mjs' --config '<clone>/config.json' serve
```

`allowedRoots` 限制可派发的工作目录。实际文件和命令权限由 Harness 执行。`config.json` 和运行状态应留在本机；模型凭据由 Harness 自己读取。

### 可见的 DeepSeek TUI

在 Windows 上将 `windowMode` 改为 `tui`，补齐以下本机绝对路径字段。

| 字段 | 用途 |
| --- | --- |
| `tuiHome` | 桥接专用 Harness 目录 |
| `tuiPackage` | 已安装的 `@deepseek-harness-tui/dsh-tui` 包目录 |
| `credentialsPath` | Harness 的凭据文件路径 |
| `settingsPath` | Harness 的设置文件路径 |
| `powershellPath` | `pwsh.exe` 的绝对路径，避免新终端查找失败 |
| `terminalPath` | 可选，Windows Terminal `wt.exe` 的绝对路径 |

可见模式为每次启动的阶段打开一个独立 TUI 窗口，显示任务、工具执行和回复。阶段结束后窗口保留供查看。当前版本的 `previous_job_id` 只传递任务交接信息，同一个 TUI 对话内的续聊不在此版本的功能范围内。对需要保持现有对话的项目，通过原 TUI 已验证的续聊入口继续。

## 使用

| MCP 工具 | 用途 |
| --- | --- |
| `deepseek_start` | 派发任务 |
| `deepseek_status` / `deepseek_result` | 查询进度 / 查看结果 |
| `deepseek_feedback` | 记录提供给下一阶段的补充要求 |
| `deepseek_review` | 记录验收通过、要求修改或停止的决定 |
| `deepseek_cancel` | 请求取消正在执行的阶段 |
| `deepseek_list` | 列出本地任务 |

也可以直接运行 CLI。

```powershell
node ./bridge.mjs start --cwd '<workspace>' --task-file '<task.md>'
node ./bridge.mjs result --job '<job-id>'
node ./bridge.mjs review --job '<job-id>' --decision approve --notes '已核验交付物与测试结果'
```

工作目录重叠时，桥接只允许一个阶段执行。完成后先核验交付物，再记录评估。`adapterMode: legacy` 使用旧版 Harness 的文本输出；`json` 是新版 CLI 的实验适配。

## 测试

```powershell
npm test
```

测试使用模拟 Harness 和 Agent，覆盖派发、评估、跨阶段反馈、工作区限制、取消、超时、MCP 发现和可见模式的结果回传，无需模型调用。
