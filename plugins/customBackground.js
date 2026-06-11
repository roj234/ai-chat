import {getKV, setKV} from "/src/database.js";
import {SETTINGS} from "/src/settings.js";
import {$computed, $state, $watch, unconscious} from "unconscious";
import {config, isMobile} from "/src/states.js";
import {onLoad} from "/src/plugin.js";

/** @type {import('unconscious').Reactive<Blob>} */
const BG_BLOB = $state(), FONT_BLOB = $state();
/** @type {import('unconscious').Reactive<'cover' | 'contain' | 'stretch' | 'tile' | 'center'>} */
const BG_FIT = $computed(() => config.backgroundFit);

onLoad(() => {
	getKV("chat-background", BG_BLOB);
	getKV("chat-font", FONT_BLOB);

	$watch([BG_BLOB, BG_FIT], () => {
		const blob = unconscious(BG_BLOB);
		const style = document.body.style;
		if (!blob) { style.background = ''; return; }
		let url = blob.toUrl();

		const pos = isMobile ? 'center top' : 'center center';
		const fit = unconscious(BG_FIT);
		let bgStyle;

		switch (fit) {
			default:
			case 'cover': bgStyle = `${pos} / cover no-repeat`; break;
			case 'contain': bgStyle = `${pos} / contain no-repeat`; break;
			case 'stretch': bgStyle = `${pos} / 100% 100% no-repeat`; break;
			case 'tile': bgStyle = `repeat`; break;
			case 'center': bgStyle = `${pos} / auto no-repeat`; break;
		}

		style.background = `url("${url}") `+bgStyle;
		return () => URL.revokeObjectURL(url);
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
	type: "radio",
	required: true,
	_tab: "appearance",
	id: "backgroundFit",
	name: "背景图契合模式",
	choices: {
		"填充": "cover",
		"适应": "contain",
		"拉伸": "stretch",
		"平铺": "tile",
		"居中": "center"
	},
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