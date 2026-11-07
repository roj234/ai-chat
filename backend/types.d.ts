import {OpenAI} from "/src/openai";
import {DatabaseSync} from "node:sqlite";
import {TSDB} from "@roj234/logdb";

namespace AiChatBackend {
    type Router = {
        push(relPath: string);
        pop();

        post(url: string, handler: (ctx: RouteContext) => void | Promise<void>);
        get(url: string, handler: (ctx: RouteContext) => void | Promise<void>);
        put(url: string, handler: (ctx: RouteContext) => void | Promise<void>);
        delete(url: string, handler: (ctx: RouteContext) => void | Promise<void>);

        zipRouter?: ZipRouter
        sync?: SyncManager
    }

    type RouteContext = {
        url: URL,
        path: string,
        query: {[p: string]: string},
        searchParams: URLSearchParams,
        readAsBuffer(maxLength?: number): Promise<Buffer>,
        readAsString(maxLength?: number): Promise<string>,
        /** @param [sizeLimit=1048576] */
        readAsObject(sizeLimit?: number): Promise<Record<string, any>>,
        params: Record<string, string>,
        send(status: number, jsonBody?: Object): void,
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,

        getVariable(name: string): Promise<any> | null;
        setVariable(name: string): ((value: any) => void);
        variables: Function[];
    } & User;

    type ModerationHandler = (target: SSEProxyTarget, ctx: RouteContext) => [
        onStart: (req: OpenAI.ChatCompletionRequest, target: SSEProxyTarget) => Partial<SSEProxyTarget>,
        onError: (err: Error) => void,
        onFinally: (req: OpenAI.ChatCompletionResponse) => void,
    ]

    type VectorDB = {
        readonly size: number;

        set(id: string, text: string): Promise<void>;
        query(text: string, topK: number, threshold: number): Promise<{id: string, score: number}[]>;

        close(): Promise<void>;

        search(query: Float32Array, topK?: number, threshold?: number): Promise<{id: string, score: number}[]>;
        upsert(id: string, vector: Float32Array): Promise<void>;
        delete(id: string): Promise<void>;
    }

    type SSEProxyRequest = {
        //owner: SSEProxyTarget;
        id: string;
        timoutId: number;
        abort: AbortController,
        data: OpenAI.AssistantMessage[],
        event: import("node:events").EventEmitter,
        isFinished: boolean
    }

    type SyncManager = {
        onBatch(ctx: RouteContext, func: string, body: any): void;
    }

    type User = {
        db: DatabaseSync,
        vectorDB?: VectorDB,
        logDB: Promise<TSDB>
    }

    type SSEProxyTarget = {
        url: string,
        authorization: string,
        proxy?: string,
        headers?: import("node:http").OutgoingHttpHeaders,
        // 注：只有前两者实现了
        format?: 'openai' | 'responses' | 'anthropic' | 'gemini';
        // 对于大部分模拟OpenAI Responses的API来说，previous_response_id是不被支持的，必须在这里填false
        store?: boolean;
        // 留存请求和响应
        trace?: boolean;
        // 配置允许使用的模型
        models?: string[];
    }
}