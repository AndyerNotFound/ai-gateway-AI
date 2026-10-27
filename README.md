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
- 模块化拆分（`gateway.js` 入口 + `convert/record/server/pool` 等职责模块），仍为**零 npm 依赖**，有 Node.js 就能跑

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
  "redact": { "enable": true, "response": false, "extra": ["工号[0-9]+"] },
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
| `redact.enable` | 隐私过滤总开关（默认 `true`）。卡密可再设 `redact=false` 单卡关闭，实例开关是上限 |
| `redact.response` | 响应方向也打码（默认 `false`）：上游返回的正文/思考/工具参数同样替换为 `***` |
| `redact.extra` | 自定义正则数组，在内置规则之外追加打码规则（面板「路由」页可直接编辑） |

**路由规则**：`modelMap` 精确命中 > `models` 列表 > `default` 渠道 > 第一个渠道。

### 隐私过滤（敏感内容打码）

- **请求方向**：转发上游前遍历请求体 JSON，命中字段名（`api_key`/`secret`/`token`/`password`/`authorization` 等）的字符串整值打码；其余字符串按规则打码；`data:` URL 与顶层 `model` 不动（保护图片与路由）。
- **响应方向**（`redact.response=true`）：上游返回的正文、思考链、工具参数同样打码；流式响应逐片处理，密钥被 SSE 分片切开也不会漏。开启后为保证可解析会走统一转换路径（同格式不再逐字节直通）。
- **内置规则**：`sk-`/GitHub/Slack/AWS/Google/GitLab/HuggingFace 等 API Key、`Bearer` token、邮箱、中国大陆手机号、身份证、银行卡（过 Luhn 才打码，避免误伤普通长数字）、内网 IPv4。
- **自定义规则**：`redact.extra` 每项一条正则，例如 `"工号[0-9]+"`；面板路由页可编辑（每行一条），保存后热重载生效。
- **性能**：无敏感特征的普通对话走快路径，不跑正则/不算哈希；含密钥的长上下文用多级 CDC 缓存，只重算改动过的块。

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

设网关在 `http://192.168.1.100:16384`（手机局域网 IP，`ip -4 addr` 或 `ifconfig` 查看）。

### 1. OpenAI 格式（适用：ChatGPT 客户端、openai SDK、ChatBox、NextChat 等）

```bash
curl http://127.0.0.1:16384/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.1.100:16384/v1", api_key="随便填")
r = client.chat.completions.create(model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "你好"}], stream=True)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

### 2. Claude 格式（适用：Claude Code、anthropic SDK 等）

```bash
curl http://192.168.1.100:16384/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: 随便填" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gemini-2.0-flash","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

### 3. Gemini 格式（适用：Google AI SDK 等）

