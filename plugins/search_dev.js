import {SETTINGS} from "../src/settings.js";
import {searchMessages} from "../src/database.js";
import SimpleModal from "../src/components/SimpleModal.jsx";
import {highlightJsonLike} from "../src/markdown/highlight.js";

SETTINGS.push({
	name: "搜索(测试版)",
	type: "element",
	element:
		<input placeholder={"搜索"} onChange={({target}) => {
			console.log(target.value);
			searchMessages(target.value).then(convs => {
				SimpleModal({
					title: "搜索结果",
					message: <div dangerouslySetInnerHTML={highlightJsonLike(convs, 1e6)}/>
				})
			});
			target.value = "";
		}}/>
})