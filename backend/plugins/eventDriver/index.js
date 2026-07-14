/**
 * 事件驱动插件
 *
 * 给 Agent 设计的事件驱动工具，让 LLM 能等真实事件发生，不需要花 token 轮询并污染上下文。
 * 虽然底层还是轮询，但节省的 token 是实打实的
 */

import {WatchFile} from "./WatchFile.js";
import {WatchProcess} from "./WatchProcess.js";
import {WatchSocket} from "./WatchSocket.js";
import {WatchWindow} from "./WatchWindow.js";
import {IS_WINDOWS} from "./utils.js";

const mcp = new globalThis.AiChatAPI.MCPServer({
	name: 'EventDriver-MCP',
	version: '1.0.0',
});

mcp.tool(WatchFile.name, WatchFile.description, WatchFile.parameters, WatchFile.script);
mcp.tool(WatchProcess.name, WatchProcess.description, WatchProcess.parameters, WatchProcess.script);
mcp.tool(WatchSocket.name, WatchSocket.description, WatchSocket.parameters, WatchSocket.script);
if (IS_WINDOWS) mcp.tool(WatchWindow.name, WatchWindow.description, WatchWindow.parameters, WatchWindow.script);

/**
 * 插件默认导出。接收 Router 实例，将 MCP Server 挂载上去。
 * @param {AiChatBackend.Router} router
 */
export default (router) => mcp.mount(router, 'mcp/event-driver');
