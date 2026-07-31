import {duplicateConversation} from "/src/data-exchange.js";
import {openJsonEditor} from "/src/json_editor/jsonEditorProxy.js";
import {
	BRANCH_MANAGER,
	messages,
	selectedConversation,
	updateConversationListUI,
	updateMessageUI
} from "/src/states.js";
import {$unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, serializeJSON} from "/src/utils/marshal.js";
import {updateConversation} from "/src/database.js";
import {parseJson5} from "unconscious/common/Json.js";
import {enableBranches} from "/src/utils/BranchManager.js";
import {DI_settings, onLoad} from "/src/hooks.js";

onLoad(() => {
	const dataDebug = DI_settings.byId("dd");

	dataDebug.prepend(<button className="btn ghost" onClick={async () => {
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
				const {messages: messages_, ...conversation} = await decodeObjects(parseJson5(v));

				const conv = unconscious(selectedConversation);
				if (conv?.id !== conversation.id) {
					console.warn("ID不相同，忽略");
					return;
				}

				Object.keys(conv).forEach(item => {
					delete conv[item];
				});
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
	}} disabled={() => !unconscious(selectedConversation)}>
		编辑对话原始 JSON <i className={"ri-external-link-line"}/>
	</button>);

	dataDebug.prepend(<button className="btn ghost" onClick={duplicateConversation} disabled={() => !unconscious(selectedConversation)}>复制对话</button>);
})
