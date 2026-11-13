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
    content: string | ContentPart
}>
```

## 发送通知

> 和其它异步通知一样能打断 Wait

```js
import {notify} from 'tools';

await new Promise(r => setTimeout(r, 1000))

notify("操作成功");
```

## 使用和限制

沙箱内置 `node:fs/promises` shim，包括 `glob` 和 `exclude` 支持，文件操作应通过它完成。

- 工具返回值通常为原始字符串，需要解析。
- 不支持需要交互的工具（如 `AskUser`）
- 无法等待 Harness 层的异步任务（如 `CreateAgent` 会立即返回ID）
- 每次 RunJS 调用最多执行 100 次工具调用。
- 顶层函数返回后无法再执行工具调用，未触发的定时器被取消，日志被丢弃
  - 依然可以操作文件系统、等待原生异步 Promise（如网络、流等）、发送通知