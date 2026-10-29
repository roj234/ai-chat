# 路线图 / 已知问题

## TODO

- 延迟插入消息的 deferred 模式尚未实现
- 给人类用的文件管理 UI

- 加入Goal模式
- 有些供应商根本就不处理special tokens的，可能需要sanitizer
- 消息引用和流式序列化一起用在特定条件下必然出错，而且似乎和浏览器本身有关
- 富文本输入框
- 子代理回调脚本允许运行在同一个线程内
- 实装sadbox
- JSONEditor还是要想办法上虚拟列表，不然元素太多很卡
- CSS隔离和过滤 CSS Parser
- Browser Use
- 在IndexedDB/OPFS后端中实现附件管理
- JSX Parser 允许Overlay运行脚本，而且允许引用VFS中的网页，而且允许在Window中打开，而且提供API调用LLM和文件系统还有部分unconscious函数还有使用说明
- 交互式配置向导（CLI/服务器初始化）
- /fsync提交文件的diff而不是修改时间
