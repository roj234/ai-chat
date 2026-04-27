import {getKV, setKV} from "/src/database.js";
import {SETTINGS} from "/src/settings.js";
import {$state, $watch} from "unconscious";
import {isMobile} from "/src/states.js";
import {onLoad} from "/src/plugin.js";

let bgElement;

/** @type {import('unconscious').Reactive<Blob>} */
const IMAGE_BLOB = $state();

onLoad(() => {
	bgElement = document.querySelector(".chat.scroll");

	$watch(IMAGE_BLOB, () => {
		const blob = IMAGE_BLOB.value;

		let url;
		bgElement.style.background = !blob ? '' : `url("${url = blob.toUrl()}") center `+(isMobile?'top':'center')+` / cover`;
		return url && (() => URL.revokeObjectURL(url));
	});
});

SETTINGS.push({
	type: "element",
	_tab: "appearance",
	name: "聊天背景",
	element: <div className={"choice-scroll"}>
		<label className={"btn ghost"}>
			设置
			<input type={"file"} accept={"image/*"} style={"display:none"}
				   onChange={({target}) => {
					   const file = target.files[0];
					   setKV("chat-background", IMAGE_BLOB.value = file);
				   }}/>
		</label>
		<button className={"btn danger"} onClick={() => {
			setKV("chat-background", IMAGE_BLOB.value = undefined);
		}}>清除
		</button>
	</div>
});

getKV("chat-background").then(blob => IMAGE_BLOB.value = blob);