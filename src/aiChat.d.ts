import {OpenAI} from "./openai";

declare namespace AiChat {
    export type Provider = {
        endpoint: string,
        accessToken: string
    }

    interface BaseCompletionRequest {
        model: string,
        temperature?: number,
        maxTokens?: number,
        systemPrompt?: string,
        stop?: string,
    }

    interface ChatCompletionRequest extends BaseCompletionRequest {
        mode: 'chat',
        reasoning: false | 'minimal' | 'low' | 'medium' | 'high',
        /**
         * @default true
         */
        keepReasoning?: boolean,
        tools?: OpenAI.Tool[]
    }

    interface InstructCompletionRequest extends BaseCompletionRequest {
        mode: 'completion',
        template: string,
    }

    export type CompletionRequest = ChatCompletionRequest | InstructCompletionRequest;

    export type Conversation = {
        id: number,
        title: string,
        time: number,
        /**
         * 消息是否从DB加载完成
         */
        ready?: boolean,
        messageId: number,
        /**
         * 与消息分开储存在DB中
         */
        //messages?: Message[]
    }

    export type Message =
        | SystemMessage
        | UserMessage
        | AssistantMessage
        | ToolCallMessage;

    interface BaseMessage {
        content: string | OpenAI.ContentPart[];
        time: number;
        error?: string;
    }

    interface SystemMessage extends BaseMessage {
        role: 'system';
    }

    interface UserMessage extends BaseMessage {
        role: 'user';
    }

    interface AssistantMessage extends BaseMessage {
        role: 'assistant';
        model: string,
        /**
         * 仅用做渲染
         */
        think?: Thinking;
        reasoning_details?: OpenAI.ReasoningDetail[];
        tool_calls?: OpenAI.ToolCall[];
        usage?: string;
        finish_reason: 'length' | 'tool_calls' | 'stop' | 'error' | 'interrupt';
    }

    interface ToolCallMessage extends BaseMessage {
        role: 'tool';
        tool_call_id?: string;
    }

    export type Thinking = {
        start?: number;
        content?: string;
        duration?: number;
    };
}