
const language = 'zhCN';
const map = {};

/**
 * 翻译
 * @param {string} def
 * @param {string} id
 * @return {string}
 */
export const TR = (def, id) => map[language]?.[id] ?? def;