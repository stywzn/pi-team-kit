# pi-team-kit 简易教程

10 分钟读完。看不下去就只看第 1 节，其他的遇到问题再翻。

## 1. 一分钟上手

```bash
pi install npm:pi-subagents
pi install git:github.com/stywzn/pi-team-kit
node ~/.pi/agent/git/github.com/stywzn/pi-team-kit/bin/ptk.ts demo    # 建一个练手仓库 ~/code/ptk-demo
cd ~/code/ptk-demo && pi
```

在 pi 里输入 `/ptk` 看状态，然后把 `README.md` 里那行 `/team ...` 粘进去。大约一两分钟后，主会话会告诉你改了什么、测试过没过。

不在项目目录里启动 pi 也行（比如在主目录）：在 `/team` 的目标里写上项目路径，主会话会把它作为 `repo` 传给 `team_run`；换会话接手时用 `/continue <项目路径>`。这时项目里的 `.pi/ptk.json` 不会被读取，门禁命令放全局配置或直接说。

## 2. 谁跟谁说话

```text
你 ──只和──> 主会话（lead）
               ├─> 规划员 planner：读代码，拆任务，给每个任务划定能改的文件
               ├─> worker ×≤4：各自在独立的 git worktree（仓库的独立副本）里改代码
               │      └─ 有疑问 → 问主会话（不是问你）
               └─> 审查员 verifier：全新上下文、只读，看 patch，不过关就打回同一个 worker
```

- **你只和主会话说话，而且只在开头说。** 主会话先写简报（目标、完成标准、不做什么、假设），不清楚的最多问 3 个问题，然后弹确认框。你点"是"之后就可以走开：worker 的问题由主会话回答，小决定取保守方案并记在最终报告里，跑完弹桌面通知。只有删数据、强推、动生产这类不可逆的事才会停下来等你。
- **信息向下靠 brief。** worker 只看得到自己的任务说明 + 自动注入的环境信息，所以 brief 要写清楚"改什么、在哪、怎样算完成"。规划员会按这个格式写。
- **信息向上靠结构化结果。** worker 交回改了哪些文件、跑了哪些检查；审查员交回 pass / rework / blocked 和具体问题；主会话拿到的是摘要，不是几千行日志，所以上下文不会爆。

## 3. 写好一个 /team 目标

三样东西说清楚就够了：**要什么、怎样算完成、不要碰什么**。

```text
/team 给登录接口补 E2E 测试：覆盖成功、密码错误、账号锁定三种情况，用 playwright，
测试要能在 CI 里稳定跑（不用 sleep、不依赖执行顺序）。不要改业务代码。
```

```text
/team 修复 flaky test：tests/test_orders.py::test_concurrent_checkout 偶发失败。
先写能稳定复现的测试，再修，修完连跑 20 次都要过。
```

小改动（一个文件、一个函数）不需要 /team，直接让主会话改更快。

## 4. 冲突、矛盾、死锁怎么避免

| 风险 | 怎么防住 |
|---|---|
| 两个 worker 改同一个文件 | 每个任务都有文件归属；有重叠的任务由代码合并给同一个 worker |
| 两边各自发明同一个接口 | 规划员必须把接口约定原文写进双方的 brief（先定接口，再并行） |
| worker 和审查员来回扯皮 | 返工最多 3 轮（`team.maxRounds`），超过就交给主会话/你决定 |
| 命令或测试卡住 | 命令默认 180 秒、测试 900 秒、安装构建 600 秒超时；服务和 watch 必须走后台 `bg` |
| worker 等回复等到天荒地老 | 团队运行总是后台异步跑，主会话随时能回答；整次运行有 120 分钟上限（`team.runTimeoutMin`） |
| 合并时冲突 | 按文件归属分工后基本不会；万一冲突，`team_integrate` 停在那一路并说明原因，已合并的保留 |

## 5. 模型怎么搭（DeepSeek + GLM）

在 `~/.pi/agent/ptk.json` 里按角色指定模型，名字用 `pi --list-models` 里的。推荐全部用快模型：

```json
{ "team": { "models": { "planner": "deepseek/deepseek-flash", "worker": "deepseek/deepseek-flash", "verifier": "deepseek/deepseek-flash" } } }
```

思考强度默认：拆任务、审查 `max`，worker `high`。临时改直接跟主会话说（"这次 worker 用 medium"），或者 `/team-thinking worker=medium`，`/team-thinking reset` 恢复；只对当前会话有效，不改全局。想改默认值再写 `team.thinking`。可选 off、minimal、low、medium、high、xhigh、max，模型不支持的档位 pi 会自动降。思考强度是挂在模型名后面传的：某个角色没在 `team.models` 里配模型时，调它的强度会让它用主会话的模型（确认框里能看到每个角色实际用的模型），所以建议像上面那样把三个角色的模型都写上。主会话自己的思考强度用 pi 的 `/thinking`。

