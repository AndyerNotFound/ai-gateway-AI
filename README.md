# ai-gateway — 通用 AI 本地网关

一个跑在 Termux 上的**零依赖** Node.js 网关：给本地和局域网设备提供统一的 AI 接口入口，
自动在 **OpenAI / Gemini / Claude** 三种 API 格式之间互转，出站可走 **SOCKS5 / HTTP 代理**。

```
客户端(任意格式)                    上游(任意格式)
OpenAI 格式 ──┐                 ┌──▶ OpenAI 官方 / DeepSeek / 各类中转站
Claude 格式 ──┼──▶ ai-gateway ──┼──▶ Gemini 官方
Gemini 格式 ──┘   (自动互转)     └──▶ Claude 官方
      本机 127.0.0.1 + 局域网IP        直连 或 SOCKS5/HTTP 代理(按渠道)
```

- **同一个模型名，三种姿势都能调**：客户端用 OpenAI 格式也能打到 Gemini/Claude 上游，网关自动转换请求/响应（含流式打字机效果、工具调用、图片、思考内容、token 统计）
- **同格式直通**：格式一致时请求体原样转发，零损耗
- **多渠道轮询 + 故障切换**：同一模型配在多个渠道里，请求自动轮流分发；某渠道报错（限流/鉴权失败/服务端错误）自动切下一个重试
- **多开**：一份配置一个实例，互不干扰
- 单文件 `gateway.js`，**不需要 npm install**，有 Node.js 就能跑

---

## 一、快速开始（3 步）

```bash
# 1. 编辑配置, 填入你的 API Key
nano ~/ai-gateway/config.json

# 2. 启动
~/ai-gateway/agw.sh start

# 3. 测试
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

管理命令：

```bash
~/ai-gateway/agw.sh start     # 启动（全部实例）
~/ai-gateway/agw.sh stop      # 停止
~/ai-gateway/agw.sh restart   # 改完配置后重启
~/ai-gateway/agw.sh status    # 看状态
~/ai-gateway/agw.sh logs      # 看最近 50 行日志
```

---

## 二、配置说明（config.json）

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 16384 },
  "gatewayKey": "",
  "maxBodyBytes": 67108864,
  "connectTimeout": 15000,
  "responseTimeout": 180000,
  "proxies": {
    "clash": { "type": "socks5", "host": "127.0.0.1", "port": 7890 }
  },
  "channels": [
    {
      "name": "gemini-official",
      "type": "gemini",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza...",
      "proxy": "clash",
      "models": ["gemini-2.0-flash", "gemini-2.5-flash"]
    },
    {
      "name": "deepseek",
      "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "default": true
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `listen.host` | `127.0.0.1`=仅本机；`0.0.0.0`=本机+局域网（默认） |
| `listen.port` | 监听端口 |
| `gatewayKey` | 给网关自己设密码（空=不校验）。设了之后，请求带上它即可：`Authorization: Bearer xxx`、`x-api-key: xxx`、`?key=xxx` 任选一种 |
| `proxies` | 代理列表。`type` 支持 `socks5` / `http`，可选 `username`/`password`。也支持字符串写法 `"clash": "socks5://127.0.0.1:7890"` |
| `channels[].type` | 上游格式：`openai`（OpenAI/DeepSeek/中转站）、`gemini`、`claude` |
| `channels[].baseUrl` | 官方或中转站地址（写到 `/v1` 之前，如 `https://api.deepseek.com`；写了 `/v1` 结尾也能自动识别） |
| `channels[].apiKey` | 上游的 Key |
| `channels[].proxy` | 填 `proxies` 里的名字走代理；`null` 或不填=直连 |
| `channels[].models` | 该渠道支持的模型名（客户端请求的 model 匹配到这里就路由过去） |
| `channels[].modelMap` | 改名映射：`{"gpt-4o": "gemini-2.0-flash"}` 客户端发 gpt-4o 实际用 gemini |
| `channels[].default` | `true`=兜底渠道（没匹配到 models 的请求都发这里，模型名原样透传） |
| `channels[].insecure` | `true`=跳过 HTTPS 证书校验（自签名中转站用） |

**路由规则**：`modelMap` 精确命中 > `models` 列表 > `default` 渠道 > 第一个渠道。

### 多渠道轮询 & 故障切换

把**同一个模型名**配在多个渠道里，网关会自动轮流分发（轮询），某个渠道报错时自动切下一个重试：

```json
"channels": [
  { "name": "gemini-key1", "type": "gemini", "baseUrl": "...", "apiKey": "key1", "models": ["gemini-2.0-flash"] },
  { "name": "gemini-key2", "type": "gemini", "baseUrl": "...", "apiKey": "key2", "models": ["gemini-2.0-flash"] },
  { "name": "gemini-key3", "type": "gemini", "baseUrl": "...", "apiKey": "key3", "models": ["gemini-2.0-flash"] }
]
```

- **轮询**：3 个 key 轮着用 → 第 1 次走 key1、第 2 次走 key2、第 3 次走 key3、第 4 次又回到 key1……每个 key 的免费额度都不浪费
- **故障切换**：如果当前渠道返回 `429`(限流) / `401`(鉴权失败) / `500`~`504`(服务端错误) 或连接失败 → 自动切下一个渠道重试，用户无感；全部失败才报错
- **不切换的情况**：`400`(请求格式错误) 等客户端错误不切换——换渠道也一样错，直接原样返回
- 流式请求也能故障切换：上游返回错误码时尚未向客户端发送任何数据，可以安全切换；一旦开始流式输出就锁定当前渠道

---

## 三、三种客户端姿势（同一网关）

设网关在 `http://<手机局域网IP>:16384`（手机局域网 IP，`ip -4 addr` 或 `ifconfig` 查看）。

