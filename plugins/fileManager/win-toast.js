import {showToast} from "/src/components/Toast.js";

/** toast 左侧的小圆点字符 */
const TOAST_ICON = {ok: '✓', err: '×', warn: '!', info: 'i'};

/**
 * @param {string} msg
 * @param {'info'|'ok'|'err'|'warn'} [kind]
 * @param {number} [ms]
 */
export const winToast = (toastDiv, msg, kind = 'info', ms = 3000) => showToast(<>
	<span className="ic">{TOAST_ICON[kind] || 'i'}</span>
	<span>{msg}</span>
</>, kind, ms, { dom: toastDiv });