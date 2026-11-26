---
name: 'ptc-guide'
description: "How to use PTC (programmatic tool call)."
---

# Programmatic Tool Call

> 必须通过 `RunJS` 沙箱运行。

调用方式如下：

```js
import tools from 'tools';
import {Read} from 'tools';

// 方式A: 默认导入
await tools('Read', { path: "test.txt" });

// 方式B: 具名导入
await Read({ path: "test.txt" });
```

差异在于，默认导入在调用时检测权限，具名导入在 import 时检测

返回值格式如下：

```ts
type TextPart = {
    type: 'text';
    text: string | Blob;
}

type ImagePart = {
    type: 'image_url';
    image_url: {
        url: Blob | string;
    };
}
type AudioPart = {
    type: 'input_audio';
    input_audio: {
        data: Blob | string;
    };
}
type VideoPart = {
    type: 'video_url';
    video_url: {
        url: Blob | string;
    }
}

type ContentPart = TextPart | ImagePart | AudioPart | VideoPart;

type ToolResult = Promise<{
    success: boolean
    time: number
    duration: number
    content: string | ContentPart[]
}>
```

## 发送通知

> 和其它异步通知一样能打断 Wait

```js
import {notify} from 'tools';

await new Promise(r => setTimeout(r, 1000))

notify("操作成功");
```

## 等待通知

> 打破循环

```js
import {Wait} from 'tools';

// 注意：PTC中的Wait工具只接收 duration 一个参数，且支持小数。
// 省略或设置为 nullish 将查询当前是否有通知，不等待。
// 设置为 0 将无限期等待，直到收到通知
// 返回的 content （若存在）是一个数组，每个元素是收到的通知。
const result = await Wait({ duration: 0.5 });
let toConsume;
if (result.success) {
    console.log(`等待 ${result.duration}ms 后收到${result.content.length}个通知`);
    toConsume = result.content[0];
} else {
    // 未收到通知
}

// 读取的通知不被消费：它们仍然会推送给你；如果希望删除某个通知，这么做：
import {consume} from 'tools';
// 然后，这条通知就被 PTC 消费了，不会通过对话推送给你
await consume(toConsume);

```

## 使用和限制

沙箱内置 `node:fs/promises` shim，包括 `glob` 和 `exclude` 支持，文件操作应通过它完成。

- 沙箱的 `fetch` 是客户端发出的，可能和工作区不在同一网络
- 工具返回值通常为原始字符串，需要解析。
- 不支持需要交互的工具（如 `AskUser`）
- 无法等待 Harness 层的异步任务（如 `CreateAgent` 会立即返回ID）
- 每次 RunJS 调用最多执行 100 次工具调用。
- 顶层函数返回后无法再执行工具调用，未触发的定时器被取消，日志被丢弃
  - 依然可以操作文件系统、等待原生异步 Promise（如网络、流等）、发送通知