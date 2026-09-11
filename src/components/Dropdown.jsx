import "./Dropdown.css";

import {$cleanup, $computed, $foreach, $state, unconscious} from "unconscious";
import {indexInParent} from "../utils/utils.js";
import {onLoad} from "../hooks.js";

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
		options.querySelectorAll(".selected").forEach(e => e.classList.remove("selected"));
		main.classList.remove("open");

		if (typeof i !== 'number') {
			i = items.findIndex(value => value.name === i);
			if (i < 0) return;
		}

		options.children[i+1]?.classList.add("selected");
	};

	const filterText = $state("");
	let options;
	const main = <div className={"pretty-select "+dir}>
		<div className="input" onClick.stop={() => {
			if (main.classList.toggle("open")) {
				filterText.value = "";
			}
		}}>
			<span>{() => selection.value ?? "default"}</span>
			<span className={"arrow-icon ri-arrow-down-s-line"}></span>
		</div>

		<ul ref={options} className="dropdown"
			onClick.capture.delegate{".ri-delete-bin-line"}.stop={({target}) => {

			if (target.classList.toggle("clicked")) {
				setTimeout(() => {
					target.classList.remove("clicked");
				}, 2000);
			} else {
				const element = target.closest("li");
				onChanged('d', indexInParent(element)-1);
			}
		}}
			onClick.delegate{"li"}={({target}) => {
			onChanged('s', indexInParent(target)-1);
		}}>
			<input className={"text-input"} placeholder={"筛选"} onClick.stop={() => {}} onInput={e => {
				filterText.value = e.target.value.toLowerCase();
			}} value={filterText} />
			{$foreach($computed(() => {
				const arr = unconscious(items);
				const filter = unconscious(filterText);
				return filter ? arr.filter(({name}) => name.toLowerCase().includes(filter)) : arr;
			}, null, true), (item) =>
				<li class:selected={selection.value === item.name} title={item.name}>{item.name}
					<i className={"ri-delete-bin-line"} title={"删除"}></i>
				</li>, (item) => item.name)}
		</ul>
	</div>;

	main.setSelection = updateHighlight_;

	instances.add(main);
	$cleanup(main, () => instances.delete(main));

	return main;
}

onLoad((app) => {
	app.querySelectorAll(".pretty-select").forEach(el => instances.add(el));
	addEventListener("click", () => {
		instances.forEach(el => el.classList.remove("open"));
	})
})