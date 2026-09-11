

/**
 * @param {string} text
 * @param {string} [pendingText]
 * @param {string} [okText]
 * @param {string} [failText]
 * @param {string} [className]
 * @param {function(HTMLButtonElement): Promise<any>} onClick
 * @constructor
 */
export const AsyncButton = ({ pendingText, okText, failText, onClick, className = 'btn ghost' }, text) => {
	return <button className={className} onClick={({target}) => {
		target.textContent = pendingText ?? text+"中";
		target.disabled = true;
		onClick(target).then(() => {
			target.textContent = okText ?? text+"成功";
		}, () => {
			target.textContent = failText ?? text+"失败";
		}).finally(() => setTimeout(() => {
			target.textContent = text;
			target.disabled = false;
		}, 1000));
	}}>{text}</button>;
}