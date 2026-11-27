import {closeWindow, openWindow} from "/src/components/Windows.jsx";
import "./VFSManager.css";
import {Icon_branch, Icon_search} from "/src/components/Icons.jsx";
import {DiffHeader, HighlightBox, makeDiff, TextDiff} from "/src/components/TextDiff.jsx";
import {
	$asyncRenderer,
	$asyncState,
	$computed,
	$foreach,
	$state,
	$update,
	$vforeach,
	$watch,
	unconscious
} from "unconscious";
import {callFileSystemFunc, createFileSystem, getFileSystem} from "./Mounts.js";
import {
	VCS_BASE_BRANCH,
	VCS_BRANCH,
	VCS_BRANCHES,
	VCS_COMMIT,
	VCS_DELETE_BRANCH,
	VCS_DIFF,
	VCS_GET,
	VCS_GET_BASE,
	VCS_REVERT
} from "./VCS_shared.js";
import {readAsString} from "/common/chardet.js";
import {prettyError} from "/src/utils/utils.js";
import {parseGlobPattern} from "/common/fs-glob.js";
import {EVENT_BUS} from "/src/states.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {randomUUID, sleep, throttledPromiseLast} from "/common/pure-utils.js";
import {ImagePane} from "/src/components/ImagePane.jsx";
import {closeMenu, openMenu, showToast} from "/src/components/Layer.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {updateConversation} from "/src/database.js";
import {resetWorkspaceFileSystem} from "./files.js";


export const openVFSDialog = (conv) => {
	return openWindow({
		id: "vfs-"+conv.id,
		icon: <Icon_branch/>,
		title: `文件管理 (${conv.title || '无标题'}, #${conv.id})`,
		width: 1000,
		height: 600,
		element: (handle) => {
			const el = createVCSDialog(conv, );

			const off = EVENT_BUS.onoff(['convDel', conv.id], () => closeWindow(handle));
			const off2 = EVENT_BUS.onoff(['closeWindow', handle.id], () => {
				off();
				off2();
			});

			return el
		}
	});
};

function BranchMenu(branches, callVCS, selectedFileSystem, viewingOverlay) {
	const filterText = $state("");
	return <div className="dropdown">
		<div className="my-input" onClick.stop={() => {}}>
			<Icon_search/>
			<input placeholder="过滤或新建覆盖层..." autoComplete="off"
				   value={filterText}
				   onInput={e => {
					   filterText.value = e.target.value.toLowerCase();
				   }}
				   onKeyDown={e => {
					   const el = e.target;
					   if (e.key === "Enter" && !e.isComposing && !branches.includes(el.value)) {
						   filterText.value = "";

						   callVCS({mode: VCS_BRANCH, path: el.value}).then(res => {
							   el.parentElement.nextElementSibling.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
							   $update(selectedFileSystem);
						   })
					   }
				   }}
			/>
		</div>

		<ul onClick.delegate{"li"}={e => {
			const item = e.delegateTarget;
			callVCS({mode: VCS_BRANCH, path: item.firstChild.data}).then(res => {
				$update(selectedFileSystem);
			})
		}} onClick.capture.delegate{"button"}.stop={(e) => {
			const item = e.target.closest("li");
			openMenu(e, item.closest("ul"), [
				{label: `删除 ${JSON.stringify(item.firstChild.data)}？`},
				{
					el: <div className="row" style="justify-content:center">
						<button className="btn ghost" onClick={closeMenu}>留</button>
						<button className="btn danger" onClick={() => {
							callVCS({mode: VCS_DELETE_BRANCH, path: item.firstChild.data}).then(res => {
								$update(selectedFileSystem);
							});
							closeMenu();
						}}>删
						</button>
					</div>
				}
			]);
		}}>
			<li>{VCS_BASE_BRANCH}</li>
			{$vforeach($computed(() => {
				const arr = unconscious(branches);
				const filter = unconscious(filterText);
				return filter ? arr.filter((name) => name.toLowerCase().includes(filter)) : arr;
			}, null, true), item => <li
				className={(item === unconscious(viewingOverlay) ? 'selected' : '')}>
				{item}

				<button className="ri-delete-bin-line" title="删除"></button>
			</li>)}
		</ul>
	</div>;
}

