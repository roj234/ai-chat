
import "./EditWidget.css";

export const EditWidget = ({value, onChange}) => {
	const input = <textarea className={"edit-widget text-input"}
							onInput={() => {
								input.style.height = '';
								input.style.height = `${input.scrollHeight}px`;
							}}
							onChange={() => {
								onChange(input.value);
							}}
							value={value}
	/>;

	requestAnimationFrame(() => {
		input.style.height = '';
		input.style.height = `${input.scrollHeight}px`;
	})
	return input
}