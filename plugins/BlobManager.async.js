import {$foreach, $state} from "unconscious";
import {config} from "/src/states.js";
import SimpleModal from "../src/components/SimpleModal.jsx";
import {formatSize, prettyTime} from "unconscious/common/Utils.js";

const pageSize = 20;

const blobs = $state();
const currentPage = $state(1);
const total = $state();
let table;

const fetchList = async () => {
	try {
		const res = await fetch(`${config.db_server}/blobs?page=${currentPage}&limit=${pageSize}`);
		const result = await res.json();

		blobs.value = result.data;
		total.value = result.total;
	} catch (err) {
		alert('获取列表失败: ' + err.message);
	}
};

const deleteItem = hash => {
	SimpleModal({
		title: "确定要删除吗？",
		onConfirm() {
			fetch(`${config.db_server}/blob/${hash}`, {method: 'DELETE'}).then(fetchList);
		}
	})
};

const deleteSelected = () => {
	const checks = table.querySelectorAll('.row-check:checked');
	if (checks.length === 0) return;
	SimpleModal({
		title: `确定要删除选中的 ${checks.length} 项吗？`,
		onConfirm() {
			const all = [];
			for (let chk of checks) {
				all.push(fetch(`${config.db_server}/blob/${chk.value}`, {method: 'DELETE'}));
			}
			Promise.all(all).then(fetchList);
		}
	});
};

const toggleAll = master => {
	table.querySelectorAll('.row-check').forEach(chk => chk.checked = master.checked);
};

const changePage = delta => {
	const page = currentPage.value + delta;
	if (page < 1 || page > Math.ceil(total/pageSize)) return;
	currentPage.value = page;
	fetchList();
};

const showFull = url => {
	SimpleModal({
		title: "图像预览",
		message: <img src={url} />
	})
};

const container = <div className={"modal-overlay"}>
	<div className="modal" style={"max-width:70vw"}>
		<div className="header" style={"display:flex;gap:8px"}>
			<b>Blob 存储管理</b>
			<button className="ri-loop-right-line btn primary" title={"刷新"} onClick={fetchList}></button>
			<span className={"spacer"}></span>
			<button className="btn danger" onClick={deleteSelected}>删除选中</button>
			<button className="ri-close-line btn ghost" style="border:none" title={"关闭窗口"} onClick={() => container.remove()}></button>
		</div>

		<div style={"overflow:auto"}>
			<table>
				<thead>
				<tr>
					<th width="30"><input type="checkbox" onClick={({target}) => toggleAll(target)}/></th>
					<th>预览</th>
					<th>Hash</th>
					<th>类型</th>
					<th>大小</th>
					<th>上传时间</th>
					<th>操作</th>
				</tr>
				</thead>
				<tbody ref={table}>
				{$foreach(blobs, item => {
					const isImg = item.mime.startsWith('image/');
					const blobUrl = `${config.db_server}/blob/${item.hash}`;

					return <tr>
						<td><input type="checkbox" className="row-check" value={item.hash} /></td>
						<td>{isImg ?
							<img src={blobUrl} className="preview-img" onClick={() => showFull(blobUrl)}/> : '-'}</td>
						<td style="word-break: break-all; font-family: monospace; font-size: 12px;">{item.hash}</td>
						<td>{item.mime}</td>
						<td>{formatSize(item.size)}</td>
						<td>{prettyTime(item.time)}</td>
						<td>
							<a href={blobUrl} target="_blank" title={"下载"} className="ri-download-2-line btn primary"></a>
							<button className="ri-delete-bin-line btn danger" title={"删除"} onClick={() => {
								deleteItem(item.hash);
							}}>
							</button>
						</td>
					</tr>
				}, item => item.hash)}
				</tbody>
			</table>
		</div>
		<div className="pagination">
			<button className="btn" onClick={() => changePage(-1)}>上一页</button>
			<span id="pageInfo">第 {currentPage} 页  (共 {total} 条)</span>
			<button className="btn" onClick={() => changePage(1)}>下一页</button>
		</div>
	</div>
</div>;

export const display = () => {
	document.body.append(container);
	fetchList();
};