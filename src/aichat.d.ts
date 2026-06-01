import {OpenAI} from "./openai";

declare namespace AiChat {

    export type Conversation = {
        id: number,
        title: string,
        time: number,

        /** 消息是否从DB加载完成 */
        ready?: boolean,

        /** 已激活的模块(技能) */
        activatedModules?: Set<string>,
        /** 允许使用的工具 */
        allowedTools?: Set<string>,
        /** 本会话中自动允许的工具 */
        grantedTools?: Set<string>,

        // 禁用AI功能
        noAI?: true;

        /** 分支对话，最后一条对话的ID */
        bm_leaf?: number;
    }

    export type Message = BaseMessage | AssistantMessage;

    type BaseMessage = OpenAI.Message & {
        // No 'tool' type here
        role: string | 'system' | 'user' | 'assistant';
        id: number;
        time: number;
        error?: string;
        // 插件注册hook用的消息可以选择隐藏自身不渲染
        hidden?: boolean;
        // 上一条消息的ID
        parent?: number;

        // 其他人的对话
        name?: string;
    }

    type AssistantMessage = BaseMessage & {
        role: 'assistant';
        model: string;
        /**
         * 仅用做渲染
         */
        think?: Thinking;
        reasoning_details?: OpenAI.ReasoningDetail[];
        tool_calls?: OpenAI.ToolCall[]; // or reactive
        tool_responses?: ToolResponse[];
        finish_reason: 'length' | 'tool_calls' | 'stop' | 'error' | 'interrupt';
    }

    export type MessageListItem = {
        key: BaseMessage | AssistantMessage,
        index: number,
        role: string,
        content: ResponseContentPart[];
    }

    type ToolResponse = {
        time: number;
        content?: string | OpenAI.ContentPart[];
        success?: boolean;
    }

    export type Thinking = {
        format: "r" | "rc" | "rd" | string;
        content?: string;
        duration?: number;
        // not stored, for text partial match only
        index?: number;
        start?: number;
    };

    type Preset = {
        name: string,

        endpoint: string,
        accessToken: string,
        model: string,
        mode: 'chat' | 'completions',

        max_tokens: number,
        systemPrompt: string,
        reasoning: false | 'minimal' | 'low' | 'medium' | 'high',
        CoTPrompt: string,

        edit: boolean,

        reviewRequest: boolean,
        reviewMessage: boolean,
        logSSE: boolean,
        incognito: boolean,

        generateTitle: boolean,
        titleModel: string,

        permitAllTools: boolean,
        canPrefill: boolean,
        maxToolTurns: number
        sound: false | 'always' | 'background',

        stripCoT: boolean | 'm',
        forceThink: boolean | null,
        modalities: ('image' | 'audio' | 'tool')[]

        additionalBody: Record<string, any>,
        stop: string[],
        antiSlop: Record<string, number>

        nickname: string;

        jsonSupport: 0 | 1 | 2 | 3,

        // UI
        think: 0 | 1,
        tools: 0 | 1,
    }

    type BillingLog = {
        request_id: string,
        id?: number,
        provider: string,
        model: string,

        // 不包含 cached_tokens
        input_tokens: number,
        // 包含 reasoning_tokens
        output_tokens: number,
        reasoning_tokens?: number,
        cached_tokens?: number,
        // 独立
        cache_write_tokens?: number,

        time: number,
        latency: number,
        duration: number,
        finish_reason: string,

        cost: number,
        currency: string,
    }

    type LoadingPart = {
        type: "loading";
    }

    type ThinkPart = {
        type: "think";
        think: Thinking;
    }

    type GalleryPart = {
        type: "images";
        images: OpenAI.ImagePart[];
    }

    type ToolPart = {
        type: "tool_call";
        tool: OpenAI.ToolCall;
        message: AssistantMessage;
        // index of message.tool_calls
        idx: number;
    }

    type ToolUIPart = {
        type: "tool";
        tool_name: string;
        response: ToolResponse;
        // indexOf messages[]
        idx: number;
    }

    type UsagePart = {
        type: "usage";
    }

    type ErrorPart = {
        type: "error";
        title?: string;
        error: string;
    }

    type BranchPart = {
        type: "branch";
        current: number;
        total: number;
    }

    type HTMLPart = {
        type: "html";
        html: string;
    }

    type ResponseContentPart = (OpenAI.TextPart | GalleryPart | ThinkPart | ToolPart | ToolUIPart | UsagePart | ErrorPart | BranchPart | HTMLPart | LoadingPart) & {
        key?: object;
    };

