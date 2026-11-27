/**
 * `common/comfyui.js` 的类型定义。
 *
 * 分两部分：
 * 1. 全局命名空间 `Comfy.*`：源码里的 JSDoc（`@type {Comfy.ApiGraph}` 之类）和调用方都靠它引用数据类型；
 * 2. 本模块对外导出的函数 / 类：`compileWorkflow`、`NodeGraph`、`PromptClient`、`comfy`。
 */
declare global {
    namespace Comfy {
        export type Graph = {
            id: string,
            revision: number,
            last_node_id: number,
            last_link_id: number,
            nodes: Node[],
            groups?: Group[],
            links: Link[]
        }

        /** `[linkId, 源节点 id, 源输出槽位, 目标节点 id, 目标输入槽位, 类型]` */
        export type Link = [
            // id
            number,
            // src_node
            number,
            // src_output
            number,
            // dst_node
            number,
            // dst_input
            number,
            ElementType
        ]

        export type ElementType = 'STRING' | 'FLOAT' | 'INT' | 'MASK' | 'IMAGE' | 'LATENT' | 'MODEL' | 'CLIP' | 'VAE' | '*' | string;

        export type Node = {
            id: number,
            type: string,
            title?: string,
            pos: [number, number],
            size: [number, number],
            flags?: Flags,
            // Z Index
            order: number,
            /**
             * 0 = 正常, 1 = ?, 2 = mute, 4 = bypass（位掩码）
             */
            mode: number,
            inputs: NodeInput[],
            outputs: NodeOutput[],
            properties: {
                "Node name for S&R": string
            } & Record<string, string>,
            widgets_values?: Primitive[],
            widgets_values_named?: Record<string, Primitive>
        }

        export type NodeInput = {
            name: string,
            type: ElementType,
            widget?: {
                name: string
            }
            link: number | null
        }

        export type NodeOutput = {
            name: string,
            type: ElementType,
            links: number[] | [] | null
        }

        export type Primitive = string | number | boolean | null

        export type Group = {
            id: number,
            title?: string,
            bounding: BoundingBox
            color?: string,
            flags?: Flags
        }

        export type Flags = {
            pinned?: true,
            collapsed?: true
        }

        export type BoundingBox = [number, number, number, number]

        // ==================== NodeGraph（编译产物 / 手写工作流） ====================

        export type CGInput = {
            value?: Primitive
            type?: ElementType
            link?: [fromNode: number, fromOutput: number]
        }

        export type CGOutput = {
            name?: string
            type: ElementType
        }

        export type CGNodeOptions = {
            name?: string
            groups?: number[]
            bypass?: boolean
            mute?: boolean
        }

        /** `NodeGraph` 内部保存的节点 */
        export type CGNode = {
            type: string
            inputs: Record<string, CGInput>
            outputs: CGOutput[]
            bypass?: boolean
            mute?: boolean
        }

        // ==================== /prompt API 格式 ====================

        export type ApiGraph = Record<number, ApiGraphNode>;

        export type ApiGraphNode = {
            class_type: string,
            inputs: Record<string, Primitive | [string, number]>,
            _meta?: {
                title?: string
            }
        }

        // ==================== 任务与结果 ====================

        export type MediaType = 'image' | 'video' | 'audio' | string;
        export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

        export type Artifact = {
            type: MediaType
            name: string
            node: number
            get(): Promise<Blob>
        }

        export type ApiProgress = {
            /** 任务（prompt）id */
            _id?: string
            status: JobStatus | 'preview'
            /** `execution_start` / `execution_success` 的时间戳 */
            time?: number
            /** 已执行完的节点数 */
            fin: number
            /** 需要执行的节点总数 */
            tot: number
            /** 当前节点已完成的步数 */
            nfin: number
            /** 当前节点的总步数 */
            ntot: number
            /** 当前正在执行的节点 id */
            node?: string | number | null
            /** `status === 'preview'` 时的预览图 */
            data?: Blob
        };

        /** `submit()` 的返回值 */
        export type TaskHandle = {
            /** 全部结果（图片/视频等） */
            done: Promise<Artifact[]>
            /** 取消任务；返回是否真的取消了 */
            cancel(): Promise<boolean | void>
        }

        type ApiTask = [
            ApiGraph,
            (p: ApiProgress) => void,
            ApiProgress,
            (artifacts: Artifact[]) => void,
            (err: any) => void,
            TaskHandle
        ]

        // ==================== 其它 API（fetch 直读，未在本模块封装） ====================

        // fetch("http://localhost:8188/api/jobs?status=a,b&limit=200&offset=0");
        export type ApiJobsResponse = {
            jobs: Job[]
            pagination: {
                offset: number,
                limit: number,
                total: number,
                has_more: boolean
            }
        }

        export type Job = {
            id: string,
            status: JobStatus,
            create_time: number,
            execution_start_time: number,
            execution_end_time: number,
            preview_output?: {
                filename: string,
                subfolder: string,
                type: string,
                nodeId: number,
                mediaType: MediaType
            }
        }

        // fetch("http://localhost:8188/api/system_stats");
        export type ApiSystemStatsResponse = {
            system: {
                os: 'win32' | string,
                ram_total: number,
                ram_free: number,
                comfyui_version: string,
                required_frontend_version: string,
                installed_templates_version: string,
                required_templates_version: string,
                comfy_package_versions: {
                    name: string,
                    installed: string,
                    required: string
                }[],
                python_version: string,
                pytorch_version: string,
                embedded_python: boolean,
                deploy_environment: string,
                argv: string[]
            },
            devices: {
                name: string,
                type: 'cuda',
                index: number,
                vram_total: number,
                vram_free: number,
                torch_vram_total: number,
                torch_vram_free: number
            }[]
        }
    }
}

