import {duplicateConversation} from "/src/data-exchange.js";
import {openJsonEditor} from "/src/json_editor/JsonEditDialog.js";
import {selectedConversation, updateConversationListUI, updateMessageUI} from "/src/states.js";
import {$unwatch, $update, $watch, unconscious} from "unconscious";
import {decodeObjects, encodeObjects} from "/src/utils/serialization.js";
import {updateConversation} from "/src/database.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {inspect} from "unconscious/common/inspect.js";

onLoad(() => {
	const dataDebug = DI_settings.byId("dd");

	dataDebug.prepend(<button className="btn ghost" onClick={async () => {
		let jsonText, update, onclose;
		let updatePromise = async () => {
			const conv = unconscious(selectedConversation);
			const mapping = new Map;
			await encodeObjects(conv, mapping);
			jsonText = inspect(conv, mapping.size ? (_, value) => mapping.get(value) ?? value : null);
			update?.();
		};

		let skipNext;
		[update, onclose] = openJsonEditor("conversation",
			() => jsonText,
			async (obj) => {
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
		);
		const syncToEditor = () => {
			if (skipNext) skipNext = false;
			else updatePromise();
		};

		$watch(selectedConversation, syncToEditor);
		onclose(() => {
			$unwatch(selectedConversation, syncToEditor);
		});
	}} disabled={() => !unconscious(selectedConversation)}>
		编辑对话元数据 <i className={"ri-external-link-line"}/>
	</button>);

	dataDebug.prepend(<button className="btn ghost" onClick={duplicateConversation} disabled={() => !unconscious(selectedConversation)}>复制对话</button>);
})
