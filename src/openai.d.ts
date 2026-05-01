// openai.d.ts
// OpenRouter OpenAI-compatible API TypeScript 类型定义

declare namespace OpenAI {
    // 模型名称
    type Model = string;
    // 消息角色
    type Role = 'developer' | 'system' | 'user' | 'assistant' | 'tool';

    type BaseResponse = {
        id: string;
        //object: string;
        //choices: (NonStreamingChoice | StreamingChoice | TextChoice)[];
        created: number; // Unix timestamp
        model: string;
        system_fingerprint?: string; // Only present if the provider supports it
        // Usage data is always returned for non-streaming.
        // When streaming, usage is returned exactly once in the final chunk
        // before the [DONE] message, with an empty choices array.
        usage?: OpenRouter.ResponseUsage;
        timings?: LlamaCpp.ResponseUsage;

        provider?: string; // Model provider
    };

    type ChatCompletionResponse = BaseResponse & {
        object: 'chat.completion';
        choices: NonStreamingChoice[];
    }
    type ChatCompletionChunk = BaseResponse & {
        object: 'chat.completion.chunk';
        choices: ChatChoice[];
    }
    type TextCompletionChunk = BaseResponse & {
        object: 'text_completion';
        choices: TextChoice[];
    }

    type Response = ChatCompletionResponse | ChatCompletionChunk | TextCompletionChunk;

    namespace LlamaCpp {
        type ResponseUsage = {
            cache_n: number,
            prompt_n: number,
            predicted_n: number,
            predicted_per_second: number;
        };
    }

    interface BaseReasoningDetail {
        id: string;
        format: 'unknown' | 'openai-responses-v1' | 'xai-responses-v1' | 'anthropic-claude-v1';
        index?: number;
    }

    interface ReasoningSummary extends BaseReasoningDetail {
        type: 'reasoning.summary';
        summary: string;
    }

    interface ReasoningText extends BaseReasoningDetail {
        type: 'reasoning.text';
        text: string;
        signature?: string;
    }

    interface ReasoningEncrypted extends BaseReasoningDetail {
        type: 'reasoning.encrypted';
        data: string;
    }

    type ReasoningDetail = ReasoningSummary | ReasoningText | ReasoningEncrypted;

    namespace OpenRouter {
        // OpenRouter always returns detailed usage information.
        // Token counts are calculated using the model's native tokenizer.
        type ResponseUsage = {
            /** Including images, input audio, and tools if any */
            prompt_tokens: number;
            /** The tokens generated */
            completion_tokens: number;
            /** Sum of the above two fields */
            total_tokens: number;

            /** Breakdown of prompt tokens (optional) */
            prompt_tokens_details?: {
                cached_tokens: number;        // Tokens cached by the endpoint
                cache_write_tokens?: number;  // Tokens written to cache (models with explicit caching)
                audio_tokens?: number;        // Tokens used for input audio
                video_tokens?: number;        // Tokens used for input video
            };

            /** Breakdown of completion tokens (optional) */
            completion_tokens_details?: {
                reasoning_tokens?: number;    // Tokens generated for reasoning
                audio_tokens?: number;        // Tokens generated for audio output
                image_tokens?: number;        // Tokens generated for image output
            };

            /** Cost in credits (optional) */
            cost?: number;
            /** Whether request used Bring Your Own Key */
            is_byok?: boolean;
            /** Detailed cost breakdown (optional) */
            cost_details?: {
                upstream_inference_cost?: number;             // Only shown for BYOK requests
                upstream_inference_prompt_cost: number;
                upstream_inference_completions_cost: number;
            };

            /** Server-side tool usage (optional) */
            server_tool_use?: {
                web_search_requests?: number;
            };
        };
    }

    // 消息对象
    type Message = {
        role: Role;
        content: string | ContentPart[];
    }
    type AssistantMessage = Message & {
        role: 'assistant';
        reasoning?: string; // OpenAI
        reasoning_content?: string; // Llama.cpp
        reasoning_details?: OpenAI.ReasoningDetail[]; // OpenRouter
        tool_calls?: ToolCall[];
        images?: ImagePart[]; // OpenRouter
        audio?: AudioData[];
    }

    type AudioData = {
        data: string; // Base64
        expires_at: number;
        id: string;
        transcript: string;
    }

