# live-usage (Paseo plugin)

A Paseo composer pill that shows **output speed (tokens/s), first-token latency
(TTFT), a wait / thinking / output / tool-execution time breakdown, cache-hit rate
and cost** for the agent you are looking at.

It reads each harness's own session store — DeepSeek Harness (`dsh`), `pi`, Claude
Code, Codex, Devin CLI — instead of Paseo's normalized usage, because that
normalization drops the cache buckets and carries no per-call timings. For `dsh`,
`pi` and `devin` the rates use the same definitions those tools use themselves:
`TPS = output tokens ÷ (first token → message landed)`, so neither the wait for the
first token nor tool execution can drag the speed down, and thinking time is
reported separately.

> 下面是中文说明，内容以中文为准。

在 Paseo 的 composer pill 条上显示**输出速度 (TPS)、首 token 平均 (TTFT)、模型/工具用时、
缓存命中率、花费、结束时刻，以及本轮相位耗时**。dsh / pi / devin 那几行的口径**直接复刻
dsh 自己的**（`dsh-tui` 的「会话统计」/ 状态栏 TPS）；其余 provider 参考 pi 的 statusline 扩展。

## 为什么不能只靠 Paseo

Paseo 只把各 provider 的用量归一化了一部分：ACP provider（dsh、cursor、grok、kimi…）
在 `usage_update` 里只有 `used`/`size`，buckets 全丢；cache write 也没有对应字段。
所以现成插件（TokenLedger 等）在 dsh 会话里只能显示 0。

这个插件从 daemon 侧直接读**各 provider 自己的会话存储**：

| provider | 数据源 | 能给什么 |
| --- | --- | --- |
| dsh | `~/.dsh/sessions/*/<sid>/session.v<N>.jsonl.zstd` + `session_projcache` | 每次模型调用的 in/cache/out/reasoning、上下文；**逐 chunk 时间戳**，因而能给出 dsh 同口径的首 token 平均 / 输出速度 / 模型用时 / 工具用时；花费用 DeepSeek 峰谷 CNY 价目表估算 |
| pi | `~/.pi/agent/sessions/*/*_<sid>.jsonl` + `~/.pi/agent/statusline-samples.jsonl` | 每次模型调用的 in/cache/out/reasoning；statusline 扩展逐调用写了 `ttftMs`/`decodeMs`/`out`，因而**与 dsh 同口径**；且带 provider 上报的 cost |
| claude（含 `claude-*` 自定义 provider，如 claude-cpa） | `~/.claude/projects/*/<sid>.jsonl` | in / cache read / cache write / out / thinking；按 message id 去重（Claude Code 会重复写同一条）；**无首 token 时间**，只出单次调用速度 |
| codex | `~/.codex/sessions/**/rollout-*<sid>.jsonl` 的 `token_count` | OpenAI 口径（input 含 cached，已归一化）、上下文窗口、按事件间隔算速度；`token_count` 是周期采样，没有首 token 时刻 |
| devin | `~/.local/share/devin/cli/sessions.db` 的 `message_nodes` | 每次调用的 in/cache/out（Anthropic 口径）、`total_time_ms`、`ttft_ms`，**与 dsh 同口径**；工具 `chisel/tool_call_timing` 实测区间；devin 的 ACP 完全不上报用量，无花费/上下文字段 |
| 其它（opencode/copilot/cursor/grok/kimi…） | Paseo `agent.lastUsage` 兜底 | in/cache/out（若有）、命中率、上下文、花费；速度靠 1s 采样累计 output 求差 |

读取都是**增量**的：JSONL 只读新追加的字节；dsh 的 zstd 是多 frame 拼接，只解码新增 frame；
devin 的 `message_nodes` 按 `row_id` 翻页只取新行；mtime 未变时一次 `stat` 就返回。

## 指标口径

### 面板上的每个词（先定义，再看数）

面板顺序是**先本轮、后会话**，时间先总后分：

```
本轮    等待 – · 思考 0.2s · 输出 0.1s · 工具 2.8s · 流出 ≈16 tok   ← 当前这一轮，实时测
速度    本轮输出 305 t/s · 总输出 139 t/s · 首字均 9.9s             ← 速率/延迟，不是时长
耗时    总 92m = 等待首字 54m + 思考 14m + 输出 17m + 工具 6m        ← 总时间 + 拆分，一行
用量    11轮327步 · 命中 99.9% · ≈¥8.41 (峰) · 结束 11:58
```

四个部分直接相加就是总时间，**不需要单独的「生成」行**（生成 = 思考 + 输出）：

```
总时间 = 等待首字 + 思考 + 输出 + 工具执行
```

- **等待首字**：请求发出 → 第一个 token 落下来的时间（会话里是总和；速度行的「首字均」是平均值）。
- **思考**：reasoning（思考）流的首→末。**只有真正流式输出过思考的调用才算**；
  整场一次都没有思考记录时（例如 devin，或日志早于 reasoning 记录），耗时行**退回显示整体的
  「生成」**，不把它拆成思考/输出，也不编一个 0。
