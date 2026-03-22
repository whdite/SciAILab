# SciAILab Setup

本文档只记录当前仓库已经验证可运行的本地启动方式，不写理想态，不写未来态。

截至 `2026-03-20`，当前推荐启动路径是：

- 先用 `scripts/bootstrap_verify_research_core.ps1` 收敛依赖与兼容层
- 启动 `FastAPI`
- 用隔离配置启动 `OpenClaw Gateway`
- 按需启动 `web/` 开发服务器，或直接构建后交给 FastAPI 托管

## 1. 前置条件

需要本机已有：

- `python`
- `node`
- `npm`

建议工作目录固定在仓库根：

```powershell
Set-Location C:\Users\Administrator\Desktop\project\sciailab
```

## 2. 一键 bootstrap / verify

第一次在当前机器拉起，先执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1
```

如果依赖已经装好，只做复验：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1 -VerifyOnly
```

这个脚本会处理：

- Python editable install
- OpenClaw 最小依赖安装
- plugin-sdk runtime shim
- `pi-ai` 兼容补丁
- `openclaw` self-reference junction
- FastAPI / coordinator / plugin import 验证

## 3. 启动 FastAPI

在终端 1 执行：

```powershell
python -m uvicorn research_runtime.api.app:app --host 127.0.0.1 --port 8765 --reload
```

健康检查：

- `http://127.0.0.1:8765/health`

期望结果：

- 返回 `{"status":"ok", ...}`

说明：

- `FastAPI` 是当前 SciAILab control plane
- 如果 `web/dist` 已存在，FastAPI 会自动静态托管前端

## 4. 启动 OpenClaw Gateway

在终端 2 执行：

```powershell
$env:OPENCLAW_CONFIG_PATH = (Resolve-Path ".\data\runtime\openclaw-research-core.json")
$env:OPENCLAW_SKIP_CHANNELS = "1"
$env:CLAWDBOT_SKIP_CHANNELS = "1"
$env:OPENCLAW_AGENT_DIR = "$env:USERPROFILE\.openclaw\agents\main\agent"
$env:OPENCLAW_BUNDLED_PLUGINS_DIR = (Resolve-Path ".\openclaw\extensions")
Push-Location .\openclaw
node .\scripts\run-node.mjs --dev gateway
Pop-Location
```

说明：

- 不依赖 `~/.openclaw/openclaw.json`
- 当前通过 `data/runtime/openclaw-research-core.json` 使用 SciAILab 隔离配置
- 当前为了稳定联调，显式关闭 channels

重要端口说明：

- 配置文件里写的是 `18790`
- 但截至 `2026-03-20`，当前实际验证的 `--dev` Gateway 监听地址是 `ws://127.0.0.1:19001`
- 所以本地联调时应以启动日志里的实际监听地址为准

成功标志：

- 控制台日志出现 `listening on ws://127.0.0.1:19001`

## 5. 启动 WebUI

有两种方式。

### 5.1 开发态

在终端 3 执行：

```powershell
npm --prefix web run dev
```

访问：

- `http://127.0.0.1:5173`

第一次进入后建议在 `Settings` 页确认：

- FastAPI Base URL: 留空或 `http://127.0.0.1:8765`
- Gateway URL: 改成 `ws://127.0.0.1:19001`

注意：

- 当前 `web/` 默认保存的 Gateway URL 还是 `ws://127.0.0.1:18789`
- 如果不改，Gateway 探测会指向错端口

### 5.2 静态托管

先构建：

```powershell
npm --prefix web run build
```

然后直接访问：

- `http://127.0.0.1:8765/`

前提：

- FastAPI 已经在运行

## 6. 当前最小联调顺序

推荐按这个顺序启动：

1. `powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1 -VerifyOnly`
2. `python -m uvicorn research_runtime.api.app:app --host 127.0.0.1 --port 8765 --reload`
3. 按第 4 节启动 OpenClaw Gateway
4. 按需执行 `npm --prefix web run dev` 或 `npm --prefix web run build`
5. 在 `Settings` 页把 Gateway URL 改成 `ws://127.0.0.1:19001`

## 7. 当前验证命令

仓库内已经通过的验证命令：

```powershell
python scripts/verify_fastapi_runtime.py
python scripts/verify_coordinator_pipeline.py
```

```powershell
tsx scripts/verify_openclaw_agent_coordinator.mjs
tsx scripts/verify_openclaw_coordinator_service_pool.mjs
```

```powershell
Push-Location .\openclaw
tsx --tsconfig tsconfig.runtime-imports.json ..\scripts\verify_openclaw_plugin_import.mjs
Pop-Location
```

## 8. 日志位置

当前约定日志：

- `data/logs/sciailab-fastapi.out.log`
- `data/logs/sciailab-fastapi.err.log`
- `data/logs/openclaw-research-core.out.log`
- `data/logs/openclaw-research-core.err.log`

## 9. 已知问题

### 9.1 不推荐直接用 `pnpm --dir openclaw gateway:dev`

原因：

- 当前 Windows 本地联调以显式环境变量方式更稳定
- 当前仓库的可验证路径已经是 `node scripts/run-node.mjs --dev gateway`

### 9.2 OpenClaw Control UI 自动构建提示

启动时可能看到：

- `Control UI assets missing; building`

这不等价于 `research-core` 主链失败。只要 Gateway 最终监听成功，就可以继续联调。

### 9.3 `status --usage` 可能超时

这属于当前环境现象，不应直接判断为配置无效。

## 10. 当前启动完成定义

可以认为当前环境已经正常拉起的最小标准是：

- `GET http://127.0.0.1:8765/health` 返回 `ok`
- Gateway 日志出现 `listening on ws://127.0.0.1:19001`
- WebUI `Settings` 页对 FastAPI 和 Gateway 的测试都能通过
- 后续验证脚本至少能跑过 `verify_fastapi_runtime.py`
