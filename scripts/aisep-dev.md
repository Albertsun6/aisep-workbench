# AISEP 一键启动与批准前预检

`scripts/aisep-dev.mjs` 一条命令起两样东西：aisep 的 MCP HTTP 服务（`workbench` 画像），和工作台网页版（`dev:web`）。另有一个只读的批准前预检。只用 Node 内置模块，不改上游依赖。

## 前提

- aisep 仓库在 `~/Desktop/AISEP/aisep`，解释器 `~/Desktop/AISEP/aisep/.venv/bin/python`。
- 要启动的工作台检出装过前端依赖。没装时脚本会拒绝启动，并打印这条命令：

  ```bash
  cd <工作台检出>/frontend && ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
  ```

## 命令

```bash
node scripts/aisep-dev.mjs start --branch <分支> --workbench <工作台检出>
node scripts/aisep-dev.mjs preflight <分支>
node scripts/aisep-dev.mjs refresh
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--branch` | 无 | 只用来打印关口页地址 |
| `--workbench` | 脚本所在的检出 | 网页版从哪个工作台检出启动。批准那一步要指向含 L2 进度展示改动的检出 |
| `--mcp-port` | `18790` | MCP 服务端口。`preflight` 也用它找服务 |
| `--web-port` | `15190` | Vite 端口，带 `--strictPort`：端口被占就直接失败，不会自动换端口 |
| `--ao-api` | `http://127.0.0.1:9` | 网页版 `/api`、`/mux` 的代理目标（`AO_DEV_API_TARGET`） |

默认端口避开了 3001（AO 守护进程）、5173（`electron-forge` 等开发服务）和 18765、15173（规划会话在用）。

环境变量 `AISEP_REPO`、`AISEP_SERVE_DIR`、`AISEP_PYTHON` 可以改仓库、专用检出和解释器的位置。

### start

1. 检查两个端口都空闲，前端依赖已装。
2. 维护专用检出（见下节）：`git fetch origin` 后把它移到最新 `origin/main`，HEAD 不等于 `origin/main` 就拒绝启动。
3. 确认解释器导入的 `aisep` 来自专用检出。服务从启动目录导入代码，不从主检出导入。
4. 起 MCP 服务：

   ```text
   python -m aisep.server --transport http --profile workbench --port <mcp-port>
     --repo ~/Desktop/AISEP/aisep-serve
     --allow-root ~/Desktop/AISEP/aisep --allow-root ~/Desktop/AISEP/aisep-serve
     --allow-origin http://localhost:<web-port> --allow-origin http://127.0.0.1:<web-port>
   ```

5. 起网页版：`node frontend/scripts/dev-web.mjs --port <web-port> --strictPort`，带 `VITE_AISEP_MCP_URL=http://127.0.0.1:<mcp-port>/mcp` 和 `AO_DEV_API_TARGET`。这和 `npm run dev:web -- …` 等价，只是少一层 npm 进程，方便按进程组停止。
6. 等 MCP 的 `tools/list` 和网页首页都有响应，然后打印要打开的地址：
   - 首页：`http://localhost:<web-port>/#/aisep`
   - 关口页：`http://localhost:<web-port>/#/aisep/gate/<分支>`。现在首页没有进入关口页的入口，要直接输地址，分支名里的 `/` 原样保留。

两个服务各自成一个进程组。按 Ctrl-C，或对 `start` 进程的 PID 发 `SIGTERM`，脚本向两个进程组发 `SIGTERM`；组里 5 秒后还有进程就 `SIGKILL` 整组。判断看整个进程组，不只看组长，所以 `dev-web.mjs` 先退出时它拉起的 Vite 也会被停掉。任一服务意外退出，另一个也会被停掉，并且不再打印就绪信息。

来源必须精确匹配：页面来源是 `http://localhost:<web-port>`，所以 Vite 端口和 `--allow-origin` 由同一个参数决定。来源对不上时，服务对页面的请求一律回 403，前端只报「no response」。

### 专用检出

服务的代码和 `--repo` 都用 `~/Desktop/AISEP/aisep-serve`：这是 aisep 仓库登记的一个 worktree，游离检出 `origin/main`。

- 第一次 `start` 或 `refresh` 时用 `git worktree add --detach` 新建。
- 之后每次 `start` 和 `refresh` 都会先 `git fetch origin`，再 `git checkout --detach origin/main`。
- 检出里有任何未提交改动、检出了分支、或者目录不是 aisep 仓库的 worktree，都拒绝移动。
- 不读写主检出 `~/Desktop/AISEP/aisep` 的工作区。`git fetch` 只更新共享的远端跟踪引用。

