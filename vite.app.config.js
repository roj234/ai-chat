// vite.config.js

import unconscious from 'unconscious/VitePlugin.mjs';
import purgecss from 'unconscious/VitePurgeCSS.mjs';
import FontFilter from "unconscious/postcss/font-filter.js";
import OklchToRgb from "unconscious/postcss/oklch-to-rgb.js";
import InlineVars from "unconscious/postcss/inline-vars.js";
import {viteFontMinify} from 'unconscious/vite/font-minify.js';
import {minifyJsString} from 'unconscious/vite/minJs.js';

import packageInfo from "./package.json";

import fs from 'node:fs';

const LOADING_TEMPLATE = fs.readFileSync('./loading.html', 'utf-8').match(/<!--START-->(.+)<!--END-->/s)[1]
    .replaceAll(/[\r\n]|^[ \t]+|<!--.+?-->|\/\*.+?\*\//gm, '')
    .replaceAll(/[:,] /g, ([m]) => m)
    .replaceAll(";}", "}")
    .replaceAll(" {", "{");

export default {
    define: {
        APP_NAME: JSON.stringify(packageInfo.name),
        APP_VERSION: JSON.stringify(packageInfo.version),
        DB_MODE: JSON.stringify('mixed'),
        RESUME_TIMEOUT: JSON.stringify(3600000),
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
                'my/storyTurn'
            ]
        }),
        viteFontMinify(),
        minifyJsString(),
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
                return html.replace("{{loading}}", LOADING_TEMPLATE);
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

    base: '',
    build: {
        modulePreload: { polyfill: false },
        reportCompressedSize: false,

        outDir: 'dist-app',

        assetsInlineLimit: 512,
        rollupOptions: {
            input: {
                main: 'index.html',
                logViewer: 'log_viewer.html',
                docs: 'docs.html',
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
            },
        }
    }
};