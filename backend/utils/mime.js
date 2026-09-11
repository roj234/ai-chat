
// ==================== 简单的 MIME 类型映射 ====================
const JS = 'application/javascript; charset=utf-8';
const MIME_TYPES = {
	'html': 'text/html; charset=utf-8',
	'css': 'text/css; charset=utf-8',
	'js': JS, 'mjs': JS, 'cjs': JS,
	'json': 'application/json; charset=utf-8',
	'png': 'image/png',
	'jpg': 'image/jpeg',
	'jpeg': 'image/jpeg',
	'gif': 'image/gif',
	'svg': 'image/svg+xml',
	'ico': 'image/x-icon',
	'txt': 'text/plain; charset=utf-8',
	'xml': 'application/xml',
	'pdf': 'application/pdf',
	'zip': 'application/zip',
	'mp3': 'audio/mpeg',
	'wav': 'audio/wav',
	'mp4': 'video/mp4',
	'webm': 'video/webm',
};

export function getContentType(filename) {
	const pos = filename.lastIndexOf('.');
	const ext = (pos > 0 ? filename.slice(pos+1) : '').toLowerCase();
	return MIME_TYPES[ext] || 'application/octet-stream';
}