function MountMenu(fileSystems, selectedFileSystem, convAndHandle) {
	const filterText = $state("");

	return <div className="dropdown">
		<div className="my-input" onClick.stop={() => {}}>
			<Icon_search/>
			<input placeholder="过滤或新建挂载点..." autoComplete="off"
				   value={filterText}
				   onInput={e => {
					   filterText.value = e.target.value.toLowerCase();
				   }}
				   onKeyDown={e => {
					   const el = e.target;
					   const name = el.value;
					   if (e.key === "Enter" && !e.isComposing && !fileSystems.includes(name)) {
						   const opt = {fs_label: name};
						   createFileSystem(opt).then(() => {
							   filterText.value = "";

							   const conv = unconscious(convAndHandle);
							   (conv.mnt ??= {}) [name] = opt;
							   $update(convAndHandle);

							   return updateConversation(conv);
						   })
					   }
				   }}
			/>
		</div>

		<ul onClick.delegate{"li"}={e => {
			const item = e.delegateTarget;
			selectedFileSystem.value = item.firstChild.data;
			item.parentElement.querySelector(".selected")?.classList.remove("selected");
			item.classList.add("selected");
		}} onClick.capture.delegate{"button"}.stop={(e) => {
		const item = e.target.closest("li");
		openMenu(e, item.closest("ul"), [
			{label: `删除 ${JSON.stringify(item.firstChild.data)}？`},
			{
				el: <div className="row" style="justify-content:center">
					<button className="btn ghost" onClick={closeMenu}>留</button>
					<button className="btn danger" onClick={() => {
						const conv = unconscious(convAndHandle);
						const name = item.firstChild.data;
						const id = name.slice(2, -1);
						if (id) {
							delete conv.mnt[id];
						} else {
							resetWorkspaceFileSystem(conv);
						}

						if (unconscious(selectedFileSystem) === name) {
							if (!id) $update(selectedFileSystem);
							else selectedFileSystem.value = fileSystems[0];
						}

						$update(convAndHandle);
						//updateConversation(conv);
						closeMenu();
					}}>删
					</button>
				</div>
			}
		]);
	}}>
		{$foreach($computed(() => {
			const arr = unconscious(fileSystems);
			const filter = unconscious(filterText);
			return filter ? arr.filter((name) => name.toLowerCase().includes(filter)) : arr;
		}, null, true), item => <li
			className={(item === unconscious(selectedFileSystem) ? 'selected' : '')}>
			{item}

			<button className={"ri-delete-bin-line"} title="删除"/>
		</li>)}
	</ul>
</div>;
}

