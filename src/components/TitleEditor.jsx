import {conversations, isMobile, selectedConversation} from "../states.js";
import {$state, $update} from "unconscious";
import {updateConversation} from "../database.js";

export function TitleEditor() {
	//row = <div className='input-warp'>{input}</div>;
	const input = <input className={"text-input"} />;
	const title = <b>{() => selectedConversation.title || '无标题'}</b>;
	const isEditing = $state(false);
	const handler = () => {
		const after = isEditing.value ^= true;
		const conv = selectedConversation.value;
		if (!after) {
			title.textContent = conv.title = input.value;
			$update(conversations);
			updateConversation(conv);
		} else {
			input.value = conv.title;
			requestAnimationFrame(() => input.focus());
		}
	};

	let editBtn;
	if (isMobile) {
		editBtn = <button className={"ri-pencil-line btn ghost"} title={"编辑"} style={"font-size:smaller;color:var(--muted)"} onClick={handler}></button>;
	} else {
		title.addEventListener("click", handler);
		input.addEventListener("blur", handler);
	}

	return <div>{() => isEditing.value ? input : title}{editBtn}</div>;
}