// vite.config.js
import unconscious from 'unconscious/vite';
import purgecss from '@roj234/ie/plugins/purgecss.js';
import {purgeIconFont} from "@roj234/ie/plugins/purgeIconFont.js";
import {postcssOkLCHFallback} from "@roj234/ie/plugins/postcss-oklch-fallback.js";
import {postcssInlineLengthVars} from "@roj234/ie/plugins/postcss-inline-length-vars.js";
import {postcssWoff2Only} from "@roj234/ie/plugins/postcss-woff2-only.js";
import {sandboxModules} from "./common/build-sandbox-modules.js";
import {getContentType} from "@roj234/ie/utils/mimeTypes.js";

import packageInfo from "./package.json";
import serverPackageInfo from './backend/package.json' with {type: 'json'};

import fs from 'node:fs';
import path from "node:path";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {rollup} from 'rollup';
import {defineConfig} from 'vite';
import {nodeResolve} from '@roj234/ie/plugins/build-backend-helper.js';
import {HLJS_LANGUAGE_FAMILIES, HLJS_LANGUAGE_RE} from "./misc/hljs-language-families.js";

const VITE_TRICK_CONFIG = path.resolve(__dirname, 'backend/config.js');
const SERVER_BUNDLE = path.resolve(__dirname, 'node_modules/.ie/.aint-server.mjs');

if (!fs.existsSync(VITE_TRICK_CONFIG)) {
    fs.copyFileSync(path.resolve(__dirname, 'backend/config.default.js'), VITE_TRICK_CONFIG);
}


const execFilePromise = promisify(execFile);
const getCommitNumber = async () => {
    try {
        const result = await execFilePromise("git", "describe --tags --abbrev=7 --dirty=* --always".split(" "));
        return result.stdout.trim();
    } catch {
        return 'unknown';
    }
}

const PWA_DIR = path.resolve(__dirname, 'misc/pwa-config');

/**
 * 开发时把 misc/pwa-config 映射到站点根路径
 * @returns {import('vite').Plugin}
 */
const pwaStaticDevPlugin = () => ({
    name: 'pwa-static-dev',
    apply: 'serve',
    configureServer(server) {
        const matchers = ['/manifest.json', '/assets/icons/'];
        server.middlewares.use((req, res, next) => {
            const pathname = decodeURIComponent((req.url || '').split('?')[0]);
            if (!matchers.some(p => pathname === p || pathname.startsWith(p))) return next();

            const filePath = path.resolve(PWA_DIR, '.' + pathname);
            if (!filePath.startsWith(PWA_DIR + path.sep)) return next(); // 目录穿越防护

            fs.promises.stat(filePath).then(info => {
                if (!info.isFile()) return next();
                res.setHeader('Content-Type', getContentType(filePath));
                res.setHeader('Content-Length', info.size);
                res.setHeader('Cache-Control', 'no-cache');
                fs.createReadStream(filePath).pipe(res);
            }, () => next());
        });
    }
});

const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
const cleanHtml = s => s
    .replaceAll(/[\r\n]|^[ \t]+|<!--.+?-->|\/\*.+?\*\//gm, '')
    .replaceAll(/\s*([:,;{}])\s*/g, '$1')
    .replaceAll(";}", "}");

//https://cn.vite.dev/
export default defineConfig(async ({mode}) => {
    if (mode === 'development') {
        const bundle = await rollup({
            input: 'backend/server-dev.js',
            external: [
                'bufferutil',
                ...Object.keys(packageInfo.dependencies || {}),
                ...Object.keys(serverPackageInfo.dependencies || {}),
            ],
            plugins: [
                nodeResolve({basePath: __dirname}),
                (await import("file://"+__dirname+"/common/fs-glob.js")).globMacroPlugin(),
                {
                    name: 'fix-import-meta-dirname',
                    transform(code, id) {
                        code = code.replaceAll("IS_ANDROID_BUILD", "false");
                        code = code.replace(/import\.meta\.dirname/g, JSON.stringify(path.dirname(id)));
                        return {
                            code,
                            map: null
                        };
                    }
                }
            ],
        });
        await bundle.write({file: SERVER_BUNDLE, format: 'esm'});
    }

    const commit = await getCommitNumber();
    const buildTime = new Date().toLocaleString();
    const define = {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version + (process.env.BUILD_NUMBER ? '' : ` (dev)`)),
        DB_MODE: JSON.stringify('mixed'), // local remote mixed
        IS_ANDROID_BUILD: JSON.stringify(false),
        BUILD_NUMBER: JSON.stringify(process.env.BUILD_NUMBER || `build: ${commit} · ${buildTime}`),
    };

    return {
    define,

    plugins: [
        unconscious({
            exclude: ["vendor/*"]
        }),
        purgecss({
            safelist: [
                // Explorer.jsx
                /^ri-folder(?:-open)?-(?:fill|line)$/,

                // katex
                'katex-sizing',
                'delimsizing',
                'mtable',
                /-arrow-pad$/,
                /^cd-label-/,
                /_fallback$/,
                // hljs
                /^hljs-/,
            ],
            //debug: true
        }),
        purgeIconFont(),
        sandboxModules(),
        pwaStaticDevPlugin(),
        ...(mode === 'production' ? [(await import("file://"+__dirname+"/common/fs-glob.js")).globMacroPlugin()] : [(await import("file://"+SERVER_BUNDLE)).serverDevPlugin()]),
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
                if (process.env.NODE_ENV === 'development') return html;
                return cleanHtml(html);
            }
        },
    ],

    css: {
        postcss: {
            plugins: [
                postcssWoff2Only,
                postcssOkLCHFallback,
                postcssInlineLengthVars({
                    safelist: [
                        "--panel-width"
                    ]
                })
            ]
        }
    },

    base: '',
    build: {
        modulePreload: { polyfill: false },
        reportCompressedSize: !isGitHubActions,
        chunkSizeWarningLimit: 9999999,
        copyPublicDir: false,

        mergeUniqueCss: true,

        assetsInlineLimit: 512,
        rollupOptions: {
            input: {
                main: 'index.html',
                sw: "sw.js",
            },

            external(id) {
                return id.startsWith("node:")
            },

            output: {
                entryFileNames(chunkInfo) {
                    if (chunkInfo.name === 'sw') return '[name].js'
                    return 'assets/[name]-[hash].js'
                },
                // 手动控制 chunk 拆分
                manualChunks(id) {
                    const normalized = id.replaceAll('\\', '/');

                    const match = HLJS_LANGUAGE_RE.exec(normalized);
                    if (match) {
                        const i = HLJS_LANGUAGE_FAMILIES.findIndex(s => s.languages.includes(match[1]));
                        if (i >= 0) return "hljs/"+String(i).padStart(2, "0")+"-"+HLJS_LANGUAGE_FAMILIES[i].id;
                        return 'hljs/'+match[1];
                    }
                },

                experimentalMinChunkSize: 5120000,
            },
        }
    },

    server: {
        watch: { ignored: ['**/data/**', '**/misc/**'] }
    }
}});