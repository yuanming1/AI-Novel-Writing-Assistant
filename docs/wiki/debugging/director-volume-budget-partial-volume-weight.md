# execution_retry_budget_exhausted（卷预算低估节奏板跨度）：JIT 部分生成卷的预算权重坑

## 背景

自动导演 v2 的滚动生产依赖 JIT 路线窗口（`ChapterRouteWindowService.ensureRouteWindow`）：每批运行只为授权范围附近补 3—5 章路线。因此"节奏板已定完整卷规模、但路线只生成了一小段"是滚动生产的**常态**，不是数据异常。

章节预算分配（`services/novel/volume/volumeChapterBudgetAllocation.ts` 的 `allocateChapterBudgets`）有两种模式：

- 均分模式：任何卷的已有路线数 < 3 时启用，各卷均分全书预算。
- 权重模式：所有卷已有路线数 ≥ 3 时启用，按"已有路线数"作权重分配。

## 失败形态

写完某个 JIT 批次后，下一批提交进入 `volume_beat_sheet` 步骤（其 inputProvider 调用 `ensureRouteWindow`）时抛错：

- `execution_failure` 事件 message 为 `当前卷节奏板的章节跨度异常，建议先重生成节奏板，再继续生成章节标题。`
- 自动恢复预算只有 0—1 次（`modules/director/application/runtime.ts` 的 `automaticRecoveryBudget`），确定性错误重试一次后即 `stop_signal: execution_retry_budget_exhausted`，运行转为 `paused: manual_recovery`。

## 根因（2026-10-12 案例）

全书目标 80 章、3 卷：卷一 30 条路线、卷二 27 条、卷三节奏板声明 26 章但只生成了 3 条路线（JIT 窗口刚起步）。卷三路线数达到 3 后分配从均分切换为权重模式，权重 `[30, 27, 3]` 给卷三只分到 `round(80 × 3/60) = 4` 章预算；章节列表生成时节奏板要求 26 章，`resolveTargetChapterCount` 的容差（预算 + max(6, 25%)）无法覆盖，判定"节奏板跨度异常"。**节奏板本身是对的，错在预算把"JIT 只补了 3 章窗口"误当成卷的最终规模。**

同一条链路上还有一个前置陷阱：启动校验 `validateLaunch`（`app/director/productionComposition.ts`）曾把"起始章完全没路线"也 400 拦截，导致完成页推荐的范围必然提交失败（2026-10-12 已放行，起始章无路线由 JIT 窗口补齐；只有"起始章有唯一路线但范围内断档"的部分覆盖才拦截）。

## 判定方法

- 查 `DirectorNextEvent` 该 run 的 `execution_failure` message；`execution_retry_budget_exhausted` 本身只说明重试预算耗尽，真实原因在 failure message。
- 查 active `VolumePlanVersion.contentJson`：对比 `volumes[].chapters.length`（已生成路线数）与 `beatSheets[].beats[].chapterSpanHint`（节奏板声明的卷内相对跨度）。注意 `chapterSpanHint` 语义是**卷内相对章序**，prompt 明确禁止全书绝对章号。
- 按当前数据复算 `allocateChapterBudgets` 的输出，确认目标卷预算与节奏板声明规模的差值是否超过 `resolveTargetChapterCount` 容差。

## 当前规则（2026-10-12 修复后）

- 预算权重不再用"已生成路线数"代表卷规模：`resolveVolumePlanScale(volume, beatSheets)` 取 `max(已生成路线数, 节奏板 span 合计, 节奏板最远上界)`；`volumeBeatSheetGeneration` / `volumeChapterListGeneration` 调用 `allocateChapterBudgets` 时传入 `document.beatSheets`。
- 无节奏板的卷（骨架卷、未规划卷）保持原行为：规模 = 已生成路线数，通常为 0 → 维持均分模式。
- 节奏板仍是卷规模的最终事实来源：遇到"跨度异常"优先核对预算分配是否失真，**不要**先重生成节奏板（旧导演链路 `novelDirectorChapterTitleRepair` 的重整逻辑针对的是节奏板本身异常的场景）。
- 确定性错误重试必然耗尽预算：预算只有 0—1 次是保守设计，遇到该暂停要修根因（数据或代码），不要调高 `maxAutomaticRetries`。

## 相关模块

- `server/src/services/novel/volume/volumeChapterBudgetAllocation.ts`（权重分配、规模解析）
- `server/src/services/novel/volume/volumeChapterListGeneration.ts`、`volumeBeatSheetGeneration.ts`（调用方）
- `server/src/services/novel/planning/ChapterRouteWindowService.ts`（JIT 路线窗口）
- `server/src/modules/director/application/runExecutor.ts` / `runtime.ts`（重试预算）
- `server/tests/volumeChapterBudgetAllocation.test.js`（回归测试）
- `docs/wiki/debugging/director-rejection-budget-protected-content.md`（同链路的前置校验问题）
