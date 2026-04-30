// vite.config.js

import unconscious from 'unconscious/VitePlugin.mjs';
import purgecss from 'unconscious/VitePurgeCSS.mjs';
import FontFilter from "unconscious/postcss/font-filter.js";
import OklchToRgb from "unconscious/postcss/oklch-to-rgb.js";
import InlineVars from "unconscious/postcss/inline-vars.js";
import { viteFontMinify } from 'unconscious/vite/font-minify.js';
import {serverDevPlugin} from "./backend/server-dev.js";

import packageInfo from "./package.json";

const sqliteFlag = !!process.env.USE_SQLITE ? {
    './database/db-indexeddb.js': './database/db-sqlite.js',
} : {};

//https://cn.vite.dev/
export default {
    define: {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version),
    },

    resolve: {
        alias: {
            ...sqliteFlag
        },
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
            ]
        }),
        viteFontMinify(),
        serverDevPlugin(),
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
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
        //sourcemap: true,

        assetsInlineLimit: 512,
        rollupOptions: {
            output: {
                experimentalMinChunkSize: 10240,
                entryFileNames: `[name].[hash].js`,
                chunkFileNames: `[name].[hash].js`,
                assetFileNames: `[name].[hash].[ext]`,
            },
        }
    }
};