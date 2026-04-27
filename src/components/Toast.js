import './Toast.css';
import {onLoad} from "../plugin.js";

const container = <div className="toasts" />;
onLoad(() => document.body.append(container));

/**
 *
 * @param message
 * @param [type='' | 'error' | 'ok']
 * @param {number} timeout
 */
export function showToast(message, type='', timeout = 3000) {
	function onClose() {
		clearTimeout(timer);
		elm.classList.add("closing");
		setTimeout(() => elm.remove(), 300);
	}

	const timer = timeout && setTimeout(onClose, timeout);

	const elm = <div className={"toast "+type}>
		<div className="content">
			<span>{message}</span>
			<button className="close" onClick={onClose}>&times;</button>
		</div>
	</div>;

	container.append(elm);

	return onClose;
}
