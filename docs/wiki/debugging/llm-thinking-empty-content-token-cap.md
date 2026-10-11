# 思考型模型结构化调用返回空正文（Token 上限被思考耗尽）

## 背景

用户把模型路由的 Token 上限清空（或填了 4096，历史占位值会被当作"未配置"存为 null）后，章节任务表审核（`novel.volume.chapter_task_sheet_quality@v2`）等结构化阶段连续失败，报错：

```
[STRUCTURED_OUTPUT:transport_error] 模型没有返回可用内容，无法执行结构校验或 JSON 修复。
```

调用记录特征：HTTP 调用本身 `completed`，completionTokens **恰好等于输出上限**（4096 或 8192），输入 Token 正常。任务中心/运行记录里表现为"生成失败"且 Token 统计未返回。

## 根因链

1. 结构化审核类调用未显式传 maxTokens → 路由为空 → anthropic 协议客户端兜底 `max_tokens = 4096`（`anthropicClient.ts`）。
2. glm-5.3 等思考型模型经网关（custom_new_api 等）走 anthropic 协议时**默认开启思考**，思考与正文共享 max_tokens 预算。
3. 服务端此前只对 openai 兼容协议下发 `thinking` 参数，且 `isGlmThinkingModeProvider` 不识别自定义网关；anthropic 协议客户端不传 thinking → 思考无法关闭。
4. 审核任务上下文大，思考阶段独自烧完 4096，`stop_reason=max_tokens` 且没有任何 text 内容块。
5. `structuredInvokeParser` 只提取 text 块，rawContent 为空 → 抛 `transport_error`。

同理，生成类服务显式传 16384 的 maxTokens 会被 anthropic profile 的 `safeStructuredMaxTokens: 8192` 钳到 8192，思考开启时同样偶发空正文（beat_sheet、chapter_execution_contract 的 8192 截断记录即此）。

## 当前规则（2026-10-11 修复后）

- `reasoning.ts` 的 `isGlmThinkingModeProvider`：GLM 4.5+ 模型在**自定义网关**上同样视为思考型（对齐 DeepSeek 的既有处理），显式下发 `thinking` 参数。
- `structuredOutput.ts`：anthropic 协议与自定义网关（openai 兼容）的 profile 对 GLM/DeepSeek 思考型模型标记 `requiresNonThinkingForStructured` + `supportsReasoningToggle`，即**结构化调用强制关思考**（与 Qwen 混合思考模型的既有策略一致）；这类模型的 `safeStructuredMaxTokens` 放开到 16384，其余保持 8192（保护 claude-3.5 等真实上限）。
- `factory.ts`：思考型模型的结构化 anthropic 调用若未配置上限，兜底 16384，不再落入客户端 4096 默认；`thinking` 参数从 modelKwargs 提升后传入 anthropic 客户端。
- `anthropicClient.ts`：请求体支持 `thinking: { type: "enabled" | "disabled" }`。
- 自由文本调用（如章节正文）不受影响，仍按模型默认思考行为执行。

## 诊断方法

- 查 `LlmInvocationUsageRecord`：失败调用的 completionTokens 恰好等于 4096/8192 → 预算被截断。
- 查 `DirectorNextEvent` 的 `execution_failure`：报"模型没有返回可用内容"即空正文路径，与截断互为印证。
- 用户侧快速自检：把该任务路由的 Token 上限调大后重试，若恢复即此问题。

## 失败模式与关联模块

- 影响范围：所有走 Prompt Registry 结构化调用 + anthropic 协议 + 思考型模型的组合（审核、契约、清单类 JSON 阶段）。
- 关联模块：`server/src/llm/{reasoning,structuredOutput,factory,anthropicClient,structuredInvokeParser}.ts`。
- 残留风险：非思考型模型的空正文（网关异常）、自由文本长输出仍可能被低上限截断（表现为内容不完整而非报错）。

## 相关文档

- `docs/wiki/debugging/recurring-failure-modes.md`
- `server/src/prompting/README.md`（Prompt Registry 结构化输出约定）