const createVCSDialog = (conv) => {
	const mntUpdateHandle = $state(conv);
	const fileSystems = $computed(() => ['./', ...Object.keys(mntUpdateHandle.mnt ?? {}).map(name => '~/' + name + '/')]);
	const selectedFileSystem = $state(fileSystems[0]);
	const selectedOverlay = $state(VCS_BASE_BRANCH);
	const isReadonly = $computed(() => !!(conv.mnt?.[selectedFileSystem.slice(2, -1)] ?? conv).fs_readonly, null, true);

	let fileSystemInstance;

	const callVCS = async (opt) => {
		fileSystemInstance ??= (await getFileSystem(unconscious(selectedFileSystem), conv))[1];
		return callFileSystemFunc(fileSystemInstance, "vcs", opt);
	}

	const branches = $asyncState(async sfi => {
		fileSystemInstance = null;
		const [branch, branches] = await callVCS({mode: VCS_BRANCHES});
		selectedOverlay.value = branch ?? VCS_BASE_BRANCH;
		return branches;
	}, selectedFileSystem);

	const selections = $state(new Set);
	const cwd = $state("");

	const changes = $asyncState(throttledPromiseLast(async overlay => {
		/** @type {[string, string, number?]} */
		const deltas = await callVCS({mode: VCS_DIFF, path: '**'});

		const map = new NestedMap();
		for (let i = 0; i < deltas.length; i++) {
			map.set(deltas[i][0].split('/'), {
				mode: deltas[i][1],
				time: deltas[i][2],
			});
		}

		return map;
	}), selectedOverlay, new NestedMap());

	const branchMenu = BranchMenu(branches, callVCS, selectedFileSystem, selectedOverlay);
	branchMenu.querySelectorAll('[disposable]').forEach(e => e.removeAttribute('disposable'));

	const mountMenu = MountMenu(fileSystems, selectedFileSystem, mntUpdateHandle);

	const commitButton = $computed(() => {
		const targetOverlay = $state(VCS_BASE_BRANCH);
		return branches.error ? <pre className="fa-alert row">{branches.error === true ? '不支持Overlay' : prettyError(branches.error)}</pre> :
			<div className="row">
				<button className="btn primary" onClick={async ({target}) => {
					target.disabled = true;
					target.classList.add("spin-before");

					try {
						if (selections.size) {
							throw '部分提交尚未实现！';

							await Promise.all([...selections].map(f => callVCS({
								mode: VCS_COMMIT,
								path: f.path,
								target: unconscious(targetOverlay)
							})));
						} else {
							await callVCS({mode: VCS_COMMIT, target: unconscious(targetOverlay), backup: false});
						}
					} catch (e) {
						showToast('提交失败:\n'+prettyError(e), 'error');
					} finally {
						target.disabled = false;
						target.classList.remove("spin-before");
						refreshVCSChanges();
					}
				}} disabled={() => {
					const base = unconscious(selectedOverlay);
					return (base === VCS_BASE_BRANCH) | (unconscious(targetOverlay) === base) | (changes.size === 0);
				}}>
					提交{() => !unconscious(selections).size ? '全部': '所选'}
				</button>
				到
				<select onChange={({target}) => {
					targetOverlay.value = target.selectedOptions[0].value;
				}}>
					<option value={VCS_BASE_BRANCH}>{VCS_BASE_BRANCH}</option>
					{$foreach(branches, item => <option value={item}>{item}</option>)}
				</select>
			</div>
	}, [branches]);

	$watch(selectedOverlay, () => {
		const overlayId = unconscious(selectedOverlay);
		branchMenu.querySelectorAll("li").forEach(el => el.classList.toggle("selected", el.firstChild.data === overlayId));
	});

	const refreshVCSChanges = () => {
		$update(selectedOverlay);
		queueMicrotask(() => {
			changes.promise.then(() => $update(cwd));
		});
		return true;
	};

	/**
	 * @param {FileEntry} item
	 * @return {'m' | 'a' | 'd' | ''}
	 */
	const getVCSState = item => {
		const path = item.path;
		if (!path) return '';

		const parts = path.split('/');
		const state = changes.getChildren(parts);
		return state ? state.v?.mode || 'm' : '';
	}

	return {
		actions: <div className="vfs-title">
			<div className="row">
				挂载点
				<div className="pretty-select down">
					<button className="my-select" onClick={({target}) => {
						target.closest(".pretty-select").classList.toggle("open");
					}}>
						<Icon_branch/>
						<span>{selectedFileSystem}</span>
						<span className="-arrow ri-arrow-down-s-line"></span>
					</button>
					{mountMenu}
				</div>
			</div>
			{$computed(() => {
				return branches.error ? null :
					<div className="row">
						模型工作层
						<div className="pretty-select down">
							<button className="my-select" onClick={({target}) => {
								target.closest(".pretty-select").classList.toggle("open");
							}}>
								<Icon_branch/>
								<span>{selectedOverlay}</span>
								<span className="-arrow ri-arrow-down-s-line"></span>
							</button>
							{branchMenu}
						</div>
						<div className="-mods" title="修改的文件">{() => changes.size || ''}</div>
					</div>
			}, [branches])}
		</div>,
		element: <>
			<div className="vfs-toolbar">
				<label className="row">
					{() => unconscious(selectedFileSystem) === './' ? "全局只读" : "此挂载只读"}
					<input className="switch" type="checkbox" checked={isReadonly}
						   onChange={({target}) => {
							   const fs = conv.mnt[selectedFileSystem.slice(2, -1)] ?? conv;
							   if (target.checked) fs.fs_readonly = true;
							   else delete fs.fs_readonly;
						   }}/>
				</label>
				<span className="spacer"/>
				{commitButton}
			</div>

			{$asyncRenderer($asyncState(() => getFileSystem(unconscious(selectedFileSystem), conv).then((info) => {
				const cwd1 = info[0];
				const fs = info[1];

				cwd.value = cwd1;
				const handled = EVENT_BUS.post(['pvex'], fs, cwd);
				if (handled) {
					return handled.then(async ([s]) => {
						await changes.promise;

						const o = s._on((menu, items) => {
							if (items.length === 1) {
								const item = items[0];
								const vcsState = getVCSState(item);
								if (vcsState) {
									if (vcsState === 'd') menu.length = 0;
									if (item.type !== 'dir') {
										menu.splice(1, 0, {
											label: "对比差异",
											icon: "ri-git-pull-request-line",
											act: () => showDiff(callVCS, item.path)
										});
									}
									menu.push({
										label: "回滚更改",
										icon: "ri-reset-left-line",
										danger: true,
										act: () => callVCS({
											mode: VCS_REVERT,
											path: item.path
										}).then(res => $update(selectedOverlay))
									});
								}
							} else {
								if (items.every(getVCSState)) {
									menu.push({
										label: "回滚所有更改",
										icon: "ri-reset-left-line",
										danger: true,
										act: () => Promise.all(items.map(item => callVCS({
											mode: VCS_REVERT,
											path: item.path
										})))
											.then(res => $update(selectedOverlay))
									});
								}
							}

							return menu;
						}, (el, item) => {
							const vcsState = getVCSState(item);
							if (vcsState) el.classList.add('-'+vcsState);
							return el;
						}, (entries, path, pattern) => {
							if (changes.size) {
								return entries.then(items => {
									const matcher = new RegExp('^'+parseGlobPattern(path + '/' + (pattern || '*'), true)+'$');
									changes.forEach((value, keys) => {
										const p = keys.join('/');
										if (value.mode === 'd' && matcher.test(p)) {
											const type = changes.getChildren(keys)?.c ? 'dir' : 'file';
											if (pattern || type === 'dir') {
												items.push([
													path ? p.slice(path.length + 1) : p,
													type,
													0
												]);
											}
										}
									});

									return items;
								});
							}

							return entries;
						}, refreshVCSChanges);

						selections.value = o.selection;

						s.navigateTo(unconscious(cwd));
						return s.element;
					});
				}

				return <div className="error">本构建不包含预览插件</div>;
			}), selectedFileSystem),

			<div className="center"><div className="spinner"/></div>,
			err => <div className="center"><div className="fa-alert">{prettyError(err)}</div></div>
			)}
		</>};
};

