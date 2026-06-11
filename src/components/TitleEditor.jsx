import {isMobile, selectedConversation} from "../states.js";
import {$state, unconscious} from "unconscious";
import {setConversationTitle} from "./ConversationList.jsx";

export function TitleEditor() {
	//row = <div className='input-warp'>{input}</div>;
	const input = <input className={"text-input"} />;
	const title = <b>{() => selectedConversation.title || '无标题'}</b>;
	const isEditing = $state(false);
	const handler = () => {
		const after = isEditing.value ^= true;
		const conv = unconscious(selectedConversation);
		if (!after) {
			setConversationTitle(conv, title.textContent = input.value);
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