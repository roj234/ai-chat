// vite.config.js
import unconscious from 'unconscious/VitePlugin.mjs';
import purgecss from 'unconscious/VitePurgeCSS.mjs';
import FontFilter from "unconscious/postcss/font-filter.js";
import OklchToRgb from "unconscious/postcss/oklch-to-rgb.js";
import InlineVars from "unconscious/postcss/inline-vars.js";
import {viteFontMinify} from 'unconscious/vite/font-minify.js';
import {minifyJsString} from 'unconscious/vite/minJs.js';

import packageInfo from "./package.json";
import serverPackageInfo from './backend/package.json' with {type: 'json'};

import fs from 'node:fs';
import path from "node:path";
import {rollup} from 'rollup';
import {defineConfig} from 'vite';
import {nodeResolve} from 'unconscious/vite/build-backend.js';

const VITE_TRICK_CONFIG = path.resolve(__dirname, 'backend/config.js');
const SERVER_BUNDLE = path.resolve(__dirname, 'node_modules/.vite/.aichat-dev-server.mjs');

if (!fs.existsSync(VITE_TRICK_CONFIG)) {
    fs.copyFileSync(path.resolve(__dirname, 'backend/config.example.js'), VITE_TRICK_CONFIG);
}

const stringHash = s => {
    let h = 1;
    for (let i = 0; i < s.length; i++) {
        h = (31 * h + s.charCodeAt(i)) & 4294967295;
    }
    return h;
};

const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
const LOADING_TEMPLATE = fs.readFileSync('./loading.html', 'utf-8').match(/<!--START-->(.+)<!--END-->/s)[1]
    .replaceAll(/[\r\n]|^[ \t]+|<!--.+?-->|\/\*.+?\*\//gm, '')
    .replaceAll(/[:,] /g, ([m]) => m)
    .replaceAll(";}", "}")
    .replaceAll(" {", "{");

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
                {
                    name: 'fix-import-meta-dirname',
                    transform(code, id) {
                        code = code.replaceAll("IS_ANDROID_BUILD", "false");
                        if (code.includes('import.meta.dirname')) {
                            code = code.replace(/import\.meta\.dirname/g, JSON.stringify(path.dirname(id)));
                        }
                        return {
                            code,
                            map: null
                        };
                    }
                }
            ],
        });
        await bundle.write({file: SERVER_BUNDLE, format: 'esm'});
    }return {

    define: {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version),
        DB_MODE: JSON.stringify('mixed'), // local remote mixed
        RESUME_TIMEOUT: JSON.stringify(3600000),
        IS_ANDROID_BUILD: JSON.stringify(false),
        BUILD_NUMBER: JSON.stringify(process.env.BUILD_NUMBER || "0"),
    },

    plugins: [
        unconscious({
            exclude: ["vendor/*"]
        }),
        purgecss({
            safelist: [
                /^hljs-/,
                /^role-/,
                /^btn-/,
                'closed',
                'lang',
                'locked', // presetFastSwitch
                'my/storyTurn'
            ]
        }),
        minifyJsString(),
        viteFontMinify(),
        ...(mode === 'production' ? [] : [(await import("file://"+SERVER_BUNDLE)).serverDevPlugin()]),
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
                html = html.replace("{{loading}}", LOADING_TEMPLATE);

                if (process.env.NODE_ENV === 'development') return html;

                const buildTime = new Date().toLocaleString();
                return html.replaceAll(/[\r\n]/g, "").replaceAll(/  +/g, " ").replace(
                    '</head>',
                    `<script>console.log("构建时间: ${buildTime}")</script></head>`
                );
            }
        },
        {
            name: 'sw-helper',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    const originalUrl = req.url;
                    if (!originalUrl.endsWith("/sw.js")) return next();

                    const code = fs.readFileSync("sw.js", "utf-8");
                    res.writeHead(200, {"Content-Type": "text/javascript"});
                    res.write(Object.entries(define).map(([k, v]) => `const ${k} = ${k === 'IS_ANDROID_BUILD' ? true : v};`).join('') + code);
                    res.end();
                });
            }
        },
    ],

    css: {
        postcss: {
            plugins: [
                FontFilter,
                OklchToRgb,
                InlineVars({
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
        //sourcemap: true,
        copyPublicDir: false,

        assetsInlineLimit: 512,
        rollupOptions: {
            input: {
                main: 'index.html',
                logViewer: 'log_viewer.html',
                jsonEditorPage: 'json_editor.html',
                characterViewer: 'characters.html',
                docViewer: 'docs.html',
                markdownPreview: 'markdown.html',
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
                    if (id.includes('highlight.js/es/languages/')) {
                        if (id.includes("json")) return;

                        return 'hljs/'+(stringHash(id)&31).toString(36)
                    }
                },

                //experimentalMinChunkSize: 10240,
            },
        }
    }
}});