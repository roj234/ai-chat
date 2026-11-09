/**
 * 各语言的示例内容
 *
 * 目的：切换语言时能立刻看到该语言的着色效果（块注释、模板字符串、
 * 标签属性、三引号、正则、宏调用等构造都在示例里出现）。
 */

const JS = `// 虚拟列表 + 异步高亮的演示
import {useMemo, useState} from "react";

const CACHE = new Map();
const LIMIT = 1024 * 32;

/**
 * 只高亮「可见区上下各 200 行」：
 * highlight.js 在时间片里跑，滚到哪儿算哪儿，与文件总行数无关。
 */
export function highlightWindow(lines, from, to) {
	const text = lines.slice(from, to).map((l) => l.text).join("\\n");
	const html = hljs.highlight(text, {language: "javascript"}).value;
	return splitMultilineHTML(html, []);
}

const RE_WORD = /[A-Za-z_$][\\w$]*/g;
const r = \`模板字符串可以
跨很多行，里面的 \${1 + 1} 会被单独着色\`;

export default class VirtualEditor {
	#lines = [];
	#version = 0;

	constructor(text) {
		this.#lines = text.split("\\n");
	}

	get length() {
		return this.#lines.length;
	}

	scrollTo(line) {
		const index = Math.max(0, Math.min(this.#lines.length - 1, line));
		return this.#lines[index]?.trim() ?? "";
	}
}
`;

const TS = `import type {Language, Token} from "./types";

interface EditorOptions {
	readonly lineHeight?: number;
	readOnly?: boolean;
	language?: Language | "plain";
}

type TokenSink = (start: number, end: number, kind: number) => void;

/** 高亮结果的状态机：算完之前先按纯文本渲染 */
export enum HighlightState {
	Idle = 0,
	Pending = 1,
	Ready = 2,
	Stale = 3
}

export class WindowHighlighter<T extends Language = Language> {
	private readonly opts: Required<EditorOptions>;
	protected state: HighlightState = HighlightState.Idle;

	constructor(opts: EditorOptions = {}) {
		this.opts = {lineHeight: 20, readOnly: false, language: "plain", ...opts};
	}

	/** 可见区 + 上下文，太长的窗口直接放弃 */
	scan(line: string, sink: TokenSink): HighlightState {
		/* 这里只是示例 */
		return this.state;
	}
}

const cache = new WeakMap<object, WindowHighlighter>();
`;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8"/>
	<meta name="viewport" content="width=device-width, initial-scale=1"/>
	<title>虚拟列表编辑器</title>
	<!-- 注释可以跨行，
	     高亮不会因为换行而断掉 -->
	<style>
		.vje-line { height: 20px; white-space: pre; }
	</style>
</head>
<body>
	<main id="app" class="editor" data-mode="editable">
		<h1>Hello&nbsp;World</h1>
		<p>行数再多也只渲染可见的那几十行 &mdash; 这就是虚拟列表。</p>
		<button type="button" onclick="location.reload()">重新加载</button>
		<ul>
			<li>语法高亮</li>
			<li>自绘光标与选区</li>
			<li>Ctrl+Z 撤销</li>
		</ul>
	</main>
	<script>
		const el = document.getElementById("app");
		console.log("ready", el.dataset.mode);
	</script>
</body>
</html>
`;

const CSS = `/* 主题变量 */
:root {
	--bg: #ffffff;
	--fg: #1f2328;
	--accent: #0969da;
	--radius: 6px;
}

/**
 * 行容器：
 * 保持 height 固定，虚拟列表才敢用固定行高算偏移
 */
.vje-line {
	height: 20px;
	line-height: 20px;
	padding-left: calc(var(--digits) * 1ch + 22px);
	white-space: pre;
}

.vje-line:hover,
.vje-line.is-current {
	background: #f6f8fa;
}

@media (max-width: 720px) {
	.vje-line {
		padding-left: 28px;
		font-size: 12px;
	}
}

.sel {
	background: rgba(9, 105, 218, 0.22);
}

.vje-gutter-nums {
	color: #8b949e;
	text-align: right;
	user-select: none !important;
}
`;

const PY = `#!/usr/bin/env python3
"""跨行状态在 Python 里就是三引号字符串。

下面这个 docstring 会跨很多行，
而且里面的 # 井号不是注释。
"""

from dataclasses import dataclass
from typing import Iterable


@dataclass
class Token:
    start: int
    end: int
    kind: str = "plain"


def tokenize(text: str, state: int = 0) -> tuple[list[Token], int]:
    tokens: list[Token] = []
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]
        if ch == "#":                        # 行注释
            tokens.append(Token(i, n, "comment"))
            break
        if text.startswith('\"\"\"', i):
            close = text.find('\"\"\"', i + 3)
            if close < 0:
                return tokens, 2             # 状态 2：三引号没闭合
            tokens.append(Token(i, close + 3, "string"))
            i = close + 3
            continue
        i += 1

    return tokens, 0


if __name__ == "__main__":
    lines: Iterable[str] = ["x = 1", "y = 2"]
    print(f"{len(list(lines))} lines, ratio={1 / 3:.2%}")
`;

const SQL = `-- 统计每个语言的行数
/* 这是一个
   跨行的块注释 */
WITH stats AS (
	SELECT
		language_id,
		COUNT(*)            AS files,
		SUM(line_count)     AS lines,
		MAX(updated_at)     AS last_seen
	FROM editor_file
	WHERE deleted_at IS NULL
	  AND line_count > 0
	GROUP BY language_id
)
SELECT
	s.language_id,
	l.name,
	s.files,
	s.lines,
	ROUND(s.lines * 100.0 / SUM(s.lines) OVER (), 2) AS pct
