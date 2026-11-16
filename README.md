# pi-team-kit

给 [pi](https://pi.dev) 编码 agent 用的一套「团队干活 + 不卡死 + 少重复」工具包。装上后不用改习惯：照常跟 pi 说话，它会自己用上这些能力。

*A pi package: lead + up to 4 parallel workers + verifier + automatic rework, a command guard that stops hangs, environment facts detected by code, plain-language output, and a reusable toolbox.*

## 解决什么问题

| 问题 | pi-team-kit 的做法 |
|---|---|
| 一个人串行干活慢，多个 agent 一起改又互相覆盖 | `/team <目标>`：主会话拆任务，**按文件归属分组**，共用文件的任务合并到同一个 worker，最多 4 个 worker 并行，每个在独立的 git worktree（仓库的独立副本）里改 |
| 子任务做完没人检查，或者检查靠自觉 | 每路先跑**测试命令**（由宿主机执行，worker 自己说"测过了"不算），再由**全新上下文的只读审查员**看 patch；不通过就打回同一个 worker 返工，最多 3 轮，之后交给人决定 |
| 命令干等几十分钟甚至一小时 | pi 的 bash 默认没有超时。本包默认 180 秒、上限 1200 秒；开发服务器、watch、`tail -f`、REPL 这类不会自己结束的命令直接拦下，改用后台工具 `bg`；`sudo` 自动加 `-n`，分页器和密码提示通过环境变量关掉 |
| AI 每次都重新摸索环境：用什么包管理器、镜像在哪、测试怎么跑 | 每次会话开始用**代码探测**环境（系统、WSL、运行时、镜像、代理、仓库分支、项目脚本、测试命令）注入提示词。探测出来的不会过时 |
| 踩过的坑下次还踩，查到的资源下次还要查 | `remember` 工具把事实和坑存成 JSON：事实可带一条检查命令，检查失败就标为"可能过期"；坑带正则，下次匹配到的命令会被提醒或直接拦下 |
| 每次新对话都重写 md 转 pdf 之类的脚本 | 工具箱自带 `md2pdf`、`shot`（截图）、`bg`（后台进程）；新写的好用脚本用 `toolbox add` 存起来，以后所有会话直接用 |
| 输出一堆黑话看不懂 | 讲人话规则：先说结论，不用没解释的缩写；代码会检查回复里没解释的缩写，下一轮提醒模型 |
| `grep -r`、`find` 慢 | 引导到 pi 内置的 `grep`/`find` 工具（底层是 ripgrep/fd）或 `rg`/`fd`，没装就用 pi 自带的那份 |

## 安装

需要 pi（Node.js 22.19+）。在 pi 所在的环境里（Linux / macOS / WSL）：

```bash
pi install npm:pi-subagents
```

```bash
pi install git:github.com/stywzn/pi-team-kit
```

打开 pi，输入 `/ptk` 看状态。全部检查用命令行：

```bash
node ~/.pi/agent/git/github.com/stywzn/pi-team-kit/bin/ptk.ts doctor
```

> 如果装过 pi 官方的 subagent 示例扩展（`~/.pi/agent/extensions/subagent/index.ts`），它也注册了 `subagent` 工具，会和 pi-subagents 冲突，先移走。`ptk doctor` 会检查这一项。

## 用法

```text
/team 修掉 calc.py 的两个 TODO 并补测试，同时新增 stats.py（mean/median）和测试
```

主会话会读必要的代码、列出任务表，然后调 `team_run` 在后台开跑；跑完自动唤醒，调 `team_integrate` 把各路 patch 合进工作区，再在合并后的代码上跑一遍测试，最后用大白话汇报。worker 遇到需要决定的事会通过 supervisor 通道问主会话。进度在 pi-subagents 的 FleetView 里看。

上面这条命令的真实运行记录（两路并行，81 秒完成，含时间线和合并结果）：[examples/demo-run.md](examples/demo-run.md)。

其他能力不用记命令，直接说就行：

```text
把 docs/report.md 转成 PDF
起一下开发服务器，确认首页能打开
记住：测试数据库在 docker compose 的 db 服务，端口 5433
```

## 团队流程

```text
主会话 ── 拆任务（每个任务带文件归属）──> team_run
          │  共用文件的任务合并成一路（lane）
          ├─ lane A: worker(独立 worktree) → 测试命令 → 审查员 → [返工 → 测试 → 审查]×≤3
          ├─ lane B: ...                                   最多 4 路同时跑
          └─ 完成事件唤醒主会话 ──> team_integrate：按顺序 git apply，合并后再跑一遍测试
```

没有单独的"监控会话"：完成通知、卡住提醒、进度展示都由 pi-subagents 的运行时用代码完成，不花模型的 token，也不会跑偏。

## 配置

所有键和默认值都在 [`lib/config.ts`](lib/config.ts) 里（以代码为准，不另写文档）。全局写在 `~/.pi/agent/ptk.json`，项目级写在 `<仓库>/.pi/ptk.json`，项目覆盖全局：

```json
{
  "guard": { "defaultTimeoutSec": 300, "preferFastSearch": "warn" },
  "team": { "gate": "npm run lint && npm test", "maxParallel": 3 },
  "plainTalk": { "allow": ["SKU", "GMV"] }
}
```

项目里 `remember` 存下的事实在 `.pi/ptk/facts.json`，提交进仓库，团队成员就共享同一份环境知识。

## 设计原则

- **能用代码就不写文档**：环境靠探测，规则靠检查，事实带检查命令。文档会过时，代码要么能跑、要么报错。
- **能确定性检查的就不交给模型**：超时、拦截、合并、测试都是代码；模型只做需要判断的事（拆任务、写代码、审查）。
- **所有等待都有上限**：命令超时、测试超时、整次团队运行的期限、返工轮数。
- **站在现成的轮子上**：并行、worktree、审查、通知用 [pi-subagents](https://github.com/nicobailon/pi-subagents)，本包只补它没有的那层。

## 开发

```bash
npm install && npm test
```

测试会用一个假的 pi-subagents 跑生成的团队脚本，覆盖通过、返工、测试失败修复、超过轮数交给人这几种情况，不花模型 token。

## 许可

MIT
