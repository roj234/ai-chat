import {duplicateConversation} from "/src/data-exchange.js";
import {openJsonEditor} from "/src/json_editor/JsonEditDialog.js";
import {
	BRANCH_MANAGER,
	messages,
	selectedConversation,
	updateConversationListUI,
	updateMessageUI
} from "/src/states.js";
import {$unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, encodeObjects} from "/src/utils/marshal.js";
import {getMessages, markMessageDirty, updateConversation} from "/src/database.js";
import {enableBranches} from "/src/utils/BranchManager.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {inspect} from "unconscious/common/inspect.js";
import {cloneNamed} from "../src/utils/utils.js";

onLoad(() => {
	const dataDebug = DI_settings.byId("dd");
	const MESSAGE_KEYS = ['id', 'parent', 'role', 'label', 'time', 'content', 'finish_reason'];

	dataDebug.prepend(<button className="btn ghost" onClick={async () => {
		let jsonText, update, onclose;
		let updatePromise = async () => {
			const conv = unconscious(selectedConversation);

			const obj = {
				...conv,
				messages: (await getMessages(conv)).map(message => (cloneNamed(message, MESSAGE_KEYS)))
			};

			const mapping = new Map;
			await encodeObjects(obj, mapping);
			jsonText = inspect(obj, mapping.size ? (_, value) => mapping.get(value) ?? value : null);
			update?.();
		};
		await updatePromise();

		let skipNext;
		[update, onclose] = openJsonEditor("conversation",
			() => jsonText,
			async (obj) => {
				const {messages: changedMessage, ...conversation} = await decodeObjects(obj);

				const conv = unconscious(selectedConversation);
				if (conv?.id !== conversation.id) {
					console.warn("ID不相同，忽略");
					return;
				}

				Object.keys(conv).forEach(item => { delete conv[item]; });
				Object.assign(conv, conversation);

				const mfc = await getMessages(conv);
				const messageMap = new Map;
				for (const msg of mfc) {
					const id = msg.id;
					if (id > 0) messageMap.set(id, msg);
				}
				for (const msg of changedMessage) {
					const id = msg.id;
					const sys = messageMap.get(id);
					if (!sys) continue;
					messageMap.delete(id);

					for (const key of MESSAGE_KEYS){
						if (key in msg) sys[key] = msg[key];
						else delete sys[key];
					}

					markMessageDirty(sys);
				}
				for (let i = mfc.length - 1; i >= 0; i--){
					const value = mfc[i];
					if (messageMap.has(value.id)) {
						mfc.splice(i, 1);
					}
				}

				delete conv[BRANCH_MANAGER];
				if (conversation.bm_leaf) {
					messages.value = enableBranches(conv, mfc);
				} else {
					const msg = unconscious(messages);
					if (msg !== mfc) {
						msg.length = 0;
						msg.push(...mfc);
					} else {
						$update(messages);
					}
				}

				await updateConversation(conv, mfc, true);

				$update(updateMessageUI);
				$update(updateConversationListUI);
				$update(selectedConversation);
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
		编辑对话元数据 <i className={"ri-external-link-line"}/>
	</button>);

	dataDebug.prepend(<button className="btn ghost" onClick={duplicateConversation} disabled={() => !unconscious(selectedConversation)}>复制对话</button>);
})
