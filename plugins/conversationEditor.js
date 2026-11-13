import {openJsonEditor} from "/src/components/JsonEditor.jsx";
import {EVENT_BUS, selectedConversation, updateConversationListUI, updateMessageUI} from "/src/states.js";
import {$cleanup, $state, $unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, encodeObjects} from "/src/utils/serialization.js";
import {updateConversation} from "/src/database.js";
import {inspect} from "@roj234/util-inspect";

const editJson = async () => {
	openJsonEditor(`[当前对话]`,
		(w) => {
			let skipNext;
			const data = $state();
			const setValue = async (obj) => {
				const conversation = await decodeObjects(obj);

				const conv = unconscious(selectedConversation);

				const id = conv.id;

				Object.keys(conv).forEach(item => { delete conv[item]; });
				Object.assign(conv, conversation);

				conv.id = id;

				await updateConversation(conv);

				$update(updateMessageUI);
				$update(updateConversationListUI);
				$update(selectedConversation);
				skipNext = true;
			}

			const syncToEditor = () => {
				if (skipNext) skipNext = false;
				else {
					const conv = unconscious(selectedConversation);
					const mapping = new Map;
					encodeObjects(conv, mapping).then(() => {
						data.value = inspect(conv, mapping.size ? (_, value) => mapping.get(value) ?? value : null);
					});
				}
			}

			$watch(selectedConversation, syncToEditor);
			$cleanup(w, () => $unwatch(selectedConversation, syncToEditor));

			return [data, setValue];
		},
	);
};

EVENT_BUS.on(['getMenu', 'dev'], items => {
	items.push(
		{ icon: "ri-braces-line", label: "编辑会话 JSON", disabled: !unconscious(selectedConversation), act: editJson }
	);

})
