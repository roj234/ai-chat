// vite.config.js

import unconscious from 'unconscious/vite';
import purgecss from '@roj234/ie/plugins/purgecss.js';
import {purgeIconFont} from "@roj234/ie/plugins/purgeIconFont.js";
import {postcssOkLCHFallback} from "@roj234/ie/plugins/postcss-oklch-fallback.js";
import {postcssInlineLengthVars} from "@roj234/ie/plugins/postcss-inline-length-vars.js";
import {postcssWoff2Only} from "@roj234/ie/plugins/postcss-woff2-only.js";
import {sandboxModules} from "./common/build-sandbox-modules.js";

import packageInfo from "./package.json";

import fs from 'node:fs';
import {globMacroPlugin} from "./common/fs-glob.js";

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
        IS_ANDROID_BUILD: JSON.stringify(true),
        BUILD_NUMBER: JSON.stringify(process.env.BUILD_NUMBER || "0"),
    },

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
            ]
        }),
        purgeIconFont(),
        sandboxModules(),
        globMacroPlugin(),
        {
            name: 'inject-build-time',
            transformIndexHtml(html) {
                return html.replace("{{loading}}", LOADING_TEMPLATE).replace("<link rel=\"manifest\" href=\"manifest.json\" />", "");
            }
        }
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
        reportCompressedSize: false,

        mergeUniqueCss: true,

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