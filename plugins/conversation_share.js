import {COMMAND_REGISTRY} from "/src/commands.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {isIDB} from "/src/database.js";
import {requestBackend} from "../src/database/remoteDB.js";
import {unconscious} from "unconscious";
import {selectedConversation} from "../src/states.js";

if (!isIDB) {
	COMMAND_REGISTRY['share'] = [
		async () => {
			const {pat} = await requestBackend('shareToken?id='+unconscious(selectedConversation).id);
			const url = location.href.slice(0, -location.hash.length)+"#!shareView/"+pat;
			const canvas = (await import("unconscious/common/qr.js")).renderQRCodeToCanvas(url);

			SimpleModal({
				title: "手机浏览器扫码打开",
				message: <>{url}<br/>{canvas}</>
			})
		},
		"分享这条对话"
	]
}
