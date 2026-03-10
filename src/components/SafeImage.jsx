import {$state, unconscious} from "unconscious";

import "./SafeImage.css";
import {isLanAddress} from "../tools/isLanAddress.js";
import {loadingBlock} from "../utils.js";

const whiteList = new Set([
	"img.shields.io",
	"latex.codecogs.com",
	"quickchart.io",

	"images.pexels.com",
	"pixabay.com",
	"images.unsplash.com",

	"user-images.githubusercontent.com",
	"avatars.githubusercontent.com"
]);

export function SafeImage({src, title = ""}) {
	const state = $state("");
	let image;

	return <div>
		{() => {
			let url = unconscious(src);

			if (state.value === "error") {
				return <div className="my-box error">
					<span>❌ 图像加载失败</span>
					<button className={"btn ghost"} onClick={() => state.value = "loading"}>重试</button>
				</div>
			}

			if (!state.value) {
				let safe = url.startsWith("blob:") || url.startsWith("data:");

				if (!safe) {
					// normalize
					url = <a href={url} />.href;
					safe = isLanAddress(url);
					if (!safe) {
						let domain = 'unknown';
						try {
							domain = new URL(url).hostname;
						} catch {}

						if (!whiteList.has(domain)) {
							return <div className="my-box warning">
								<span className="icon" title={url}>⚠️ 来自 { domain } 的图像</span>
								<button className={"btn ghost"} onClick={() => state.value = "loading"}>加载</button>
							</div>
						}
					}
				}

				state.value = "loading";
			}

			if (state.value === "loading") {
				image = <img
					referrerPolicy="no-referrer"
					src={url} title={title}
					onLoad={() => state.value = "loaded"}
					onError={() => state.value = "error"}
				/>

				return loadingBlock("图像加载中……");
			}

			return image;
		}}
	</div>;
}