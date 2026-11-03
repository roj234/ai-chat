import "./interactive_simulation.css";
import {AskUser} from "./AskUser.js";
import {RollDice} from "./RollDice.js";
import {GetVariable, UpdateVariable} from "./Variables.js";
import {Wait} from "./Wait.js";
import {ConfigureOverlay} from "./Overlay.js";
import {registerToolset} from "/src/toolset.js";
import {RunJS} from "../agent/index.js";

/** @type {AiChat.FunctionTool} */
export const GetTime = {
	name: "GetTime",
	description: "Read current date, time and timezone",
	title: () => "查看时间",
	script: () => new Date().toString()
};

registerToolset("AskUser", "让AI问问题.", [AskUser], {
	default: true,
	hidden: "manual"
});

registerToolset("GetTime", "让AI主动读时间", [GetTime], {
	default: true,
	hidden: "manual"
});

registerToolset(
	"InteractiveSimulation",
	"Interactive scenarios / tabletop roleplay: dice rolls, timers, and visual overlays. Use when the task requires user choices, random outcomes, structured state tracking, countdowns, or roleplay-style simulation.",
	[AskUser, RollDice, UpdateVariable, GetVariable, Wait, ConfigureOverlay, RunJS, GetTime],
	{
		depend: ['Files'],
		//systemPrompt: ''
	}
);
