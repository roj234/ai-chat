import {$foreach} from "unconscious";
import "./TagList.css";

/**
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<number[]>} selection
 */
export function LorebookList({items, selection}) {
	function toggleLorebook(id) {
		const x = selection.indexOf(id);
		if (x >= 0) selection.splice(x, 1);
		else selection.push(id);
	}

	return <div className="tag-dropdown">
		<button className="btn ghost">+ 使用 {() => selection.length} 个世界书</button>
		<div className="list" onClick.delegate{"input"}={({delegateTarget}) => {
			toggleLorebook(delegateTarget.dataset.id);
		}}>
			<label>
				<input
					data-id={""}
					type="checkbox"
					checked={selection.includes("")}
				/> 内置
			</label>
			{$foreach(items, ({name}) => (
				<label>
					<input
						data-id={name}
						type="checkbox"
						checked={selection.includes(name)}
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
 */
export function PresetList({items, selection}) {
	function toggleLorebook(id) {
		selection.value = id;
	}

	return <div className="tag-dropdown">
		<button className="btn ghost">{() => !selection.value ? "跟随当前预设" : "锁定 "+selection.value+" 预设"}</button>
		<div className="list" onClick.delegate{"label"}={({delegateTarget}) => {
			delegateTarget.parentElement.querySelector(".selected")?.classList.remove("selected");
			delegateTarget.classList.add("selected");
			toggleLorebook(delegateTarget.dataset.id);
		}}>
			<label data-id={""} className={selection.value == null ? "selected" : null}>不指定</label>
			{$foreach(items, ({name}) => (
				<label data-id={name} className={selection.value === name ? "selected" : null}>{name}</label>
			))}
		</div>
	</div>;
}