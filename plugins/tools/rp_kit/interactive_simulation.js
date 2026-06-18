import "./interactive_simulation.css";
import {AskUser} from "./AskUser.js";
import {RollDice} from "./RollDice.js";
import {GetVariable, UpdateVariable} from "./Variables.js";
import {SetTimeout} from "./SetTimeout.js";
import {ConfigureOverlay} from "./Overlay.js";
import {registerTools} from "/src/skills.js";
import {CodeRunner} from "../interpreter.js";

registerTools(
	"InteractiveSimulation",
	"Interactive scenarios / tabletop roleplay: dice rolls, timers, and visual overlays. Use when the task requires user choices, random outcomes, structured state tracking, countdowns, or roleplay-style simulation.",
	[AskUser, RollDice, UpdateVariable, GetVariable, SetTimeout, ConfigureOverlay, CodeRunner],
	{systemPrompt: `<interactive-simulation>
Use \`UpdateVariable\` and \`GetVariable\` for persistent scenario state.
Use \`ConfigureOverlay\` only for important state that should remain visible and auto-update from storage.
Use \`AskUser\` when the scenario needs a user choice or clarification.
Use \`SetTimeout\` only for real-time countdowns.
Use \`RollDice\` only for actual random outcomes.
Do not use these tools for ordinary explanations or non-interactive text responses.
</interactive-simulation>`}
);
