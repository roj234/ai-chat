import {platform} from 'node:os';

export const IS_WINDOWS = platform() === 'win32';

// ─── 工具函数 ────────────────────────────────────────────

export const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
/** 延迟 ms 毫秒 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const pollInterval = 500;