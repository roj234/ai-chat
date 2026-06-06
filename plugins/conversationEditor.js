import {SETTINGS} from "/src/settings.js";
import {duplicateConversation} from "/src/data-exchange.js";
import {openJsonEditor} from "/src/json_editor/editorProxy.js";
import {messages, selectedConversation} from "/src/states.js";
import {$unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, serializeJSON} from "/src/utils/marshal.js";
import {updateConversation} from "../src/database.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {updateConversationListUI} from "/src/components/ConversationList.jsx";
import {parseJsonLenient} from "unconscious/common/Json.js";
import {BRANCH_MANAGER, enableBranches} from "../src/utils/BranchManager.js";

SETTINGS.push({
	type: "element",
	_tab: "data",
	name: "复制选中的对话",
	title: "仅应用于测试",
	element: <div className={"choice-scroll"}>
		<button className="btn ghost" onClick={duplicateConversation}>另存为</button>
		<button className="btn ghost" onClick={async () => {
			let jsonText, update, onclose;
			let updatePromise = () => {
				const conv = unconscious(selectedConversation);
				serializeJSON({
					...conv,
					messages: conv[BRANCH_MANAGER]?.messages.slice(1) || unconscious(messages)
				}, 2).then(text => {
					jsonText = text;
					update?.();
				})
			};
			await updatePromise();

			let skipNext;
			[update, onclose] = openJsonEditor("conversation",
				() => jsonText,
				async (v) => {
					const {messages: messages_, ...conversation} = await decodeObjects(parseJsonLenient(v));

					const conv = unconscious(selectedConversation);
					if (conv?.id !== conversation.id) {
						console.warn("ID不相同，忽略");
						return;
					}

					Object.keys(conv).forEach(item => {delete conv[item];});
					Object.assign(conv, conversation);

					if (conversation.bm_leaf) {
						messages.value = enableBranches(conv, messages_);
					} else {
						const msg = unconscious(messages);
						msg.length = 0;
						msg.push(...messages_);
					}

					await updateConversation(conv, messages_, true);

					$update(updateMessageUI);
					$update(updateConversationListUI);
					skipNext = true;
				}
			);
			const syncToEditor = () => {
				if (skipNext) skipNext = false;
				else updatePromise();
			};

			$watch([selectedConversation, messages], syncToEditor);
			onclose(() => {
				$unwatch(selectedConversation, syncToEditor);
				$unwatch(messages, syncToEditor);
			});
		}} disabled={() => !unconscious(selectedConversation)}>编辑当前对话的原始数据 <i className={"ri-external-link-line"} /></button>
	</div>
});