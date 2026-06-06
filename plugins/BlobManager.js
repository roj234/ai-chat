import {SETTINGS} from "/src/settings.js";

import "./BlobManager.css";

if (DB_MODE !== "local") {
	SETTINGS.push({
		type: "element",
		name: "Blob管理器",
		_tab: ["general", "data"],
		element: <div className={"choice-scroll"}>
			<button className={"btn danger"} onClick={() => {
				import("./BlobManager.async.js").then(mod => {
					mod.display();
				});
			}}>编辑
			</button>
		</div>
	});
}
