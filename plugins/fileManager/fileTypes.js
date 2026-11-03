import {loadLanguage} from "/src/markdown/highlight.js";

/* ============================== 根据扩展名设置图标和颜色 ============================== */

/** 图标名 -> 空格分隔的扩展名（比逐条 key 更短，同类聚合，不易漏写） */
const EXT_GROUPS = {
	//'dir':                  ['#d29922', ''],
	'ri-file-image-fill':   ['#f472b6', 'png jpg jpeg webp bmp svg ico avif tif tiff heif heic'],
	'ri-file-gif-fill':     ['#f472b6', 'gif apng'],
	'ri-file-video-fill':   ['#a371f7', 'mp4 webm mov mkv avi flv m4v mpg mpeg'],
	'ri-file-music-fill':   ['#38bdf8', 'mp3 wav ogg flac m4a aac opus wma mid midi'],
	'ri-file-code-fill':    ['#e3b341', 'conf env'], // 这里只填没法自动判断的
	'ri-file-text-fill':    ['#7d8590', 'md markdown txt log'],
	'ri-file-ppt-fill':     ['#7d8590', 'ppt pptx odp key'],
	'ri-file-word-fill':    ['#7d8590', 'doc docx rtf odt'],
	'ri-file-excel-fill':   ['#3fb950', 'xlsx xls ods numbers'],
	'ri-table-2':           ['#3fb950', 'csv tsv'],
	'ri-database-2-fill':   ['#3fb950', 'db parquet mdb'],
	'ri-file-zip-fill':     ['#fb923c', 'zip rar 7z gz tar bz2 xz zst zstd tgz jar'],
	'ri-file-pdf-2-fill':   ['#f85149', 'pdf'],
	'ri-book-2-fill':       ['#a371f7', 'epub mobi'],
	'ri-terminal-box-fill': ['#8b949e', 'exe msi apk app dmg deb rpm appimage'],
	'ri-font-size':         ['#c084fc', 'woff woff2 ttf otf eot'],
};

/** @type {Record<string, string>} */
const EXT_GROUP = Object.create(null), COLOR = Object.create(null);

for (const icon in EXT_GROUPS) {
	const [color, exts] = EXT_GROUPS[icon];
	for (const ext of exts.split(' ')) EXT_GROUP[ext] = icon;
	COLOR[icon] = color;
}

/**
 * @param {string} ext
 * @returns {string}
 */
export const iconClassOf = ext => EXT_GROUP[ext] ?? (loadLanguage(ext, true) ? 'ri-file-code-fill' : ext ? 'ri-file-unknow-fill' : 'ri-file-3-fill');
/**
 * @param {string} type
 * @returns {string}
 */
export const iconColorOf = type => COLOR[type] ?? COLOR["ri-file-3-fill"];