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

        /**
         * 分支对话，最后一条对话的ID
         * 这个选项无法在开启后关闭
         */
        branches?: number;
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
    }

    type AssistantMessage = BaseMessage & {
        role: 'assistant';
        model: string;
        content: ResponseContentPart[];
        /**
         * 仅用做渲染
         */
        think?: Thinking;
        reasoning_details?: OpenAI.ReasoningDetail[];
        tool_calls?: OpenAI.ToolCall[]; // or reactive
        usage?: string;
        finish_reason: 'length' | 'tool_calls' | 'stop' | 'error' | 'interrupt';

        tool_responses?: ToolResponse[];
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

    interface Preset {
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
        debug: boolean,

        generateTitle: boolean,
        titleModel: string,

        permitAllTools: boolean,
        allowContinue: boolean,
        maxToolTurns: number
        sound: false | 'always' | 'background',

        forceThink: boolean | null,
        modalities: ('image' | 'audio' | 'tool')[]

        // UI
        think: boolean,
        tools: boolean,
    }

    interface BillingLog {
        preset_id: string,
        request_id: string,
        message_id: number,
        provider: string,

        input_tokens: number,
        output_tokens: number,
        reasoning_tokens?: number,
        cached_tokens?: number,
        cache_write_tokens?: number,

        time: number,
        latency: number,
        ttft: number,
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

    interface ToolUIPart {
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

    interface ApiModel {
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
        id: number,
        type?: IDBValidKey,
        name?: IDBValidKey
    }

    namespace DnD {
        //region 酒馆类型定义
        type SillyTavernCharacterCard = STCharacterCard2;// | STCharacterCard3;
        interface STCharacterCard2 {
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: STCardSpec2
        }

        interface STCharacterCard3 {
            spec: "chara_card_v3",
            spec_version: "3.0",
            data: STCardSpec2,
            // ...
        }

        interface STCardSpec2 {
            name: string,
            description: string,
            personality: string;
            first_mes: string;
            avatar?: string;
            mes_example: string;
            scenario: string;
            creator_notes: string;
            system_prompt: string,
            post_history_instructions: string
            alternate_greetings?: string[]
            tags: string[],
            creator: string,
            character_version: string,
            extensions: Record<string, any> & {
                world: string
                depth_prompt: {
                    role: "system" | "user" | "assistant";
                    depth: number;
                    prompt: string;
                }
            },
            character_book: null | {
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

            probability: number,
            extensions: Record<string, any> & {
                // 滑动窗口大小
                depth: number,
                // 递归……等有人用到了再说
                excludeRecursion: boolean
            }
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

            impersonation_prompt: string,
            new_chat_prompt: string,
            new_group_chat_prompt: string,
            new_example_chat_prompt: string,
            continue_nudge_prompt: string,
            bias_preset_selected: string,
            max_context_unlocked: boolean,
            wi_format: string,
            scenario_format: string,
            personality_format: string,
            group_nudge_prompt: string,
            prompts: STPresetPrompt[]
            prompt_order: {
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
            reactive?: boolean;
            compose?(message: Message, output: OpenAI.Message[], callbacks: MessageComposedCallback[], index: number, length: number);
            getChunks(message: Message, chunks: ResponseContentPart[], index: number, isEditing: function(Message): boolean);
            keyFunc?(chunk: ResponseContentPart): any[];
        }

        type MessageComposedCallback = (messages: Message[], output: OpenAI.Message[], body: Record<string, any>, is_prefill: boolean) => void;

        type MyCharacter = IDBKVList & {
            type: "st|char",

            creator: string;
            creatorNotes: string;

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
                activatedLorebookItems: Set<string>;
            };

            [CHARACTER]: MyCharacter,
            [LOREBOOKS]: MyLorebook[],
            [PRESET]: MyPreset
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