### 让 team 跑得更快的几件事（默认都开着）

- worker 的副本会自动激活项目的 `.venv`、复制被 git 忽略的 `.env`，不用重装依赖、不会因为缺配置返工（`team.linkIntoWorktrees`）。
- 每一路只跑自己负责的测试文件，合并后再跑一次全套（`team.laneTests`）。
- 小而明确的目标，主会话会自己拆好任务，跳过规划员。
- `/feedback` 会显示时间花在哪个角色上。

### 阅读 agent（默认不用）

需要时直接说"让阅读 agent 看一下 xxx（关键词或目录），主题叫 xxx"。它读完给主会话一份带出处的要点（事实、关键文件、怎么跑、缺什么），结果会缓存：同一主题再问，源文件没变就直接用缓存。`/team` 时说"把阅读 agent 的 xxx 交给团队"，规划员和 worker 就不再重读一遍。

审查员最好和 worker 不是同一家模型：不同模型的盲区不一样，互相检查能发现更多问题。GLM 的 key 用 `/login` 登录，或设环境变量 `ZAI_CODING_CN_API_KEY`（国内 Coding Plan）/ `ZAI_API_KEY`（国际版）。

## 6. 出问题怎么办

| 现象 | 做法 |
|---|---|
| 不确定装好没有 | pi 里 `/ptk`；命令行 `ptk.ts doctor` |
| 想看 worker 在干嘛 | pi-subagents 的 FleetView（输入框下方），`/subagents-fleet` 打开详情 |
| 某一路 needs-human | 主会话会总结审查员的意见并给建议，你拍板就行 |
| 同样的坑踩了两次 | `/skill:retro`：把教训变成检查、坑或保存的事实，而不是写进文档 |
| 确认框里发现简报不对 | 选 No，主会话会问你要改什么，改完再确认 |
| worker 跑到一半被停（超时） | team 里每个子 agent 默认 44 分钟（`team.childTimeoutMin`），整次运行 120 分钟（`team.runTimeoutMin`）。直接用 subagent 时，在 `~/.pi/agent/extensions/subagent/config.json` 里写 `{ "timeoutMs": 2640000 }`（Windows 是 `%USERPROFILE%\.pi\agent\extensions\subagent\config.json`） |
| 命令被拦了 | 看拦截原因，它会告诉你正确做法（比如改用 `bg`） |

## 7. 换会话接着干、上下文怎么管

| 情况 | 做法 |
|---|---|
| 第二天、重启后、或者换个会话继续 | 新会话打开时会提示"有上一个主会话留下的任务"，输入 `/continue`：它带着简报、每次运行的结果接手，先核对现状、等你确认再动手 |
| 当前会话太长了，想带着要点开新的 | `/handoff <下一步要做什么>`：生成交接简报，你改一改，在新会话里回车 |
| 只是想回到某个旧会话本身 | pi 自带的 `/resume` |

上下文预算（`~/.pi/agent/ptk.json` 的 `context`，单位 token）：主会话 160k、规划员 80k、worker 120k、审查员 60k，同时不超过模型窗口的一半。规则是：

- 主会话：超过预算就在**空闲时**压缩（实测：任务进行中压缩会中断任务，所以只在一轮结束后做）；压缩两次后提示你 `/handoff`，因为摘要的摘要会丢细节。
- 规划员、worker、审查员：每个任务都是新会话，不继承；返工时继续用同一个 worker（它需要知道自己改过什么），最多 3 轮。
- 想让子 agent 也严格按预算：`ptk caps --apply`，pi 会在两轮之间按角色窗口自动压缩。

### 把一次项目的经验带到下一次（playbook）

1. 项目做完：`/harvest web-e2e-automation 给 Web 应用写自动化用例`。它从这个项目的会话记录、团队运行（含审查员每轮打回的原因）和 git 里取证据，写一份 playbook，弹编辑框给你改，存到 `~/.pi/agent/ptk/playbooks/`。
2. 下次同类任务：什么都不用说。主会话看到匹配的 playbook 会先读它，开工前问它的"Ask first"，`/team` 时把它带给规划员、worker、审查员。
3. 跑完：合并结果里会提示"用了哪个 playbook"，主会话在报告末尾提最多 3 条修改（新坑、又验证一次的、错的），你同意后它用 `playbook` 工具改单行。也可以 `/skill:retro`。

写短是硬规则：描述 200 字符内；每节最多 5～8 条，每条一行（160 字符内），全文 60 行内。写满了只能替换或删掉旧的；删掉的进 `references/retired.md`，证据在 `references/sources.md`，可复用的文件在 `templates/`。

### 工具本身哪里慢（问题清单）

