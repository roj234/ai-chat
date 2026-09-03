import {conversations, EVENT_BUS, inputText, onConversationLoaded, selectedConversation} from "/src/states.js";
import {$store, $watch, unconscious} from "unconscious";

const inputTextObj = $store("inputText", {}, {persist: true});

$watch(inputText, () => {
	const conv = unconscious(selectedConversation);
	const id = conv?.id;
	if (id) {
		const input = unconscious(inputText);
		if (input) inputTextObj[id] = input;
		else delete inputTextObj[id];
	}
}, false);

onConversationLoaded((conv) => {
	inputText.value = inputTextObj[conv.id] || '';
});

EVENT_BUS.on('load', () => {
	const ids = new Set(Object.keys(inputTextObj));
	conversations.forEach(c => ids.delete(String(c.id)));
	for (const id of ids) delete inputTextObj[id];
});