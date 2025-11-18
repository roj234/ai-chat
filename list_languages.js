import fs from 'fs';
import path from 'path';

console.warn("生成 highlight.js 语言异步加载文件...");

let script = `
export function loadLanguage(id) {
  do {
    id = MAPPING[id];
  } while (typeof id === 'string');

  if (typeof id === 'function') {
    return id();
  }

  return null;
}

const MAPPING = {`;

function scriptPath(pkg) {
    const fileUrl = new URL(import.meta.resolve(pkg));
    return path.normalize(fileUrl.pathname.slice(process.platform === 'win32' ? 1 : 0));
}

(async () => {
  const dir = path.join(scriptPath('highlight.js'), "../languages/");

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.js.js'));

  const hljs = (await import('highlight.js/lib/core')).default;

  for (const file of files) {
    try {
      // 使用 file:// URL 直接导入文件，绕过 package.json exports 限制
      const langModule = (await import(`file://${path.join(dir, file)}`)).default;
      const langDef = langModule(hljs);
      const scriptName = file.replace('.js', '');

      script += `\n  ${JSON.stringify(scriptName)}: () => import('highlight.js/lib/languages/${scriptName}'),`;

      if (langDef.aliases) {
        for (const alias of langDef.aliases) {
          script += `\n  ${JSON.stringify(alias)}: ${JSON.stringify(scriptName)},`;
        }
      }
    } catch (error) {
      console.error(`导入失败 ${file}:`, error.message);
    }
  }

  script += `\n};`;

  fs.writeFileSync('src/highlight-languages.js', script);
})();