/**
 * 把 ComfyUI 前端「导出 (API)」得到的（或浏览器里 Ctrl+S 保存的）工作流 JSON
 * 编译成 `cg => { ... }` 形式的源码字符串。
 *
 * ```js
 * const graph = new NodeGraph(Function('cg', compileWorkflow(json)));
 * ```
 *
 * @param graph 工作流 JSON
 * @param ignore 这些类型的节点在没有输出时会被直接丢弃，默认 `My_Notification` / `MarkdownNote` / `Reroute`
 * @returns 以 `cg` 为形参的函数体源码
 */
export function compileWorkflow(graph: Comfy.Graph, ignore?: Set<string>): string;

/**
 * 可编程的工作流图。构造时传入的构建函数会立即执行，用 `cg`（即实例本身）拼图。
 *
 * ```js
 * const graph = new NodeGraph(cg => {
 *     const model = cg.node('CheckpointLoaderSimple', { ckpt_name: { value: 'a.safetensors' } }, [
 *         { name: 'MODEL', type: 'MODEL' },
 *     ], { name: 'loader' });
 *     cg.node('SaveImage', { images: { type: 'IMAGE' } }, [], { name: 'save' });
 *     cg.link(model, 0, cg.find('save'), 'images');
 * });
 * ```
 *
 * 节点 / 分组的 id 就是创建顺序（从 0 开始）；`toJSON()` 生成的 prompt 也用这些 id 作 key。
 */
export class NodeGraph {
    /** @param fn 构建函数，参数是刚创建的实例 */
    constructor(fn: (graph: NodeGraph) => void);

    /** 新建分组，返回分组 id */
    group(name: string): number;

    /**
     * 新建节点，返回节点 id。
     * @param type 节点类型（class_type）
     * @param inputs 输入槽位 → 字面量值 / 上游连线占位
     * @param outputs 输出槽位（只影响 UI 语义与下游连线）
     * @param options 名称、所属分组、bypass / mute
     */
    node(type: string, inputs: Record<string, Comfy.CGInput>, outputs: Comfy.CGOutput[], options?: Comfy.CGNodeOptions): number;

    /** 把 `fromNode` 的第 `fromId` 个输出连到 `toNode` 的 `toName` 输入 */
    link(fromNode: number, fromId: number, toNode: number, toName: string): void;

    /** 按名字（title 或唯一的 type）查节点 id，查不到返回 -1 */
    find(nodeName: string): number;

    set(nodeName: string | number, property: string, value: Comfy.Primitive): void;

    get(nodeName: string | number, property: string): Comfy.Primitive;

    /**
     * 关闭 / 开启节点的 bypass（默认）或 mute。
     * @param nodeOrGroup 节点名 / id，或分组名
     * @param value 省略则取反
     * @param key
     */
    disable(nodeOrGroup: string | number, value?: boolean, key?: 'mute' | 'bypass'): void;

    /** 目前是空实现 */
    validate(objectDef: unknown): void;

    /**
     * 序列化成 ComfyUI `/prompt` 接受的 API 格式。
     */
    toJSON(): Comfy.ApiGraph;
}

/**
 * 单个 ComfyUI 服务端的客户端：WebSocket 拿进度 / 二进制预览，HTTP 上传与提交任务。
 * 一般不要直接 new，用 `comfy(server)` 取缓存实例（同一个 endpoint 共用一个连接）。
 */
export class PromptClient {
    constructor(endpoint: string);

    /** 上传参考图到 `input/cg-ref/`，返回 ComfyUI 侧的文件名（可能带子目录） */
    upload(file: Blob | File | Uint8Array, name?: string): Promise<string>;

    /**
     * 提交任务。
     * @param prompt 工作流（`NodeGraph` 会自动 `toJSON()`）
     * @param onProgress 进度回调
     * @param needPreview 是否需要执行中的预览图（`preview_method: auto`）
     */
    submit(prompt: NodeGraph | Comfy.ApiGraph, onProgress?: (progress: Comfy.ApiProgress) => void, needPreview?: boolean): Promise<Comfy.TaskHandle>;

    /** 关闭连接并从缓存里移除；空闲 60s 也会自动关闭 */
    close(): void;
}

/** 取（或创建）某个 ComfyUI 服务端的客户端 */
export function comfy(server: string): PromptClient;