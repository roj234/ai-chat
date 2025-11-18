import './Toast.css';
import {prettyError} from "./utils.js";

const container = <div className="toasts"></div>;
document.body.append(container);

/**
 *
 * @param message
 * @param [type='' | 'error' | 'ok']
 */
export function showToast(message, type='') {
	function onClose() {
		clearTimeout(timer);
		elm.classList.add("closing");
		setTimeout(() => elm.remove(), 300);
	}

	const timer = setTimeout(onClose, 3000);

	const elm = <div className={"toast "+type}>
		<div className="content">
			<span>{prettyError(message)}</span>
			<button className="close" onClick={onClose}>&times;</button>
		</div>
	</div>;

	container.append(elm);
}
