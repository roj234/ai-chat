import "./assistant-profile.css";
import {toolScriptRegistry, toolset} from "/src/toolset.js";
import {BlobImage, cloneNamed, deleteWithDrawback, prettyError} from "/src/utils/utils.js";
import {defaultSystemPrompt, GLOBAL_SETTINGS} from "/src/settings.js";
import {$asyncState, $state, $vforeach, appendChild, unconscious} from "unconscious";
import {onLoad} from "/src/hooks.js";
import {getMessages, kvListDel, kvListGet, kvListGetKeys, kvListSet} from "/src/database.js";
import {config, selectedConversation} from "/src/states.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {presets} from "/src/presets.js";
import {IMAGE_MIMES} from "/src/components/UserInputComposer.jsx";
import {formatSize} from "unconscious/common/Utils.js";
import {serializeMsgpack} from "/src/database/remoteDB.js";
import {showToast} from "/src/components/Toast.js";
import {compressImage} from "/common/imate.js";
import {importConversationData} from "/src/data-exchange.js";
import {inspect} from "@roj234/util-inspect";

const PROFILE_KVS_ID = 'assistant';
const profiles = $state([]);

const toolNameFilter = (value) => {
	value = value.trim();
	if (!value) throw '工具名称不能为空';
	if (!toolScriptRegistry[value]) {
		const matches = Object.keys(toolScriptRegistry).filter(item => item.toLowerCase().startsWith(value.toLowerCase())).slice(0, 5).join(' ');
		throw '工具 '+value+' 不存在'+(matches.length ? '\n建议: '+matches:'');
	}

	return [value];
};

const stringLengthFilter = (val) => {
	if (!val) throw '必填';
	if (val.length > 99) throw `文本太长了 (${val.length} > 99)`;
};

const editAssistant = (cloned, isCreate) => {
	const modal = SimpleModal({
		type: "filter",
		title: isCreate ? "创建助手" : <>{"编辑助手 "+cloned.name+" "}
			<button className="btn danger" onClick={(e) => {
				modal.remove();

				// 这代码挺好的，之后有需要可以复用一下
				const name = cloned.name;
				const idx = profiles.findIndex(s => s.name === name);
				if (idx < 0) return;

				const prev = profiles[idx-1];
				const item = profiles[idx];
				profiles.splice(idx, 1);

				deleteWithDrawback('助手'+name, () => kvListDel(PROFILE_KVS_ID, name), () => {
					if (idx === 0) profiles.unshift(cloned);
					else if (profiles[idx-1] === prev) profiles.splice(idx, 0, item);
					else profiles.push(cloned);
				}, e.detail === 0);
			}}>删除此助手</button>
		</>,
		message: <>
			当前共 {cloned.messages.length} 条消息，约占用 {$asyncState(() => serializeMsgpack(cloned).then(b => formatSize(b.length)))}
			<details>
				<summary>助手还会保存哪些内容</summary>
				工具配置，模型锁定，文件系统配置，环境变量配置，系统提示词配置等，
				以及当前对话的消息（不包含分支，只保存当前渲染的消息树）
				名称、简介、头像、系统提示以外的项目，不建议初学者修改。
			</details>
		</>,
		placeholder: {
			name: cloned.name,
			description: cloned.meta?.description,
			avatar: cloned.meta?.avatar,
			systemPrompt: cloned.overrides?.systemPrompt || defaultSystemPrompt,
			activatedModules: [...cloned.activatedModules || []],
			tools: [...cloned.tools || []],
			grantedTools: [...cloned.grantedTools || []],
			presets: typeof cloned.presets === 'string' ? [cloned.presets] : [...cloned.presets || []],
		},
		value: [
			{
				id: "name",
				type: "input",
				name: "名称 (slug)",
				required: true,
				placeholder: "不能重复 (重复将替换)",
				pattern: stringLengthFilter
			},
			{
				type: "input",
				id: "description",
				name: "一句话简介",
				placeholder: "留空使用系统提示做简介",
				pattern: stringLengthFilter
			},
			{
				type: "file",
				accept: IMAGE_MIMES,
				id: "avatar",
				name: "头像",
				placeholder: "留空使用名称第一个字做头像"
			},
			{
				type: "textbox",
				id: "systemPrompt",
				name: "系统提示词",
				required: true
			},
			{
				type: "list",
				id: "presets",
				name: "引用其他预设（系统提示词、模型等）",
				required: true,
				pattern(value) {
					value = value.trim();
					if (!value) throw '预设名称不能为空';

					if (!presets.find(t => t.name === value)) {
						const matches = presets.filter(item => item.name.toLowerCase().startsWith(value.toLowerCase())).slice(0, 5).map(s => s.name).join(' ');
						throw '预设 ' + value + ' 不存在' + (matches.length ? '\n建议: ' + matches : '');
					}

					return [value];
				}
			},
			{
				type: "list",
				name: "激活的工具集",
				title: "示例：移除 Files 后，可单独开关各个文件工具；禁用工具集会同时禁用其系统提示。",
				id: "activatedModules",
				required: true,
				pattern: (value) => {
					value = value.trim();
					if (!value) throw '工具集名称不能为空';

					if (!toolset[value]) {
						const matches = Object.keys(toolset).filter(item => item.toLowerCase().startsWith(value.toLowerCase())).slice(0, 5).join(' ');
						throw '工具 ' + value + ' 不存在' + (matches.length ? '\n建议: ' + matches : '');
					}

					return [value];
				}
			},
			{
				type: "list",
				name: "激活的工具",
				id: "tools",
				required: true,
				pattern: toolNameFilter
			},
			{
				type: "list",
				name: "授权的工具",
				id: "grantedTools",
				required: true,
				pattern: toolNameFilter
			},
			{
				type: "element",
				//id: "mnt",
				name: "文件系统",
				title: "还不支持在这里改。",
				element: <pre>{inspect(cloned.mnt)}</pre>
			},
		],
		async onConfirm(obj) {
			cloned.time = Date.now();
			(cloned.overrides ??= {}).systemPrompt = obj.systemPrompt;

			const keys = ['activatedModules', 'tools', 'grantedTools', 'presets'];
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const arr = obj[key];
				if (!arr.length) delete cloned[key];
				else {
					if (i < 3) {
						cloned[key] = new Set(arr);
					} else {
						cloned[key] = arr.length === 1 ? arr[0] : arr;
					}
				}
			}

			let avatar = obj.avatar;
			if (avatar && !avatar.hash) {
				const name = avatar.name||obj.name;
				avatar = await compressImage(avatar, {
					imageLongLimit: 128,
					imageSizeLimit: 0.064,
					imageAllowWebp: true
				});
				avatar = new File([avatar], (name)+"-助手头像", { type: avatar.type });
			}

			cloned.meta = {
				description: obj.description || obj.systemPrompt.slice(0, 100),
				avatar
			};

			return kvListSet(cloned, PROFILE_KVS_ID, obj.name).catch(e => {
				showToast("保存失败\n"+prettyError(e), 'error');
				return false;
			});
		}
	})
};