- **输出**：首字之后**除思考以外**的全部生成 —— 正文**加上工具调用的参数**。
  它按 `生成 − 思考` 定义，所以四项相加严格等于总时间，不留「其它」这种说不清的口子。
- **工具执行**：`tool/call`→`tool/result` 墙钟的并集（并行批次不重复计），在模型时间**之外**。
- **本轮输出 / 总输出**：都除以**生成**时间（分母里既没有等待首字、也没有工具执行）。
  「本轮」= 最新一轮，「总」= 整个会话。生成期间「本轮输出」是流式估算（标 `≈`），
  调用落盘后换成精确值。
- **本轮**（第一行）：客户端订阅 timeline 实时测的相位墙钟，只覆盖当前这一轮。

### dsh / pi / devin 的数据来源

三家都存了「首 token 时刻」，所以上面的拆分是实测，不是估的：

| 来源 | 首 token 时刻 | 生成窗口 | 思考 |
| --- | --- | --- | --- |
| dsh | `assistant/message.data.stream` 的第一条记录 | 首 chunk → 消息落盘 | `reasoning-chunks` 记录的首→末 |
| pi | statusline 样本的 `ttftMs` | 样本的 `decodeMs` | 样本自带的 `thinkMs` |
| devin | `metrics.ttft_ms` | `metrics.total_time_ms` − `ttft_ms` | ❌ 没有，耗时行退回显示「生成」 |

「输出」三家都不单独采集，统一按 `生成 − 思考` 定义（所以四项相加必然等于总时间）。

采样规则照 dsh 的 aggregate：没拿到计时槽的调用跳过；没测到首 token 的调用不给
TTFT/生成样本（不拿 0 拉低平均），但它的 output 仍进 token 总量；生成窗口 <250ms 不给速度。

dsh 的逐 token 流是**压进落盘事件**的（结构记录带 `time`，内容记录带 `time0` + 逐 delta 的
`dt` 偏移），pre-0.1.5 的旧日志则是逐条 `assistant/chunk` 事件 —— 两种都支持。思考跨度只取
reasoning 记录的首→末，**不会被同一次调用里更晚的 `finish` 记录拉长**（`finish` 只用来收
生成窗口）。

`本轮` 行是客户端订阅 timeline 实时测的。生成期间速度行给流式估算（标 `≈`），调用落盘后
换成精确值；估算沿用 dsh 自己的 `Math.ceil(字符数 / 4)`（`pi-nano-context`），并要求 ≥1s
且 ≥8 估算 token 才显示，免得「1 个字符 / 0.25s」报成 4 t/s。`流出` 只计**正文**
（`assistant_message`）字符，思考不计。

### 其它 provider

- **token/s** = 该次调用 `output / 调用墙钟`（pi 是「上一条 entry → 本条落盘」；claude 同一
  message 按 thinking/text/tool_use 分多行落盘，取「首个分块之前的上一条计入 entry → 末块
  落盘」；codex 是相邻 `token_count` 事件的累计 output 差；兜底路径是 1s 采样差）。
  含首字等待，不是纯解码窗口；采样窗口 <250ms 不给值。生成中标 `≈` 的是流式估算值。
- **缓存命中率** = `cacheRead / (freshInput + cacheRead + cacheWrite)`。各 provider 的
  input 语义已分别归一化（Anthropic 式 input 不含 cache；OpenAI 式含，已减掉）。
  颜色：<50% 红 / <90% 黄 / 其余默认色。
- **花费**：provider 上报的美元成本优先；dsh 没有 cost 字段，用 DeepSeek flash/pro 峰谷
  CNY 价目表估算（标 `≈`）。

## 相位与耗时

- **本轮（面板第一行，实时跳动）**：客户端订阅 agent 的 timeline 流自己计时 ——
  `turn_started` 起锚，首个 `assistant_message`/`reasoning` chunk 算首字，之后按当前相位
  累加墙钟；`tool_call` 用 callId 的 running/terminal 算工具墙钟（并行批次不重复计）。
  只在 pill 挂载时订阅（popover 关闭也保留上一轮），卸载即释放。
  中途挂载错过 `turn_started` 时等待无法测量，显示 `–` 而不是 0，且**不参与**累计分摊；
  此时若流式 chunk 已在到达，仍按 chunk 推断「轮次在跑」，相位与解码速度照常。
