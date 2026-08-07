

/**
 * @param {string} text
 * @param {string} pendingText
 * @param {string} okText
 * @param {string} failText
 * @param {string} className
 * @param {function(HTMLButtonElement): Promise<any>} onClick
 * @constructor
 */
export const AsyncButton = ({ pendingText, okText, failText = '操作失败', onClick, className = 'btn ghost' }, text) => {
	return <button className={className} onClick={({target}) => {
		target.textContent = pendingText;
		target.disabled = true;
		onClick(target).then(() => {
			target.textContent = okText;
		}, () => {
			target.textContent = failText;
		}).finally(() => setTimeout(() => {
			target.textContent = text;
			target.disabled = false;
		}, 1000));
	}}>{text}</button>;
}