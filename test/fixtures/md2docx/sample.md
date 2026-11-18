# 登录接口测试报告 & <总结>

本次共 **42** 条用例，*通过* 40 条，~~跳过~~ 失败 2 条。命令：`pytest -k "login and not slow" --maxfail=1`，详见 [Allure 报告](https://example.com/report?a=1&b=2)。

## 结果

| 用例 | 结果 | 耗时 (s) |
|:--|:-:|--:|
| 成功登录 | ✅ 通过 | 1.2 |
| 密码错误 | ❌ 失败 | 0.8 |

## 待办

- 修复 flaky test
  - 去掉 `sleep(3)`
  - 改用显式等待
- [x] 补齐账号锁定用例
- [ ] 接入 CI

3. 第三步
4. 第四步

> 注意：失败的两条都和 **验证码** 有关。
> - 引用里的列表

```python
def test_login(page):
	page.fill("#user", "admin")  # 中文注释 <tag> & stuff
    assert page.url.endswith("/home")
```

![红色方块](./red%20box.png)

---

结束。
