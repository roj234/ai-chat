import {OpenAI} from "/src/openai";

namespace AiChatBackend {
    type Router = {
        push(relPath: string);
        pop();

        post(url: string, handler: function(RouteContext): void | Promise<void>);
        get(url: string, handler: function(RouteContext): void | Promise<void>);
        put(url: string, handler: function(RouteContext): void | Promise<void>);
        delete(url: string, handler: function(RouteContext): void | Promise<void>);

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
        readAsObject(sizeLimit?: number = 1048576): Promise<Record<string, any>>,
        params: Record<string, string>,
        send(number, Object): void,
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
        db?: import("node:sqlite").DatabaseSync
        vectorDB?: VectorDB

        getVariable(name: string): Promise<any> | null;
        setVariable(name: string): ((value: any) => void);
        variables: Function[];
    }

    type VectorDB = {
        readonly size: number;

        set(id: string, text: string): Promise<void>;
        query(text: string, topK: number, threshold: number): Promise<string[]>;

        close(): void;

        search(query: Float32Array, topK = 5, threshold = 0.3): string[];
        upsert(id: string, vector: Float32Array): void;
        delete(id: string): Promise<void>;
    }

    type SSEProxyRequest = {
        id: string;
        timoutId: number;
        abort: AbortController,
        data: OpenAI.AssistantMessage[],
        event: EventEmitter,
        isFinished: boolean
    }

    type SyncManager = {
        onBatch(ctx: RouteContext, func: string, body: *): void;
    }
}