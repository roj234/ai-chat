import {DI_settings, onLoad} from "/src/hooks.js";
import {FS_SOURCE} from "./agent/index.js";
import {EVENT_BUS} from "/src/states.js";

onLoad(() => {
	const el = DI_settings.byId('aux');
	el.append(<a href="#" onClick.prevent={async() => {
		const fs = {
			readRaw: async ({path, stream, offset}) => {
				const r = await fetch(path);
				if (!offset && stream) return r;

				let blob = await r.blob();
				blob.toUrl = () => path;

				if (offset) blob = blob.slice(offset);
				return stream ? new Response(blob, { headers: { 'content-length': String(blob.size) } }) : blob;
			},
		};
		fs[FS_SOURCE] = {fs_type: "web",fs_readonly: true};

		EVENT_BUS.post(['viewFile'], "README_doc.md", null, fs);
	}}>文档</a>);
});