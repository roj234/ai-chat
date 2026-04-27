import './SimpleModal.css';

/**
 *
 * @param {'info' | 'input'} type
 * @param {string} title
 * @param {string} message
 * @param {string} placeholder
 * @param {string} value
 * @param {'primary' | 'danger' | 'ghost'} accent
 * @param {string} confirmMessage
 * @param {function(string): void = } onConfirm
 * @param {function(string): void = } onCancel
 * @returns {HTMLDivElement}
 * @constructor
 */
const SimpleModal = ({
		type = 'info', // 'info' or 'input'
		title = '提示',
		message,
		placeholder,
		value,
		accent = 'primary',
		confirmMessage = '确认',
		onConfirm,
		onCancel
}) => {
	let inputValue = '';

	const handleClose = () => {
		if (false === onCancel?.(inputValue)) {
			return;
		}
		element.remove();
	}

	const handleConfirm = () => {
		if (false === onConfirm?.(inputValue)) {
			return;
		}
		element.remove();
	};

	const element = (
		<div className="modal-overlay" onClick={handleClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<div className="header"><b>{title}</b></div>
				<div className="body">
					{message && <p>{message}</p>}
					{type === 'input' ? <textarea
						onChange={(e) => inputValue = e.target.value}
						placeholder={placeholder}
					>{value}</textarea> : null}
				</div>
				<div className="footer">
					<button className={"btn " + accent} onClick={handleConfirm}>{confirmMessage}</button>
					<button className="btn ghost" onClick={handleClose}>取消</button>
				</div>
			</div>
		</div>
	);

	document.body.append(element);
};

export default SimpleModal;