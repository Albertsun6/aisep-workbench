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

## AISEP 接触面（合并时只需关注这些）

AISEP 代码全部在 `frontend/src/renderer/aisep/`（上游没有这个目录，合并永不冲突）。碰到上游的只有：

| 文件 | AISEP 改了什么 |
|---|---|
| `frontend/src/renderer/components/Sidebar.tsx` | 3 行：`SidebarTopNavRow` 前加 `export`；`import { AisepSidebarItems } from "../aisep/AisepSidebarItems";`；Artifacts 行后 `<AisepSidebarItems isCollapsed={isCollapsed} />` |
| `frontend/src/renderer/routes/_shell.aisep.$.tsx` | AISEP 新增的路由壳（3 行），上游没有同名文件 |
| `frontend/src/renderer/routeTree.gen.ts` | 生成文件，多出 aisep 路由的几行 |
| 上游 `APP_LOCALES`（`frontend/src/shared/ui-locale.ts`） | AISEP 不改它，但 `aisep/i18n/index.ts` 按它做类型约束：上游加语言时 typecheck 会报 `Property '<locale>' is missing`，补一个 `aisep/i18n/<locale>.json` 即可 |
| AO 会话接口（`GET /api/v1/sessions`，类型取自 `frontend/src/api/schema.ts` 的 `ControllersSessionView`） | AISEP 不改它，只读。工作台"AI 进行中"区域（ADR-013）经 `aisep/data/ao-sessions.ts` 读取，这是 AISEP 唯一引用 AO API 客户端和生成类型的文件。用到的字段：`id`、`status`、`isTerminated`、`kanbanColumn`（只看是否为 `archive`）、`harness`、`branch`、`terminalTitle`、`displayName`、`issueId`。`status` 的 15 个取值：`working`、`pr_open`、`draft`、`ci_failed`、`review_pending`、`changes_requested`、`commented`、`approved`、`mergeable`、`merged`、`needs_input`、`exited`、`idle`、`terminated`、`no_signal`。`STATUS_BUCKETS` 按这个联合类型写成 `Record`：上游增删取值时 typecheck 报错，补上分组即可。另引用 `lib/api-client`（`apiClient`、`hasTrustedApiBaseUrl`）和 `lib/agent-options`（`agentLabel`） |

上游 i18n 语言文件（`frontend/src/renderer/i18n/*.json`）**AISEP 不改**：AISEP 文案在独立命名空间 `aisep` 里。

## 同步步骤（升级演练）

1. `git fetch upstream --tags`，选定目标 tag（优先 stable）。
2. 开一个独立 worktree 做合并，避免打扰正在运行的开发实例：
   `git worktree add ../workbench-sync -b sync/<tag> aisep-main && cd ../workbench-sync && git merge --no-ff <tag>`
3. `git diff --name-only --diff-filter=U` 列出冲突，逐个解决并记入下方“已知冲突点”：
   - `routeTree.gen.ts` 不手工合，在 `frontend/` 下重新生成：
     `node --input-type=module -e 'import { Generator, getConfig } from "@tanstack/router-generator"; const root = process.cwd(); await new Generator({ config: getConfig({ routesDirectory: "./src/renderer/routes", generatedRouteTree: "./src/renderer/routeTree.gen.ts", target: "react", autoCodeSplitting: true }, root), root }).run();'`
   - `Sidebar.tsx` 按上表的 3 行重放。
