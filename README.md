# Windows Codex App 手机连接指南

> A practical guide for connecting ChatGPT/Codex mobile to a Windows Codex desktop host.

## 状态说明

截至 2026-05，OpenAI 官方文章说明 Codex 已进入 ChatGPT mobile preview，并通过 secure relay 连接正在运行 Codex 的机器；同一篇文章也说明，手机连接 Windows Codex app 的支持仍是 “coming soon”。因此，本指南记录的是一个非官方 Windows 绕过/调试流程，可能随 Codex 版本更新失效。

建议把它当作高级调试手册，而不是稳定产品说明。

## 快速上手

### 1. 准备条件

你需要：

- Windows 上已安装 Codex Desktop。
- 已用同一个 ChatGPT 账号登录 Windows Codex 和手机 ChatGPT/Codex。
- 已安装可运行 `node` 的 Node.js，建议 Node.js 22 或更新版本。
- Windows 上的 `codex` CLI 可用，或已通过 npm 安装 `@openai/codex`。
- 手机和电脑能正常访问 ChatGPT/OpenAI 服务。代理、TUN、公司网络、DNS 或防火墙都可能影响 relay 长连接。

### 2. 打开并锁定配置

编辑：

```text
%USERPROFILE%\.codex\config.toml
```

确保有：

```toml
[features]
remote_connections = true
remote_control = true
```

然后把配置设为只读：

```powershell
attrib +R "%USERPROFILE%\.codex\config.toml"
```

检查：

```powershell
(Get-Item -LiteralPath "$env:USERPROFILE\.codex\config.toml").IsReadOnly
```

应该返回：

```text
True
```

> 为什么要只读：部分 Windows Codex Desktop 版本启动时会尝试从 `config.toml` 删除 `remote_control`。只读可以阻止这个实验开关被自动移除。

### 3. 手动触发 remote control 注册

进入本项目目录，运行：

```powershell
node .\scripts\try-remote-control-enable.mjs --keep-alive=600
```

看到类似输出后再操作手机：

```text
remote-control connected? true
```

或者日志里出现：

```text
status: connected
environmentId: <non-null>
```

### 4. 手机端连接

电脑端已经显示 `connected` 后：

1. 强制关闭手机 ChatGPT/Codex App。
2. 重新打开。
3. 进入 Codex 设备页。
4. 选择最近在线的 Windows 设备。
5. 点击重新连接。

如果列表里有多个同名设备，优先选择最近在线时间最新的那个。

### 5. 停止临时服务

连接成功后，如果你想清理临时 app-server：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\stop-remote-control-enable.ps1" -Port 17897
```

如果你没有手动指定端口，也可以直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\stop-remote-control-enable.ps1"
```

## 核心原理

这个流程有两层：

1. `config.toml` 中的 `remote_control = true` 让 Windows Codex 保留 remote-control 实验能力。
2. `remoteControl/enable` 才会真正把本机注册到 remote-control backend，并拿到 `environmentId`。

只做到第一层时，手机端可能仍然显示旧设备、离线设备，或者新设备连接超时。

判断成功不要只看手机列表。更可靠的本机证据是：

```text
remoteControl/status/read -> status = connected
environmentId != null
```

## 调试速查表

| 现象 | 更可能的原因 | 建议处理 |
| --- | --- | --- |
| 手机只显示旧设备，点重新连接没反应 | 手机端或账号侧有 stale device record；本机没有完成新的 enable/registration | 先运行 `try-remote-control-enable.mjs`，等本机 `connected` 后再强杀手机 App 重进 |
| 手机出现多个同名 Windows 设备 | 多次 profile reset 或多次注册造成云端/手机端旧记录残留 | 不要继续重置 profile；选最近在线的设备 |
| `config.toml` 里 `remote_control` 自动消失 | Codex Desktop 启动时移除了实验开关 | 写回 `remote_control = true` 后执行 `attrib +R` |
| `remoteControl/status/read` 返回 `disabled` | remote-control API 存在，但还没 enable | 运行脚本发送 `remoteControl/enable` |
| `remoteControl/enable` 后一直 `connecting` | relay 长连接、代理、TUN、DNS、账号安全状态或服务端状态异常 | 关闭/切换代理 TUN，重启 ChatGPT 手机端，确认同账号，稍后重试 |
| `connected` 后手机仍看不到最新设备 | 手机端缓存未刷新或选中了旧设备 | 强杀手机 App，退出重登，选择最近在线的设备 |
| 报 `Unknown feature flag: remote_connections` | 把配置名当成了 app-server `--enable` flag | app-server 命令只传 `--enable remote_control` |
| PowerShell 报 `ConvertFrom-Json` 没有 `-Depth` 参数 | Windows PowerShell 5.1 不支持该参数 | 删除 `ConvertFrom-Json -Depth`，或用 PowerShell 7+ |
| Node 报 `spawn EINVAL` | Windows 下直接 spawn `.cmd` 包装脚本失败 | 使用脚本内置的真实 `codex.exe` 查找逻辑，或用 `shell` 启动 |
| 临时端口被占用 | 上次脚本退出时进程未清干净，或手动指定了冲突端口 | 不指定 `--port` 让脚本自动挑空闲端口，或运行 `stop-remote-control-enable.ps1` |
| 日志里出现 plugin catalog `403 Forbidden` | 插件同步被拦或 Cloudflare challenge；不一定影响 remote control | 如果 remote-control 已 `connected`，可暂时忽略 |
| 手机授权提示安全设置错误 | 账号安全认证、移动端登录态或服务端安全门槛 | 先完成 ChatGPT 账号安全验证，再退出重登手机 App |
| 修改 SSH 配置没有改善 | SSH Remote 和手机 remote-control 注册不是同一条链路 | 只有日志明确指向 SSH/Remote SSH 时才改 SSH |

