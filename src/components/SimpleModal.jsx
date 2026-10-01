import './SimpleModal.css';
import Filter from "unconscious/common/components/Filter.jsx";
import {$state} from "unconscious";

/**
 *
 * @param {'info' | 'input' | 'filter'} type
 * @param {string} title
 * @param {string} className
 * @param {string} message
 * @param {string} placeholder
 * @param {string} value
 * @param {string} list datalist 元素的 id
 * @param {'primary' | 'danger' | 'ghost'} accent
 * @param {string} confirmMessage
 * @param {function(string): void = } onConfirm
 * @param {function(string, any, Record<string, any>): void = } onFilterChanged
 * @param {function(string): void = } onCancel
 * @param {Element} after
 * @returns {HTMLDivElement}
 */
const SimpleModal = ({
		type = 'info', // 'info' or 'input'
		title = '提示',
		className = '',
		message,
		placeholder,
		value,
		list,
		accent = 'primary',
		confirmMessage = '确认',
		onConfirm,
		onFilterChanged,
		onCancel,
		after
}) => {
	let inputValue = '';
	const ignoreCancel = onCancel === null;

	const handleClose = async () => {
		if (ignoreCancel || false === await onCancel?.(inputValue)) {
			return;
		}
		modal.remove();
	}

	const handleConfirm = async () => {
		if (false === await onConfirm?.(inputValue)) return;
		modal.remove();
	};

	let input;
	const onFocusBlur = e => {
		const isFocus = e.type === "focus";
		input.style.height = isFocus ? "500px" : "";
	};

	let filter;
	if (type === "filter") {
		inputValue = $state(placeholder || {});
		const onChanged = () => queueMicrotask(() => {
			modal.querySelector(".btn.primary").disabled = !!after.hasError();
		});
		filter = <Filter config={value} choices={inputValue} onChange={(k, v, obj) => {
			onChanged();
			onFilterChanged?.(k, v, obj);
		}} />;
		onChanged();
	} else {
		inputValue = value;
	}

	const modal = <dialog className={"modal " + className} onClick={(e) => {
		// 排除键盘导致的点击事件
		if (e.pointerId < 0 || !modal.isConnected) return;

		// 检测点击是否落在 dialog 自身（而非内部子元素）
		const rect = modal.getBoundingClientRect();
		const inside =
			e.clientX >= rect.left &&
			e.clientX <= rect.right &&
			e.clientY >= rect.top &&
			e.clientY <= rect.bottom;

		if (!inside && onConfirm && !ignoreCancel) handleClose();
	}} role="dialog" aria-modal="true">
		<div className="header"><b>{title}</b></div>
		<div className="body">
			{typeof message === 'string' ? <p>{message}</p> : message}
			{type === 'input' ? <input className={"text-input"}
				onChange={(e) => inputValue = e.target.value}
				placeholder={placeholder} list={list}
				onKeyDown={(e) => {
					e.key === "Enter" && handleConfirm();
				}}
				value={value}
			/> :
			type === 'textarea' ? input = <textarea className={"text-input"}
				onChange={(e) => inputValue = e.target.value}
				onFocus={onFocusBlur} onBlur={onFocusBlur}
				placeholder={placeholder}
			>{value}</textarea> : null}
			{filter}
			{after}
		</div>
		<div className="footer">
			<button className={"btn " + accent}
					onClick={onConfirm ? handleConfirm : handleClose}>{confirmMessage}</button>
			{onConfirm && !ignoreCancel && <button className="btn ghost" onClick={handleClose}>取消</button>}
		</div>
	</dialog>;

	document.body.append(modal);
	modal.showModal();
	return modal;
};

export default SimpleModal;