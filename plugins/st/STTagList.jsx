import {$foreach} from "unconscious";
import "./STTagList.css";

/**
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<number[]>} selection
 * @constructor
 */
export function LorebookList({items, selection}) {
	function toggleLorebook(id) {
		const x = selection.indexOf(id);
		if (x >= 0) selection.splice(x, 1);
		else selection.push(id);
	}

	return <div className="tag-dropdown">
		<button className="btn ghost">+ 已选择 {() => selection.length} 个世界书</button>
		<div className="list" onClick.delegate{"input"}={({delegateTarget}) => {
			toggleLorebook(parseInt(delegateTarget.dataset.id));
		}}>
			<label>
				<input
					data-id={-1}
					type="checkbox"
					checked={selection.includes(-1)}
				/> 内置
			</label>
			{$foreach(items, ({id, name}) => (
				<label>
					<input
						data-id={id}
						type="checkbox"
						checked={selection.includes(id)}
					/> {name}
				</label>
			))}
		</div>
	</div>;
}


/**
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<number>} selection
 * @constructor
 */
export function PresetList({items, selection}) {
	function toggleLorebook(id) {
		selection.value = id;
	}

	return <div className="tag-dropdown">
		<button className="btn ghost">{() => selection.value === -1 ? "跟随当前预设" : "锁定预设"}</button>
		<div className="list" onClick.delegate{"label"}={({delegateTarget}) => {
			delegateTarget.parentElement.querySelector(".selected")?.classList.remove("selected");
			delegateTarget.classList.add("selected");
			toggleLorebook(parseInt(delegateTarget.dataset.id));
		}}>
			<label data-id={-1} className={selection.value === -1 ? "selected" : null}>不指定</label>
			{$foreach(items, ({id, name}) => (
				<label data-id={id} className={selection.value === id ? "selected" : null}>{name}</label>
			))}
		</div>
	</div>;
}