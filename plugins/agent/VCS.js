import {registerToolset} from "/src/toolset.js";
import {EVENT_BUS} from "/src/states.js";
import {debugSymbol} from "unconscious";
import {getImmediateMessages, markMessageDirty, updateConversation} from "/src/database.js";
import {fileAccess} from "./Mounts.js";
import {VCS_BASE_BRANCH, VCS_BRANCH, VCS_COMMIT, VCS_DELETE_BRANCH, VCS_REVERT} from "./VCS_shared.js";
import {getRandomString, prettyError} from "/src/utils/utils.js";
import {showToast} from "/src/components/Layer.js";
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

registerToolset(vcsEnabledKey, `允许撤销模型修改
按轮次记录模型对工作区的修改，不记录手动编辑。

- 每轮创建一个 \`.0V\` 开头的隐藏文件夹
- 永不清理历史
- *目前*只支持根挂载和 \`local\` 文件系统
- 可以但不建议切分支，慢并且写磁盘`, [], {
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
});

EVENT_BUS.on('loopResp', conv => {
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
				branch: UNDO_BRANCH+vcsRevision,
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
				branch: REDO_BRANCH+vcsRevision,
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
