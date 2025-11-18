// openai.d.ts
// OpenRouter OpenAI-compatible API TypeScript 类型定义

declare namespace OpenAI {
    // 模型名称类型
    type Model = string;

    // 消息角色
    type Role = 'system' | 'user' | 'assistant' | 'tool';

    // 消息对象
    interface Message {
        role: Role;
        content: string;
        reasoning?: string;
        reasoning_details?: ReasoningDetail[]
        tool_calls?: ToolCall[];
        images?: ImagePart[];
    }

    interface TextPart {
        type: 'text';
        text: string;
    }
    interface ImagePart {
        type: 'image_url';
        image_url: {
            url: string;
        };
    }

    type ContentPart = TextPart | ImagePart;

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

    interface ToolCall {
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string; // JSON 字符串
        };
    }

    // 聊天完成请求
    interface ChatCompletionRequest {
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
    }

    // 工具定义
    interface Tool {
        type: 'function';
        function: {
            name: string;
            description?: string;
            parameters: {
                type: 'object';
                properties: Record<string, ParameterDefinition>;
                required?: string[];
            };
        };
    }

    // 参数定义（简化版）
    interface ParameterDefinition {
        type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
        description?: string;
        enum?: (string | number)[];
        example?: string;
        default?: string;
        properties?: Record<string, ParameterDefinition>;
        items?: ParameterDefinition;
    }

    interface BaseCompletion {
        id: string;
        created: number; // Unix 时间戳
        model: Model;
        provider?: string;
    }
    interface BaseChoice {
        index: number;
        finish_reason?: 'stop' | 'length' | 'function_call' | 'content_filter' | 'tool_calls';
        native_finish_reason?: string;
        logprobs?: any;
    }

    interface ChatUsage {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        completion_tokens_details?: {
            reasoning_tokens: number;
        }
    }

    // 聊天完成响应（非流式）
    interface ChatCompletionResponse extends BaseCompletion {
        object: 'chat.completion';
        choices: Choice[];
        usage: ChatUsage;
    }
    interface Choice extends BaseChoice {
        message: Message;
    }

    interface ChatCompletionChunk extends BaseCompletion {
        object: 'chat.completion.chunk';
        choices: ChunkChoice[];
        usage?: ChatUsage;
    }
    interface ChunkChoice extends Choice {
        delta: Partial<Message>;
    }
}

// 全局声明（如果不使用命名空间）
export type { OpenAI };
