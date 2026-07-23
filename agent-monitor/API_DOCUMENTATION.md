# Agent Monitor 服务接口文档

本文档详细介绍了 **Agent Monitor**（Mac 端 AI Agent 状态与系统监控服务）对外提供的接口使用方法、数据格式及服务发现机制，供其他前端项目、移动端应用（如 iPhone Widget/App）或第三方系统对接集成。

---

## 目录

1. [服务概述与网络协议](#1-服务概述与网络协议)
2. [服务发现 (Service Discovery)](#2-服务发现-service-discovery)
   - [UDP 局域网广播](#21-udp-局域网广播)
   - [Bonjour (mDNS / Zeroconf)](#22-bonjour-mdns--zeroconf)
3. [REST API 接口规范](#3-rest-api-接口规范)
   - [接口列表概览](#31-接口列表概览)
   - [1. 健康检查 (`GET /health`)](#1-健康检查-get-health)
   - [2. 获取完整状态快照 (`GET /status`)](#2-获取完整状态快照-get-status)
   - [3. 获取 Agent 列表 (`GET /agents`)](#3-获取-agent-列表-get-agents)
   - [4. 获取指定 Agent 详情 (`GET /agents/{agent_id}`)](#4-获取指定-agent-详情-get-agentsagent_id)
   - [5. 获取系统性能指标 (`GET /system`)](#5-获取系统性能指标-get-system)
   - [6. 获取 AI 模型额度与使用量 (`GET /usage`)](#6-获取-ai-模型额度与使用量-get-usage)
   - [7. 配对二维码生成 (`GET /pair`)](#7-配对二维码生成-get-pair)
   - [8. 配对令牌验证 (`POST /pair`)](#8-配对令牌验证-post-pair)
4. [WebSocket 实时推送 (`WS /ws/status`)](#4-websocket-实时推送-ws-wsstatus)
5. [数据结构字典与字段解析](#5-数据结构字典与字段解析)
6. [调用示例代码 (Python / JavaScript / Swift)](#6-调用示例代码-python--javascript--swift)

---

## 1. 服务概述与网络协议

- **默认 HTTP 端口**：`8898`
- **默认 UDP 广播端口**：`8899`
- **通信格式**：JSON (`application/json`) / WebSocket
- **基准 URL 示例**：`http://<Mac_Local_IP>:8898`

---

## 2. 服务发现 (Service Discovery)

为了方便局域网内的设备（如移动端 APP、智能终端）自动发现 Mac 端的 Agent Monitor 服务，系统提供了两种服务发现机制：

### 2.1 UDP 局域网广播

服务启动后，每 **3 秒** 会向 `255.255.255.255:8899` 发送一个 UDP 广播包。

#### 广播包 Payload 格式 (JSON)：
```json
{
  "type": "agent-monitor-beacon",
  "hostname": "MacBook-Pro.local",
  "ip": "192.168.1.100",
  "http_port": 8898,
  "udp_port": 8899,
  "timestamp": 1721712345,
  "version": 1721712345000,
  "agents_summary": [
    {
      "id": "opencode",
      "status": "working",
      "count": 1
    },
    {
      "id": "claude-code",
      "status": "idle",
      "count": 0
    }
  ]
}
```

### 2.2 Bonjour (mDNS / Zeroconf)

系统在局域网注册了 mDNS 发现服务：
- **服务类型**：`_agentmon._tcp.local.`
- **服务名称**：`<hostname>._agentmon._tcp.local.`
- **TXT 记录**：`ip=<Mac_IP>`, `port=8898`

---

## 3. REST API 接口规范

### 3.1 接口列表概览

| HTTP 方法 | Path | 说明 |
| :--- | :--- | :--- |
| `GET` | `/health` | 健康检查与基本网络信息 |
| `GET` | `/status` | 包含系统、Agent、Usage 的完整快照（支持增量查询） |
| `GET` | `/agents` | 仅获取所有 Agent 运行状态列表 |
| `GET` | `/agents/{agent_id}` | 获取单个特定 Agent 的详细状态与进程列表 |
| `GET` | `/system` | 仅获取 Mac 系统级 CPU、内存、温度等监控数据 |
| `GET` | `/usage` | 仅获取 AI 工具（OpenCode、Codex 等）用量与额度统计 |
| `GET` | `/pair` | 生成客户端配对二维码图片 (PNG) |
| `POST` | `/pair` | 校验客户端配对 Token 并生成 API Key |

---

### 1. 健康检查 (`GET /health`)

#### 请求参数
无

#### 响应示例 (`200 OK`)
```json
{
  "ok": true,
  "hostname": "MacBook-Pro.local",
  "ip": "192.168.1.100"
}
```

---

### 2. 获取完整状态快照 (`GET /status`)

支持增量拉取（通过 `since` 参数）。如果数据版本未发生变化，服务端会返回未变更标记，极大节省传输流量与计算开销。

#### Query 参数
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `since` | `integer` | 否 | 上次获取到的版本号 `version`。若当前版本 `<= since`，返回轻量级未变更响应。 |

#### 响应示例 (数据有更新时)
```json
{
  "timestamp": 1721712345,
  "hostname": "MacBook-Pro.local",
  "version": 1721712345001,
  "content_hash": "a1b2c3d4e5f6",
  "system": {
    "cpu_percent": 12.5,
    "cpu_count": 10,
    "cpu_count_physical": 8,
    "memory_used_gb": 18.5,
    "memory_total_gb": 32.0,
    "memory_percent": 57.8,
    "swap_used_gb": 0.0,
    "swap_total_gb": 2.0,
    "temperature": {
      "cpu": 45.2
    }
  },
  "usage": {
    "opencode": {
      "provider": "opencode",
      "status": "ok",
      "windows": [
        {
          "label": "Today",
          "cost_cents": 125,
          "tokens_input": 45000,
          "tokens_output": 12000
        }
      ]
    }
  },
  "agents": [
    {
      "id": "opencode",
      "display_name": "OpenCode",
      "status": "working",
      "process_count": 1,
      "total_cpu_percent": 15.2,
      "total_memory_mb": 230.5,
      "max_uptime_seconds": 3600,
      "processes": [
        {
          "agent_id": "opencode",
          "display_name": "OpenCode",
          "status": "working",
          "pid": 12345,
          "cpu_percent": 15.2,
          "memory_mb": 230.5,
          "uptime_seconds": 3600,
          "command_line": "/usr/local/bin/opencode"
        }
      ]
    }
  ]
}
```

#### 响应示例 (数据无更新 `version <= since`)
```json
{
  "unchanged": true,
  "version": 1721712345001
}
```

---

### 3. 获取 Agent 列表 (`GET /agents`)

#### 响应示例 (`200 OK`)
```json
[
  {
    "agent_id": "opencode",
    "display_name": "OpenCode",
    "status": "working",
    "process_count": 1,
    "total_cpu_percent": 15.2,
    "total_memory_mb": 230.5,
    "max_uptime_seconds": 3600,
    "processes": [...]
  },
  {
    "agent_id": "claude-code",
    "display_name": "Claude Code",
    "status": "idle",
    "process_count": 0,
    "total_cpu_percent": 0.0,
    "total_memory_mb": 0.0,
    "max_uptime_seconds": 0,
    "processes": []
  }
]
```

---

### 4. 获取指定 Agent 详情 (`GET /agents/{agent_id}`)

支持的 `agent_id` 包括：`opencode` / `claude-code` / `codex-cli` / `codex-app` / `antigravity` 等。

#### 响应示例 (找到 Agent)
```json
{
  "agent_id": "opencode",
  "display_name": "OpenCode",
  "status": "working",
  "process_count": 1,
  "total_cpu_percent": 15.2,
  "total_memory_mb": 230.5,
  "max_uptime_seconds": 3600,
  "processes": [
    {
      "agent_id": "opencode",
      "display_name": "OpenCode",
      "status": "working",
      "pid": 12345,
      "cpu_percent": 15.2,
      "memory_mb": 230.5,
      "uptime_seconds": 3600,
      "command_line": "opencode start"
    }
  ]
}
```

#### 响应示例 (未找到 Agent)
```json
{
  "found": false,
  "agent_id": "unknown-agent"
}
```

---

### 5. 获取系统性能指标 (`GET /system`)

#### 响应示例 (`200 OK`)
```json
{
  "cpu_percent": 8.4,
  "cpu_count": 10,
  "cpu_count_physical": 8,
  "memory_used_gb": 16.25,
  "memory_total_gb": 32.0,
  "memory_percent": 50.78,
  "swap_used_gb": 0.0,
  "swap_total_gb": 2.0,
  "temperature": {
    "cpu": 42.5
  }
}
```

---

### 6. 获取 AI 模型额度与使用量 (`GET /usage`)

自动聚合本地 OpenCode 数据库及 Codex 额度信息。

#### 响应示例 (`200 OK`)
```json
{
  "opencode": {
    "provider": "opencode",
    "status": "ok",
    "plan": null,
    "windows": [
      {
        "label": "Today",
        "used_percent": null,
        "cost_cents": 85,
        "sessions": 12,
        "tokens_input": 32000,
        "tokens_output": 8500
      }
    ],
    "fetched_at": 1721712300.0,
    "error": null
  },
  "codex": {
    "provider": "codex",
    "status": "ok",
    "plan": "Plus",
    "windows": [
      {
        "label": "5h window",
        "used_percent": 35.0,
        "limit_seconds": 18000,
        "reset_seconds": 7200
      }
    ]
  }
}
```

---

### 7. 配对二维码生成 (`GET /pair`)

移动端 APP 扫码获取服务器连接 IP、端口及临时配对 Token。

- **响应格式**：`image/png` 二维码二进制图片
- **二维码解析出来的 JSON 内容结构**：
  ```json
  {
    "ip": "192.168.1.100",
    "port": 8898,
    "token": "a1b2c3d4",
    "hostname": "MacBook-Pro.local"
  }
  ```

---

### 8. 配对令牌验证 (`POST /pair`)

#### Query 参数
| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `token` | `string` | 是 | - | 二维码中解析得到的 8 位配对 Token |
| `device_name` | `string` | 否 | `iPhone` | 请求配对的设备名称 |

#### 响应示例 (`200 OK`)
```json
{
  "device_id": "f8a9e7d6c5b4",
  "api_key": "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
  "hostname": "MacBook-Pro.local",
  "ip": "192.168.1.100",
  "port": 8898
}
```

#### 错误响应示例 (`400 Bad Request`)
```json
{
  "detail": "Invalid or expired pairing token"
}
```

---

## 4. WebSocket 实时推送 (`WS /ws/status`)

为支持 UI 的毫秒级数据同步，提供 WebSocket 管道。服务端当监控数据有变动时会自动推送最新快照。

- **URL**：`ws://<Mac_IP>:8898/ws/status`
- **工作机制**：
  1. 客户端建立 WebSocket 连接后，服务端**立即发送**一份最新的完整 status 快照。
  2. 服务端后台轮询监控数据（默认间隔 0.5s）。若 `version` 增加，自动广播推送 JSON 格式 snapshot 给所有连入的客户端。
- **推送数据格式**：同 `GET /status` 的完整 JSON 响应结构。

---

## 5. 数据结构字典与字段解析

### AgentStatus (Agent 状态字典)
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `agent_id` | `string` | Agent 唯一标识，如 `opencode` / `claude-code` / `codex-cli` |
| `display_name` | `string` | 展示名称 |
| `status` | `string` | 运行状态：`working`（繁忙中） / `idle`（空闲） / `stopped`（未启动） |
| `process_count` | `integer` | 关联匹配的进程数量 |
| `total_cpu_percent` | `float` | 所有关联进程的 CPU 总占用率 (%) |
| `total_memory_mb` | `float` | 所有关联进程的内存总占用量 (MB) |
| `max_uptime_seconds` | `integer` | 最长运行进程的已运行时间 (秒) |
| `processes` | `array[ProcessSnapshot]` | 具体进程明细列表 |

### SystemInfo (系统指标字典)
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `cpu_percent` | `float` | 当前系统 CPU 总使用率 (%) |
| `cpu_count` | `integer` | 逻辑 CPU 核心数 |
| `cpu_count_physical` | `integer` | 物理 CPU 核心数 |
| `memory_used_gb` | `float` | 已用内存 (GB) |
| `memory_total_gb` | `float` | 总物理内存 (GB) |
| `memory_percent` | `float` | 内存占用比例 (%) |
| `swap_used_gb` | `float` | 已用 Swap 交换区大小 (GB) |
| `swap_total_gb` | `float` | 总 Swap 交换区大小 (GB) |
| `temperature` | `object` | 硬件传感器温度 (如 `{"cpu": 45.0}`) |

---

## 6. 调用示例代码

### JavaScript / TypeScript (Fetch API)

```javascript
// 轮询带增量校验的获取状态
let currentVersion = 0;

async function fetchStatus() {
  const url = currentVersion 
    ? `http://192.168.1.100:8898/status?since=${currentVersion}`
    : `http://192.168.1.100:8898/status`;
    
  const res = await fetch(url);
  const data = await res.json();
  
  if (data.unchanged) {
    console.log("数据未变动");
  } else {
    currentVersion = data.version;
    console.log("最新数据:", data);
  }
}
```

### Python (WebSocket 实时监听)

```python
import asyncio
import json
import websockets

async def listen_status():
    uri = "ws://192.168.1.100:8898/ws/status"
    async with websockets.connect(uri) as websocket:
        print("Connected to Agent Monitor WS")
        while True:
            msg = await websocket.recv()
            data = json.loads(msg)
            print(f"[Version {data['version']}] CPU: {data['system']['cpu_percent']}%")

asyncio.run(listen_status())
```

### Swift (iOS / Mac App WebSocket 监听)

```swift
import Foundation

class AgentMonitorClient: ObservableObject {
    private var webSocketTask: URLSessionWebSocketTask?
    
    func connect(host: String, port: Int = 8898) {
        guard let url = URL(string: "ws://\(host):\(port)/ws/status") else { return }
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        receiveMessage()
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                if case .string(let text) = message, let data = text.data(using: .utf8) {
                    print("Received status update")
                }
                self?.receiveMessage()
            case .failure(let error):
                print("WS Error: \(error)")
            }
        }
    }
}
```