    type FunctionToolImpl<Payload> = {
        interactive?: boolean | "secure";
        autorun?: boolean | "on_import";

        script: (parameters: Record<string, any>, response: ToolResponse & Payload, global_storage: Conversation) => any | Promise<any>;
        undo?: (context: ToolResponse & Payload, global_storage: Conversation) => void;

        renderer?: (context: ToolResponse & Payload, has_successor: boolean) => HTMLElement;
        /**
         * 判断自己在列表项中是否需要重新生成HTML
         * 往keys里面填任何对象就行
         */
        keyFunc?: (keys: Array, context: ToolResponse & Payload, has_successor: boolean) => void;
    }

    type FunctionTool<Payload> = OpenAI.FunctionToolJSON & FunctionToolImpl<Payload>;

    type ApiModel = {
        id: string;
        aliases: string[];
        tags: string[];
        object: "model";
        created: number;
        status: {
            value: "loaded" | "loading" | "unloaded";
        }
    }

    type IDBKVList = {
        type?: IDBValidKey,
        name?: IDBValidKey
    }

    type LLMRequestContext = {
        antiSlop?: AntiSlop
    }

    type AntiSlop = {
        sample(chunk: OpenAI.TextChoice | OpenAI.ChatChoice, message: AssistantMessage): true | void;
    }

    type MarkdownRendererOptions = {
        noHighlight?: boolean,
        stream?: boolean,
        noImage?: boolean,
        trusted?: boolean
    }

    namespace DnD {
        //region 酒馆类型定义
        type SillyTavernCharacterCard = {
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: STCardSpec3
        }

        interface STCardSpec3 {
            name: string,
            description: string,
            personality: string;
            firstMes: string;
            avatar?: string;
            mesExample: string;
            scenario: string;
            creatorNotes: string;
            systemPrompt: string,
            postHistoryInstructions: string
            alternateGreetings?: string[]
            tags: string[],
            creator: string,
            creationDate: number,
            modificationDate: number,
            groupOnlyGreetings: string[],
            characterVersion: string,

            world: string
            depthPrompt: {
                role: "system" | "user" | "assistant";
                depth: number;
                prompt: string;
            },

            characterBook: null | {
                entries: STLorebookEntry[],
                name: string
            },
        }

        type STLorebookEntry = {
            name: string;
            comment: string,

            keys: string[],

            secondary_keys: string[],
            keysecondary: string[],

            content: string,
            // 不基于滑动窗口
            constant: boolean,
            // 不是很懂，感觉不如正则？
            selective: boolean,

            priority: number,
            enabled: boolean,
            position: "after_char" | "before_char" | number,

            excludeRecursion: boolean,
            preventRecursion: boolean,
            delayUntilRecursion: boolean,
            depth: number;
            role: null | number;

            uid?: number;
            displayIndex?: number;

            probability: number;
        };

        type SillyTavernPreset = {
            extensions: Record<string, any>
            // unused
            /*
            temperature: number,
            frequency_penalty: number,
            presence_penalty: number,
            repetition_penalty: 1,
            top_p: number,
            top_k: number,
            top_a: number,
            min_p: number,
            assistant_prefill: string,
            assistant_impersonation: string,
            squash_system_messages: true,
            continue_prefill: false,
            continue_postfix: string,
            function_calling: false,
            show_thoughts: true,
            reasoning_effort: high,
             */

            impersonationPrompt: string,
            newChatPrompt: string,
            newGroupChatPrompt: string,
            newExampleChatPrompt: string,
            continueNudgePrompt: string,
            biasPresetSelected: string,
            maxContextUnlocked: boolean,
            wiFormat: string,
            scenarioFormat: string,
            personalityFormat: string,
            groupNudgePrompt: string,
            prompts: STPresetPrompt[]
            promptOrder: {
                character_id: number,
                order: {
                    identifier: UUID,
                    enabled: boolean
                }[]
            }[]
        }

        type STPresetPrompt = {
            identifier: UUID,
            name: string,
            enabled: boolean,
            injection_position: number,
            injection_depth: number,
            injection_order: number,
            role: OpenAI.Role,
            content: string,
            system_prompt: boolean,
            marker: boolean,
            forbid_overrides: boolean,
            injection_trigger: string[]
        }
        //endregion

