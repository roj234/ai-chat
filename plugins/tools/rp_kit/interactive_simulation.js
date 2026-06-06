import "./interactive_simulation.css";
import {ask_user} from "./ask_user.js";
import {dice} from "./dice.js";
import {storage} from "./storage.js";
import {timeout} from "./timeout.js";
import {dashboard} from "./dashboard.js";
import {registerTools} from "/src/skills.js";
import {interpreter} from "../interpreter.js";

registerTools(
	"interactive_simulation",
	"Support interactive scenarios, tabletop roleplay, game mechanics, dice rolls, persistent state, timers, and visual dashboards. Use when the task requires user choices, random outcomes, structured state tracking, countdowns, or roleplay-style simulation.",
	[ask_user, dice, storage, timeout, dashboard, interpreter],
	{systemPrompt: `<interactive-simulation>
Use \`manage_storage\` for persistent scenario state.
Use \`init_dashboard\` only for important state that should remain visible and auto-update from storage.
Use \`ask_user\` when the scenario needs a user choice or clarification.
Use \`set_timeout\` only for real-time countdowns.
Use \`roll_dice\` only for actual random outcomes.
Do not use these tools for ordinary explanations or non-interactive text responses.
</interactive-simulation>`}
);
