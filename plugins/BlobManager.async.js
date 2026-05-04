import {$foreach, $state} from "unconscious";
import {config} from "/src/states.js";
import SimpleModal from "../src/components/SimpleModal.jsx";
import {prettyTime, formatSize} from "unconscious/ext/Utils.js";

const pageSize = 20;

const blobs = $state([]);
let currentPage = $state(1);
let total = $state();
let table;

const container = <div className={"modal-overlay"}>
	<div className="modal" style={"max-width: 70vw"}>
		<div className="header">
			<b>Blob 存储管理</b>
			<button className="btn primary" onClick={fetchList}>刷新</button>
			<button className="btn danger" onClick={deleteSelected}>删除选中</button>
			<button className="ri-close-line btn ghost" style="border:none" onClick={() => container.remove()}></button>
		</div>

		<div style={"overflow:auto"}>
			<table>
				<thead>
				<tr>
					<th width="30"><input type="checkbox" onClick={({target}) => toggleAll(target)}/></th>
					<th>预览</th>
					<th>Hash / 名称</th>
					<th>类型</th>
					<th>大小</th>
					<th>修改时间</th>
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
							<a href={blobUrl} target="_blank" className="btn primary">下载</a>
							<button className="btn danger" onClick={() => {
								deleteItem(item.hash);
							}}>删除
							</button>
						</td>
					</tr>
				})}
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

async function fetchList() {
	try {
		const res = await fetch(`${config.db_server}/blobs?page=${currentPage}&limit=${pageSize}`);
		const result = await res.json();

		blobs.value = result.data;
		total.value = result.total;
	} catch (err) {
		alert('获取列表失败: ' + err.message);
	}
}

async function deleteItem(hash) {
	if (!confirm('确定要删除吗？')) return;
	await fetch(`${config.db_server}/blob/${hash}`, {method: 'DELETE'});
	fetchList();
}

async function deleteSelected() {
	const checks = table.querySelectorAll('.row-check:checked');
	if (checks.length === 0) return;
	if (!confirm(`确定要删除选中的 ${checks.length} 项吗？`)) return;

	for (let chk of checks) {
		await fetch(`${config.db_server}/blob/${chk.value}`, {method: 'DELETE'});
	}
	fetchList();
}

function toggleAll(master) {
	table.querySelectorAll('.row-check').forEach(chk => chk.checked = master.checked);
}

function changePage(delta) {
	if (currentPage.value + delta < 1) return;
	currentPage.value += delta;
	fetchList();
}

function showFull(url) {
	SimpleModal({
		title: "图像预览",
		message: <img src={url} />
	})
}

export function display() {
	document.body.append(container);
	fetchList();
}