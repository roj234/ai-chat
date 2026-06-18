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
		onCancel,
		after
}) => {
	let inputValue = '';
	const ignoreCancel = onCancel === null;

	const handleClose = () => {
		if (ignoreCancel || false === onCancel?.(inputValue)) {
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

	let input;
	const onFocusBlur = e => {
		const isFocus = e.type === "focus";
		input.style.height = isFocus ? "500px" : "";
	};

	const self = (h) => {
		return (e) => {
			if (e.target === element) h(e);
		}
	};

	const element = (
		<div className="modal-overlay" onContextMenu.self.prevent={handleClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<div className="header"><b>{title}</b></div>
				<div className="body">
					{message && <p>{message}</p>}
					{type === 'input' ? <input className={"text-input"}
						onChange={(e) => inputValue = e.target.value}
						placeholder={placeholder}
						value={value}
					/> : type === 'textarea' ? input = <textarea className={"text-input"}
						onChange={(e) => inputValue = e.target.value}
						onFocus={onFocusBlur} onBlur={onFocusBlur}
						placeholder={placeholder}
					>{value}</textarea> : null}
					{after}
				</div>
				<div className="footer">
					<button className={"btn " + accent} onClick={handleConfirm}>{confirmMessage}</button>
					{onConfirm && !ignoreCancel && <button className="btn ghost" onClick={handleClose}>取消</button>}
				</div>
			</div>
		</div>
	);

	document.body.append(element);
	return element;
};

export default SimpleModal;