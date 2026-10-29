import {currentCombinedConfig, setCombinedConfig} from "./presets.js";
import {selectedConversation} from "./states.js";

/**
 *
 * @type {JSX.Element[]}
 */
export const CUSTOM_CONTROLS = <>
	<button className="ri-lightbulb-flash-line chip ghost"
			style:display={() => currentCombinedConfig.forceThink == null ? "" : "none"}
			class:active={() => currentCombinedConfig.think}
			onClick={() => setCombinedConfig('think', !currentCombinedConfig.think)}>
		<div className="tooltip">深度思考：先思考后回答，解决复杂问题</div>
	</button>
	<button className="ri-robot-2-line chip"
			style:display={() => currentCombinedConfig.modalities?.includes("tool") ? "" : "none"}
			class:active={() => selectedConversation.activatedModules?.size}
	>
		<div className="tooltip">智能体：让AI使用工具</div>
	</button>
</>;