## Agent 运行手册

给自动化 agent 或远程协作者的建议流程：

1. 先读 `%USERPROFILE%\.codex\config.toml`，不要直接重置 profile。
2. 如果缺少 `[features] remote_connections` 或 `remote_control`，补齐。
3. 将 `config.toml` 设为只读。
4. 运行 `scripts/try-remote-control-enable.mjs`。
5. 只把下面三个状态当成有效证据：

```text
remoteControl/enable returned connecting or connected
remoteControl/status/changed returned connected
remoteControl/status/read returned connected with non-null environmentId
```

6. 如果本机已 `connected`，再让用户操作手机。
7. 不要因为手机端有旧设备记录就反复清 profile 或卸载重装。
8. 不要在公开 issue 或 README 中粘贴未经脱敏的日志。

### 什么时候停止折腾本地配置

如果出现以下情况，继续改 `config.toml` 通常收益很低：

- `remote_control = true` 已存在并且只读。
- 本地 `remoteControl/status/read` 能返回。
- 但 `remoteControl/enable` 一直无法从 `connecting` 到 `connected`。

此时更应该检查：

- 网络代理和 TUN 模式。
- 手机端账号登录状态。
- ChatGPT 账号安全认证。
- Codex 版本是否变化。
- OpenAI 是否已经正式开放 Windows 手机连接支持。

## 日志与本地调试

`try-remote-control-enable.mjs` 默认会：

- 随机选择一个空闲本地端口，而不是固定使用 `17897`。
- 将日志写到系统临时目录下的 `codex-remote-control` 文件夹。
- 对 JSON 字段中的机器名、邮箱、账号字段、用户/租户字段、路径字段、profile 字段、`installationId`、`environmentId` 等做脱敏。
- 对 stdout/stderr 的纯字符串日志也做基础脱敏，包括邮箱、`C:\Users\<name>` 路径、`DESKTOP-*` 机器名、UUID、`env_*`、IPv4 地址。

这些日志主要给本地用户或本地 agent 判断 remote-control 状态使用。默认脱敏只是降低误传风险，不是强安全保证；Codex app-server 的原始输出可能包含新的字段名或新的日志格式，脚本无法保证覆盖所有未来情况。

如果你需要指定日志目录：

```powershell
node .\scripts\try-remote-control-enable.mjs --log-dir="%TEMP%\codex-remote-control"
```

如果你为了本机深度调试必须保留原始日志，可以加：

```powershell
node .\scripts\try-remote-control-enable.mjs --no-redact
```

`--no-redact` 适合临时交给你信任的本地 agent 分析。调试结束后，建议删除对应的 `remote-control-enable-*.log`。

## 还原配置

如果你不想继续使用这个 workaround，可以取消只读：

```powershell
attrib -R "%USERPROFILE%\.codex\config.toml"
```

然后从 `config.toml` 中删除：

```toml
remote_control = true
```

保留普通远程连接开关通常是安全的：

```toml
remote_connections = true
```

## FAQ

### 这是不是官方支持方式？

不是。它是基于本地 app-server JSON-RPC 行为整理出的 Windows 调试流程。官方支持状态可能随 Codex 更新而变化。

### 为什么手机端没有删除旧设备入口？

目前手机端设备列表看起来包含账号/服务端侧记录或缓存。本地删除 profile、清 `.codex-global-state.json` 不一定会删除手机端旧记录。

### 我是否应该卸载重装 Codex？

通常不建议。重装可能生成更多同名设备记录。优先跑 `remoteControl/enable` 并确认本机 `connected`。

### 连接成功后可以取消 `config.toml` 只读吗？

不建议。如果取消只读，Codex Desktop 可能再次移除 `remote_control`，下次重启后手机端又变成离线。

### 为什么明明之前成功，后来重新只读还是不行？

因为只读只保住配置，不会自动恢复 remote-control backend 注册态。注册态丢了以后，需要重新触发 `remoteControl/enable`。

### 为什么脚本默认不再固定使用 17897？

固定端口本身不是严重隐私问题，但长期公开复用固定端口会增加被关联和冲突的概率。脚本现在默认自动挑选空闲本地端口；只有需要配合其他调试工具时才建议手动传 `--port=17897` 或其他端口。

## 参考

- OpenAI: [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
