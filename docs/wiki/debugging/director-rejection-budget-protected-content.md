# rejection_budget_exhausted：导演运行时否决预算耗尽

## 背景

新版导演运行时（`modules/director`）的运行契约带有 `rejectionBudget`（默认 3）。编排器提出的动作如果被守卫（`domain/guard.ts`）连续否决达到预算，运行会写入 `stop_signal`（`manual_recovery` / `rejection_budget_exhausted`）并转为暂停，等待人工恢复。

最常见的触发码是 `protected_content`：某步骤的产物类型（如 `chapter_task_sheet`）已存在被标记为受保护用户内容的产物，守卫拒绝执行会覆盖它的步骤（例如 `volume_chapter_list`）。

## 判定方法

- 查 `DirectorNextEvent` 中该 run 的 `action_rejected` 事件：`code` 字段说明否决原因，`action` 说明编排器想做什么。
- 查 `DirectorNextRunControl.pauseJson`：`reason: rejection_budget_exhausted` 确认暂停来源。
- 触发本错误的典型形态：运行范围（如 `chapters:3-5`）的起始章已有受保护的任务表（`chapter_task_sheet` 快照存在），但卷规划工作区没有覆盖整个范围的章节路线（缺第 4、5 章）。快照不注册 `volume_chapter_list` → 编排器认为规划步骤未完成 → 守卫拒绝覆盖 → 否决预算耗尽。
- 核对 `VolumePlanVersion`（active）的 `contentJson.volumes[].chapters[].chapterOrder`，确认规划覆盖到哪一章。

## 当前规则（2026-10-11 修复后）

- **推荐范围只覆盖已规划章节**（`app/director/projections/productionProgress.ts`）：`nextLaunchRange.to` 收敛到从起始章起连续存在的卷章节路线，起始章本身无路线时保持原行为。
- **open_run 启动校验**（`app/director/productionComposition.ts` 的 `validateLaunch`，经 `modules/director` 的 `CommandService.validateLaunch` 端口在创建运行前调用）：起始章有路线但范围内后续章节没有时，直接返回 400 与可写的最大范围，并指引用户先补全卷规划；起始章完全没有路线时放行，由运行中的 JIT 路线窗口（`volume_beat_sheet` / `chapter_route_window` 的 `ensureRouteWindow`）补齐后续路线。
- 修复前 UI 会推荐"继续写第 3—5 章"（只看已写章节与全书目标章数，不看规划覆盖），用户点击后必然触发本错误并死锁暂停。

## 后续待办

- ~~规划章节全部写完后（如卷一 1—3 章写完、卷二未规划），"继续写作"入口尚未与"补全下一卷规划"打通~~（2026-10-12 已解决）：滚动推进到已规划路线末尾时（例如写完第 60 章、第 61 章还没有路线），直接提交后续范围即可，运行中的 JIT 路线窗口会自动补齐下一批章节路线（必要时扩展后续卷骨架），用户不需要先去卷规划页手动补路线。若只想补规划不写正文，仍可在提交面板取消"生成指定章节正文"。

## 当前规则

- 这是内容保护机制按设计工作：已生成的章节任务表等受保护产物不会被自动覆盖。不要为绕过它而放宽守卫。
- 正确的恢复路径不是重放全量计划，而是以剩余章节范围重新启动（继续生成剩余章节）；范围正确的 run 会跳过已满足步骤直接进入章节批次。
- 被暂停的 run 在被新 run 取代后会转为 `cancelled`，无需人工清理。

## 失败模式

- 启动入口以全量计划范围发起"继续"类操作时，会先撞一次该保护再被纠正重启（约 30 秒内自愈）。若频繁出现，应修启动入口的范围计算，而不是提高 rejectionBudget。

## 相关模块

- `server/src/modules/director/application/runExecutor.ts`、`domain/guard.ts`
- `docs/wiki/debugging/llm-thinking-empty-content-token-cap.md`（同晚另一故障，注意区分：那个是 transport_error 空正文）
