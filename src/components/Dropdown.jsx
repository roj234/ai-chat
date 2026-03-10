import "./Dropdown.css";

import {$computed, $foreach} from "unconscious";
import {indexInParent} from "../utils.js";

/**
 * 注意：如果传对象，必须是inline key
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<string>} selection
 * @param {function('s' | 'd', number): void} onChanged
 * @return {JSX.Element & {
 *     setSelection(number): void
 * }}
 * @constructor
 */
export function Dropdown({items, selection, onChanged}) {
	function updateHighlight_(i) {
		options.querySelector(".selected")?.classList.remove("selected");
		options.children[i]?.classList.add("selected");
		main.classList.remove("open");
	}

	let options;
	const main = <div className="pretty-select">
		<div className="input" onClick={() => main.classList.toggle("open")}>
			<span>{() => selection.value ?? "default"}</span>
			<svg className="arrow-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
				 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="m6 9 6 6 6-6"/>
			</svg>
		</div>

		<ul ref={options} className="dropdown"
			onClick.capture.stop.delegate{".ri-delete-bin-line"}={({target}) => {

			if (target.classList.toggle("clicked")) {
				setTimeout(() => {
					target.classList.remove("clicked");
				}, 2000);
			} else {
				const element = target.closest("li");
				onChanged('d', indexInParent(element));
			}
		}}
			onClick.delegate{"li"}={({target}) => {
			onChanged('s', indexInParent(target));
		}}>
			{$foreach(items, (item) =>
				<li class:selected={selection.value === item.name}>{item.name} <span>
					<i className={"ri-delete-bin-line"} title={"删除"}></i>
				</span></li>, (item) => item.name)}
		</ul>
	</div>;

	main.setSelection = updateHighlight_;
	main.onInserted = (id, name) => {
		let index = items.findIndex(value => value.name === name);
		if (index >= 0) {
			items[index].id = id;
		} else {
			items.unshift({
				id,
				//type: "preset",
				name,
			});
		}
		updateHighlight_(index);
	};

	return main;
}