```bash
curl "http://192.168.1.100:16384/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: 随便填" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

> 模型列表：`GET /v1/models`（OpenAI/Claude 通用）或 `GET /v1beta/models`（Gemini）。健康检查：`GET /health`。
> 状态统计已收敛到管理面板（webToken 鉴权），无公开状态端点。

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

## 八、HTTPS 接入（无 root）

**日常只管一条命令：`agw-tls`（看状态）、`agw-tls setup`（一键开启）、`agw-tls use`（给现成代码）。**
`agw-tls trust` 导出的证书文件默认 5 分钟后自动删除（`--keep N` 调整）。
全部实例一起开：`agw-tls all --pure`（每个实例在原端口上只说 HTTPS，共 38 个入口）；`agw-tls all` 则是双开（https = http + 10000）。

非 root 拿不到 443，但每个实例都可以在自己的高位端口上说 HTTPS（单端口或双开都行）。推荐：本地私有 CA + 用户证书库，
设备装一次 CA，之后换 IP 只重签服务器证书。

```bash
cd ~/ai-gateway
bash tls/gen-ca.sh                    # 建私有 CA（只一次）
bash tls/gen-server.sh                # 签发 cert.pem（SAN 自动含本机全部 IP）
agw-tls all --pure                    # 全部实例：原端口改纯 HTTPS（当前状态）
./agw.sh restart
```

客户端要点：Python `httpx.Client(verify="ca.pem")`、Node `NODE_EXTRA_CA_CERTS=ca.pem`、
curl `--cacert ca.pem`；手机/电脑把 `tls/ca.pem` 装成「CA 证书」即可。

完整说明（各平台安装、SDK 示例、IP 变更、故障排查、安全注意）：[docs/HTTPS.md](docs/HTTPS.md)

证书自动续签（<7 天触发）与客户端密钥轮换（默认 90 天、14 天宽限）由 watchdog 每 5 分钟驱动：
`bash ops/guard.sh`（日志 `log/tls.log`、`log/keyrotation.log`）。

---

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

## 变更记录

### 2026-10-27 — 隐私过滤增强（响应方向 + 更多规则 + 性能）

- 新增 `redact.response`：响应正文/思考/工具参数打码，流式跨分片不漏；面板新增开关。
- 新增邮箱/手机号/身份证/银行卡/内网 IPv4 规则；`redact.extra` 支持面板编辑（每行一条正则）。
- 修复：面板保存只发 `{enable}` 会清空 `extra`；长 token 跨 CDC 切点被切开导致漏打码；块指纹未覆盖安全切点后移的尾部。
- 性能：无敏感特征文本走前缀/数字快路径（只做一次字符扫描，85KB 上下文约 1ms；命中后零正则、零分配）；内置 13+ 条规则合并为单次正则扫描。
- 顶层 `model` 字段不再参与打码，避免模型名被改写导致路由失败。

### 2026-10-16 — 修复 DSML 标记泄漏（思考链与工具调用不连贯）

- **现象**：部分 DeepSeek 系上游（如 NVIDIA NIM）把工具调用以文本形式写进 `content`，形如
  `<｜DSML｜tool_calls>…`，网关把整块当标记吞掉后只剩思考、没有工具调用，链路中断。
- **根因**：该方言只有**外层**标签带 `｜DSML｜` 前缀，内层 `<invoke>`/`<parameter>`/`</tool_calls>` 全是裸的；
  旧状态机假设所有层都带前缀，内层终止正则永远匹配不上。
- **修复**：`dsmlFeed` 状态机放宽终止/开始正则（前缀可选），块结束时改为**解析回填**成结构化
  `tool_calls`（含 direct 直通路径的 final 补发），不再只丢弃。
- **验证**：`node --check` 通过；单测 23+ 用例全绿；真机 17 段思考+工具调用链路连续无断裂。
- **回滚**：`cp ~/ai-gateway/gateway.js.bak-backfill-20261016-1113 ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`
- **后续**：上游若再改方言（换前缀/标签名），用 `/tmp/dsml/capture.js` 思路抓一次原始流，
  只需调整 `gateway.js` 里 DSML 相关的三个正则即可。
### 2026-10-16（第二轮）— v1.4.4：小概率"空白/断链"收口（方言再放宽 + 宽松兜底 + 留证）

- **现象**：第一轮修复后仍**小概率**出现"中间空白"（思考后断链、无工具调用）。
- **又找到三条静默丢弃路径**（都表现为"整块被吞掉 → 正文空白"）：
  1. `dsmlParseCall` 开头要求块内含 `DSML` 字样，否则直接 `return null`；
  2. 解析要求 `</invoke>` 严格配对，模型漏写闭合标签 / 自闭合 `<invoke …/>` 时解析失败；
  3. 回填要求函数名与客户端声明**完全一致**，大小写/命名空间差异 → 解析成功但不回填。
- **修复**：
  - 方言统一放宽为三种：① `｜DSML｜…`（含 DSML）② 完全裸标签 ③ 只剩竖线 `<｜tool_calls>`；
  - 解析器改**按结构识别**（不再要求 DSML 字样）+ 宽松兜底（缺 `</invoke>`、自闭合、`<parameter>` 不闭合、块内 JSON 形态）；
  - 回填闸：完全同名 → 规范化同名（大小写/命名空间）→ **单调用兜底**（宁可回填也不静默丢正文）；
  - 上游截断（流结束仍在块内）时也先尽力解析回填，再决定丢弃。
- **留证**：任何"吞块未回填"都写一行 JSON 到 `log/dsml-miss.log`（原因 / 原始上下文 / 声明工具名）。
  `AGW_DSML_MISS_LOG=off` 可关闭；置为绝对路径可改位置。
- **验证**：单元 25/25（含 133 个分片切点的模糊测试、逐字符喂入、三方言、截断回填）；
  端到端 12/12（逐字符切片流式、工具名不匹配、非流式路径，均产出结构化 `tool_calls`）。
- **回滚**：`cp ~/ai-gateway/gateway.js.bak-dsmlv2-*.bak ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`### 2026-10-16（第三轮）— v1.4.5：停止/断流/崩溃三连修

- **现象**：仍偶发"空白/断链"，且早先"停止按钮没效果、请求卡死"。
- **实锤**（log/dsml-miss.log + 网关日志）：上游在`<｜DSML｜ calls>`（注意是空格变体）处被掐断/自然结束 → 整块丢弃后界面无下文；日志里出现 `upstream idle timeout (180s)` 与 `uncaughtException: write after end`。
- **根因三条**：① 客户端按停止时网关完全不处理，上游继续生成到自然结束或 180s 超时；② 上游连接重置（无 `end`）时下游永久悬挂；③ 上游 `error` 后提前 `res.end()`，随后 `close` 收尾再写 → write-after-end 打死整个网关进程。
- **修复**：
  - 客户端断开（`res.close` / `req.aborted`）→ 立即 `upReq.destroy()` 取消上游；
  - 上游 `close`（无 `end`）→ 直接/转换/裸直通三条路径都强制收尾；
  - 流式收尾时若上游未发 `[DONE]` → 网关补发，客户端不再当"未完成"；
  - `error` 路径统一走管道收尾 + `res.on('error')` 兜底，杜绝 uncaughtException 崩进程。
- **验证**：单元 25/25；E2E 直通 12/12（逐字符切片/名字不匹配/非流式）；E2E 中止 3/3（上游断流必补 [DONE]、客户端停止 2s 内取消上游）。
- **测试文件已入仓**：`test/dsml/`（t2.js 单元、run.js 直通、abort.js 中止；`node test/dsml/t2.js` 等可直接跑）。
- **回滚**：`cp ~/ai-gateway/gateway.js.bak-dsmlv3-*.bak ~/ai-gateway/gateway.js && ~/ai-gateway/agw.sh restart`### 2026-10-16（第四轮）— v1.4.6：孤儿标记截断的定向排查（maxTokens + 证据环）

- **现象**：仍偶发"空白/断链"，且 miss.log 一色 `truncated-drop | len=15 | <｜DSML｜ calls>\n`（12 次同签名）。
- **指向**：deepseek-v4.1-flash(NIM) 长思考（20–100s）后刚写出 `<｜DSML｜ calls>`（空格变体）流即结束 —— 疑似 NIM 侧输出 token 预算在思考期耗尽、标记中途被截。
- **改动**：
  - 渠道级新选项 `maxTokens`（openai 直通/转换两路径，客户端未带 `max_tokens` 时才注入）；
  - 证据环：直通管道保留最近 12 条上游 SSE 载荷，流结束时状态机仍挂起（截断/孤儿标记）→ 连同 `finish_reason` 一起写入 `log/dsml-miss.log`（reason=`pipe-final-active`），下次不必再猜；
  - 已为 NVIDIA-NIM 四渠道注入 `maxTokens: 8192`（配置备份 `config.NVIDIA-NIM.json.bak-mt-*`）。
- **验证**：单元 25/25，E2E 直通 12/12，E2E 中止 3/3。
- **若仍复现**：`tail -3 ~/ai-gateway/log/dsml-miss.log` — 看 `pipe-final-active` 行的 `finish_reason`：`length` → 继续调大/确认 NIM 上限；`stop` → 模型自停，换处理策略。