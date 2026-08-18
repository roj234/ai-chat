import './Toast.css';

let container;

/**
 *
 * @param message
 * @param [type='' | 'error' | 'ok']
 * @param {number} timeout
 */
export const showToast = (message, type, timeout = 5000) => {
	if (!container) document.body.append(container = <div className="toasts" />);

	const closeToast = () => {
		clearTimeout(timer);
		elm.classList.add("closing");
		setTimeout(() => elm.remove(), 300);
	};

	const timer = timeout > 0 && setTimeout(closeToast, timeout);

	const elm = <div className={"toast "+(type||'info')}>
		<div className="content">
			<span>{message}</span>
			{timeout >= 0 && <button className="close" onClick={closeToast}>&times;</button>}
		</div>
	</div>;
	container.append(elm);
	return closeToast;
};
