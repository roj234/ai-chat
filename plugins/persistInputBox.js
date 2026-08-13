import {inputText, onConversationLoaded, selectedConversation} from "/src/states.js";
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