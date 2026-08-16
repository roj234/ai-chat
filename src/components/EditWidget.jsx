import "./EditWidget.css";

export const EditWidget = ({value, placeholder, onChange}) => {
	const updateHeight = () => {
		input.style.height = '0';
		//border 2px
		input.style.height = `${input.scrollHeight + 2}px`;
	};
	const input = <textarea className={"edit-widget text-input"}
							onInput={updateHeight}
							onChange={() => {
								onChange(input.value);
							}}
							placeholder={placeholder}
							value={value}
	/>;

	requestAnimationFrame(updateHeight);
	return input
}