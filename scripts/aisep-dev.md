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
node scripts/aisep-dev.mjs start --approve --branch <分支> --workbench <工作台检出>
node scripts/aisep-dev.mjs preflight <分支>
node scripts/aisep-dev.mjs refresh
```

### 两种模式

| | 预览模式（默认） | 批准模式（`--approve`） |
|---|---|---|
| 谁启动 | 任何会话都可以 | **只由 Albert 本人启动**，其他会话不得启动 |
| allow-root | 只有专用检出 `~/Desktop/AISEP/aisep-serve` | 再加整个 `~/Desktop/AISEP/aisep` |
| 能看的 | 首页、关口页（模型差异、gate、批准人下拉） | 同左 |
| 能批准吗 | 不能，前提是专用检出里面没有别的 git 检出。起作用的是 allow-root 只含专用检出：各会话的分支 worktree 都在它外面，批准工具报 `PATH_OUTSIDE_ROOT`（专用检出是游离 HEAD 只是附带的，它自己没有分支可批）。启动时如果发现专用检出里面有别的 git 检出（worktree 或独立 clone），直接拒绝启动 | 能，批准写进分支所在的 worktree |
| 用多久 | 随意 | 只开批准那一步，批准完立即停止 |

两种模式都用 `workbench` 画像。没有用 `agent` 画像做预览，是因为它带写工具（`model_add_element`、`model_remove` 等），会对本机不带 Origin 的进程开放写入。`workbench` 画像只有只读工具和批准工具，预览模式下批准工具又被 allow-root 挡住。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--approve` | 关 | 批准模式，见上节 |
| `--branch` | 无 | 只用来打印关口页地址（批准模式下也打印预检命令） |
| `--workbench` | 脚本所在的检出 | 网页版从哪个工作台检出启动。批准那一步要指向含 L2 进度展示改动的检出 |
| `--mcp-port` | `18790` | MCP 服务端口。`preflight` 也用它找服务 |
| `--web-port` | `15190` | Vite 端口，带 `--strictPort`：端口被占就直接失败，不会自动换端口 |
| `--ao-api` | `http://127.0.0.1:9` | 网页版 `/api`、`/mux` 的代理目标（`AO_DEV_API_TARGET`） |
| `--fetch-interval` | `60` | 运行期间每隔多少秒自动 `git fetch origin` 一次，`0` 关闭。见下节「自动刷新」 |

默认端口避开了 3001（AO 守护进程）、5173（`electron-forge` 等开发服务）和 18765、15173（规划会话在用）。

环境变量（都有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AISEP_ROOT` | `~/Desktop/AISEP` | 下面三项的默认值都从它推出 |
| `AISEP_REPO` | `$AISEP_ROOT/aisep` | aisep 仓库，也是批准模式多加的那个 allow-root |
| `AISEP_SERVE_DIR` | `$AISEP_ROOT/aisep-serve` | 专用检出 |
| `AISEP_PYTHON` | `$AISEP_REPO/.venv/bin/python` | 解释器 |

### start

1. 检查两个端口都空闲，前端依赖已装。
2. 维护专用检出（见下节）：`git fetch origin` 后把它移到最新 `origin/main`，HEAD 不等于 `origin/main` 就拒绝启动。
3. 确认解释器导入的 `aisep` 来自专用检出。服务从启动目录导入代码，不从主检出导入。
4. 起 MCP 服务：

   ```text
   python -m aisep.server --transport http --profile workbench --port <mcp-port>
     --repo ~/Desktop/AISEP/aisep-serve
     --allow-root ~/Desktop/AISEP/aisep-serve
     [--allow-root ~/Desktop/AISEP/aisep]   # 只在 --approve 时
     --allow-origin http://localhost:<web-port> --allow-origin http://127.0.0.1:<web-port>
   ```

5. 起网页版：`node frontend/scripts/dev-web.mjs --port <web-port> --strictPort`，带 `VITE_AISEP_MCP_URL=http://127.0.0.1:<mcp-port>/mcp` 和 `AO_DEV_API_TARGET`。这和 `npm run dev:web -- …` 等价，只是少一层 npm 进程，方便按进程组停止。
6. 等 MCP 的 `tools/list` 和网页首页都有响应，然后打印要打开的地址：
   - 首页：`http://localhost:<web-port>/#/aisep`
   - 关口页：`http://localhost:<web-port>/#/aisep/gate/<分支>`。现在首页没有进入关口页的入口，要直接输地址，分支名里的 `/` 原样保留。

7. 就绪后开始自动刷新（见下节）。

两个服务各自成一个进程组。按 Ctrl-C，或对 `start` 进程的 PID 发 `SIGTERM`，脚本向两个进程组发 `SIGTERM`；组里 5 秒后还有进程就 `SIGKILL` 整组。判断看整个进程组，不只看组长，所以 `dev-web.mjs` 先退出时它拉起的 Vite 也会被停掉。任一服务意外退出，另一个也会被停掉，并且不再打印就绪信息。

