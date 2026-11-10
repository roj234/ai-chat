import {isIDB} from "/src/database.js";
import {DI_settings, onLoad} from "/src/hooks.js";

if (!isIDB) {
	onLoad(() => {
		const dataDebug = DI_settings.byId("dd");
		dataDebug.append(<button className={"btn ghost"} onClick={() => {
			import("./BlobManager.js").then(mod => mod.display());
		}}>附件管理</button>);
	});
}
