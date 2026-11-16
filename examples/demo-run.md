# 一次真实的 /team 运行

环境：WSL2 Ubuntu 24.04，pi 1.5.2，pi-subagents 0.88.1，模型 deepseek-v4-pro。仓库是一个故意留了两个 TODO 的小计算器（`calc.py` + `test_calc.py`）。

## 输入

```text
/team 两件事并行做：1) 修掉 calc.py 里的两个 TODO：除以 0 时抛出 ValueError("除数不能为 0")；main() 参数个数不对时打印用法到 stderr 并返回 2；在 test_calc.py 补上对应测试。2) 新增 stats.py，提供 mean(xs) 和 median(xs)，空列表抛 ValueError；新建 test_stats.py 覆盖它们。计划不用等我确认，直接开跑。
```

## 过程（时间从发出命令算起）

| 时间 | 事件 |
|---|---|
| 0s | 主会话读 `calc.py`、`test_calc.py`，拆成两路：`calc-fixes`（calc.py, test_calc.py）和 `stats-module`（stats.py, test_stats.py）；测试命令自动识别为 `python3 -m unittest -q` |
| 35s | `stats-module` 的 worker 在自己的 worktree 里写完，测试命令由宿主机执行通过 |
| 42s | `calc-fixes` 的 worker 写完，测试通过 |
| 51s | 审查员（全新上下文、只读）看完 `stats-module` 的 patch：pass |
| 67s | 审查员看完 `calc-fixes` 的 patch：pass；整次运行结束，自动唤醒主会话 |
| 81s | 主会话调 `team_integrate`：两个 patch 依次 `git apply`，合并后的代码上再跑测试，8 个全过；用中文汇报 |

运行中 FleetView 的样子：

```text
async workflow: b04d9bae ─ background
  id: b04d9bae · 3/4 done · 1 active · 48.7s
  ✓ calc-fixes-work · team-worker · Implement calc-fixes
  ✓ stats-module-work · team-worker · Implement stats-module
  ✓ stats-module-verify-1 · team-verifier · Verify stats-module #1
  └─ calc-fixes-verify-1 ⠋ team-verifier · 6 tool uses · 19.4s
```

## 合并结果

```text
applied pi-subagents/calc-fixes-work-...: 2 files changed, 21 insertions(+), 3 deletions(-)
applied pi-subagents/stats-module-work-...: 2 files changed, 44 insertions(+)
gate `python3 -m unittest -q`: PASSED
Ran 8 tests
```

## 主会话的最终汇报（原文）

> 完成。两条 lane 都通过门禁，补丁已合并到工作区，`python3 -m unittest -q` 实测 8 个测试全过。
>
> - `calc.py`：`calc()` 除零抛 `ValueError("除数不能为 0")`；`main()` 参数个数不对时向 stderr 打印含"用法"的提示并返回 2。
> - `test_calc.py`：新增除零、参数错误两个测试，未动原有测试。
> - `stats.py`（新增）：`mean()`、`median()`，空列表抛 `ValueError`，偶数长度取中间两数平均。
> - `test_stats.py`（新增）：5 个用例覆盖普通均值、奇偶中位数、空列表报错。
>
> 未做的事：没有提交 git，`stats.py`/`test_stats.py` 还是未跟踪文件；没有清理 worker 的临时 worktree。

（后一条已在 0.1.0 修复：测试通过后 `team_integrate` 会自动删掉 worker 的 worktree 和分支。）

## 同一个会话里的防卡死表现

让它「起一个 HTTP 服务、请求一次首页、再关掉，同时找出所有 TODO」：

```text
toolbox run bg ["start","http18766","--wait-for",":18766","--","python3","-m","http.server","18766"]
  -> http18766: ready (:18766) after 0.3s
bash rg -n "TODO" --hidden -g '!.git' .          (和上一步并行)
bash curl -sS http://127.0.0.1:18766/ | head -c 500
toolbox run bg ["stop","http18766"]  -> stopped
```

服务在后台跑，没有占住前台；搜索用的是 ripgrep。