/**
 * @param {function(Object): Promise<Blob>} callVCS
 * @param {string} selectedFile
 * @param {boolean} [newWindow]
 */
const showDiff = (callVCS, selectedFile, newWindow) => {
	const s = openWindow({
		width: 600,
		height: 600,
		id: "vcs-diff :"+(newWindow ? randomUUID() : ''),
		icon: <i className="ri-git-pull-request-line" />,
		element: (s) => createDiffWidget(s.call = $state(), s.file = $state(""))
	});
	s.call.value = callVCS;
	s.file.value = selectedFile;
}

const hash = async (blob) => {
	const hasher = new SHA256();

	const reader = blob.stream().getReader();
	while (true) {
		await sleep(0);
		const {done, value} = await reader.read();
		if (done) break;
		hasher.update(value);
	}

	return hasher.digest('hex');
};

/**
 *
 * @param {import("unconscious").Reactive<function(Object): Promise<Blob>>} callVCS
 * @param {import("unconscious").Reactive<string>} selectedFile
 * @return {JSX.Element}
 */
const createDiffWidget = (callVCS, selectedFile) => {
	const actions = $state();

	return {
		title: () => unconscious(selectedFile)+" 的差异",
		actions,
		element: $asyncRenderer($asyncState(async file => {
			if (!file) return;

			const fn = unconscious(callVCS);
			const [blobA, blobB] = await Promise.all([
				fn({mode: VCS_GET_BASE, path: file}),
				fn({mode: VCS_GET, path: file})
			]);

			if (/\.?(?:jpg|jpeg|jpe|jfif|png|apng|gif|webp|bmp|svg|ico|avif|heic|heif)$/i.test(file)) {
				actions.value = <div className="vcs-diff-title row"><span className="bin">图像</span></div>;

				if (blobA && blobB && await hash(blobA) === await hash(blobB)) {
					return <div className="center">文件完全相同</div>;
				}

				return <div className="images">
					{blobA && <ImagePane variant='l' overlay="原始" blob={blobA}/>}
					{blobB && <ImagePane variant='r' overlay="当前" blob={blobB}/>}
				</div>
			}

			try {
				const a = blobA ? await readAsString(blobA) : "";
				const b = blobB ? await readAsString(blobB) : "";

				const diff = makeDiff(a, b);
				actions.value = <div className="vcs-diff-title row"><DiffHeader diff={diff}/><span className="bin">文本</span></div>;
				return diff.length ? <TextDiff start={[1]} diff={diff}/> : <div className="center">文件完全相同</div>;
			} catch (err) {
				const a = !blobA ? '' : `[Blob ${blobA.size} bytes\nsha256=${await hash(blobA)}]`;
				const b = !blobB ? '' : `[Blob ${blobB.size} bytes\nsha256=${await hash(blobB)}]`;
				const diff = makeDiff(a, b);

				actions.value = <div className="vcs-diff-title"><span className="bin">二进制</span></div>;
				return diff.length ? <TextDiff start={[1]} diff={diff}/> : <div className="center">文件完全相同</div>;
			}
		}, selectedFile), () => {
			actions.value = "";
			return <div className="center"><div className="spinner" /></div>;
		}, (e) => {
			actions.value = <div className="vcs-diff-title row"><span className="error">发生错误。</span></div>
			return <HighlightBox code={prettyError(e)}/>;
		})
	};
};