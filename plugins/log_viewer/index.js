import {DI_settings, onLoad} from "/src/hooks.js";

onLoad(() => {
	const el = DI_settings.byId('aux');
	el.append(<a href="#" onClick.prevent={async() => {
		(await import("./log_viewer.js")).openLogViewer();
	}}>统计</a>)
});