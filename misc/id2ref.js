#!/usr/bin/env node

/**
 * 脚本功能：
 * 1. 读取指定 JS 文件，匹配所有 document.getElementById('ID') 中的 ID
 * 2. 去重后，在文件头部插入 let ID; 声明（每个 ID 一行）
 * 3. 将文件中所有 id="ID"（仅限已收集的 ID）替换为 ref={ID}
 * 4. 输出到新文件（默认输入文件名 + '.transformed.js'）
 *
 * 用法：node transform.js [输入文件] [输出文件?]
 */

import fs from 'fs';

// 简单的正则特殊字符转义函数
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node id2ref.js <输入文件> [输出文件]');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1] || inputFile.replace(/(\.js)$/, '.out.js');

// 读取文件
let content;
try {
  content = fs.readFileSync(inputFile, 'utf8');
} catch (err) {
  console.error(`无法读取文件: ${inputFile}`, err.message);
  process.exit(1);
}

// 步骤1：收集所有在 document.getElementById('...') 中出现的 ID
const idSet = new Set();
const getElementByIdRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;

content = content.replaceAll(getElementByIdRegex, (_, match) => {
  idSet.add(match);
  return match;
})

if (idSet.size === 0) {
  console.log('未找到任何 document.getElementById 调用，无需处理。');
} else {
  console.log(`找到 ${idSet.size} 个唯一 ID: ${[...idSet].join(', ')}`);

  // 步骤2：生成声明字符串（按排序保证一致性）
  const sortedIds = [...idSet].sort();
  const declarations = "let "+sortedIds.join(', ') + ';\n';

  // 在文件内容开头插入声明
  content = declarations + content;

  // 步骤3：逐个替换 id="ID" 为 ref={ID}
  for (const id of sortedIds) {
    const idAttrRegex = new RegExp(`id="${escapeRegExp(id)}"`, 'g');
    content = content.replace(idAttrRegex, `ref={${id}}`);
  }

  console.log(`已将 id="ID" 替换为 ref={ID}`);
}

// 步骤4：写入输出文件
try {
  fs.writeFileSync(outputFile, content, 'utf8');
  console.log(`转换完成，已写入: ${outputFile}`);
} catch (err) {
  console.error(`写入文件失败: ${outputFile}`, err.message);
  process.exit(1);
}