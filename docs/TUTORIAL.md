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
| worker 等回复等到天荒地老 | 团队运行总是后台异步跑，主会话随时能回答；整次运行有 60 分钟上限（`team.runTimeoutMin`） |
| 合并时冲突 | 按文件归属分工后基本不会；万一冲突，`team_integrate` 停在那一路并说明原因，已合并的保留 |

## 5. 模型怎么搭（DeepSeek + GLM）

在 `~/.pi/agent/ptk.json` 里按角色指定，名字用 `pi --list-models` 里的：

```json
{
  "team": {
    "models": {
      "planner": "deepseek/deepseek-v4-pro",
      "worker": "deepseek/deepseek-flash",
      "verifier": "zai-coding-cn/glm-5-3"
    }
  }
}
```

审查员最好和 worker 不是同一家模型：不同模型的盲区不一样，互相检查能发现更多问题。GLM 的 key 用 `/login` 登录，或设环境变量 `ZAI_CODING_CN_API_KEY`（国内 Coding Plan）/ `ZAI_API_KEY`（国际版）。

## 6. 出问题怎么办

| 现象 | 做法 |
|---|---|
| 不确定装好没有 | pi 里 `/ptk`；命令行 `ptk.ts doctor` |
| 想看 worker 在干嘛 | pi-subagents 的 FleetView（输入框下方），`/subagents-fleet` 打开详情 |
| 某一路 needs-human | 主会话会总结审查员的意见并给建议，你拍板就行 |
| 同样的坑踩了两次 | `/skill:retro`：把教训变成检查、坑或保存的事实，而不是写进文档 |
| 确认框里发现简报不对 | 选 No，主会话会问你要改什么，改完再确认 |
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

## 8. 多个 pi 会话怎么分

终端标题是「会话名 · 目录」，会话名默认取你的第一句话，运行中前面带 `●`。跑完超过 30 秒会弹桌面通知（WSL 下是 Windows 通知，在 tmux 里也能弹）。tmux 里可以让窗口名跟随标题（`automatic-rename-format '#{pane_title}'`）。

### 几个主会话互相通知

比如一个主会话做后端（`~/code/api`），一个做前端（`~/code/web`）。不用配置，开着就互相看得见，名字默认是仓库文件夹名（`api`、`web`）：

```text
（在 api 里）把 POST /login 改成 /v2/login，改完告诉 web
```

- api 改完用 `leads` 工具发消息给 web。要求对方跟着改时带 `update=true`：web 正在跑就在下一步之前收到（不打断），空闲就被叫醒，去改自己的代码、文档、状态，再回 api 一句。
- 防止来回没完：被消息叫醒的会话再发消息，只能把对方叫醒一次（A→B→A 之后就不再叫醒，消息留着等下一轮看）。
- 防止改冲突：同一个仓库（包括它的 worktree）里，A 要改 B 最近 30 分钟改过的文件，会先被拦下，提示先告诉 B；告诉之后放行。只认 pi 的 edit/write 工具改的文件，用 bash 命令改的看不到。
- `/leads`（pi 里）或 `ptk leads`（shell 里，SSH 远程也能看）看谁在线、各自在做什么、最近的消息；`/leads name <名字>` 改名。对方不在线时消息会留着，下一个用这个名字的会话（通常是同一个仓库里 `/continue` 接手的那个）打开时就收到。
- 关掉：`~/.pi/agent/ptk.json` 里 `"leads": { "enabled": false }`；只想通知、不想叫醒对方：`"wake": false`。
