import "./Dropdown.css";

import {$cleanup, $computed, $state, $vforeach, unconscious} from "unconscious";
import {onLoad} from "../hooks.js";
import {ITEM_KEY} from "unconscious/common/VirtualList.js";
import {Icon_search} from "./Icons.jsx";
import {LOCKED} from "../states.js";
import {closeMenu, openMenu} from "./Layer.js";

let instances = new Set;
/**
 * 注意：如果传对象，必须是inline key
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<string>} selection
 * @param {function('s' | 'd' | string, string): void} onChanged
 * @param {'up'|'down'} dir
 * @param {function(): Promise<?> | void} [lazy]
 * @param {Function} [add]
 * @param {Function} [actions]
 * @param {string} [displayName]
 * @return {JSX.Element & {
 *     setSelection(number): void
 * }}
 */
export function Dropdown({
	items, selection, onChanged, dir = 'down',
	lazy,
	add, actions, displayName = "name"
}) {
	const filterText = $state("");
	let options;
	const main = <div className={"pretty-select "+dir}>
		<div className="input" tabIndex={0} onClick.stop={() => {
			if (main.classList.toggle("open")) {
				filterText.value = "";

				if (lazy) {
					const loading = <div className="center"><div className="spinner"/></div>;
					options.append(loading);
					lazy().finally(() => loading.remove());
					lazy = null;
				}
			}
		}}>
			<span>{() => unconscious(selection) ?? "default"}</span>
			<span className={"-arrow ri-arrow-down-s-line"}></span>
		</div>

		<div className={"dropdown"}>
			<div className="my-input" onClick.stop={() => {}}>
				<Icon_search />
				<input placeholder="筛选" autoComplete="off"
					   value={filterText} onInput={({target}) => {
					filterText.value = target.value.toLowerCase();
				}}/>
				{add && <button className="ri-add-line ghost" title="新建" onClick={() => {
					const r = add(unconscious(filterText));
					if (r !== false) filterText.value = "";
				}} />}
			</div>
			<ul ref={options} onClick.capture.delegate{".ri-delete-bin-line"}.stop={(e) => {
				const target = e.target.closest("li");
				openMenu(e, options, [
					{ label: `删除 ${JSON.stringify(target[ITEM_KEY])}？` },
					{ el: <div className="row" style="justify-content:center">
						<button className="btn ghost" onClick={closeMenu}>留</button>
						<button className="btn danger" onClick={() => {
							onChanged('d', target[ITEM_KEY]);
							closeMenu();
						}}>删</button>
					</div> }
				], true);
			}}
			onClick.delegate{"li"}={(e) => {
				onChanged('s', e.delegateTarget[ITEM_KEY], e);
			}}>
				{$vforeach($computed(() => {
					const arr = unconscious(items);
					const filter = unconscious(filterText);
					return filter ? arr.filter(({name}) => name.toLowerCase().includes(filter)) : arr;
				}, null, true), (item) => {
					const deleteBtn = item[LOCKED] ? null : <button className="ri-delete-bin-line" title="删除" tabIndex={0} />;
					return <li className={item.className} tabIndex={0} class:selected={unconscious(selection) === item.name} title={item[displayName]}>
						<span className="ellipsis">{item[displayName]}</span>
						{actions ? <div className="-btns">{actions(item)}{deleteBtn}</div> : deleteBtn}
					</li>
				}, (item) => item.name)}
			</ul>
		</div>
	</div>;

	/**
	 * @type {import("unconscious/common/VirtualList.js").VirtualList}
	 */
	let vl = options.firstElementChild.list;

	/**
	 * @param {string} name
	 */
	main.setSelection = name => {
		options.querySelectorAll(".selected").forEach(e => e.classList.remove("selected"));
		main.classList.remove("open");

		const i = vl.findIndex(value => value.name === name);
		if (i < 0) return;
		vl.getValue(i)?.classList.add("selected");
	};

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