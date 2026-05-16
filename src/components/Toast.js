import './Toast.css';
import {onLoad} from "../plugin.js";

const container = <div className="toasts" />;

onLoad((app) => app.append(container));

/**
 *
 * @param message
 * @param [type='' | 'error' | 'ok']
 * @param {number} timeout
 */
export const showToast = (message, type='', timeout = 3000) => {
	const closeToast = () => {
		clearTimeout(timer);
		elm.classList.add("closing");
		setTimeout(() => elm.remove(), 300);
	};

	const timer = timeout && setTimeout(closeToast, timeout);

	const elm = <div className={"toast "+type}>
		<div className="content">
			<span>{message}</span>
			<button className="close" onClick={closeToast}>&times;</button>
		</div>
	</div>;
	container.append(elm);
	return closeToast;
};
