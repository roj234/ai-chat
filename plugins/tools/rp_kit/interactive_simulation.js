import "./interactive_simulation.css";
import {AskUser} from "./AskUser.js";
import {RollDice} from "./RollDice.js";
import {GetVariable, UpdateVariable} from "./Variables.js";
import {SetTimeout} from "./SetTimeout.js";
import {ConfigureOverlay} from "./Overlay.js";
import {registerToolset} from "/src/toolset.js";
import {RunJS} from "../run_js.js";

/** @type {AiChat.FunctionTool} */
export const GetTime = {
	name: "GetTime",
	description: "Read current date, time and timezone",
	script: () => new Date().toString()
};

registerToolset(
	"InteractiveSimulation",
	"Interactive scenarios / tabletop roleplay: dice rolls, timers, and visual overlays. Use when the task requires user choices, random outcomes, structured state tracking, countdowns, or roleplay-style simulation.",
	[AskUser, RollDice, UpdateVariable, GetVariable, SetTimeout, ConfigureOverlay, RunJS, GetTime],
	{
		depend: ['Files'],
		//systemPrompt: ''
	}
);
