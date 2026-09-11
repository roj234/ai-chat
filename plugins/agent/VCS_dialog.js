import {closeWindow, openWindow} from "/src/components/Windows.jsx";
import "./VCS_dialog.css";
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
import {callFileSystemFunc, getFileSystem} from "./Mounts.js";
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
import {ITEM_KEY} from "unconscious/common/VirtualList.js";
import {readAsString} from "/common/chardet.js";
import {prettyError} from "/src/utils/utils.js";
import {compileGlobPattern} from "/common/fs-glob.js";
import {EVENT_BUS} from "/src/states.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {sleep, throttledPromiseLast} from "/common/pure-utils.js";
import {ImagePane} from "./ImagePane.jsx";

export const showVCSDialog = (conv) => {
	return openWindow({
		id: "vcs-"+conv.id,
		icon: <Icon_branch/>,
		title: `文件系统管理 (${conv.title || '#'+conv.id})`,
		width: 1000,
		height: 600,
		element: (handle) => {
			const upd = $state();
			const el = createVCSDialog(conv, upd);

			const off3 = EVENT_BUS.onoff(['loopEnd'], (conv_) => {
				if (conv_ === conv) $update(upd);
			});

			const off = EVENT_BUS.onoff(['convDel', conv.id], () => closeWindow(handle));
			const off2 = EVENT_BUS.onoff(['closeWindow', handle.id], () => {
				off();
				off2();
				off3();
			});

			return el;
		}
	});
};

const DiffPane = ({filename, left, right, bin}) => {
	const diff = makeDiff(left, right);
	return <section className="vcs-diff-pane">
		<div className="row">
			<span>{filename}</span>
			<span className="spacer"/>
			{bin ? <span className="bin">二进制</span> : <DiffHeader diff={diff}/>}
		</div>
		<TextDiff start={[1]} diff={diff} />
	</section>
};

