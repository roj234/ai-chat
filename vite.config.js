// vite.config.js
import {defineConfig} from 'vite';

import unconscious from 'unconscious/VitePlugin.mjs';
import purgecss from 'unconscious/VitePurgeCSS.mjs';
import FontFilter from "unconscious/postcss/font-filter.js";
import OklchToRgb from "unconscious/postcss/oklch-to-rgb.js";
import InlineVars from "unconscious/postcss/inline-vars.js";
import {viteFontMinify} from 'unconscious/vite/font-minify.js';

import packageInfo from "./package.json";

import fs from 'node:fs';
import path from "node:path";


const VITE_TRICK_CONFIG = path.resolve(__dirname, 'backend/config.js');
const VITE_TRICK_SERVER = path.resolve(__dirname, 'backend/server-dev.js');

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
const LOADING_TEMPLATE = `<div id="loading">
    <style>
        #loading {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            background: #8886;
            z-index: 99;
            transition: opacity 0.6s ease;
        }
        .spinner {
            stroke-dasharray: 0 75;
            stroke-linecap: round;
            stroke-width: 2;
            fill: none;
            transform-origin: center;
            animation:
                    dash 1.5s ease-in-out infinite,
                    spin 2s linear infinite;
        }
        @keyframes spin {
            to {
                transform: rotate(360deg);
            }
        }
        @keyframes dash {
            50% {
                stroke-dasharray: 55 75;
                stroke-dashoffset: -15;
            }
            100% {
                stroke-dashoffset: -75;
            }
        }
    </style>
    <noscript><h1>Enable JavaScript to continue.</h1></noscript>
    <svg width="20vw" height="20vh" viewBox="0 0 32 32">
        <circle stroke="currentColor" cx="16" cy="16" r="12" class="spinner" />
    </svg>
</div>`.replaceAll(/[\r\n]|^[ \t]+/gm, '')
    .replaceAll(": ", ":")
    .replaceAll(";}", "}")
    .replaceAll(" {", "{");

//https://cn.vite.dev/
export default defineConfig(async () => {
    const serverConfigInfo = await import("file://"+VITE_TRICK_CONFIG);

    return {
    define: {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version),
        DB_SERVER: JSON.stringify(serverConfigInfo.SERVER_BASE_ADDR),
        DB_MODE: JSON.stringify('mixed'), // local remote mixed
        DEFAULT_LLM_ENDPOINT: JSON.stringify(serverConfigInfo.SERVER_BASE_ADDR ? serverConfigInfo.SERVER_BASE_ADDR+"sse/v1" : ""),
        RESUME_TIMEOUT: JSON.stringify(serverConfigInfo.SSE_RESUME_TIMEOUT),
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
                'my/storyEngine'
            ]
        }),
        viteFontMinify(),
        (await import("file://"+VITE_TRICK_SERVER)).serverDevPlugin(),
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
        }
        //viteSingleFile()
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

    base: '', // 绝对路径什么的不要啊
    build: {
        modulePreload: { polyfill: false },
        reportCompressedSize: !isGitHubActions,
        //sourcemap: true,

        assetsInlineLimit: 512,
        rollupOptions: {
            input: {
                main: 'index.html',
                logViewer: 'log_viewer.html',
                jsonEditor: 'json_editor.html',
                characterViewer: 'character_viewer.html',
                docs: 'docs.html',
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