### 1. OpenAI 格式（适用：ChatGPT 客户端、openai SDK、ChatBox、NextChat 等）

```bash
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://<手机局域网IP>:16384/v1", api_key="随便填")
r = client.chat.completions.create(model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "你好"}], stream=True)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

### 2. Claude 格式（适用：Claude Code、anthropic SDK 等）

```bash
curl http://<手机局域网IP>:16384/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 随便填" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gemini-2.0-flash","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

### 3. Gemini 格式（适用：Google AI SDK 等）

```bash
curl "http://<手机局域网IP>:16384/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: 随便填" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

> 模型列表：`GET /v1/models`（OpenAI/Claude 通用）或 `GET /v1beta/models`（Gemini）。
> 状态统计：`GET /status`。健康检查：`GET /health`。

---

## 四、多开（多个实例）

复制配置改端口即可：

```bash
cp ~/ai-gateway/config.json ~/ai-gateway/config.proxy2.json
# 编辑 config.proxy2.json: 改 port 为 16385, 改渠道/代理
~/ai-gateway/agw.sh start proxy2
~/ai-gateway/agw.sh status        # 两个实例同时运行
```

- 实例名 `default` 用 `config.json`，其他名字用 `config.<实例名>.json`
- `agw.sh start`（不带名字）= 启动全部实例
- 停止某实例：`agw.sh stop proxy2`

---

## 五、常用场景配方

- **OpenAI 兼容中转站**：`"type": "openai", "baseUrl": "https://中转站域名"`（key 填中转站的）
- **DeepSeek**：`"type": "openai", "baseUrl": "https://api.deepseek.com"`
- **Gemini 官方**：`"type": "gemini", "baseUrl": "https://generativelanguage.googleapis.com"`（国内需走代理）
- **Claude 官方**：`"type": "claude", "baseUrl": "https://api.anthropic.com"`（国内需走代理）
- **本地 llama.cpp**：`"type": "openai", "baseUrl": "http://127.0.0.1:8080"`（直连）

---

## 六、安全提示

1. 局域网监听（`0.0.0.0`）意味着**同一 WiFi 下任何设备都能用你的 Key 跑模型**。
   建议设置 `"gatewayKey": "一个密码"`，客户端任意位置带上即可。
2. 配置文件里有明文 Key，不要把 `ai-gateway` 目录发给别人。
3. 只在本机用的话，把 `listen.host` 改回 `"127.0.0.1"`。

---

## 七、目录结构 & 测试

```
~/ai-gateway/
├── gateway.js     # 网关本体（单文件, 零依赖）
├── config.json    # 默认实例配置
├── agw.sh         # 管理脚本
├── log/           # 运行日志（每实例一个）
└── .run/          # pid 文件
```

沙箱测试套件 215 项全过：转换器单元测试、9 种组合互转 E2E（流式+非流式）、
SOCKS5/HTTP 代理隧道（含认证、HTTPS 自签）、网关鉴权、渠道路由、多实例、
轮询（严格交替）、故障切换（429/连接失败/不可重试400/全失败）。

## OpenAI 扩展端点 (Responses / Images / Embeddings / Audio / Completions)

> 版本: 2026-09-06 新增。默认关闭(向后兼容), 开启方式见下。

### 配置开关 (config.json 顶层)

```json
{
  "openaiExtras": {
    "enable": false,            // 总开关: 对外开放扩展端点 + 允许 OpenAI 上游走 Responses API
    "upstreamResponses": false  // 全局默认: OpenAI 渠道上游用 /v1/responses 而不是 /v1/chat/completions
  }
}
```

渠道级可覆盖(单个 OpenAI 渠道加字段):

```json
{ "name": "my-resp", "type": "openai", "baseUrl": "…", "useResponses": true }
```

- 渠道 `useResponses` 未设置时跟随全局 `upstreamResponses`; 仅 openai 类型渠道有效; 仅在 `enable=true` 时生效。
- 保存后需重启实例: `bash agw.sh restart <实例名>` (m3 面板保存后会自动重启)。

### 网关对外新增端点 (enable=true 时)

| 端点 | 说明 |
|---|---|
| `POST /v1/responses` | OpenAI Responses API 入口(支持流式 SSE), 自动与 Chat Completions / Claude / Gemini 互转 |
| `POST /v1/images/generations` | 图片生成(直通 openai 渠道, JSON) |
| `POST /v1/images/edits` `POST /v1/images/variations` | 图片编辑/变体(multipart 直通) |
| `POST /v1/embeddings` | 文本嵌入(直通) |
| `POST /v1/audio/speech` | TTS(直通, 二进制/流式透传) |
| `POST /v1/audio/transcriptions` `POST /v1/audio/translations` | 语音转写/翻译(multipart 直通) |
| `POST /v1/completions` | 老版文本补全(直通) |
| `POST /v1/moderations` | 内容审核(直通) |

- 扩展直通端点只支持 openai 类型渠道(按 body.model 路由, modelMap 改名对 JSON 端点生效; multipart 端点不改名), 无匹配渠道返回 503。
- `/v1/responses` 是完整转换端点: 客户端 Responses ↔ 上游 Chat/Responses/Claude/Gemini 任意组合均支持, 含流式、工具调用、reasoning。
- 关闭开关时以上端点全部 404(与旧版本行为一致)。

### 上游选择矩阵

| 客户端 API | 上游渠道 useResponses=false | 上游渠道 useResponses=true |
|---|---|---|
| Chat Completions | 直通(原行为) | canonical 转换 → Responses body |
| Responses | canonical 转换 → Chat body | 直通 |
| Claude / Gemini | canonical 转换 | canonical 转换 → Responses body |
