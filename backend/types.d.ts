import {OpenAI} from "/src/openai";

namespace AIChatBackend {
    type Router = {
        post(url: string, handler: function(RouteContext): void | Promise<void>);
        get(url: string, handler: function(RouteContext): void | Promise<void>);
        put(url: string, handler: function(RouteContext): void | Promise<void>);
        delete(url: string, handler: function(RouteContext): void | Promise<void>);
    }

    type RouteContext = {
        url: URL,
        path: string,
        query: {[p: string]: string},
        readBody: (function(): Promise<Record<string, any>>),
        params: Record<string, string>,
        send: (function(number, Object)),
        req: import("node:http").Request,
        res: import("node:http").Response,
    }

    type SSEProxyRequest = {
        abort: AbortController,
        data: OpenAI.AssistantMessage[],
        event: EventEmitter,
        isFinished: boolean
    }
}