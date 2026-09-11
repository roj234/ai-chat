import {$asyncState, $computed, $foreach, $state, $update, unconscious} from "unconscious";
import {config} from "/src/states.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {formatSize, prettyTime} from "unconscious/common/Utils.js";
import {copyButtonAnimation, showImageZoomView} from "/src/utils/utils.js";
import {requestBackend, u_deleteBlob} from "/src/database/remoteDB.js";
import {openWindow} from "../../src/components/Windows.jsx";
import {Icon_search} from "../../src/components/Icons.jsx";

const pageSize = $state(20);

const searchTerm = $state();
const currentPage = $state(1);
const total = $state();
const selectedItems = $state();
const totalPages = $computed(() => Math.ceil(unconscious(total)/unconscious(pageSize)));
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
			u_deleteBlob(hash).then(() => $update(currentPage));
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
				all.push(u_deleteBlob(chk.value));
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

let scrollWin, selectAllBtn;

const container = <>
	<div className="fa-search">
		<Icon_search />
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
					<td className={"_pv"}>{isImg ? <img src={blobUrl} loading="lazy" onClick={() => showImageZoomView(blobUrl, item.name || item.hash)}/> : '-'}</td>
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
		}} /> / {totalPages} 页  (每页 <input type={"number"} value={pageSize} min={10} max={100} step={10} onChange={e => {
			pageSize.value = e.target.valueAsNumber;
			currentPage.value = 1;
			$update(currentPage);
		}} /> 条，共 {total} 条)</span>
		<button className="ri-arrow-right-s-line btn ghost" title={"下一页"} disabled={() => unconscious(currentPage) >= unconscious(totalPages)} onClick={() => currentPage.value += 1}></button>
	</div>
</>;

export const display = () => {
	openWindow({
		id: "blobManager",
		icon: <i className="ri-database-2-line" />,
		title: "附件管理器",
		element: container,
		actions: <>
			<button className="ri-loop-right-line ghost" title={"刷新"} onClick={() => $update(currentPage)}></button>
			<button className="btn danger" disabled={() => !unconscious(selectedItems)} onClick={deleteSelected}>删除选中 ({selectedItems})</button>
		</>,
		reuse: true,
		width: 768,
		height: 0.75
	});
	$update(currentPage);
};