import {getToolParameters, registerTools, updateConversationState, watchConversationState} from "/src/skills.js";
import {onConversationLoaded} from "/src/states.js";
import {$foreach, $state} from "unconscious";
import "./task_list.css";

/**
 * @type {AiChat.FunctionTool<*>}
 */
const TaskCreate = {
	name: 'TaskCreate',
	description: 'Create a structured task list for your current session, and obtain integer id for further `TaskUpdate` calls. This helps track progress, organize complex tasks, and demonstrate thoroughness.',
	parameters: {
		type: 'object',
		properties: {
			title: { type: 'string', description: "A brief title for the task" },
			description: { type: 'string' },
			status: {
				type: 'string',
				enum: ['pending', 'in_progress'],
			},
		},
		required: ['title', 'description', 'status'],
	},
	script(par, resp, conv) {
		const tasks = conv.tasks || (conv.tasks = []);
		const nextTaskId = tasks.push({...par});
		resp.id = nextTaskId;
		updateConversationState(conv, "TaskList:tasks");
		return "Task created, id="+nextTaskId;
	},
	title(req, ctx = {}) {
		const par = getToolParameters(ctx, req);
		return "创建任务 ["+par.title+"]";
	},
	undo(ctx, conv, req) {
		const par = getToolParameters(ctx, req);
		const idx = conv.tasks.findIndex(item => item.title === par.title);
		if (idx >= 0) {
			conv.tasks.splice(idx, 1);
			updateConversationState(conv, "TaskList:tasks");
		}
	}
};

const taskUpdate_title = {
	'pending': '暂停',
	'in_progress': '开始',
	'completed': '完成',
	'cancelled': '取消'
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const TaskUpdate = {
	name: 'TaskUpdate',
	description: 'Update a task in the task list.',
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'integer',
			},
			title: {
				type: 'string',
				description: "New title for the task",
			},
			description: {
				type: 'string',
				description: "New description for the task",
			},
			status: {
				enum: ['pending', 'in_progress', 'completed', 'cancelled'],
			},
		},
		required: ['id'],
	},
	script({id, ...par}, resp, conv) {
		const tasks = conv.tasks || (conv.tasks = []);
		const task = tasks[id-1];
		if (!task) throw "Task #"+id+" not found";

		Object.assign(task, par);
		updateConversationState(conv, "TaskList:tasks");
		return "Task #"+id+" updated";
	},
	title(req, resp = {}) {
		const {id, status} = getToolParameters(resp, req);
		const title = taskUpdate_title[status] || "更新";
		return title+"任务 #"+id;
	}
};

let taskDiv;

export const registerTaskList = () => {
	registerTools(
		"TaskList",
		"Create and manage structured task list for your current session. This helps track progress, organize complex tasks, and demonstrate thoroughness.",
		[TaskCreate, TaskUpdate]
	);

	onConversationLoaded((conv) => {
		let done_r = $state(),
			success_r = $state(),
			failed_r = $state(),
			total_r = $state(),
			tasks_r = $state();

		watchConversationState(conv, "TaskList:tasks", () => {
			const tasks = conv.tasks;
			if (!tasks?.length) {
				if (taskDiv) {
					taskDiv.remove();
					taskDiv = null;
				}
			} else {
				let done = 0, success = 0, failed = 0, total = tasks.length;
				tasks.forEach((task) => {
					switch (task.status) {
						case 'failed':
							failed++;
							done++;
							break;
						case 'completed':
							success++;
							done++;
							break;
					}
				});
				done_r.value = done;
				success_r.value = success;
				failed_r.value = failed;
				total_r.value = total;
				tasks_r.value = tasks.toReversed();

				if (taskDiv) return;
				taskDiv = (
					<div className="rp-overlay TaskListPanel">
						<div className="header">
							<strong className="title">任务</strong>
							<div className="progressBar">
								<div className="progressFill"
									 style:reactive={{width: () => `${(done_r / total_r) * 100}%`}}/>
							</div>
							<span className="progressText">{done_r}/{total_r}</span>
							<button className="collapse" onClick={() => {
								taskDiv.value.classList.toggle("collapsed");
							}}>▼
							</button>
						</div>
						<div className="body">
							{$foreach(tasks_r, (task, i) => (
								<div className="TaskItem" data-status={task.status}>
									<div className="status" data-status={task.status}/>
									<div className="content">
										<div className="title ellipsis">{tasks_r.length - i}. {task.title}</div>
										{task.description && (
											<div className="desc">{task.description}</div>
										)}
									</div>
								</div>
							), JSON.stringify)}
						</div>
						<div className="footer">
							<span>成功 {success_r}</span>
							<span>失败 {failed_r}</span>
						</div>
					</div>
				);
				document.body.append(taskDiv);
			}
		});
	});
}
