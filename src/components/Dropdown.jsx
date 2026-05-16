import "./Dropdown.css";

import {$disposable, $foreach} from "unconscious";
import {indexInParent} from "../utils/utils.js";
import {onLoad} from "../plugin.js";

let instances = new Set;

/**
 * 注意：如果传对象，必须是inline key
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<string>} selection
 * @param {function('s' | 'd', number): void} onChanged
 * @param {'up'|'down'} dir
 * @return {JSX.Element & {
 *     setSelection(number): void
 * }}
 */
export function Dropdown({items, selection, onChanged, dir = 'down'}) {
	const updateHighlight_ = i => {
		options.querySelector(".selected")?.classList.remove("selected");
		options.children[i]?.classList.add("selected");
		main.classList.remove("open");
	};

	let options;
	const main = <div className={"pretty-select "+dir}>
		<div className="input" onClick.stop={() => main.classList.toggle("open")}>
			<span>{() => selection.value ?? "default"}</span>
			<span className={"arrow-icon ri-arrow-down-s-line"}></span>
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
				<li class:selected={selection.value === item.name} title={item.name}>{item.name}
					<i className={"ri-delete-bin-line"} title={"删除"}></i>
				</li>, (item) => item.name)}
		</ul>
	</div>;

	main.setSelection = updateHighlight_;
	main.onInserted = (type, name) => {
		let index = items.findIndex(value => value.name === name);
		if (index < 0) {
			items.unshift({
				type,
				name,
			});
		}
		updateHighlight_(index);
	};

	instances.add(main);
	$disposable(main, () => instances.delete(main));

	return main;
}

onLoad((app) => {
	app.querySelectorAll(".pretty-select").forEach(el => instances.add(el));
	addEventListener("click", () => {
		instances.forEach(el => el.classList.remove("open"));
	})
})