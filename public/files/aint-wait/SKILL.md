---
name: 'wait'
description: "不阻塞 不轮询 省钱 等待事件通知"
---

# 等待

等待的成本不是时间，是钱：每调用一次模型，整个上下文就要重新发一遍。所以正确形态永远是**一次调用阻塞到事件发生**，而不是醒来 N 次。

## 规则

- `Shell`/`RunProgram` 会在运行约 20 秒后自动转后台。
- 后台进程退出时，会注入一条进程退出通知（`<process pid exitCode logPath>`），你会被自动唤醒。**这就是通知机制，不需要轮询。**
- 等待长任务时，不要用 sleep，而是**同时**调用 `Shell` 和 `Wait`。
- `Wait` 收到任何消息会提前返回。
- 第一次 `Wait` 超时到达后，如果预计需要等 10 分钟以上：直接停，**不要调用任何工具**；否则，继续调用 `Wait`。

## 不要

- `sleep 10` 之后检查好了没。十次检查就是十份缓存读取，是等待这件事里唯一真正昂贵的部分。

## 示例

```bash
# 服务已在别处用 background: true 起好了，这里一条命令阻塞到它真的能连上（通常几秒）
until curl -sf -o /dev/null http://127.0.0.1:5173/; do sleep 0.3; done; echo ready
```

```bash
# 等构建产物写完（存在且非空）
until [ -s dist/index.js ]; do sleep 0.2; done; echo built
```

```bash
# 等测试在日志里打印出结论，命中即返回，不浪费轮次
npm test > test.log 2>&1 & tail -f test.log | grep -m1 -E "passed|failed"
```

```
# 长任务：起后台同时 Wait
RunProgram {program: "npm", arguments: ["run", "build"], background: true}
Wait {duration: 120, label: "等构建"}
```

`duration` 是安全上限而不是预测时长，给宽一点没成本——退出通知会提前把你叫醒。

没有 `until`/`curl` 时：

```powershell
while (!(Test-Path dist\index.js)) { Start-Sleep -Milliseconds 200 }
```

## 等 GUI 窗口（仅 Windows）

这个方案适用于较为复杂的轮询场景，无法用一行 bash 表达：写成脚本，让代码替你轮询。  
编写这种脚本，请阅读 `ptc-guide`。

```
RunJS({path: "~/skills/aint-wait/watch-window.js", argv: ["--title", "记事本"], timeout: 60})
```

- `--title`（子串）/ `--hwnd` / `--process`（子串）至少给一个；`--state appeared|missing|foreground`，默认 `appeared`
- `--list` 只枚举一次，看看现在有哪些窗口
- `timeout` 不要设置的太小