跑过几次任务后，`/feedback`（默认看当前项目最近 30 天，`/feedback 7 all` 看所有项目最近 7 天）或 shell 里 `ptk feedback --repo <项目名>`。它读 pi 已有的会话记录，按耗时列出问题，比如"返工 9 次，≈38 分钟，原因：waitForTimeout ×6"、"共享 fixtures/auth.ts，把任务挤成了一路"，每条附一句可以试的方向。报告也存到 `~/.pi/agent/ptk/feedback.md`，可以直接丢给别的 agent："针对前几条，找出 pi-team-kit 里的原因，给每条提最小的改法"。

分钟数是估算（返工和"没能并行"按运行时长分摊）；审查员的打回原因从 0.5.0 起才有记录。

团队共享：建一个 playbook 仓库，大家 clone 下来，在 `~/.pi/agent/ptk.json` 里加 `"playbooks": { "dirs": ["~/code/team-playbooks"] }`；改动走 PR，CI 里跑 `ptk playbooks check .` 检查长度。`ptk playbooks` 列出现有的和使用次数。

## 8. 多个 pi 会话怎么分

终端标题是「会话名 · 目录」，会话名默认取你的第一句话，运行中前面带 `●`。跑完超过 30 秒会弹桌面通知（WSL 下是 Windows 通知，在 tmux 里也能弹）。tmux 里可以让窗口名跟随标题（`automatic-rename-format '#{pane_title}'`）。

### 几个主会话互相通知

比如一个主会话做后端（`~/code/api`），一个做前端（`~/code/web`）。不用配置，开着就互相看得见，名字默认是仓库文件夹名（`api`、`web`）：

```text
（在 api 里）把 POST /login 改成 /v2/login，改完告诉 web
```

- api 改完用 `leads` 工具发消息给 web。要求对方跟着改时带 `update=true`：web 正在跑就在下一步之前收到（不打断），空闲就被叫醒，去改自己的代码、文档、状态，再回 api 一句。
- 防止来回没完：被消息叫醒的会话再发消息，只能把对方叫醒一次（A→B→A 之后就不再叫醒，消息留着等下一轮看）。
- 防止改冲突：同一个仓库（包括它的 worktree）里，A 要改 B 最近 30 分钟改过的文件，会先被拦下，提示先告诉 B；告诉之后放行。用 shell 命令（`sed -i`、脚本、PowerShell）改的文件也算：有别的主会话在线时，命令前后各看一次 `git status`；命令没法事先拦，所以是在结果里提示"先告诉 B"。
- `/leads`（pi 里）或 `ptk leads`（shell 里，SSH 远程也能看）看谁在线、各自在做什么、最近的消息；`/leads name <名字>` 改名。对方不在线时消息会留着，下一个用这个名字的会话（通常是同一个仓库里 `/continue` 接手的那个）打开时就收到。
- 关掉：`~/.pi/agent/ptk.json` 里 `"leads": { "enabled": false }`；只想通知、不想叫醒对方：`"wake": false`。

## 9. 在浏览器里用

```bash
node ~/.pi/agent/git/github.com/stywzn/pi-team-kit/bin/ptk.ts web
```

第一次会下载 [pi-web](https://github.com/agegr/pi-web)（固定用测过的版本），然后自动打开 `http://127.0.0.1:30141`。要 Node.js 22.19 以上。图片直接粘贴或拖进输入框（deepseek-flash 能看图，v4-pro 不能）；左边是按项目分组的会话，能接着聊、改名、分叉。

和终端一起用：

- 是同一个 pi：配置、模型、会话文件、本包都共用，终端开的会话浏览器里能看到，反过来也一样。
- 同一个对话别两边同时聊：两边各有一份，互相看不到对方新说的，还会写进同一个会话文件。两边都开着时两边都会提醒，留一边就行。
- 每个浏览器会话都是一个主会话，和终端的一起出现在 `/leads` 里，改同一个文件照样先拦下。
- pi-web 会关掉闲置 10 分钟的会话；团队运行还没跑完的会话不会被关（`PI_WEB_IDLE_TIMEOUT_MS` 可以改这个时间）。
- 从别的电脑访问：`PI_WEB_PASSWORD=<长随机密码> ptk web -H 0.0.0.0`，只在可信的内网或 VPN 里用。没设密码时 `ptk web` 拒绝监听本机以外的地址。Windows PowerShell 里先 `$env:PI_WEB_PASSWORD = "..."`。
- 端口被占：`ptk web -p 8080`。停止：在那个窗口按 Ctrl+C。

回复里提到的文件（md、docx、pdf、html、图片等）会变成链接：终端里 Ctrl+点击用默认程序打开（WSL 里打开的是 Windows 那边看到的同一个文件），浏览器里点击下载，也可以在左下文件栏预览。tmux 里要先让它转发链接：`set -as terminal-features ',*:hyperlinks'`，否则链接地址显示在括号里。
