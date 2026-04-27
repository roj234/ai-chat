import {resumableCompletions, selectedConversation} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {sendUserChatMessage} from "/src/api-request.js";
import {onLoad} from "/src/plugin.js";
import {$watch} from "unconscious";

/*SETTINGS.push({
	id: 'autoResumeSSE',
	type: 'radio',
	name: '自动继续意外中止的响应',
	title: '若网页意外关闭，重新打开后会向服务器请求'
})*/

onLoad(() => {
	$watch(selectedConversation, () => {
		if (selectedConversation.ready) {
			const conversationId = selectedConversation.id;
			const resumeObj = resumableCompletions[conversationId];
			if (resumeObj) {
				if (Date.now() - resumeObj.time < RESUME_TIMEOUT) {
					sendUserChatMessage(null);
					showToast("正在继续上次意外中断的响应", 'ok');
				} else {
					delete resumableCompletions[conversationId];
				}
			}
		}
	}, false);
})