    type ToolCallMessage = Message & {
        role: 'tool';
        tool_call_id: string;
    }

    type TextPart = {
        type: 'text';
        text: string;
    }
    type ImagePart = {
        type: 'image_url';
        image_url: {
            // file://, http:// or base64 encoded string
            url: Blob | string;
        };
    }
    type AudioPart = {
        type: 'input_audio';
        input_audio: {
            data: Blob | string;
            // llama.cpp only support them
            format: "wav" | "mp3";// | "aiff" | "aac" | "ogg" | "flac" | "m4a"
        };
    }

    type ContentPart = TextPart | ImagePart | AudioPart;

    type ToolCall = {
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string; // JSON 字符串
        };
    }

    // 聊天完成请求
    type ChatCompletionRequest = {
        model: Model;
        messages: Message[];
        frequency_penalty?: number; // -2.0 到 2.0，默认 0
        presence_penalty?: number; // -2.0 到 2.0，默认 0
        max_tokens?: number; // 最大令牌数，1 到 4096+
        n?: number; // 生成的完成数量，默认 1
        temperature?: number; // 0 到 2，默认 1
        top_p?: number; // 0 到 1，默认 1
        stop?: string | string[]; // 停止序列
        stream?: boolean; // 是否流式响应，默认 false
        tools?: Tool[]; // 工具定义（可选）
        tool_choice?: 'none' | 'auto' | 'required' | {type: "function", function: {"name": string}};
    }

    // 工具定义
    type Tool = {
        type: 'function';
        function: FunctionToolJSON;
    }

    type FunctionToolJSON = {
        name: string;
        description: string;
        parameters: ObjectSchema;
    }

    //region JSON Schemas
    type ParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
    type StringFormat = 'date' | 'time' | 'date-time' | 'uri' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'uuid'/* | /^uuid[1-5]/*/;

    type BaseSchema = {
        type: ParameterType | ParameterType[] | 'value';
        description?: string;
        example?: string;
        default?: any;

        enum?: (string | number)[];
        const?: string | number;

        $ref?: string;
        oneOf?: Schema[];
        anyOf?: Schema[];
        allOf?: Schema[];
    }
    type ObjectSchema = BaseSchema & {
        type: 'object';
        properties?: Record<string, Schema>;
        required?: string[];
        additionalProperties?: boolean | Schema;
    }
    type ArraySchema = BaseSchema & {
        type: 'array';
        items?: Schema;
        //prefixItems?: Schema;
        minItems?: number;
        maxItems?: number;
    }
    type StringSchema = BaseSchema & {
        type: 'string';
        pattern?: string;
        format?: StringFormat;
        minLength?: number;
        maxLength?: number;
    }
    type IntegerSchema = BaseSchema & {
        type: 'integer';
        minimum?: number;
        maximum?: number;
        exclusiveMinimum?: number;
        exclusiveMaximum?: number;
    }
    type Schema = BaseSchema | ObjectSchema | ArraySchema | StringSchema | IntegerSchema;
    //endregion
    // region Choice
    type Choice = {
        index: number;
        finish_reason?: 'stop' | 'length' | 'function_call' | 'content_filter' | 'tool_calls' | 'error';
        native_finish_reason?: string;
        error?: ErrorResponse;

        logprobs?: {
            content: ((LogprobItem | PostSampleProbItem) & {
                top_logprobs?: LogprobItem[];
                top_probs?: PostSampleProbItem[];
            })[]
        }
    }
    interface NonStreamingChoice extends Choice {
        message: AssistantMessage;
    }
    interface ChatChoice extends Choice {
        delta: Partial<AssistantMessage>;
    }
    interface TextChoice extends Choice {
        text: string;
    }

    type ErrorResponse = {
        code: number; // See "Error Handling" section
        message: string;
        metadata?: Record<string, unknown>; // Contains additional error information such as provider details, the raw error message, etc.
    };

    type LogprobItem = {
        id: number;
        logprob: number;
        token: string;
        bytes?: number[];
    }

    type PostSampleProbItem = {
        id: number;
        prob: number;
        token: string;
        bytes?: number[];
    }
    //endregion
}

// 全局声明（如果不使用命名空间）
export type { OpenAI };
