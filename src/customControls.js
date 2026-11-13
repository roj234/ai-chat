import {currentCombinedConfig} from "./presets.js";
import {selectedConversation} from "./states.js";

/**
 *
 * @type {JSX.Element[]}
 */
export const CUSTOM_CONTROLS = <>
	<button className="ri-robot-2-line chip"
			style:display={() => currentCombinedConfig.modalities?.includes("tool") ? "" : "none"}
			class:active={() => selectedConversation.activatedModules?.size}
	>
		<div className="tooltip">工具</div>
	</button>
</>;