`--repo` 也必须在 allow-root 之内（aisep `gitio.locate_repo`），所以 allow-root 有两项：`~/Desktop/AISEP/aisep` 覆盖各会话放在 `aisep/.claude/worktrees` 和 `aisep/aisep/.claude/worktrees` 下的分支 worktree；`~/Desktop/AISEP/aisep-serve` 覆盖专用检出本身。

### refresh

只移动专用检出的工作区。首页不传 ref，读的是 `--repo` 的工作区，所以合并后要跑一次 `refresh`，首页才会把新模型显示为已批准。服务按文件内容缓存解析结果，不会读到旧数据（aisep `core.py`），所以只换模型数据时不用重启服务。

运行中的服务用的仍是启动时导入的 Python 代码。新的 main 改了 `aisep/*.py` 时，`refresh` 不会让服务换代码，要停掉后重新 `start`。

### preflight

逐项输出「通过 / 不通过」，全部通过时退出码为 0。需要服务已经在 `--mcp-port` 上运行。

| 项 | 怎么查 |
|---|---|
| 分支不是 `main` | 主分支上不能批准 |
| 分支已在 allow-root 下的 worktree 检出 | `git worktree list --porcelain`，取第一条匹配，与服务的查找规则相同 |
| 该 worktree 的 `models/` 干净 | `git status` 只看 `models/` 下的 `.ttl`（含未跟踪），与服务端判脏的范围相同。带 assume-unchanged 或 skip-worktree 标记的文件这里看不到 |
| 本地头等于远端头 | 本地 `refs/heads/<分支>` 对比 `git ls-remote origin`。不 fetch，不改本地引用 |
| `tools/list` 含 `governance_record_approval` | 确认服务是 `workbench` 画像 |
| 分支头还不在 `origin/main` 上 | `git merge-base --is-ancestor`，用本地记录的 `origin/main`。已合入或与 main 同头时，关口页的四个关口都会被拒 |
| 分支头 `model_gate` 为 PASS | 和关口页一样：先 `model_diff` 取分支头，再在该提交上跑 gate |
| 批准人下拉 | 用关口页逐字相同的查询列出 Stakeholder，行数和顺序与页面下拉一致，第 1 行是默认值。所属模型另查一次，只用来标注 |

另外还输出两项信息：专用检出与远端 `main` 是否一致，以及 `model_diff` 的 head、base 和条目数。

预检只调用 `model_diff`、`model_gate`、`model_query`。脚本里只有这三个工具名能发出 `tools/call`，没有调用批准工具的代码路径。git 命令带 `GIT_OPTIONAL_LOCKS=0`，`git status` 不会回写别的会话的 index；带 `GIT_TERMINAL_PROMPT=0`，凭据失效时直接报错，不会卡在提示上。

预检没覆盖的服务端检查：批准时头提交之后不能有非批准提交（`STALE_HEAD`）、写锁冲突、批准过程中 worktree 被切换分支。全部通过不等于批准一定成功。

**选批准人**：下拉会列出所有模型里带中文标签的 Stakeholder，默认选中第一行，可能是 procurement 的「首席架构师」。批准新模型时要选新模型的「项目负责人」。预检的列表会写出每个人所属的模型。

## 网页模式下没有数据的栏目

- **「AI 进行中」**一直显示 Loading。这一栏读 AO 守护进程的 `GET /api/v1/sessions`，网页版把 `/api` 代理到 `--ao-api`。默认指向不监听的 `127.0.0.1:9`，免得连到本机 3001 上别的会话的守护进程。首页唯一能点进关口页的链接也在这一栏，所以关口页只能直接输地址。
- 侧栏显示 `daemon stopped`，项目、会话等 AO 自己的页面用的是网页版的示例数据。
- 默认不接 AO 时，Vite 每隔几秒会报一次 `/api` 代理失败，脚本不转发这些日志。用 `--ao-api` 指向真实守护进程时照常转发。

## 已知风险

- **批准工具对本机不带 Origin 的进程开放。** `workbench` 画像包含 `governance_record_approval`。服务只校验浏览器请求的 Origin，不带 Origin 的请求（curl、本机任意脚本或 agent）直接放行（aisep `server.py` 的 `OriginGate`）。所以服务运行期间，本机任何进程都能以任意 Stakeholder 的名义写批准记录。服务只为批准那一步起，用完就停；在服务运行期间，别的会话不得调用批准工具。
- allow-root 覆盖整个 `~/Desktop/AISEP/aisep`，其中所有会话的 worktree 都可以被批准。
- 界面语言是英文。
- 只验证了网页版。Electron 版没有验证；`--ignore-scripts` 跳过了原生模块构建，对网页版没有影响。
- Claude 桌面应用的内置浏览器面板隐藏时，页面停在启动画面不往下走；在普通浏览器或无头 Chrome 里正常。原因未查。