FROM stats s
JOIN language l ON l.id = s.language_id
ORDER BY s.lines DESC
LIMIT 20;

INSERT INTO editor_file (id, language_id, line_count, updated_at)
VALUES ('f_01', 'javascript', 1200, '2026-11-08 12:00:00');
`;

const YAML = `# 编辑器配置
version: 2
name: syntax-editor
enabled: true

server:
  host: 0.0.0.0
  port: 5199
  timeout: 30s
  tls:
    enabled: false
    cert: null

languages:
  - id: json
    label: JSON
    stateful: false
  - id: javascript
    label: JavaScript
    stateful: true
    openers: ["/*", "\`"]

limits: &limits
  maxLines: 200000
  maxBytes: 33554432

override: *limits

description: |
  竖线后面的内容按块标量处理，
  这里一般写多行说明文字。
`;

const SH = `#!/usr/bin/env bash
# 打包并发布，失败就退出
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
OUT="\${ROOT}/dist"
PORT="\${PORT:-5199}"

if [[ ! -d "\${ROOT}/node_modules" ]]; then
	echo "缺少依赖，先安装" >&2
	exit 1
fi

for f in "\${ROOT}"/src/*.js; do
	[[ -e "\$f" ]] || continue
	echo "打包 \$f"
done

node "\${ROOT}/node_modules/@roj234/ie/cli.js" dev --port "\${PORT}"

# 大文件用 dd 更稳，但这里只是示例
dd if=/dev/zero of="\${OUT}/empty.bin" bs=1M count=1 2>/dev/null

echo "完成：\${OUT}"
`;

const MD = `# 虚拟列表编辑器

一个**只渲染可见行**的代码编辑器，支持 10 万行不卡。

## 特性

- [x] 语法高亮（多语言）
- [x] 自绘光标 / 选区
- [x] 撤销重做
- [ ] 代码折叠

> 行数只影响滚动条位置，不影响每帧的 DOM 工作量。

\`\`\`js
// 围栏代码块内部整行原样显示
const rows = visibleRange(scrollTop, height, lineHeight);
render(rows.from, rows.to);
\`\`\`

常用命令见 [文档](https://example.com/docs)，图片语法：![logo](./logo.png)。

| 语言 | 跨行状态 |
| --- | --- |
| JSON | 无 |
| JavaScript | 块注释 / 模板字符串 |
`;


const JAVA = `package com.example.editor;

import java.util.List;
import java.util.Map;

/**
 * 跨行块注释对 hljs 来说是最基本的场景。
 */
public class HighlightService implements AutoCloseable {
    private static final int MAX_LINES = 200_000;
    private final Map<String, List<String>> cache;

    public HighlightService(Map<String, List<String>> cache) {
        this.cache = cache;
    }

    @Override
    public void close() {
        cache.clear();
    }

    public String pick(String key) {
        List<String> rows = cache.get(key);
        if (rows == null || rows.isEmpty()) {
            return "";
        }
        return rows.get(0) + "…";   // 注释
    }
}
`;

const GO = `package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// 跨行注释
/*
   块注释
*/

type Editor struct {
	Lines int
	ready bool
}

func (e *Editor) Highlight(ctx context.Context) error {
	if !e.ready {
		return errors.New("editor not ready")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(80 * time.Millisecond):
		return nil
	}
}

func main() {
	e := &Editor{Lines: 100000, ready: true}
	if err := e.Highlight(context.Background()); err != nil {
		fmt.Println("failed:", err)
	}
	fmt.Printf("lines=%d\n", e.Lines)
}
`;

const RUST = `use std::collections::HashMap;

/// 文档注释用三个斜杠
#[derive(Debug, Default)]
pub struct Editor {
    lines: Vec<String>,
    cache: HashMap<String, usize>,
}

impl Editor {
    pub fn new() -> Self {
        Self::default()
    }

    /* 块注释可以跨行
       而且支持嵌套 */
    pub fn highlight(&mut self, lang: &str) -> Result<usize, String> {
        if lang.is_empty() {
            return Err("empty language".to_string());
        }
        let count = self.lines.iter().filter(|l| !l.trim().is_empty()).count();
        self.cache.insert(lang.to_string(), count);
        Ok(count)
    }
}

fn main() {
    let mut e = Editor::new();
    e.lines.push(String::from("fn main() {}"));
    match e.highlight("rust") {
        Ok(n) => println!("{n} lines"),
        Err(msg) => eprintln!("error: {msg}"),
    }
}
`;

const C = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 跨行块注释
   第二行仍然在注释里 */
#define MAX_LINES 200000

typedef struct {
    char *data;
    size_t len;
} Buffer;

static int buffer_init(Buffer *b, size_t cap) {
    b->data = malloc(cap);
    if (!b->data) return -1;
    b->len = 0;
    return 0;
}

int main(int argc, char **argv) {
    Buffer b;
    if (buffer_init(&b, 1024) != 0) {
        fprintf(stderr, "oom\n");
        return 1;
    }
    // 行注释
    printf("cap=%d\n", MAX_LINES);
    free(b.data);
    return 0;
}
`;


export const SAMPLES = [JAVA, GO, RUST, C, JS, TS, HTML, CSS, PY, SQL, YAML, SH].join('\n\n');
