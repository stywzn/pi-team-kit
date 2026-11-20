# pi-team-kit

给 [pi](https://pi.dev) 编码 agent 用的一套「团队干活 + 不卡死 + 少重复」工具包。装上后不用改习惯：照常跟 pi 说话，它会自己用上这些能力。

*A pi package: lead + up to 4 parallel workers + verifier + automatic rework, a command guard that stops hangs, environment facts detected by code, plain-language output, and a reusable toolbox.*

**形式**：一个标准的 pi 包（pi package）。一个 git 仓库里同时装着扩展代码、子 agent 角色、skill、`/team` 命令、工具箱脚本和 `ptk` 命令行，`pi install` 一条命令装好，`pi update` 更新，`pi remove` 卸载。不依赖任何终端、WSL 或个人配置，团队里谁装都是同一套；需要更正式的分发时，可以原样发布到 npm（`keywords` 里已经带了 `pi-package`，会出现在 [pi.dev 包列表](https://pi.dev/packages)）。

## 解决什么问题

| 问题 | pi-team-kit 的做法 |
|---|---|
| 一个人串行干活慢，多个 agent 一起改又互相覆盖 | `/team <目标>`：**规划员**读代码拆任务、给每个任务划定能改的文件，共用文件的任务合并到同一个 worker，最多 4 个 worker 并行，每个在独立的 git worktree（仓库的独立副本）里改；worker 还能把自己这一路互不相干的几块分给最多 3 个子 worker 同时做（只到这两层）。你只和主会话说话，worker 的问题由主会话回答 |
| worker 慢：重装依赖、缺配置返工、每路都跑全套测试 | worker 的副本自动激活项目 `.venv`、复制被 git 忽略的 `.env`；每一路只跑自己的测试文件，合并后跑一次全套；审查清单提前给 worker；小目标主会话自己拆、跳过规划员。思考强度：拆任务和审查 max、worker high，对话里一句话就能改（只对当前会话）。可选的阅读 agent（默认不用）读文档或代码库，提炼结果缓存复用 |
| 子任务做完没人检查，或者检查靠自觉 | 每路先跑**测试命令**（由宿主机执行，worker 自己说"测过了"不算），再由**全新上下文的只读审查员**检查；不通过就打回同一个 worker 返工，最多 3 轮，之后交给人决定。审查员可以配成另一家模型（如 worker 用 DeepSeek、审查员用 GLM） |
| 命令干等几十分钟甚至一小时 | pi 的 bash 默认没有超时。本包按命令类型给默认值：普通 180 秒、测试 900 秒、安装构建 600 秒，上限 1800 秒；测试自动带 `CI=1`（不进 watch 模式、Playwright 报告不起服务）；开发服务器、watch、`tail -f`、REPL、`cypress open` 这类不会自己结束的命令直接拦下，改用后台工具 `bg`（包在 `bash -c` 里也拦得住）；`sudo` 自动加 `-n` |
| AI 每次都重新摸索环境：用什么包管理器、镜像在哪、测试怎么跑 | 每次会话开始用**代码探测**环境（系统、WSL、运行时、镜像、代理、仓库分支、项目脚本、测试命令）注入提示词。探测出来的不会过时 |
| 踩过的坑下次还踩，查到的资源下次还要查 | `remember` 工具把事实和坑存成 JSON：事实可带一条检查命令，检查失败就标为"可能过期"；坑带正则，下次匹配到的命令会被提醒或直接拦下 |
| 每次新对话都重写 md 转 pdf 之类的脚本 | 工具箱自带 `md2pdf`、`md2docx`（md 转 Word，不用装 Word/pandoc）、`shot`（截图）、`bg`（后台进程）；回复里提到的文件（md、docx、pdf 等）自动变成链接，终端里 Ctrl+点击直接用默认程序打开，浏览器里点击下载；新写的好用脚本用 `toolbox add` 存起来，以后所有会话直接用 |
| 输出一堆黑话看不懂 | 讲人话规则：先说结论，不用没解释的缩写，英文更地道的术语（flaky test、fixture、mock）保留英文；代码会检查回复里没解释的缩写，下一轮提醒模型 |
| 没问清楚就开工，做完才发现方向不对 | 主会话开工前先写清简报（目标、完成标准、不做什么、替你做的假设），不清楚的最多问 3 个问题；`team_run` 会弹确认框，你点"是"才开跑 |
| 想交代完就走，回来看结果（像 CI/CD） | 确认之后全程无人看守：worker 的问题主会话自己答，小决定取保守方案并记下来；跑完自动合并、跑测试、写 CI 风格的报告，再弹桌面通知 |
| 换一个主会话接着干 | 每次团队运行的简报、进度、结果都记在状态文件里（不在仓库里，不弄脏工作区）。新会话打开时会提示，输入 `/continue` 接手：先核对现状、等你确认，再动手。会话太长时 `/handoff <下一步>` 生成交接简报并开新会话 |
| 上下文越用越长，又慢又贵还变笨 | 按角色设上下文预算：主会话 160k、规划员 80k、worker 120k、审查员 60k（大窗口模型也按这个算）。主会话在空闲时压缩，压缩两次后建议 `/handoff`；规划员、worker、审查员每个任务都是新会话，`ptk caps` 还能按角色给模型设窗口上限 |
| 多个 pi 会话分不清谁在干嘛 | 终端标题显示「会话名 · 目录」（第一句话自动当会话名），运行中前面带 ●；跑完超过 30 秒弹桌面通知（WSL/Windows、macOS、Linux 都支持，tmux 里也能弹） |
| 几个主会话各做相关的一块（如前端、后端），互相不知道对方改了什么 | 主会话之间自动互相可见：`leads` 工具看谁在线、各自状态，A 改完告诉 B（`update=true` 时 B 会被叫醒去改自己的代码、文档和状态，再回 A 一句）。A 要改 B 最近 30 分钟改过的文件，会先被拦下，告诉 B 之后才放行。人用 `/leads`（或 shell 里 `ptk leads`）看全局。只靠本机的几个文件，没有后台进程 |
| 做完一类任务（如用例自动化），下次同类任务又从头摸索 | `/harvest <名字>`：从这次项目的真实记录（你的纠正、失败、审查员打回的原因、通过的检查）整理出一份 playbook，存成 skill。下次同类任务主会话自动读它，开工前问它列的问题，按它的步骤做，它的"完成标准"直接当门禁。代码强制写短：每条一行，每节有上限，满了只能替换或删掉；之后的修改只改单行，不整篇重写 |
| 想知道工具本身哪里拖慢了，好继续改进 | `/feedback`（或 shell 里 `ptk feedback --repo <项目>`）：直接读 pi 已经存下的会话记录，列出工具层面的问题，按耗时排序（返工及原因、因共享文件没能并行、超时、被拦的命令、工具报错、你中途插手或按 Esc），每条带一句可以试的方向。不额外记录任何东西，所以对已经跑过的项目也能马上出结果。主会话觉得工具拖慢了，可以用 `friction` 记一句。清单可以直接交给别的 agent 去调研怎么改 |
| 终端里传图片、翻会话不方便 | `ptk web`：在浏览器里用 pi（[pi-web](https://github.com/agegr/pi-web)），粘贴/拖图片、会话列表、文件和 diff 预览，中文界面。跑的是同一个 pi、同一份配置和会话，本包的功能照常；终端照常用，两边不冲突：同一个对话两边都开着会提醒，用 shell 命令改的文件也计入冲突检测，浏览器里的团队运行没跑完不会被自动关掉 |
| 同样的错误反复出现 | `retro` skill（`/skill:retro`）：把这次会话里浪费时间的地方变成检查、保存的坑或事实，而不是写进文档 |
| `grep -r`、`find` 慢 | 引导到 pi 内置的 `grep`/`find` 工具（底层是 ripgrep/fd）或 `rg`/`fd`，没装就用 pi 自带的那份 |

## 安装

需要 pi（Node.js 22.19+）。在 pi 所在的环境里（Linux / macOS / WSL）：

```bash
pi install npm:pi-subagents
```

```bash
pi install git:github.com/stywzn/pi-team-kit
```

打开 pi，输入 `/ptk` 看状态。全部检查和练手仓库用命令行：

```bash
node ~/.pi/agent/git/github.com/stywzn/pi-team-kit/bin/ptk.ts doctor
```

```bash
node ~/.pi/agent/git/github.com/stywzn/pi-team-kit/bin/ptk.ts demo
```

> 如果装过 pi 官方的 subagent 示例扩展（`~/.pi/agent/extensions/subagent/index.ts`），它也注册了 `subagent` 工具，会和 pi-subagents 冲突，先移走。`ptk doctor` 会检查这一项；用 [way-pi-kit](https://github.com/stywzn/way-pi-kit) 安装会自动处理。

**Windows（不用 WSL）注意**：
- 需要 Git for Windows：pi 的 bash 工具、门禁命令和事实检查都用它带的 bash。
- Python 会自动挑一个真能运行的：`python`、`py -3` 或 `python3`，会跳过微软商店那个只会提示 "Python was not found" 的空壳。
- 如果是从本地路径安装的（`pi install C:\...`），先运行一次 `ptk doctor --fix`。pi 会把路径存成反斜杠，pi-subagents 就找不到本包的规划员、worker、审查员。

**10 分钟教程：[docs/TUTORIAL.md](docs/TUTORIAL.md)**（角色怎么配合、怎么写目标、怎么防冲突和死锁、DeepSeek + GLM 怎么搭）。

## 用法

```text
/team 修掉 calc.py 的两个 TODO 并补测试，同时新增 stats.py（mean/median）和测试
```

两个阶段：

1. **和你一起**：主会话读必要的代码，写出简报（目标、完成标准、不做什么、假设），有不清楚的就问你；确认框里点"是"。
2. **无人看守**：规划员拆任务，worker 并行干活，审查员把关、不过关就返工；跑完自动唤醒主会话，合并各路改动，在合并后的代码上再跑一遍测试，写一份 CI 风格的报告，弹桌面通知。你回来看报告就行。

进度在 pi-subagents 的 FleetView 里看。第二天换个会话接着干：`/continue`。

真实运行记录：[examples/demo-run.md](examples/demo-run.md)（两路并行，81 秒完成）。端到端测试 `test/e2e/rework.sh` 用一个"第一轮必打回"的审查员夹具，验证规划 → 并行 → 打回 → 返工 → 合并整条链路（实测 2 分钟左右）。

其他能力不用记命令，直接说就行：

```text
把 docs/report.md 转成 PDF
起一下开发服务器，确认首页能打开
记住：测试数据库在 docker compose 的 db 服务，端口 5433
```

## 团队流程

```text
你 ──> 主会话 ── 目标 + 完成标准 ──> team_run
                  ├─ 规划员：读代码，拆任务，给每个任务划定文件，跨任务的接口先写死
                  │    共用文件的任务合并成一路（lane）
                  ├─ lane A: worker(独立 worktree) → 测试命令 → 审查员 → [返工 → 测试 → 审查]×≤3
                  ├─ lane B: ...                                   最多 4 路同时跑
                  │    worker 有疑问 → 问主会话（不是问你）
                  └─ 完成事件唤醒主会话 ──> team_integrate：从各 worktree 取改动，按顺序合并，再跑一遍测试
```

没有单独的"监控会话"：完成通知、卡住提醒、进度展示都由 pi-subagents 的运行时用代码完成，不花模型的 token，也不会跑偏。也没有让人去和子会话对话：信息向下靠 brief 和自动注入的环境信息，向上靠结构化结果（改了哪些文件、跑了哪些检查、审查结论）。

思路上参考了 Lauren Tan（poteto）的 pstack：验收要有运行时证据（这里是宿主机执行的测试命令），把反复纠正的错误变成检查（`retro` skill），按任务类型选作业手册（规划员的 bug fix / feature / refactor / 测试 / 性能 五种写法），不同模型互相审查，每次改动后重新检查（每轮返工都换一个全新的审查员）。

## 配置

所有键和默认值都在 [`lib/config.ts`](lib/config.ts) 里（以代码为准，不另写文档）。全局写在 `~/.pi/agent/ptk.json`，项目级写在 `<仓库>/.pi/ptk.json`，项目覆盖全局：

```json
{
  "guard": { "testTimeoutSec": 1200, "preferFastSearch": "warn" },
  "team": {
    "gate": "npm run lint && npm test",
    "maxParallel": 3,
    "models": { "worker": "deepseek/deepseek-flash", "verifier": "zai-coding-cn/glm-5-3" }
  },
  "plainTalk": { "allow": ["SKU", "GMV"] }
}
```

agent 用 `remember` 存下的项目事实放在 `.git/ptk/facts.json`：在 git 目录里，`git status` 看不到，不会弄脏工作区挡住团队运行，也不会被误提交。想和团队共享时，运行 `ptk facts share`，把它们合并进 `.pi/ptk/facts.json` 再提交；团队文件只在 pi 信任该项目后才加载。

想让子 agent 的上下文也严格按预算走：配好 `team.models` 之后运行 `ptk caps` 看建议，`ptk caps --apply` 写进 `~/.pi/agent/models.json`（会先备份）。pi 会在两轮之间按这个窗口自动压缩，不会打断正在跑的任务。

和 [way-pi-kit](https://github.com/stywzn/way-pi-kit) 的关系：way-pi-kit 是作者个人的终端环境（WSL + tmux + WezTerm），它可以安装本包；本包不依赖它，也不包含任何个人配置。

## 设计原则

- **能用代码就不写文档**：环境靠探测，规则靠检查，事实带检查命令。文档会过时，代码要么能跑、要么报错。
- **能确定性检查的就不交给模型**：超时、拦截、合并、测试都是代码；模型只做需要判断的事（拆任务、写代码、审查）。
- **所有等待都有上限**：命令超时、测试超时、整次团队运行的期限、返工轮数。
- **站在现成的轮子上**：并行、worktree、审查、通知用 [pi-subagents](https://github.com/nicobailon/pi-subagents)，本包只补它没有的那层。

## 开发

```bash
npm install && npm test
```

`npm test` 不花模型 token：用一个假的 pi-subagents 跑生成的团队脚本（通过、返工、测试失败修复、超过轮数交给人、规划员模式），加上安全测试（恶意任务文本、路径穿越、未信任项目的配置）和性能测试（防卡死检查每条命令约 9 微秒，环境探测约 15 毫秒）。CI 在 Linux / macOS / Windows × Node 22 / 24 上跑。

真实模型的端到端测试（几分钱，约 2 分钟）：

```bash
PTK_E2E_WORKER_MODEL=deepseek/deepseek-flash bash test/e2e/rework.sh
```

## 许可

MIT
