# UPSTREAM.md：上游同步记录

本仓库是 [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)（Apache-2.0）的**私有镜像**，AISEP 改动在 `aisep-main` 分支上。为什么用私有镜像而不是 GitHub fork：GitHub 的 fork 只能公开。决策见 AISEP `decisions.md` ADR-006。

## 当前锁定版本

| 项 | 值 |
|---|---|
| 上游 tag | `v0.15.3`（stable，2026-11-16 发布） |
| 上游 commit | `dec37bc9941e78cf1ebf1ada9e8028b1a2978555` |
| 上次同步日期 | 2026-11-19（初始基线，尚未合并过上游） |
| AISEP 主线 | `aisep-main` |

## Remote 约定

- `upstream` = OrchestratorInc/agent-orchestrator，**只拉不推**：push 地址已设成无效值 `DISABLED-no-push-to-upstream`。
- `origin` = Albertsun6/aisep-workbench（私有）。

## 同步步骤（升级演练）

1. `git fetch upstream --tags`，选定目标 tag（优先 stable）。
2. `git checkout -b sync/<tag> aisep-main && git merge --no-ff <tag>`
3. 有冲突就逐个解决。`frontend/src/renderer/routeTree.gen.ts` 不要手工合，重新生成即可。把每个冲突记入下方“已知冲突点”。
4. 验证：`cd frontend && npm ci && npm run typecheck` 加 AISEP 相关的 vitest，再启动开发实例看一眼 Architecture 面板。
5. 验证通过后合回 `aisep-main`，更新上表的锁定版本和同步日期，在下方“同步记录”追加一行。

## 已知冲突点

（初始为空）

| 文件 | 原因 | 是否由 AISEP 改动引起 | 解决方式 |
|---|---|---|---|

## 同步记录

| 日期 | 从 → 到 | 冲突数 | 耗时 | 备注 |
|---|---|---|---|---|
