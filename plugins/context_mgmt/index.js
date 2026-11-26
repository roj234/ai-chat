//import "./passive-compaction.js";
import "./subjective-compaction.js";
import {COMMAND_REGISTRY} from "/src/commands.js";

COMMAND_REGISTRY["ctx"] = [
	() => import ("./MessageFold.jsx").then(mod => mod.showMessageFolder()),
	"打开上下文管理器"
]