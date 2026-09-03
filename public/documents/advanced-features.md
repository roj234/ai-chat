# 高级功能

## AntiSlop 采样

自研算法，按概率拒绝模型生成符合正则表达式的句子，用于消除"AI 味"的固定句式。

### 工作原理

1. 在流式生成过程中，实时检查新 token 是否使文本匹配预定义的正则表达式
2. 若匹配，按概率拒绝该 token，回退到正则匹配点之前
3. 重新采样，直到生成不符合任何正则的文本

### 配置示例

在设置面板的「约束采样」中配置规则：

```json
{
  "不是.{1,20}，而是": 0.9,
  ".{2}生理性的": 1,
  "值得一提的是": 0.8
}
```

### 注意事项

- 使用这个功能需要 API 支持 prefill 和 logits，很多闭源模型（特别是逆向出来的API）都不支持这些
- 中转 API 使用此功能会比较烧钱
- 建议本地推理
- 回退到正则匹配点之前，如果近距离的重试次数太多，你可能需要加入类似 `.{2}` 的正则以扩展回退范围
- 与 `logit_bias` 不同，这不是调整 token 概率

## "继续消息" / Prefill / 回复预填充 (Assistant Message Prefill)

在生成AI回复前，先插入一段自定义文本
例如
```
user: 你好
// prefill
assistant: Hello
// generated
assistant: , how are you today.
```
我们假装AI生成了Hello，那么即便输入的是中文你好，模型也会用英文回复  
在本项目中，可以用来继续因为长度限制等原因而中断的消息，或者使用AntiSlop采样器。  
其他功能也许包括jailbreak，或者按指定要求生成文本（例如预填充` ```json\n `）

## 基础角色扮演

### 角色卡导入

支持导入酒馆（SillyTavern）的角色卡：
- **JSON 格式**：直接拖入或通过导入菜单
- **PNG 格式**：支持嵌入角色信息的 PNG 卡片
- 附带世界书和预设的导入

### 世界书

基于工具调用的全新世界书实现：
- 不再使用传统正则/字符串匹配
- 通过 Function Calling 触发世界书条目
- 在支持工具调用的模型上表现远好于正则方案

### 快速切换

通过快速菜单一键切换预设和世界书组合。

## RPG 管线

基于 `response_format` 和约束采样的角色扮演游戏**框架**。  
详见[独立文档](./rpg-pipeline.md)

## 思考模式

支持多种思考格式：
- `reasoning`（OpenAI 标准）
- `reasoning_content`（Llama.cpp / DeepSeek）
- `reasoning_details`（Anthropic）
- 基于 `<think>` 标签的纯文本思考

Token/开销统计支持 OpenAI 和 llama-server 格式

### 手动 CoT

在手动思考模式下，本项目会解析以文本形式输出的思考标签，例如 <think>abc</think>  
你可以通过手动思考提示词来控制模型的思考
