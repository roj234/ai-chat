import {duplicateConversation} from "/src/data-exchange.js";
import {openJsonEditor} from "/src/json_editor/jsonEditorProxy.js";
import {messages, selectedConversation, updateConversationListUI, updateMessageUI} from "/src/states.js";
import {$unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, encodeObjects} from "/src/utils/marshal.js";
import {getMessagesCacheFirst, markMessageDirty, updateConversation} from "/src/database.js";
import {parseJson5} from "unconscious/common/Json.js";
import {enableBranches} from "/src/utils/BranchManager.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {stringify} from "/common/json5-stringify.js";
import {cloneNamed} from "../src/utils/utils.js";

onLoad(() => {
	const dataDebug = DI_settings.byId("dd");
	const MESSAGE_KEYS = ['id', 'parent', 'role', 'label', 'time', 'content'];

	dataDebug.prepend(<button className="btn ghost" onClick={async () => {
		let jsonText, update, onclose;
		let updatePromise = async () => {
			const conv = unconscious(selectedConversation);

			const obj = {
				...conv,
				messages: (await getMessagesCacheFirst(conv)).map(message => (cloneNamed(message, MESSAGE_KEYS)))
			};

			const mapping = new Map;
			await encodeObjects(obj, mapping);
			jsonText = stringify(obj, mapping.size ? (_, value) => mapping.get(value) ?? value : null, 2);
			update?.();
		};
		await updatePromise();

		let skipNext;
		[update, onclose] = openJsonEditor("conversation",
			() => jsonText,
			async (v) => {
				const {messages: changedMessage, ...conversation} = await decodeObjects(parseJson5(v));

				const conv = unconscious(selectedConversation);
				if (conv?.id !== conversation.id) {
					console.warn("ID不相同，忽略");
					return;
				}

				Object.keys(conv).forEach(item => { delete conv[item]; });
				Object.assign(conv, conversation);

				const messagesFromCache = await getMessagesCacheFirst(conv);
				const messageMap = new Map;
				for (const msg of messagesFromCache) {
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
				for (let i = messagesFromCache.length - 1; i >= 0; i--){
					const value = messagesFromCache[i];
					if (messageMap.has(value.id)) {
						messagesFromCache.splice(i, 1);
					}
				}

				if (conversation.bm_leaf) {
					messages.value = enableBranches(conv, messagesFromCache);
				} else {
					const msg = unconscious(messages);
					if (msg !== messagesFromCache) {
						msg.length = 0;
						msg.push(...messagesFromCache);
					} else {
						$update(messages);
					}
				}

				await updateConversation(conv, messagesFromCache, true);

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
