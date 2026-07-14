# 编写技能

技能是包含 YAML Frontmatter 的 Markdown 文件，格式如下：
```markdown
---
name: 名称
description: >-
  描述
# 依赖的工具
allowed-tools: Read Write Grep
# 隐藏
disable-model-invocation: true
---
技能正文（Markdown）
```
`name` and `description` are required，它们会被系统提取并注入上下文。
All other keys are optional。
`disable-model-invocation`: 不注入上下文，无法被你看到，只能在用户提到后通过 Skill 工具调用

Skill 工具返回正文和技能路径。
Read 工具通过路径读取完整的文件内容。

## 路径

`~/.skills/文件夹名/SKILL.md`
技能名字来自 name 键，文件夹名任选但建议相同

## 语法

系统支持的 YAML Frontmatter 是一个很小的子集

仅支持：
- 行首注释
- Inline Scalar / Block Scalar
- Mapping / List
- Inline JSON5 (必须符合 JSON5 标准, 回退到 Inline String)
- Nesting (通过缩进)

不支持：
- 行内注释
- 混合使用 List 和 Mapping `- a: b`
- 所有未显式提到的特性
