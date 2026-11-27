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

registerToolset("AskUser", "向用户提问", [AskUser], {default: true,});
registerToolset("GetTime", "读取当前时间", [GetTime], {default: true,});

// TODO: remove files depend
registerToolset(
	"InteractiveSimulation",
	"Interactive scenarios / tabletop roleplay: dice rolls, timers, and visual overlays. Use when the task requires user choices, random outcomes, structured state tracking, countdowns, or roleplay-style simulation.",
	[AskUser, RollDice, UpdateVariable, GetVariable, Wait, ConfigureOverlay, RunJS, GetTime],
	{ depend: ['Files'], usable: true }
);
