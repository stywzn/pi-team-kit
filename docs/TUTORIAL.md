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

- **你只和主会话说话。** worker 有问题会通过 supervisor 通道问主会话，主会话能答的自己答，只有产品或范围上的决定才来问你。
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
| 同样的坑踩了两次 | `/team-retro`：把教训变成检查、坑或保存的事实，而不是写进文档 |
| 命令被拦了 | 看拦截原因，它会告诉你正确做法（比如改用 `bg`） |

## 7. 多个 pi 会话怎么管（tmux）

装了 [way-pi-kit](https://github.com/stywzn/way-pi-kit) 的话：每个 pi 窗口的标题会显示会话名和状态（`●` 正在跑，`✓` 刚跑完），跑完超过 20 秒会响铃，tmux 会在状态栏标出那个窗口。`pw <任务名>` 给一个独立任务开新的 worktree + 窗口。
