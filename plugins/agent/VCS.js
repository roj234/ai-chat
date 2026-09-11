import {registerToolset} from "/src/toolset.js";
import {EVENT_BUS, selectedConversation} from "/src/states.js";
import {debugSymbol, unconscious} from "unconscious";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {showVCSDialog} from "./VCS_dialog.js";
import {getImmediateMessages, markMessageDirty, updateConversation} from "/src/database.js";
import {fileAccess} from "./Mounts.js";
import {VCS_BASE_BRANCH, VCS_BRANCH, VCS_COMMIT, VCS_DELETE_BRANCH, VCS_REVERT} from "./VCS_shared.js";
import {getRandomString, prettyError} from "../../src/utils/utils.js";
import {showToast} from "../../src/components/Toast.js";
import {formatDate} from "unconscious/common/Utils.js";

//endregion

export const vcsAvailableKey = debugSymbol("VCSAvailable");
export const vcsEnabledKey = 'Files/VCS';
const callVCS = fileAccess("vcs");

const R = {};

const STAGING_BRANCH = "B";
const UNDO_BRANCH = "R";
const REDO_BRANCH = "S";

const makeRevision = () => formatDate("ymd_his_")+getRandomString(3);

registerToolset(
	vcsEnabledKey,
	`自动版本控制
> 允许撤回模型对工作区的修改.

- 每轮对话创建一个 \`.0V\` 开头的文件夹
- 不会主动清理旧数据
- 当前版本只支持主工作区和WebFS文件系统
- 不建议切分支，很慢，而且写磁盘
- 尚未支持跟踪手动修改

也可用 /vcs 命令手动管理`,
	[],
	{
		hidden: 'manual',
		depend: ['Files'],
		onActivated(conv) {
			const activeBranch = STAGING_BRANCH+makeRevision();
			conv.vcsBranch = activeBranch;
			return callVCS({
				mode: VCS_BRANCH,
				path: activeBranch,
			}, R, conv);
		},
		onDeactivated(conv) {
			return Promise.all([
				callVCS({
					mode: VCS_COMMIT,
				}, R, conv),
				callVCS({
					mode: VCS_BRANCH,
					path: VCS_BASE_BRANCH,
				}, R, conv),
			]).then(() => {
				const activeBranch = conv.vcsBranch;
				delete conv.vcsBranch;
				return callVCS({
					mode: VCS_DELETE_BRANCH,
					path: activeBranch
				}, R, conv);
			});
		}
	}
);

EVENT_BUS.on('loopEnd', conv => {
	if (!conv.activatedModules?.has(vcsEnabledKey) || conv.meta?.owner) return;

	const messages = getImmediateMessages(conv);
	const last = messages.at(-1);

	if (last.role === 'assistant' && last.finish_reason === 'stop' && null == last.vcsRevision) {
		let vcsRevision = makeRevision();
		return callVCS({
			mode: VCS_COMMIT,
			backup: UNDO_BRANCH+vcsRevision,
		}, R, conv).then(s => {
			markMessageDirty(last);
			if (s === true) {
				last.vcsRevision = vcsRevision;
				return updateConversation(conv, messages);
			} else {
				last.vcsRevision = "";
				return callVCS({
					mode: VCS_DELETE_BRANCH,
					path: UNDO_BRANCH+vcsRevision
				}, R, conv);
			}
		});
	}
});

const undo = async (conv, path, messages, first, willRestore) => {
	if (!conv.activatedModules?.has(vcsEnabledKey) || conv.meta?.owner) return;

	const last = messages.at(-1);
	if (willRestore) {
		const currentBranch = conv.vcsBranch;

		await callVCS({
			mode: VCS_DELETE_BRANCH,
			path: currentBranch,
			emptyOnly: true
		}, R, conv).then(() => {
			markMessageDirty(last);
			last.vcsActiveBranch = currentBranch;
		}, () => {});
	} else {
		await callVCS({ mode: VCS_REVERT, }, R, conv);
	}

	for (let i = messages.length - 1; i >= first; i--) {
		const {vcsRevision} = messages[i];
		if (vcsRevision) {
			await callVCS({
				mode: VCS_COMMIT,
				path: UNDO_BRANCH+vcsRevision,
				backup: willRestore ? REDO_BRANCH+vcsRevision : null,
			}, R, conv).then(s => {
				if (s === true) {
					return callVCS({
						mode: VCS_DELETE_BRANCH,
						path: UNDO_BRANCH+vcsRevision
					}, R, conv);
				}
			}).catch(e => {
				showToast(prettyError(e), 'error');
			});
		}
	}
};

EVENT_BUS.on('undo', undo);

EVENT_BUS.on('switchBranch', async (conv, path, oldMessages, newMessages, first) => {
	if (!conv.activatedModules?.has(vcsEnabledKey) || conv.meta?.owner) return;

	const dialog = showToast("正在同步文件系统状态\n请勿进行操作或关闭页面\n否则可能导致数据损坏", '', -1);

	await undo(conv, path, oldMessages, first, true);

	for (let i = first; i < newMessages.length; i++) {
		const {vcsRevision} = newMessages[i];
		if (vcsRevision) {
			await callVCS({
				mode: VCS_COMMIT,
				path: REDO_BRANCH+vcsRevision,
				backup: UNDO_BRANCH+vcsRevision,
			}, R, conv).then(s => {
				if (s === true) {
					return callVCS({
						mode: VCS_DELETE_BRANCH,
						path: REDO_BRANCH+vcsRevision
					}, R, conv);
				}
			}).catch(e => {
				showToast(prettyError(e), 'error');
			});
		}
	}

	const last = newMessages.at(-1);
	const newRevision = last.vcsActiveBranch ?? STAGING_BRANCH+makeRevision();

	await callVCS({
		mode: VCS_BRANCH,
		path: conv.vcsBranch = newRevision,
	}, R, conv);

	if (last.vcsActiveBranch) {
		delete last.vcsActiveBranch;
		markMessageDirty(last);
	}

	dialog();
});


COMMAND_REGISTRY['vcs'] = [
	() => {
		showVCSDialog(unconscious(selectedConversation));
	},
	"打开文件管理窗口",
];