来源必须精确匹配：页面来源是 `http://localhost:<web-port>`，所以 Vite 端口和 `--allow-origin` 由同一个参数决定。来源对不上时，服务对页面的请求一律回 403，前端只报「no response」。

### 专用检出

服务的代码和 `--repo` 都用 `~/Desktop/AISEP/aisep-serve`：这是 aisep 仓库登记的一个 worktree，游离检出 `origin/main`。

- 第一次 `start` 或 `refresh` 时用 `git worktree add --detach` 新建。
- 之后每次 `start` 和 `refresh` 都会先 `git fetch origin`，再 `git checkout --detach origin/main`。
- 检出里有任何未提交改动、检出了分支、或者目录不是 aisep 仓库的 worktree，都拒绝移动。
- 不读写主检出 `~/Desktop/AISEP/aisep` 的工作区。`git fetch` 只更新共享的远端跟踪引用。

`--repo` 也必须在 allow-root 之内（aisep `gitio.locate_repo`），所以专用检出本身总是 allow-root。批准模式另加的 `~/Desktop/AISEP/aisep` 覆盖各会话放在 `aisep/.claude/worktrees` 和 `aisep/aisep/.claude/worktrees` 下的分支 worktree。

### 自动刷新

`start` 运行期间，每隔 `--fetch-interval` 秒（默认 60）在 aisep 仓库跑一次 `git fetch origin`。一轮做完再等下一轮，不会叠在一起。

- **远端跟踪引用每轮都更新。** 关口页的「已推送」「已合入」读的是 `refs/remotes/origin/*`，所以推送、合并之后最多一个间隔加一次进度轮询（15 秒）就能看到，不用再手动 `refresh`。fetch 只更新远端跟踪引用（带 `--no-auto-maintenance`，不顺带跑 gc；带 `--no-write-fetch-head`，不改写主检出的 `.git/FETCH_HEAD`），不动主检出和任何分支 worktree 的工作区。
- **和别的 fetch 并发。** 本机其他会话同时在这个仓库 `git fetch` 时，对方偶尔会报 `cannot lock ref`（两边抢同一个远端跟踪引用的锁），重试即可，仓库不会损坏。本脚本这边遇到同样的情况只打印一行，下一轮再试。
- **专用检出只在安全时自动跟到新的 `origin/main`。** 首页的「已批准」读的是专用检出的工作区，所以它要跟上 main 才会变。四条同时满足才移动（`git checkout --detach`，与 `refresh` 相同）：
  1. 专用检出是 aisep 仓库登记过的游离 worktree；
  2. 工作区干净（含未跟踪文件）；
  3. 只是快进：专用检出的 HEAD 在新 `origin/main` 的历史上；
  4. 从**服务启动时的提交**到新 `origin/main`，服务已加载的文件都没变：`aisep/`（服务的全部 Python 代码）、`modules/`、`vendor/`、`requirements.txt`。`aisep-mcp/` 只有测试，不算。比较基准是启动时记下的提交，不是专用检出当前的 HEAD：服务运行中有人手动 `refresh` 过，HEAD 就已经不是进程里加载的版本。

  不满足时不动，只打印一行原因。前三条的提示是「…首页要看新的 main 就处理后跑 refresh」；第 4 条的提示是「服务启动后 main 改了服务已加载的代码或规则文件（modules/aisep-core/shapes.ttl），要先停掉服务，再重新 start；服务运行中不要 refresh」。
- **为什么第 4 条不跟。** 运行中的服务在进程里留着这些文件的旧版本，换了文件不重启就会新旧混用：
  - `aisep/`：启动时导入的 Python 代码。之后才懒加载的模块会读到新代码。
  - `modules/`、`vendor/`：aisep `core.py` 里有两份**按路径**缓存的数据。`_SC` 是 `modules/aisep-core/shapes.ttl` 的 SHACL-SPARQL 约束（`ApprovalRecordShape` 等），`_RT` 是 vendor 的 ArchiMate 关系表。专用检出的路径不变，文件换了也不会重读，于是同一次校验里一部分用新规则、一部分用旧规则。
  - 模型文件（`models/`）没有按路径的缓存：pyshacl 那层按文件内容缓存（`_content_key`），其余每次请求现读。所以只改模型、文档、测试、CI 的 main 可以不重启地跟过去，这也是合并批准后最常见的情况。

  改了上面四类的 main，要人来决定什么时候停服务、重新 `start`。
