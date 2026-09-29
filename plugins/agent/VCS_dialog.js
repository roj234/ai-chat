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
	VCS_COMMIT,
	VCS_DELETE_BRANCH,
	VCS_DIFF,
	VCS_LIST_BRANCHES,
	VCS_QUERY,
	VCS_REVERT,
	VCS_SWITCH
} from "./VCS_shared.js";
import {ITEM_KEY} from "unconscious/common/VirtualList.js";
import {readAsString} from "/common/chardet.js";
import {prettyError, showImageZoomView} from "/src/utils/utils.js";
import {formatSize} from "unconscious/common/Utils.js";
import {compileGlobPattern} from "/common/fs-glob.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {EVENT_BUS} from "/src/states.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {sleep, throttledPromiseLast} from "../../common/pure-utils.js";

export const showVCSDialog = (conv) => {
	return openWindow({
		id: "vcs-"+conv.id,
		icon: <Icon_branch/>,
		title: `文件版本管理 (${conv.title || '#'+conv.id})`,
		width: 1000,
		height: 600,
		element: (handle) => {
			const upd = $state();
			const el = createVCSDialog(conv, upd);

			const off3 = EVENT_BUS.onoff(['loopEnd'], (conv_) => {
				if (conv_ === conv) $update(upd);
			});

			const off = EVENT_BUS.onoff(['conversationDeleted', conv.id], () => closeWindow(handle));
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

/**
 * 图像版本比对的单侧面板：显示文件在某一层（base / overlay）中的版本。
 * @param {string} variant 面板变体（base / overlay），用于着色
 * @param {Blob|null} blob 该层中的文件；null 表示此层中不存在
 */
const ImagePane = ({variant, overlay, blob}) => {
	const meta = $state(formatSize(blob.size));

	return <figure>
		<figcaption>
			<span className={"layer "+variant}>{overlay}</span>
			<span className="meta ellipsis">{meta}</span>
		</figcaption>
		<div>
			<img src={blob.toUrl()} alt={overlay+" 图像"}
				 onClick={() => showImageZoomView(blob.toUrl(), blob.name)}
				 onLoad={({target}) => {meta.value = `${target.naturalWidth}×${target.naturalHeight} · ${formatSize(blob.size)}`}}
				 onError={() => {meta.value = "无法解码";}}/>
		</div>
	</figure>
};

const createVCSDialog = (conv, state) => {
	const fileSystems = ['./', ...Object.keys(conv.mnt ?? {}).map(name => '~/'+name+'/')];
	const selectedFileSystem = $state("./");
	const viewingOverlay = $state(VCS_BASE_BRANCH);

	const callVCS = async (opt) => {
		const [path, fs] = await getFileSystem(unconscious(selectedFileSystem), conv);
		return callFileSystemFunc(fs, "vcs", opt, conv);
	}

	const branches = $asyncState(async mnt => {
		const [path, fs] = await getFileSystem(mnt, conv);

		callFileSystemFunc(fs, "vcs", { mode: VCS_QUERY }, conv).then(branchName => {
			viewingOverlay.value = branchName ?? VCS_BASE_BRANCH;
		});

		return callFileSystemFunc(fs, "vcs", {mode: VCS_LIST_BRANCHES, json: true}, conv);
	}, selectedFileSystem);

	const filterText = $state("");

	let glob = '';
	const changes = $asyncState(throttledPromiseLast(async mnt => {
		if (mnt === VCS_BASE_BRANCH) return [];
		const [path, fs] = await getFileSystem(mnt, conv);
		return callFileSystemFunc(fs, "vcs", {mode: VCS_DIFF, path: glob || '**', json: true}, conv);
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
					   onKeyPress={e => {
						   const el = e.target;
						   if (e.key === "Enter" && !branches.includes(el.value)) {
							   filterText.value = "";

							   callVCS({mode: VCS_SWITCH, path: el.value}).then(res => {
								   el.parentElement.nextElementSibling.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
								   $update(selectedFileSystem);
							   })
						   }
					   }}
				/>
		</div>

		<ul onClick.delegate{"li"}={e => {
			const item = e.delegateTarget;
			callVCS({mode: VCS_SWITCH, path: item.firstChild.data}).then(res => {
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
				<span>覆盖层:<span className="tooltip down">注意：切换覆盖层不只是GUI操作<br/>它同时改变了LLM操作的VFS</span></span>
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
				{$computed(() => {
					return branches.error ? <pre className="fa-alert row">{"错误\n" + prettyError(branches.error)}</pre> : null
				})}
			</div>
			<button className="btn primary" onClick={async ({target}) => {
				if (target.nodeName !== 'BUTTON') return;

				const pattern = compileGlobPattern(glob, "");
				if (pattern.segments.length > 1 || pattern.segments[0] !== undefined) {
					SimpleModal({
						title: "抱歉，暂不支持",
						message: "当前版本只支持路径前缀，而不是完整的Glob",
					});
					return
				}

				target.disabled = true;
				target.classList.add("spin-before");

				const names = changes.map(f => f[1]);
				try {
					await callVCS({mode: VCS_COMMIT, path: pattern.path});
				} finally {
					target.disabled = false;
					target.classList.remove("spin-before");
					$update(viewingOverlay);
				}
			}} disabled={() => {
				const base = unconscious(viewingOverlay);
				return (base === VCS_BASE_BRANCH) | (unconscious(targetOverlay) === base) | (changes.length === 0);
			}}/* style:display={() => unconscious(viewingOverlay) === VCS_BASE_BRANCH ? "none" : ""}*/>
				中{() => changes.length}项并入
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
						return <li className={type + (unconscious(selectedFile) === name ? " active" : "")}>
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

				const [blobA, blobB] = await callVCS({mode: VCS_QUERY, path: file});

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