import {$asyncState, $computed, $foreach, $state, $update, $watch, unconscious} from "unconscious";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {formatSize, prettyTime} from "unconscious/common/Utils.js";
import {copyWithAnimation, deleteWithDrawback, showImageZoomView} from "/src/utils/utils.js";
import {requestBackend, u_deleteBlob} from "/src/database/remoteDB.js";
import {remoteDBUrl} from "/src/database.js";
import {openWindow} from "/src/components/Windows.jsx";
import {Icon_search} from "/src/components/Icons.jsx";

import "./BlobManager.css";
import {deepEqual} from "unconscious/common/deepEqual.js";

const pageSize = $state(50);

const searchTerm = $state();
const currentPage = $state(1);
const total = $state();
const selectedItems = $state();
const listAll = $state(false);
const totalPages = $computed(() => Math.ceil(unconscious(total)/unconscious(pageSize)));
let table;

/**
 * @type {import("unconscious").ReactivePromise<{ hash: string, name: string, lastModified: number, user?: string }[]>}
 */
const blobs = $asyncState(async currentPage => {
	const term = unconscious(searchTerm);
	const all = unconscious(listAll) ? '&all=1' : '';
	const result = await requestBackend(`blobs?page=${currentPage}&limit=${pageSize}${term ? `&term=${encodeURIComponent(term)}` : ''}${all}`);
	total.value = result.total;
	return result.data;
}, currentPage);

$watch(blobs, () => {
	queueMicrotask(() => {
		selectedItems.value = [...table.querySelectorAll('.row-check:checked')].length;
	});
}, false);

/**
 * 尚未实现（因为不是很想把pat放在url里面）
 */
const blobUrl = item => {
	let url = remoteDBUrl;
	if (item.user) {
		const idx = remoteDBUrl.lastIndexOf('/', remoteDBUrl.length-2);
		url = remoteDBUrl.slice(0, idx+1)+item.user+'/';
	}
	return `${url}blob/${item.hash}`
};

const removeBlob = item => unconscious(listAll)
	? requestBackend('blob/'+item.hash+'?user='+encodeURIComponent(item.user), {method: 'DELETE'})
	: u_deleteBlob(item.hash);

const deleteItem = (item, e) => {
	const isKeyboard = e.detail === 0;
	const idx = blobs.findIndex(s => deepEqual(s, item));
	blobs.splice(idx, 1);

	deleteWithDrawback((item.name || item.hash), () => {
		removeBlob(item).then(() => $update(currentPage));
	}, () => $update(currentPage), isKeyboard);
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
				all.push(removeBlob(chk._value));
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
		<label style={"display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer"}>
			<input type="checkbox" checked={() => unconscious(listAll)} onChange={e => {
				listAll.value = e.target.checked;
				currentPage.value = 1;
				$update(currentPage);
			}}/>
			其他用户
		</label>
	</div>

	<div style={"overflow:auto"} ref={scrollWin}>
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
				const url = blobUrl(item);

				return <tr>
					<td><input className={"row-check" + (item.name ? " named" : "")} type="checkbox" _value={item} onChange={updateSelected} /></td>
					<td className={"_pv"}>{isImg ? <img src={url} loading="lazy" referrerpolicy={"no-referrer"} onClick={() => showImageZoomView(url, item.name || item.hash)}/> : '-'}</td>
					<td className={"_info"}>
						<a style={"display:flex;gap:8px"} href={url} rel={"noopener noreferrer"} target={"_blank"} title={"下载"}>
							<i className={"ri-download-2-line"}></i>
							{item.name || '临时对象'}
						</a>
						<div>
							<span className="hash" title={item.hash}>{item.hash.slice(0, 6)}...{item.hash.slice(-6)}</span>
							<button className="ri-file-copy-line ghost" title={"复制哈希"} onClick={({target}) => {
								copyWithAnimation("![blob]("+item.hash+")", target)
							}}></button>
							{unconscious(listAll) ? <span>{item.user}</span> : null}
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
						<button className="ri-delete-bin-line btn danger-focus" title={"删除"} onClick={(e) => {
							deleteItem(item, e);
						}}></button>
					</td>
				</tr>
			}, item => (item.user ?? '') + '/' + item.hash)}
			</tbody>
		</table>
	</div>
	<div className="pagination">
		<button className="ri-arrow-left-s-line btn ghost" title={"上一页"} disabled={() => unconscious(currentPage) === 1} onClick={() => currentPage.value -= 1}></button>
		<span>第 <input style={"width: 60px"} type={"number"} value={currentPage} min={1} max={totalPages} onChange={e => {
			currentPage.value = e.target.valueAsNumber;
		}} /> / {totalPages} 页  (每页 <input style={"width: 60px"} type={"number"} value={pageSize} min={10} max={100} step={10} onChange={e => {
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
		title: "附件管理",
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