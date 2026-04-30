import {ContentPart, registerTools} from "/src/skills.js";
import {config} from "/src/states.js";
import {SETTINGS} from "/src/settings.js";

SETTINGS.push({
	id: "fs_endpoint",
	_tab: "tools",
	name: "[fs] 本地访问服务",
	title: "提供本地文件系统访问和执行命令功能",
	type: "input",
	pattern: /^(\/|https?:\/\/).+\/aichat\/v2$/,
	warning: "请输入合法的API端点",
	placeholder: "http://localhost:1/aichat/v2"
});

const HOST_OS = /\((.+?)\)/.exec(navigator.userAgent)?.[1] || "unknown";

function callAPI(func, type = 'fs') {
	return async (parameters) => {
		const baseUrl = (import.meta.env.DEV ? "/aichat/v2" : config.fs_agent_endpoint);
		if (!baseUrl) throw ("用户未配置");

		const response = await fetch(baseUrl+"/"+type+"/"+func, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(parameters)
		});

		if (!response.ok) throw ((await response.json()).detail);

		const content = response.headers.get("content-type");
		if (content.startsWith("image/")) return new ContentPart().image(await response.blob());
		if (content.startsWith("text/")) return await response.text();

		return await response.json();
	};
}

const list_path = {
	name: "list_directory",
	description: "列目录",
	script: callAPI("list"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			glob: {
				type: "string",
				description: "Glob pattern",
			}
		},
		required: ["path"]
	}
};

const read_file = {
	name: "read",
	description: "读取文件, 返回标签和内容",
	script: callAPI("read"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			begin: {
				type: "integer",
				description: "起始行号, inclusive",
			},
			end: {
				type: "integer",
				description: "结束行号, inclusive",
			},
			max_chars: {
				type: "integer",
				default: 10000,
				description: "最大读取字符数，结果将截断到整行。"
			}
		},
		required: ["path"]
	}
};
const read_image = {
	name: "read_image",
	description: "读取图像 (仅支持 jpg png bmp)",
	script: callAPI("read"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
const write_file = {
	name: "write",
	description: "覆盖写入文件",
	script: callAPI("write"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			lines: {
				type: "array",
				items: { type: "string" }
			},
		},
		required: ["path", "lines"]
	}
};
const replace_file = {
	name: "replace",
	description: "替换文件区域, 区间为 [start_tag, end_tag) 左闭右开\n如果起始和结束相同, 会在该位置插入新行\n标签格式为 `Line#HexTag` 必须严格参照 read, write 或 replace 工具的返回值",
	script: callAPI("replace"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			start_tag: {
				type: "string",
				description: "起始行号和标签, inclusive"
			},
			end_tag: {
				type: "string",
				description: "结束行号和标签, exclusive, 如果是文件末尾, 用 `#END`"
			},
			lines: {
				type: "array",
				items: { type: "string" }
			},
		},
		required: ["path", "start_tag", "end_tag", "lines"]
	}
};
const mkdir = {
	name: "mkdir",
	description: "创建目录",
	script: callAPI("mkdir"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
const copy_or_move = {
	name: "copy",
	description: "复制或移动文件(夹)",
	script: callAPI("copy"),

	parameters: {
		type: "object",
		properties: {
			src: { type: "string", },
			dest: { type: "string", },
			move: { type: "boolean", description: "移动(删除源文件)" }
		},
		required: ["src", "dest"]
	}
};
const delete_file = {
	name: "delete",
	description: "删除文件",
	script: callAPI("delete"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
const fstat = {
	name: "fstat",
	description: "读取元数据",
	script: callAPI("stat"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};

const spawn = {
	name: "spawn_process",
	description: "在沙盒中运行子进程(当前系统: "+HOST_OS+")",

	interactive: "secure",
	script: callAPI("spawn"),

	parameters: {
		type: "object",
		properties: {
			program: { type: "string", },
			arguments: {
				type: "array",
				items: {
					type: "string",
				}
			},
			directory: {
				type: "string",
				description: "工作目录",
			},
			timeout: {
				type: "integer",
				default: 10,
				description: "(in seconds)"
			}
		},
		required: ["program", "directory"]
	}
};

registerTools("fs", "操作持久化沙盒中的文件系统. 可用于持久化存储或多文件项目。", [read_file, read_image, write_file, replace_file, delete_file, mkdir, copy_or_move, list_path, fstat]);
registerTools("spawn_process", "在持久化沙盒中执行本机程序. 可用于构造环境或自动化任务(如 ffmpeg 转码)", [spawn]);