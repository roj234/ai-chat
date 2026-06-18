import {SETTINGS} from "/src/settings.js";
import {isIDB} from "/src/database.js";

import "./BlobManager.css";

if (!isIDB) {
	SETTINGS.push({
		type: "element",
		_tab: ["general", "data"],
		element: <div className={"choice-scroll"}>
			<button className={"btn ghost"} onClick={() => {
				import("./BlobManager.async.js").then(mod => {
					mod.display();
				});
			}}>附件管理
			</button>
		</div>
	});
}