- **切换时不等在途请求。** 自动 `checkout` 不会等服务正在处理的请求，切换恰好落在一次请求中间时，这次结果可能新旧文件混读。下一次请求就正常了。手动 `refresh` 也是一样。
- **断网不退出。** fetch 失败只打印一行 `git fetch origin 失败，服务照常运行，下一轮再试：…`，服务照常运行。同样的结论连续出现只打印一次，变了才再打印，断网时不会每分钟刷屏。
- 自动刷新只在 `start` 进程里跑。`preflight` 仍然不 fetch；服务本身也从不 fetch。

### refresh

只移动专用检出的工作区。首页不传 ref，读的是 `--repo` 的工作区。`start` 的自动刷新已经会在安全时跟进 main（见上节），`refresh` 留给这几种情况：没有在跑 `start`、用了 `--fetch-interval 0`、或者自动刷新提示「没有自动跟进」而你处理完了想立刻移动。`refresh` 不检查快进和服务已加载的文件，只要检出干净就移动。

服务运行中 `refresh`，只在新的 main 相对服务启动时的提交没改 `aisep/`、`modules/`、`vendor/`、`requirements.txt` 时安全，例如冻结窗口内只合了模型。理由见上节「为什么第 4 条不跟」：模型文件不按路径缓存，换了会被读到；代码和这两份按路径缓存的规则不会重读。改了这四类，就要停掉服务后重新 `start`，不要在服务运行中 `refresh`。

### preflight

逐项输出「通过 / 不通过」，全部通过时退出码为 0。需要服务已经在 `--mcp-port` 上运行，而且是批准模式：预览模式下第一项必然不通过。

| 项 | 怎么查 |
|---|---|
| 分支不是 `main` | 主分支上不能批准 |
| 分支已在服务 allow-root 下的 worktree 检出 | `git worktree list --porcelain` 取第一条匹配，与服务的查找规则相同。allow-root 从端口上那个服务进程的启动参数里读（`lsof` 只取 IPv4 上的监听者，`ps` 读整条命令行，路径里有空格也行；路径里出现以 `-` 开头的片段时分不清参数边界，判为读不到，不截成更宽的 allow-root），不用脚本自己的推算；端口上有多个 IPv4 监听进程时也判为读不到 |
| 该 worktree 的 `models/` 干净 | `git status` 只看 `models/` 下的 `.ttl`（含未跟踪），与服务端判脏的范围相同。带 assume-unchanged 或 skip-worktree 标记的文件这里看不到 |
| 本地头等于远端头 | 本地 `refs/heads/<分支>` 对比 `git ls-remote origin`。不 fetch，不改本地引用 |
| `tools/list` 含 `governance_record_approval` | 确认服务是 `workbench` 画像 |
| 分支头还不在 `origin/main` 上 | 先沿第一父提交跳过顶端的批准提交（与服务端 `mergecheck._effective_content` 同一思路，只按形状认：单父、恰好新增一个 `models/<slug>/governance/*.ttl`、恰好一个 `AISEP-Evidence` trailer），再 `git merge-base --is-ancestor`，用本地记录的 `origin/main`。已合入或与 main 同头时，关口页的四个关口都会被拒 |
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

- **批准模式下，批准工具对本机不带 Origin 的进程开放。** `workbench` 画像包含 `governance_record_approval`。服务只校验浏览器请求的 Origin，不带 Origin 的请求（curl、本机任意脚本或 agent）直接放行（aisep `server.py` 的 `OriginGate`）。批准模式的 allow-root 覆盖整个 `~/Desktop/AISEP/aisep`，所以批准模式运行期间，本机任何进程都能以任意 Stakeholder 的名义，给任一会话的分支写批准记录。缓解：默认是预览模式；批准模式只由 Albert 本人启动，批准完立即停止；其他会话不得启动批准模式，也不得调用批准工具。
- 预览模式的 allow-root 是专用检出本身。服务运行期间有人在 `aisep-serve` 里面再建一个分支 worktree 或放一个独立 clone（服务端只要求仓库在 allow-root 下），上面的分支在预览模式下也能被批准；启动时的检查只覆盖启动那一刻。不要在专用检出里面放任何 git 检出。
- `--approve` 只是一个开关，没有二次确认。脚本拦不住会话自己加 `--approve`（交互确认也能被管道喂过去），靠的是规则：只由 Albert 本人启动。
- 预览模式下批准工具同样列在 `tools/list` 里，关口页的批准表单也照常显示，点了会被服务拒绝：分支 worktree 不在 allow-root 内，`gitio.locate_worktree` 报 `PATH_OUTSIDE_ROOT`（读代码得出，没有实际点过批准）。
- 界面语言是英文。
- 只验证了网页版。Electron 版没有验证；`--ignore-scripts` 跳过了原生模块构建，对网页版没有影响。
- Claude 桌面应用的内置浏览器面板隐藏时，页面停在启动画面不往下走；在普通浏览器或无头 Chrome 里正常。原因未查。
