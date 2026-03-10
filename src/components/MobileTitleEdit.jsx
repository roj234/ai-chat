import {conversations, selectedConversation} from "../states.js";
import {$state, $update} from "unconscious";
import {updateConversation} from "../database.js";

export function MobileTitleEdit() {
	const input = <input />;
	const title = <b>{() => selectedConversation.title || '无标题'}</b>;
	const isEditing = $state(false);
	const editBtn = <button className={"ri-pencil-line"} style={"font-size: 12px; color: var(--muted)"} onClick={() => {
		const after = isEditing.value ^= true;
		const conv = selectedConversation.value;
		if (!after) {
			title.textContent = conv.title = input.value;
			$update(conversations);
			updateConversation(conv);
		} else {
			input.value = conv.title;
		}
	}}></button>;

	return <span style={"display:inline-flex;align-items:center"}>{() => isEditing.value ? input : title}{editBtn}</span>;
}