const createProfile = async () => {
	const conv = unconscious(selectedConversation);
	if (!conv) return;

	const fsKeys = [
		"fs_type",
		"fs_base",
		"fs_server",
		"fs_readonly",
		"fs_ACL",
		"fs_branch"
	];

	const cloned = cloneNamed(conv, [
		"activatedModules",
		"tools",
		"grantedTools",
		"sb_secureEnv",
		"presets",
		"overrides",
		...fsKeys
	]);

	if (conv.mnt) {
		cloned.mnt = Object.fromEntries(Object.entries(conv.mnt).map(([k, v]) => [k, cloneNamed(v, fsKeys)]));
	}

	const messages = await getMessages(conv);

	cloned.messages = messages.filter(s => s.id >= 0).map(s => {
		const {id,parent,foldGroup,folded,...rest} = s;
		return rest;
	});
	editAssistant(cloned, true);
}

/** 防止连点开出一堆空会话 */
const openingAssistant = $state(false);
const safeCreateAssistant = async (name) => {
	if (unconscious(openingAssistant)) return;
	openingAssistant.value = true;
	try {
		await createAssistant(name);
	} catch (e) {
		showToast("打开助手失败\n" + prettyError(e), 'error');
	} finally {
		openingAssistant.value = false;
	}
}

/**
 *
 * @returns {Promise<void>}
 */
export const createAssistant = async info => {
	const {messages, type, name, time, meta, ...conv} = await kvListGet(PROFILE_KVS_ID, info);
	conv.time = Date.now();
	if (config.temporaryChat) {
		conv.temporary = true;
		conv.id = "temporary-"+conv.time;
	}
	await importConversationData(conv, messages);
};


const assistantChip = (item) => {
	const name = item.name;
	const {avatar, description} = item.meta;

	return <button className="btn assistant-chip"
		title={description}
		onClick={() => safeCreateAssistant(name)}>
		<span className="-avatar">{avatar ? <BlobImage src={avatar}/> : name[0]}</span>
		<span className="-name">{name}</span>
	</button>;
};

onLoad((app) => {
	kvListGetKeys(PROFILE_KVS_ID, profiles);

	const logo = app.querySelector(".composer > .logo");
	const mod = logo.querySelector(".-model");

	appendChild(logo, <div className="row assistant-picker" class:empty={() => !profiles.length}>
		<div className="-label">{mod}<span className="-desc">或者，选择一个助手</span></div>
		<div className="-row">
			{$vforeach(profiles, assistantChip, item => JSON.stringify([item.name, item.meta, item.time]), {horizontal: true})}
		</div>
	</div>);
});

GLOBAL_SETTINGS.push({
	name: <>助手
		<div className="spacer"/>
		<button className="btn ghost" disabled={() => !unconscious(selectedConversation)} onClick={createProfile}>基于当前对话创建</button>
	</>,
	title: "助手是一组可选配置，可包含系统提示词、工具、文件系统定义和消息。你还可以设置头像和简介，便于区分和选择。",
	type: 'element',
	_tab: "prompt",
	element: <div className="assistant-profile scroll">
		{$vforeach(profiles, (item) => {
			const name = item.name;
			const {avatar, description} = item.meta;
			return <div className="-item">
				<div className="-avatar">{avatar ? <BlobImage src={avatar}/> : name[0]}</div>
				<div style="flex:1;overflow:hidden;cursor:pointer" onClick={() => createAssistant(name)} title="使用此助手">
					<div className="-name">{name}</div>
					<div className="-desc ellipsis">{description}</div>
				</div>
				<button className="ri-edit-2-line ghost" title="编辑助手" onClick={e => {
					kvListGet(PROFILE_KVS_ID, name).then(editAssistant);
				}}></button>
			</div>
		}, item => JSON.stringify([item.name, item.meta, item.time]))}
	</div>
})
