
export const debugSecret = process.env.AINT_DEBUG ? crypto.randomUUID() : "";

if (debugSecret) console.log("[DEBUG] 调试模式已启用", debugSecret);
else console.log("[DEBUG] 调试模式未启用");