- **累计（最后一行，仅在没有逐 token 计时数据时出现）**：从会话文件算 总时 / 工具墙钟 /
  请求墙钟 / 其它（claude 用 assistant→tool_result(user) 间隔；codex 用 task + function_call
  事件）。判断依据是**这一次的 `speed` 有没有值**：
  - `speed` 是对象 → 上面已经有实测的 等待首字/思考/输出/工具，这行不显示；
  - `speed` 为 `undefined`（claude / codex / 兜底：存储里根本没有逐 token 计时）
    或 `null`（dsh / pi / devin 支持，但还没有调用落盘）→ 回退显示这行，
    速度行也回退成该次调用的 `解码` 速率。
  文件里没有首字/思考时刻，所以按 statusline 的口径分摊，比例按优先级取**整个 thread 的聚合**，
  绝不用单个在飞的轮次（2026-10-01 之前用「本轮实测」切总时长：思考中途打开面板，
  整条 thread 会被显示成 100% 思考、等待/输出归零）：
  1. 本客户端观测到的**已结束轮次**聚合（wait/think/out）；
  2. token 比例（Σreasoning / Σoutput，无 totals 时退化到最近一次调用）。
  等待比例拿不到实测时按 1:1 兜底；«其它» 占比 <2% 不显示。

## 安装

```bash
git clone https://github.com/apple-ouyang/paseo-live-usage.git ~/code/paseo-live-usage
cd ~/code/paseo-live-usage && npm install   # 只有 devDependencies，用于 daemon 编译器解析 @getpaseo/* 类型
```

然后在 Paseo 里 Settings → Plugins → Enable plugins → Install，填本仓的克隆路径：

```
~/code/paseo-live-usage
```

改完源码后 `paseo plugin reload live-usage`，或在 Plugins 页点 Reload。

## 已知限制

- **等待首字/思考/输出/工具 这几项只有 dsh / pi / devin 有**：它们的存储里存了首 token
  时刻。claude / codex 只记整条消息或周期采样，`speed` 恒为 `undefined`，面板只出单次调用的
  `速度` 和 `累计`，**不会**拿别的数冒充。dsh / pi / devin 在还没有调用落盘时 `speed` 为
  `null`，这时同样走这套回退，而不是显示空白。
- pi 的 TPS/TTFT 取自 statusline 样本（按 resume 父链汇总整个 thread），而 `N 轮 M 步`
  和工具用时取自当前会话文件 —— 同一个 thread 被 resume 过时，两者的统计范围不完全重合。
- **devin 没有思考切分**（它的 `metrics` 只有 `ttft_ms` / `total_time_ms`），
  耗时行对 devin 给「生成」，而不是「思考 + 输出」；dsh 和 pi 才有思考。
- dsh/pi/claude 的文件精确值每个模型调用出一次；生成期间另有 timeline 估算值，每 250ms 刷新。
- 依赖各 provider 的私有存储格式；provider 大版本升级要重新核对。
- **dsh 会话日志的文件名带存储格式版本**：`session.v3.jsonl.zstd`（≤0.1.6）→ `session.v4.jsonl.zstd`
  （0.1.7-rc.2，2026-09-26）。插件取该会话目录里版本号最高的那个，所以再涨版本号
  不用改代码；但**若事件结构本身变了**（不只是文件名），仍然要重核解析逻辑。
  2026-09-26 的「pill 只剩命中率、没有 t/s」就是只改了文件名导致的：`findLogPath` 当时写死 v3，
  新会话一个都匹配不到，`last` 为 null，于是只回退到 `session_projcache` 的花费/上下文。
- 只订阅 agent 目录第一页（200 个 agent）。
- **Cursor 没有可读的用量**（2026-09-24 逐个位置核过）：`~/.cursor/acp-sessions/<sid>/store.db`
  只有对话消息、无 token 字段；`~/.cursor/projects/*/agent-transcripts/*.jsonl` 只有 message 与
  `turn_ended`；`~/.cursor/ai-tracking/ai-code-tracking.db` 只记代码 hash。所以 cursor 只有
  「本轮相位」，命中率/花费/结束/累计都没有。
- `本轮` 的相位是客户端订阅 timeline 实时测的，daemon 只推送实时事件、不重放历史，所以
  插件没在跑的时候发生的 turn 看不到相位；pill 常驻保住了「上一轮」。中途挂载（错过
  `turn_started`）的轮次只有思考/输出相位可信，等待显示 `–`；累计行的比例不受影响，
  它只用本客户端观测到的**已结束轮次**聚合，退化时取 token 比例。
- **「本轮输出」只有 dsh 在轮次结束后仍保留精确值**（它的日志带 `turn` 号，能按轮求和）。
  pi / devin 的存储没有轮号，只能在生成中用流式估算显示 `≈ 本轮输出`，调用落盘后该行
  只剩「总输出 / 首字均」。
- pi 的 statusline 样本是逐版本演进的：老版本的行没有 `thinkMs` 字段，这类样本按
  **未知**处理（该会话显示「生成」而不是「思考 0.0s」）；只有真的写了数字 0 才算 0。
- claude 的 assistant 消息按内容块分多行写（thinking/text/tool_use 各一行，同 `message.id`、同 usage），
  且 `attachment` 等记账行会在请求中途插入、timestamp 可能比下一行还晚。2026-09-29 之前插件按
  「上一行 → 本行」算耗时且记账行也推进游标，导致解码被高估约 7 倍（799 vs 实际 ~107 t/s）、
  累计墙钟被截断（11m vs 实际 41m）。现在 stepMs 按 message 首块前的计入 entry 起算，记账行不推游标。