const createVCSDialog = (conv, state) => {
	const fileSystems = ['./', ...Object.keys(conv.mnt ?? {}).map(name => '~/'+name+'/')];
	const selectedFileSystem = $state(fileSystems[0]);
	const viewingOverlay = $state(VCS_BASE_BRANCH);
	const isReadonly = $computed(() => !!(conv.mnt[selectedFileSystem.slice(2, -1)] ?? conv).fs_readonly, null, true);

	const callVCS = async (opt) => {
		const [path, fs] = await getFileSystem(unconscious(selectedFileSystem), conv);
		return callFileSystemFunc(fs, "vcs", opt, conv);
	}

	const branches = $asyncState(async mnt => {
		const [path, fs] = await getFileSystem(mnt, conv);

		const [branch, branches] = await callFileSystemFunc(fs, "vcs", {mode: VCS_BRANCHES}, conv);
		viewingOverlay.value = branch ?? VCS_BASE_BRANCH;
		return branches;
	}, selectedFileSystem);

	const filterText = $state("");

	let glob = '';
	const changes = $asyncState(throttledPromiseLast(async mnt => {
		if (mnt === VCS_BASE_BRANCH) return [];
		const [path, fs] = await getFileSystem(mnt, conv);
		return callFileSystemFunc(fs, "vcs", {mode: VCS_DIFF, path: glob || '**'}, conv);
	}), viewingOverlay, []);

	const selectedFile = $state("");

	$watch(state, () => {
		$update(selectedFileSystem);
		$update(viewingOverlay);
	})

	const BranchMenu = () => <div className="dropdown">
		<div className="fa-search" onClick.stop={() => {}}>
				<Icon_search />
				<input className="text-input" placeholder="过滤或新建覆盖层..." autoComplete="off"
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
		}} onClick.capture.delegate{"i"}.stop={({target}) => {
			if (target.classList.toggle("clicked")) {
				setTimeout(() => {
					target.classList.remove("clicked");
				}, 2000);
			} else {
				const item = target.closest("li");
				callVCS({mode: VCS_DELETE_BRANCH, path: item.firstChild.data}).then(res => {
					$update(selectedFileSystem);
				});
			}
		}}>
			<li>{VCS_BASE_BRANCH}</li>
			{$vforeach($computed(() => {
				const arr = unconscious(branches);
				const filter = unconscious(filterText);
				return filter ? arr.filter((name) => name.toLowerCase().includes(filter)) : arr;
			}, null, true), item => <li
				className={(item === unconscious(viewingOverlay) ? 'selected' : '')}>
				{item}

				<i className={"ri-delete-bin-line"} title={"删除"}></i>
			</li>)}
		</ul>
	</div>;

	const branchMenu = BranchMenu();
	branchMenu.querySelectorAll('[disposable]').forEach(e => e.removeAttribute('disposable'));

	$watch(viewingOverlay, () => {
		const overlayId = unconscious(viewingOverlay);
		branchMenu.querySelectorAll("li").forEach(el => el.classList.toggle("selected", el.firstChild.data === overlayId));
	})

	const targetOverlay = $state(VCS_BASE_BRANCH);

	return <>
		<div className="vcs-header">
			<div className="row">
				文件系统:
				<select className="target-select" value={selectedFileSystem} onChange={e => {
					selectedFileSystem.value = e.target.value;
				}}>
					{$foreach(fileSystems, item => <option value={item}>{item}</option>)}
				</select>
				<div className="col" style="gap:4px">
					<label className="row">只读:<input className="switch" type="checkbox" checked={isReadonly} onChange={({target}) => {
						const fs = conv.mnt[selectedFileSystem.slice(2, -1)] ?? conv;
						if (target.checked) fs.fs_readonly = true;
						else delete fs.fs_readonly;
					}}/></label>
					{$computed(() => {
						return branches.error ? <pre className="fa-alert row">{prettyError(branches.error)}</pre> :
							<div className="row">
								<span>活跃覆盖层:<span className="tooltip down">注意：切换将改变LLM操作的VFS</span></span>
								<div className="pretty-select down">
									<button className="input" onClick={({target}) => {
										target.closest(".pretty-select").classList.toggle("open");
									}}>
										<Icon_branch/>
										<span>{viewingOverlay}</span>
										<span className={"arrow-icon ri-arrow-down-s-line"}></span>
									</button>
									{branchMenu}
								</div>
							</div>
					})}
				</div>
			</div>
			<button className="btn primary" onClick={async ({target}) => {
				if (target.nodeName !== 'BUTTON') return;

				target.disabled = true;
				target.classList.add("spin-before");

				const pattern = compileGlobPattern(glob, "");

				try {
					if (pattern.segments.length > 1 || pattern.segments[0] !== undefined) {
						//const queue = createAsyncQueue(64);
						await Promise.all(changes.map(f => callVCS({mode: VCS_COMMIT, path: f[1]})));
					} else {
						await callVCS({mode: VCS_COMMIT, path: pattern.path});
					}
				} finally {
					target.disabled = false;
					target.classList.remove("spin-before");
					$update(viewingOverlay);
				}
			}} disabled={() => {
				const base = unconscious(viewingOverlay);
				return (base === VCS_BASE_BRANCH) | (unconscious(targetOverlay) === base) | (changes.length === 0);
			}}/* style:display={() => unconscious(viewingOverlay) === VCS_BASE_BRANCH ? "none" : ""}*/>
				并入{() => changes.length}项到
				<select onChange={({target}) => {
					targetOverlay.value = target.selectedOptions[0].value;
				}}>
					<option value={VCS_BASE_BRANCH}>{VCS_BASE_BRANCH}</option>
					{$foreach(branches, item => <option value={item}>{item}</option>)}
				</select>
			</button>
		</div>

		<div className="vcs-body">
			<section className="vcs-file-pane">
				<div className="fa-search">
					<Icon_search/>
					<input type="text" className="text-input" value={glob} onInput={e => {
						glob = e.target.value;
						$update(viewingOverlay);
					}} placeholder="用 Glob 语法搜索"/>
				</div>
				<ul onClick.delegate{"li"}={e => {
					const item = e.delegateTarget;
					selectedFile.value = item[ITEM_KEY][1];
					item.parentElement.querySelectorAll(".active").forEach(el => el.classList.remove("active"));
					item.classList.add("active");
				}}>
					{$vforeach(changes, (n) => {
						const [type, name, time] = n;
						return <li className={type + (unconscious(selectedFile) === name ? " active" : "")} tabIndex={0}>
							{name}
							<button className="ri-reset-left-line btn" title="回滚更改" onClick.stop={({target}) => {
								if (target.classList.toggle("error")) {
									setTimeout(() => {
										target.classList.remove("error");
									}, 2000);
								} else {
									callVCS({mode: VCS_REVERT, path: name}).then(res => {
										$update(viewingOverlay);
									})
								}
							}}/>
						</li>
					})}
				</ul>
			</section>

			{$asyncRenderer($asyncState(async file => {
				if (!file) return;

				const [blobA, blobB] = await Promise.all([
					callVCS({mode: VCS_GET_BASE, path: file}),
					callVCS({mode: VCS_GET, path: file})
				]);

				if (/\.(jpg|bmp|jpeg|png|gif|webp)$/i.test(file)) {
					return <section className="vcs-diff-pane">
						<div className="row">
							<span className="ellipsis">{file}</span>
							<span className="spacer"/>
							<span className="bin-tag">图像</span>
						</div>
						<div className="images">
							{blobA && <ImagePane variant='l' overlay="原始" blob={blobA}/>}
							{blobB && <ImagePane variant='r' overlay="当前" blob={blobB}/>}
						</div>
					</section>
				}

				try {
					const a = blobA ? await readAsString(blobA) : "";
					const b = blobB ? await readAsString(blobB) : "";
					return <DiffPane filename={file} left={a} right={b}/>
				} catch (err) {
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

					return <DiffPane
						filename={file} bin={true}
						left={!blobA ? '' : `[Blob ${blobA.size} bytes\nsha256=${await hash(blobA)}]`}
						right={!blobB ? '' : `[Blob ${blobB.size} bytes\nsha256=${await hash(blobB)}]`}
					/>
				}
			}, selectedFile), () => <section className="vcs-diff-pane">
				<div className="row spin-before">{unconscious(selectedFile)}</div>
			</section>, (e) => <section className="vcs-diff-pane">
				<div className="row">{unconscious(selectedFile)}<span className="error">发生错误。</span></div>
				<HighlightBox code={prettyError(e)} />
			</section>)}
		</div>
	</>;
};