4. 装依赖，**三处都要装**，否则 typecheck 报一堆假错：仓库根、`packages/product-ui`、`frontend` 各跑一次 `npm ci`。
5. 验证（在 `frontend/` 下）：
   - `npm run typecheck`
   - `npx vitest run --config vite.renderer.config.ts src/renderer/aisep src/renderer/components/Sidebar.test.tsx src/renderer/i18n src/renderer/router.test.tsx`
   - 核对 AO 会话接口：`git diff <旧 tag> <新 tag> -- frontend/src/api/schema.ts`，看 `ControllersSessionView` 里上表列出的字段和 `status` 取值有没有改名、删除或改语义；`status` 有新增时 typecheck 已经报错，按上游 `attentionZone`（`packages/product-ui/src/session-presentation.ts`）和后端 `DeriveStatus` 的含义补进 `STATUS_BUCKETS`；`kanbanColumn` 的 `archive` 是否仍只表示已终止的会话（后端 `DeriveKanbanPresentation`）
   - 启动隔离开发实例，点侧栏 AISEP 看页面，改一处 `aisep/i18n/en.json` 看热重载：
     `env -u AO_PORT AO_PORT=3500 AO_DEV_ELECTRON_DIR=<dir>/electron AO_RUN_FILE=<dir>/running.json AO_DATA_DIR=<dir>/data npm run dev`（`<dir>` 用一个新目录，绝不用 `~/.ao`）
6. stable 版本验证通过后合回 `aisep-main`，更新“当前锁定版本”，在“同步记录”追加一行；nightly 只演练，不合回。
7. 清理：`git worktree remove ../workbench-sync`。

<!--
本机环境坑（2026-11-20 演练记录，均与 AISEP 无关）：
- `npm run dev` 的 predev 偶发报 "macOS dictation helper signing failed"，codesign 提示 "resource fork, Finder information, or similar detritus not allowed"。
  原因：~/Desktop 由 File Provider（iCloud 桌面同步）管理，新建的 Orchestrator.app 目录被打上 com.apple.FinderInfo / com.apple.fileprovider.fpfs#P 扩展属性，与 codesign 竞争。重跑即过；不改上游脚本，免得新增冲突点。
- 退出开发实例：菜单 Quit 后 daemon 不退出，Electron 主进程一直等它。做法：按确切 PID 先 TERM `frontend/daemon/ao daemon`，再 TERM Electron；还不退就对那个 Electron PID 用 KILL。不要用宽泛的 pkill。
- 全量 vitest 在本机有 4 个与 AISEP 无关的失败：HarnessUpdateNotice（时区，TZ=UTC 下通过）、browser-cookie-repair（electron-forge start 把 better-sqlite3 重编成 Electron ABI，Node 下加载失败）、browser-history-store（负载下的计时偶发，单跑通过）。
- 新数据目录的开发实例首次启动是欢迎页，选 "continue without an account"，再结束引导 tour。
-->

## 已知冲突点

| 文件 | 原因 | 是否由 AISEP 改动引起 | 解决方式 |
|---|---|---|---|
| `frontend/src/renderer/aisep/i18n/index.ts`（语义冲突，git 不报） | 上游 `v0.15.4-nightly.202611182129` 在 `APP_LOCALES` 里新增 `tr`；AISEP 的语言表按 `AppLocale` 做了类型约束 | 是（AISEP 的类型约束有意让它报错） | 新增 `aisep/i18n/tr.json` 并在 `index.ts` 加一行 import 和一项映射。不补的话 typecheck 报错、AISEP 测试加载失败，应用启动时也会崩，所以 typecheck 是不能跳过的门 |

## 同步记录

| 日期 | 从 → 到 | 冲突数 | 耗时 | 备注 |
|---|---|---|---|---|
| 2026-11-20 | `v0.15.3` → `v0.15.4-nightly.202611182129`（**演练，未合回**） | git 冲突 0；语义冲突 1（新语言 `tr`） | 合并到测试全绿约 8 分钟（其中 npm ci 约 5 分钟，修复约 2 分钟）；加上开发实例实机验证，总计约 33 分钟，多出来的时间都花在本机环境坑上 | 上游 111 个提交、1301 个文件；`Sidebar.tsx` 上游改了 35 行，与 AISEP 的 3 行不相邻，自动合并；`routeTree.gen.ts` 上游未改，重新生成后无差异。typecheck 0 错，目标测试 9 个文件 266 个全过，实机页面和热重载正常。修复提交在演练分支 `sync/v0.15.4-nightly.202611182129`（`0b694e8`），下次同步 stable 时重放 |