        interface CustomMessageRole {
            name: string;
            /**
             * chunks 是否需要动态生成
             */
            reactive?: boolean;
            /**
             *
             * @param message 输入的消息
             * @param output 输出的JSON消息
             * @param callbacks 写入一个回调，在所有compose完成后调用
             * @param index 消息序号
             * @param length 消息总数
             * @param conv 当前对话
             */
            compose?(message: Message, output: OpenAI.Message[], callbacks: MessageComposedCallback[], index: number, length: number, conv: Conversation);
            /**
             *
             * @param message 消息
             * @param chunks 输出的 chunks
             * @param index 消息序号
             * @param isEditing 一个函数，判断给定的消息是否处于编辑状态
             * @param messages 消息数组
             * @param isPostHook 后处理，chunks已经添加完成
             */
            getChunks?(message: Message, chunks: ResponseContentPart[], index: number, isEditing: function(Message): boolean, messages: Message[], isPostHook?: boolean): void | true;
            // 返回 void 表示继续后面的处理，添加内部的keys，否则直接以这些keys结束
            keyFunc?(chunk: ResponseContentPart, keys: any[]): any[] | void;
        }

        type MessageComposedCallback = (messages: Message[], output: OpenAI.Message[], body: Record<string, any>, is_prefill: boolean) => void;

        type MyCharacter = IDBKVList & {
            type: "st|char",

            creator: string;
            creatorNotes: string;

            time: number; // lastModified ? 现在不会更新。
            createTime: number;

            tags: string[];

            systemPrompt: string;
            description: string;
            personality: string;
            scenario: string;
            dialogueExamples: string[];

            //override default st_user
            user?: string;
            userdesc?: string;

            greetings: string[];
            lorebook: MyLorebookPage[];

            autoMessages: {
                name: string;
                depth: number;
                content: string;
            }[]
        };

        type MyLorebook = IDBKVList & {
            type: "st|lorebook",
            pages: MyLorebookPage[]
        }

        type MyLorebookPage = {
            name: string,
            enabled: boolean;
            comment: string,
            content: string,
            regex: boolean,
            constant: boolean,
            recursion: true | false | 'stop' | 'only',
            triggers: string[],
            window: number,
            position: 'worldInfoBefore' | 'worldInfoAfter' | 'depth',
            role: 'assistant' | 'user' | null,
            depth: number,
            id: string;
        }

        type MyPreset = IDBKVList & {
            type: "st|preset",
            prompts: MyPrompt[],
            regexps: MyRegexp[]
        }

        type MyPrompt = {
            name: string,
            enabled: boolean,
            role: OpenAI.Role,
            content: string,
            attr?: 'first' | 'marker'
        }

        type MyRegexp = {
            name: string,
            enabled: boolean,
            search: string,
            replace: string,
            stage: 'render' | 'prompt' | 'all',
            depth: [number, number]
        }

        interface MyCharConversation extends BaseMessage {
            role: "st|char";
            content: {
                name: string;
                lorebookNames?: string[];
                presetName?: string;
                greeting: number;
                /**
                 * 即将移动到 _instances 中
                 * @deprecated
                 */
                activatedLorebookItems: Set<string>;
            };

            [_instances]: {
                character: MyCharacter,
                lorebooks: MyLorebook[],
                preset?: MyPreset
            }
        }
        interface MyGreeting extends BaseMessage {
            role: "st|greeting";
            content: MyCharConversation;
        }
    }

    class BranchManager {
        readonly conversation: Conversation;
        readonly messages: Message[];
        leaf: Message;

        constructor(conversation: Conversation, messages: Message[]);

        /**
         * 获取当前分支的所有消息
         */
        getMessages(): Message[];

        /**
         * 获取当前分支的所有消息并删除分支管理器的所有相关字段
         */
        toArray(): Message[];

        /**
         * 在指定消息处创建新分支
         * @param {number} parent 父消息
         * @param {Message} message 消息
         */
        branchAt(parent: Message, message: Message);

        /**
         * 切换分支：当某个分支有多个子节点时，选择其中一个
         * @param {number} parent 分支发生点
         * @param {number} index 选择第几个分支
         */
        switchBranch(parent: Message, index: number);

        /**
         * 获取对应消息的分支状态
         * @param {Message} message
         * @returns [当前索引, 总分支数]
         */
        getBranchInfo(message: Message): [number, number];

        /**
         * 删除指定消息及其所有子孙节点，并回退当前叶子 ID 到父节点
         * @param {number} messageId - 要删除的消息 ID
         */
        remove(messageId: number);
    }
}