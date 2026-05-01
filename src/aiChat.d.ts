import {OpenAI} from "./openai";

declare namespace AiChat {

    export type Conversation = {
        id: number,
        title: string,
        time: number,
        /**
         * 消息是否从DB加载完成
         */
        ready?: boolean,

        /**
         * 已激活的模块
         */
        activatedModules?: Set<string>,
        /**
         * 允许使用的工具
         */
        allowedTools?: Set<string>,

        branches?: true;
    }

    export type Message = BaseMessage | AssistantMessage;

    type BaseMessage = OpenAI.Message & {
        // No 'tool' type here
        role: string | 'system' | 'user' | 'assistant';
        id: number,
        time: number;
        error?: string;
        hidden?: boolean;
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
        tool_name: string;
        time: number;
        content?: string | OpenAI.ContentPart[];
        success?: boolean;
    }

    export type Thinking = {
        format: "r" | "rc" | "rd";
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

        script: (parameters: Record<string, any>, response: AiChat.ToolResponse & Payload, global_storage: AiChat.Conversation) => any | Promise<any>;
        removed?: (context: AiChat.ToolResponse & Payload, global_storage: AiChat.Conversation) => void;

        renderer?: (context: AiChat.ToolResponse & Payload, has_successor: boolean) => HTMLElement;
        /**
         * 判断自己在列表项中是否需要重新生成HTML
         * 往keys里面填任何对象就行
         */
        keyFunc?: (keys: Array, context: AiChat.ToolResponse & Payload, has_successor: boolean) => void;
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
            compose?(message: AiChat.Message, output: OpenAI.Message[], callbacks: MessageComposedCallback[]);
            getChunks(message: AiChat.Message, chunks: ResponseContentPart[], index: number);
            keyFunc?(chunk: ResponseContentPart): any[];
        }

        type MessageComposedCallback = (messages: AiChat.Message[], output: OpenAI.Message[], body: Record<string, any>) => void;

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
                id: number;
                name: string;
                lorebooks: number[];
                lorebookNames?: string[];
                preset: number;
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

    interface BranchPathItem {
        index: number;
        total: number;
        message: AiChat.Message;
    }

    class BranchManager {
        readonly leaf: number;

        constructor(allMessages: AiChat.Message[], leaf: number = 0);

        /**
         * 获取当前分支的所有消息 (从叶子向上追溯到根)
         * 开销极小：只需沿着 parent 向上爬
         */
        getMessages();

        /**
         * 在指定消息处创建新分支
         * @param {number} parentId 父消息ID
         * @param {AiChat.Message} message - 消息内容 (已入库，含 id 和 parent = this.leaf)
         */
        branchAt(parentId: number, message: AiChat.Message);

        /**
         * 切换分支：当某个 ID 有多个子节点时，选择其中一个
         * @param {number} parentId 分支发生点的 ID
         * @param {number} index 选择第几个分支
         */
        switchBranch(parentId: number, index: number);

        /**
         * 获取对应消息的分支状态
         * @param {AiChat.Message} message
         * @returns [当前索引, 总分支数]
         */
        getBranchInfo(message: AiChat.Message);

        /**
         * 向当前路径末尾追加一条消息
         * @param {AiChat.Message} message - 消息内容 (已入库，含 id 和 parent = this.leaf)
         */
        push(message: AiChat.Message);

        /**
         * 删除指定消息及其所有子孙节点，并回退当前叶子 ID 到父节点
         * @param {number} messageId - 要删除的消息 ID
         */
        remove(messageId: number);
    }
}