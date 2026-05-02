import {getKV, setKV} from "/src/database.js";
import {SETTINGS} from "/src/settings.js";
import {$state, $watch} from "unconscious";
import {isMobile} from "/src/states.js";
import {onLoad} from "/src/plugin.js";

let bgElement;

/** @type {import('unconscious').Reactive<Blob>} */
const BG_BLOB = $state();
/** @type {import('unconscious').Reactive<Blob>} */
const FONT_BLOB = $state();

onLoad(() => {
	getKV("chat-background").then(blob => BG_BLOB.value = blob);
	getKV("chat-font").then(blob => FONT_BLOB.value = blob);

	bgElement = document.querySelector(".chat.scroll");

	$watch(BG_BLOB, () => {
		const blob = BG_BLOB.value;

		let url;
		bgElement.style.background = !blob ? '' : `url("${url = blob.toUrl()}") center `+(isMobile?'top':'center')+` / cover`;
		return url && (() => URL.revokeObjectURL(url));
	});

	$watch(FONT_BLOB, () => {
		const blob = FONT_BLOB.value;
		let url;
		if (!blob) {
			document.querySelector("#custFont")?.remove();
		} else {
			document.head.insertAdjacentHTML("beforeend", `<style id="custFont">
@font-face {font-family:'CUST';font-display:swap;src:url(${JSON.stringify(url = blob.toUrl())})}
.panel > ._vl > .msg > .body {font-family:'CUST';}
</style>`);
		}

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
					   setKV("chat-background", BG_BLOB.value = file);
				   }}/>
		</label>
		<button className={"btn danger"} onClick={() => {
			setKV("chat-background", BG_BLOB.value = undefined);
		}}>清除
		</button>
		{() => BG_BLOB.name}
	</div>
},{
	type: "element",
	_tab: "appearance",
	name: "聊天字体",
	element: <div className={"choice-scroll"}>
		<label className={"btn ghost"}>
			设置
			<input type={"file"} accept={"application/font-*"} style={"display:none"}
				   onChange={({target}) => {
					   const file = target.files[0];
					   setKV("chat-font", FONT_BLOB.value = file);
				   }}/>
		</label>
		<button className={"btn danger"} onClick={() => {
			setKV("chat-font", FONT_BLOB.value = undefined);
		}}>清除
		</button>
		{() => FONT_BLOB.name}
	</div>
});
