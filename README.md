# AiChat - 爱聊天

AiChat 是一个现代化的高性能纯 Web AI 前端，基于 [Unconscious](https://github.com/Roj234/unconscious) 响应式框架，支持 OpenAI-兼容 API，提供流畅的聊天体验。
- **你可以在任何能运行浏览器的设备上使用 AiChat，不需要 Docker，不需要 Python 环境，不需要数据库——你的敌人只有 CORS。**
- AiChat 性能很好，AiChat 后端可选，AiChat 界面好看；这是我开发它的理由，我未能在 GitHub 找到适合我的 LLM 前端
- 前端(gzipped) 1.5MB 可选后端(+所有依赖) 650KB

![Banner](media/banner.webp)

> 说真的，如果你希望有一个点开`index.html`就能用的前端，那你恐怕只能选我  
> 尽管我没有提供真正的`即点即用`版本，因为ESM按需导入不支持 `file://` —— 至少要一个静态文件服务  
> 你可用`vite-single-file`插件自行构建即点即用版本  

## 🚀 特性

- **高性能**：
  - 使用无 VDOM 的自研框架，内存占用很低
  - 我自己就是它的深度用户，页面一开就是几天，从未 Out Of Memory，内存几乎不超过 100MB
     - 你可能会说这很显然，但这不显然，我用的是32位的chrome，相当一部分垃圾网站会内存溢出（> 1GB）
     - 例如DeepSeek网页版或者模搭社区
  - markdown渲染经过极为充分的优化（基于状态机和最高 O(n) per character 的时间复杂度），实现了100%的流式渲染
    - 解析性能高于 `marked` (虽然不是CommonMark兼容，但更适合LLM)
  - 语法高亮性能优于 `shiki-stream`
    - 在数百TPS下流畅更新不丢帧，不会和某些前端一样TPS高就无响应甚至崩溃
  - 对话和代码块使用虚拟列表
  - Chart.js、KaTex、Mermaid 和语法高亮均按需加载，入口文件仅 200KB
  - 我很想说可能是世界上性能最好的LLM前端，但绝对会被打脸吧！
- **并发对话**：同时进行多个对话，他们在后台运行，互不干扰
- **思考开关**：通过一个按钮开关模型的思考能力，支持手动CoT
- **压缩导出**：以Zip格式导出对话数据中的多媒体（图片、音频等），而且不依赖第三方API
- **响应式设计**：移动端友好，支持暗黑主题，手机能用，手机好用
- **Mermaid 图表**：渲染各种Mermaid图表
- **改进的Markdown渲染**：正确渲染**“中文引号加粗”**标记(是的，如左侧)
  - 可能是唯一支持的开源前端，因为按CommonMark规范，**它就是不该加粗**
- **音效**：厌倦了一直盯着网页？可选在生成结束时发出声音
- **角色扮演（AIRP）**：导入酒馆的角色卡、世界书和预设（JSON/PNG格式），并配有现代化的响应式编辑器
  - 快速菜单一键切换预设和世界书
  - 基于工具调用的全新世界书实现，在支持工具调用的模型上表现远好于传统正则/字符串匹配
- **AntiSlop采样器**：自研算法，从源头防止模型生成八股，比如`不是，而是`，`生理性的泪水`
- **请求日志**：每一次API请求都会生成计费日志，可以通过消息右下角ⓘ图标查看，或在日志查看器中统计
- **TTS和T2I支持**：内置文生图和转语音工具
- **可选的后端**：
  - 绝大部分的功能都在前端，后端与其说是SpringBoot，更像Postgres
  - 数据默认保存在本地`IndexedDB`中
  - 后端扩展功能：
    - **多用户**：`无鉴权`(仅需用户名)或`交互式登录`(在CLI中接受并生成PAT)模式可选
      - 你不需要研究怎么让老妈记住`必须包含字母数字特殊符号的14位密码`
      - 只需要在服务器后台敲一下 /accept &lt;配对码> 账号就登录了
    - **数据同步**：使用SQLite，透明序列化Blob、Set等IDB支持的类型
    - **多端协作**：基于WebSocket和悲观锁，自动同步对话和解决冲突
    - **断线重连**：后端代理OpenAI兼容请求，客户端掉线不会导致生成终止
    - **语义搜索**：OpenAI兼容嵌入API+向量数据库，按语义搜索对话内容
    - **文件去重**：基于SHA-256哈希值，避免IDB后端相同文件占用多次磁盘的问题
    - **Agent**：提供命令执行能力
      - 建议在容器中运行后端的独立Agent模式（通过 --workspace &lt;path> 命令行参数），以防止恶意/意外的命令
  - 如果需要高级功能（超过部署在NAS上为一家人提供服务），请自行二次开发
- **本地Agent**：修改本地文件，运行命令
   - **基于浏览器文件系统API**，你甚至**不需要后端**就能拥有本地 Agent
   - 虽然无法运行命令，且Glob性能很糟糕，**但它存在**，从未有人像我一样这么发挥浏览器的潜力
   - 当然，也可以（并且推荐）使用后端
   - 我实现了Hashline机制（Tag=行号+哈希），这可以提升模型`部分修改文件`的能力
     - 但不一定更好
  - 命令执行没有沙盒，你**可以而且应该**在容器内部署一个文件操作服务
  - 提供了API统一操作本机文件、远程文件服务、OPFS、以及虚拟的配置文件系统
- **真正的编辑**：“你不能只在自己红温的时候支持模型应该能被打断和修改”  
  传统 Agent 的工作流是线性的、自动的、不可逆的。  
  本项目允许你修改历史中任何一条消息的思考，内容，工具调用参数和结果
   - “就当它成功过”
   - [详细介绍](public/documents/agent-filesystem.md)

![preview-2](media/preview.jpg)
> 截图并不会实时更新，要你直接去Github Pages看看？

## 理念

### 1. 在任何可能引入外部重依赖的地方，我用一层抽象把选择权交还给你  
本项目所需的后端如下

- LLM 端点：OpenAI API规范
  - 请注意：只有LLM端点位于本地网络时，才会检查是否为 llama-server
- T2I 端点：ComfyUI或A1111 WebUI规范
  - 参考实现：你可直接使用 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
- TTS 端点：我的TTS规范（基于OpenAI + 自定义音色 API）
  - 参考实现：[qwen3-audio.cpp](https://github.com/Roj234/qwen3-audio.cpp)
- 数据库端点：我的数据库API规范
  - 参考实现：`backend/init.js`
- 文件访问端点：我的文件访问API规范
  - 参考实现：`backend/init.js`

> **唯一必须的，只是LLM端点。**  
> 如果不需要执行命令，那么不需要文件访问服务  
> 如果想要更多的工具：MCP，启动！(2.20.0已支持MCP)  
> 如果我的naive实现满足不了你日益增长的需求，尝试做一个更好的，而不是让我做一些自己用不上的功能（比如鉴权）

[我的 llama.cpp 分支](https://github.com/Roj234/llama.cpp) 提供下列可选功能：
- 支持 OpenAI 规范的思考开关和思考预算字段
- 支持 JSON Schema 消息预填充

### 2. 在需要的时候高级

1. AiChat 支持展示工具的参数和结果，编辑各种原始数据，预览请求体，甚至自定义 `chat_template`
2. 在聊天框内输入 `/help` 获取指令帮助
3. **RPG管线**：一个基于AI的角色扮演游戏框架 *（开发中）*
   > 目前的 RP 预设依赖于“祈祷”——祈祷模型能记住 XML 标签，祈祷它不漏掉闭合括号，甚至祈祷它在复述几十 KB 的样板代码时不发疯。我们结束这种混乱。
   >
   > 我们使用**约束采样**：所有的非法 logits 在采样阶段就被过滤。模型**永远**不会忘记格式，**永远**不会生成错误的 JSON。
   >- **注意力的回归**：当你还在让模型背下复杂的XML标签，一不小心又没闭合，第十次重新生成，你暴跳如雷时，我们将格式交给了数学。模型 100% 的注意力都用于推演剧情，而不是去背诵标签。
   >- **Token不浪费**：只需要类似 TypeScript+JSDoc 的极简格式注解就可正确生成对象。
   >- **极高的兼容性**：几乎所有开源闭源模型的API支持通过约束采样生成完美的JSON
   - 基于 JSON schema, 工具调用, response_format 和 `世界对象模型` 创建你的AI角色扮演游戏 比如 Galgame/TRPG
   - 现已推出带流式和前端的对话版本，[详见此处](public/documents/rpg-pipeline.md)
   - 提供骰子和数据管理之类的工具
4. **Llama.cpp模型管理**；直接在UI内加载和卸载`llama-router`的本地模型
5. **插件系统**：大部分工具甚至包括角色扮演支持都支持异步导入


## 📦 快速开始

从右侧 [Release](https://github.com/Roj234/ai-chat/releases) 下载构建好的版本，它是 Github Action 自动构建的  
> PC版: full_release.zip 并解压  
> 安卓版: AiChat_&lt;版本&gt;.apk  
如果你想手动构建或开发，[请查看这里](public/documents/build.md)

浏览器需求：Chrome 118+  
在 118-124 上测试  
这个最低标准你可以认为未来五年内不会改变，因为我有一部手机系统WebView是120

### PC版(带后端)部署

> 请先安装 Node.js 22+ (建议 Node 24 LTS)

下载后直接点击 launch.bat / launch.sh 就可以启动了  
下载的版本是自带后端的，启动的也是后端  
默认的端口是 3000，你可以加入 `-p <端口> --data <数据目录>` 参数修改

### 静态部署

你可以把它部署在任何静态文件服务器上：
- 使用Github pages的[在线版本](https://roj234.github.io/ai-chat/)
- 找个`nginx`把`dist`扔进去就行
- 使用 `llama-server` 加参数 `--path`

### 安卓版本

安卓版支持调用系统相机拍照上传  
安卓版不支持调用MPA的功能，如JSON编辑器  
最低系统版本：12  
权限：网络，相机  
读写文件采用SAF API，不需要外部存储权限  
系统自带文件选择器可能难看，但我不用写代码

## 依赖
- [Unconscious](https://github.com/Roj234/unconscious) - 轻量级响应式Web框架
- [streaming-markdown](https://github.com/Roj234/streaming-markdown) + KaTex

第三方依赖
- [Remix icon](https://github.com/Remix-Design/remixicon)
- [Modern normalize](https://github.com/sindresorhus/modern-normalize)
- [Driver.js](https://driverjs.com/)

这些打包在项目里
- [highlight.js](https://highlightjs.org/): 改成生成器函数（什么你问我为啥不用shiki，包大小和流式响应性能啊兄弟！）
- [Chart.js](https://chartjs.org/): 改了代码，默认的自动长宽比在我的场景下变成了傻逼设计
- [Mermaid](https://mermaid.js.org/): 否则你会收获一个200MB的node_modules，另外Mermaid.js占据本项目打包体积的80%

### 鸣谢
- [DsChat](https://github.com/huzpsb/DsChat)
  - 你不能只在自己红温的时候支持模型应该能被打断和修改
  - 本项目允许你修改工具调用的名称、参数和结果，以及Human as tool的*灵感*完全来自该项目

## 已知问题/TODO清单
- 名字没有SEO很烂大街
  - 我知道这是个问题，但是AI想的名字还不如这个。
- 不支持录音输入
  - 浏览器貌似只支持webm格式
- 不支持PDF输入
  - pdf.js 又是 114514KB 的庞然大物
- 前端网络不好可能导致流式响应中断/浏览器直接请求暴露了我的网址、CORS问题等各种和fetch有关的……
  - 前端没办法，请使用可选的后端。
  - 你也可以试试NewAPI
- Orchestrator / Subagent

### 管理聊天中的历史多媒体文件
- IndexedDB后端不支持去重和附件管理，这个暂时没法解决
- SQLite后端没有引用计数，需要手动在GUI内管理和删除
- 前端暂不支持编辑文本文件——后端已支持知识库的基础设施

## 其他页面

### 请求和计费日志查看器 (log_viewer.html)
- 暂时必须使用后端
- 因为本项目的数据库驱动程序比较耦合，暂时还拆不出来
![日志查看器](media/logViewer.png)

### Markdown 渲染测试工具 (markdown.html)

### 角色卡查看器 (character_viewer.html)

### 文档 (docs.html)

### 测试工具 (test.html)