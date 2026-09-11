import {$asyncState, $computed, $foreach, $state, $update, unconscious} from "unconscious";
import {config, isMobile} from "/src/states.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {formatSize, prettyTime} from "unconscious/common/Utils.js";
import {copyButtonAnimation} from "/src/utils/utils.js";
import {requestBackend} from "/src/database/remoteDB.js";

const pageSize = 20;

const searchTerm = $state();
const currentPage = $state(1);
const total = $state();
const selectedItems = $state();
const totalPages = $computed(() => Math.ceil(unconscious(total)/pageSize));
let table;

const blobs = $asyncState(async currentPage => {
	const term = unconscious(searchTerm);
	const result = await requestBackend(`blobs?page=${currentPage}&limit=${pageSize}${term ? `&term=${encodeURIComponent(term)}` : ''}`);
	selectedItems.value = 0;
	total.value = result.total;
	return result.data;
}, currentPage);

const deleteItem = hash => {
	SimpleModal({
		title: `确定要删除吗？`,
		message: hash,
		onConfirm() {
			requestBackend(`blob/${hash}`, {method: 'DELETE'}).then(() => $update(currentPage));
		}
	})
};

const updateSelected = e => {
	selectedItems.value += e.target.checked ? 1 : -1;
}

const deleteSelected = () => {
	const checked = table.querySelectorAll('.row-check:checked');

	SimpleModal({
		title: `是否删除选中的 ${checked.length} 项？`,
		onConfirm() {
			const all = [];
			for (let chk of checked) {
				all.push(requestBackend(`blob/${chk.value}`, {method: 'DELETE'}));
			}
			scrollWin.scrollTop = 0;
			selectAllBtn.checked = false;
			Promise.all(all).finally(() => $update(currentPage));
		}
	});
};

const toggleAll = master => {
	const checked = master.checked;
	table.querySelectorAll('.row-check:not(.named)').forEach(input => {
		if (input.checked !== checked) {
			input.checked = checked;
			updateSelected({ target: input });
		}
	});
};

const showFull = url => {
	SimpleModal({
		title: "图像预览",
		message: <img src={url} />
	})
};

let scrollWin, selectAllBtn;

const container = <div className={"modal-overlay"}>
	<div className="modal" style={isMobile?"width:100vw":"max-width:70vw"}>
		<div className="header" style={"display:flex;gap:8px"}>
			<b>附件管理</b>
			<span className={"spacer"}></span>
			<button className="btn danger" disabled={() => !unconscious(selectedItems)} onClick={deleteSelected}>删除选中 ({selectedItems})</button>
			<button className="ri-close-line ghost" title={"关闭窗口"} onClick={() => container.remove(true)}></button>
		</div>
		<div style={"display:flex"}>
			<button className="ri-loop-right-line ghost" title={"刷新"} onClick={() => $update(currentPage)}></button>
			<input className={"text-input"} placeholder={"搜索哈希和名称"} onInput={(e) => {
				searchTerm.value = e.target.value;
				currentPage.value = 1;
				$update(currentPage);
			}}/>
		</div>

		<div className={"blob-manager"} style={"overflow:auto"} ref={scrollWin}>
			<table>
				<thead>
				<tr>
				<th width="30"><input type="checkbox" ref={selectAllBtn} title={"选择/反选不具名项(临时文件)"} onClick={({target}) => toggleAll(target)}/></th>
					<th className={"_pv"}>预览</th>
					<th>信息</th>
					<th>操作</th>
				</tr>
				</thead>
				<tbody ref={table}>
				{$foreach(blobs, item => {
					const isImg = item.type.startsWith('image/');
					const blobUrl = `${config.db_server}blob/${item.hash}`;

					return <tr>
						<td><input className={"row-check" + (item.name ? " named" : "")} type="checkbox" value={item.hash} onChange={updateSelected} /></td>
						<td className={"_pv"}>{isImg ? <img src={blobUrl} onClick={() => showFull(blobUrl)}/> : '-'}</td>
						<td className={"_info"}>
							<a style={"display:flex;gap:8px"} href={blobUrl} rel={"noopener noreferrer"} target={"_blank"} title={"下载"}>
								<i className={"ri-download-2-line"}></i>
								{item.name || '临时对象'}
							</a>
							<div>
								<span className={"hash"}>{item.hash.slice(0, 6)}...{item.hash.slice(-6)}<span
									className={"tooltip"}>{item.hash}</span></span>
								<button className="ri-file-copy-line ghost" title={"复制哈希"} onClick={({target}) => {
									copyButtonAnimation("![blob]("+item.hash+")", target)
								}}></button>
							</div>
							<div style={"color:var(--muted)"}>
								<span>
									<span className={"tooltip"}>
										MIME类型: {item.type}<br/>
										时间戳：{new Date(item.lastModified).toISOString()}
									</span>
									{formatSize(item.size)} | {prettyTime(item.lastModified)}
								</span>
							</div>
						</td>
						<td>
							<button className="ri-delete-bin-line btn danger-focus" title={"删除"} onClick={() => {
								deleteItem(item.hash);
							}}></button>
						</td>
					</tr>
				}, item => item.hash)}
				</tbody>
			</table>
		</div>
		<div className="pagination">
			<button className="ri-arrow-left-s-line btn ghost" title={"上一页"} disabled={() => unconscious(currentPage) === 1} onClick={() => currentPage.value -= 1}></button>
			<span>第 <input style={"width: 60px"} type={"number"} value={currentPage} min={1} max={totalPages} onChange={e => {
				currentPage.value = e.target.valueAsNumber;
			}} /> / {totalPages} 页  (共 {total} 条)</span>
			<button className="ri-arrow-right-s-line btn ghost" title={"下一页"} disabled={() => unconscious(currentPage) >= unconscious(totalPages)} onClick={() => currentPage.value += 1}></button>
		</div>
	</div>
</div>;

export const display = () => {
	document.body.append(container);
	$update(currentPage);
};