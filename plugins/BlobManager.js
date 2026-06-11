import {SETTINGS} from "/src/settings.js";
import {isIDB} from "/src/database.js";

import "./BlobManager.css";

if (!isIDB) {
	SETTINGS.push({
		type: "element",
		name: "Blob管理面板",
		_tab: ["general", "data"],
		element: <div className={"choice-scroll"}>
			<button className={"btn ghost"} onClick={() => {
				import("./BlobManager.async.js").then(mod => {
					mod.display();
				});
			}}>管理附件
			</button>
		</div>
	});
}
