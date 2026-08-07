import './SimpleModal.css';

/**
 *
 * @param {'info' | 'input'} type
 * @param {string} title
 * @param {string} message
 * @param {string} placeholder
 * @param {string} value
 * @param {string} list datalist 元素的 id
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
		list,
		accent = 'primary',
		confirmMessage = '确认',
		onConfirm,
		onCancel,
		after
}) => {
	let inputValue = '';
	const ignoreCancel = onCancel === null;

	const handleClose = async () => {
		if (ignoreCancel || false === await onCancel?.(inputValue)) {
			return;
		}
		element.remove();
	}

	const handleConfirm = async () => {
		if (false === await onConfirm?.(inputValue)) return;
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
					{typeof message === 'string' ? <p>{message}</p> : message}
					{type === 'input' ? <input className={"text-input"}
						onChange={(e) => inputValue = e.target.value}
						placeholder={placeholder}
						list={list}
						onKeyDown={(e) => {
							e.key === "Enter" && handleConfirm();
						}}
						value={value}
					/> : type === 'textarea' ? input = <textarea className={"text-input"}
						onChange={(e) => inputValue = e.target.value}
						onFocus={onFocusBlur} onBlur={onFocusBlur}
						placeholder={placeholder}
					>{value}</textarea> : null}
					{after}
				</div>
				<div className="footer">
					<button className={"btn " + accent} onClick={onConfirm ? handleConfirm : handleClose}>{confirmMessage}</button>
					{onConfirm && !ignoreCancel && <button className="btn ghost" onClick={handleClose}>取消</button>}
				</div>
			</div>
		</div>
	);

	document.body.append(element);
	return element;
};

export default SimpleModal;