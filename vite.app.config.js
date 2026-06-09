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

if (!fs.existsSync(VITE_TRICK_CONFIG)) {
    fs.copyFileSync(path.resolve(__dirname, 'backend/config.example.js'), VITE_TRICK_CONFIG);
}

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
    <h1 id="versionCheck">系统WebView版本过低，请安装最新浏览器并使用AiChat网页版</h1>
    <svg width="20vw" height="20vh" viewBox="0 0 32 32">
        <circle stroke="currentColor" cx="16" cy="16" r="12" class="spinner" />
    </svg>
</div>`.replaceAll(/[\r\n]|^[ \t]+/gm, '')
    .replaceAll(": ", ":")
    .replaceAll(";}", "}")
    .replaceAll(" {", "{");

export default defineConfig(async () => {
    const serverConfigInfo = await import("file://"+VITE_TRICK_CONFIG);

    return {
    define: {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version),
        DB_SERVER: JSON.stringify(""),
        DB_MODE: JSON.stringify('mixed'), // local remote mixed
        DEFAULT_LLM_ENDPOINT: JSON.stringify(""),
        RESUME_TIMEOUT: JSON.stringify(serverConfigInfo.SSE_RESUME_TIMEOUT),
        IS_ANDROID_BUILD: JSON.stringify(true),
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
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
                html = html.replace("{{loading}}", LOADING_TEMPLATE);
                return html;
            }
        }
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
        reportCompressedSize: false,

        outDir: 'dist-app',

        assetsInlineLimit: 512,
        rollupOptions: {
            input: {
                main: 'index.html',
                logViewer: 'log_viewer.html',
                //characterViewer: 'character_viewer.html',
                docs: 'docs.html'
            },

            external(id) {
                return id.startsWith("node:")
            },

            output: {
                //experimentalMinChunkSize: 10240,
            },
        }
    }
}});