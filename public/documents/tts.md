
## 生图

> 相关实现位于 `plugins/tools/multimedia_generation.js` 的「MultimediaGeneration」工具集（已弃用，这个文档很快要重写）

### SD.cpp / WebUI
图像生成API填写
> http://127.0.0.1:1234/sdapi/v1

请确认端口号正确

### ComfyUI
图像生成API填写
> http://127.0.0.1:8188/prompt

ComfyUI 工作流需要你自己做，请参考我的示例
```json
{"1":{"inputs":{"unet_name":"ernie_image_fp8e4m3.safetensors","weight_dtype":"default"},"class_type":"UNETLoader"},"2":{"inputs":{"clip_name":"Ministral-3-3B-Instruct-2512-UD-Q6_K_XL.gguf","type":"flux2"},"class_type":"CLIPLoaderGGUF"},"3":{"inputs":{"lora_name":"ernie_turbo_lora_r256.safetensors","strength_model":1,"model":["1",0]},"class_type":"LoraLoaderModelOnly"},"4":{"inputs":{"text":{{prompt}},"clip":["2",0]},"class_type":"CLIPTextEncode"},"5":{"inputs":{"samples":["8",0],"vae":["7",0]},"class_type":"VAEDecode"},"6":{"inputs":{"width":{{width}},"height":{{height}},"batch_size":1},"class_type":"EmptyFlux2LatentImage"},"7":{"inputs":{"vae_name":"flux.2_vae_small_decoder.safetensors"},"class_type":"VAELoader"},"8":{"inputs":{"seed":{{seed}},"steps":8,"cfg":1,"sampler_name":"euler","scheduler":"simple","denoise":1,"model":["3",0],"positive":["4",0],"negative":["10",0],"latent_image":["6",0]},"class_type":"KSampler"},"9":{"inputs":{"images":["5",0]},"class_type":"SaveImageWebsocket"},"10":{"inputs":{"conditioning":["4",0]},"class_type":"ConditioningZeroOut"}}
```
如何制作：
1. 工作流中，**必须**使用官方的 `Save to WebSocket` 节点，而不是`保存到文件`节点
2. 使用 `Export (API)` 导出
3. 把工作流中的种子、提示词、尺寸等参数替换为 `{{变量}}` 格式
   - 可用变量：`width` `height` `prompt` `negativePrompt` `seed` `sampler_name` `cfg_scale` `steps`（注意是 `negativePrompt` 驼峰，不是 `negative_prompt`）
   - 变量名必须存在，缺键会直接报错；需要固定值就写死数字
   - 很明显，这一步要求你懂得如何编辑JSON

## 语音
> 目前只支持 Qwen3 TTS 和我的后端

### 准备服务

[首先下载服务端](https://github.com/roj234/qwen3-audio.cpp)  
算了以后再说，好麻烦我不想写  
首先你要下载 llvm-mingw 和 llama.cpp 然后编译一下  
然后你可能要用我的 aimake 项目编译 llama.cpp

### 准备模型

HF 上面下载 然后用我的转换器转换一下

### API 规范
参考服务端（`qwen3-tts-server.py`），或直接看 `plugins/tools/multimedia_generation.js`：
- `GET {api}/voices` 列出音色
- `POST {api}/audio/speech`（OpenAI 风格，`model` 固定 `qwen3-tts`）合成语音
- `POST {api}/voices/create` 基于参考音频克隆音色

> 以后再写。。