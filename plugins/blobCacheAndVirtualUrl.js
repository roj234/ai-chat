import {updateOnIntersected} from "/src/utils/utils.js";
import {GLOBAL_SETTINGS} from "/src/settings.js";
import {onLoad} from "/src/hooks.js";
import {$derived, $state, $watch, unconscious} from "unconscious";
import {formatSize} from "unconscious/common/Utils.js";
import {config, EVENT_BUS} from "/src/states.js";

const SW_URL = './sw.js';

let element;

const swc = navigator.serviceWorker;

if (swc) {
	GLOBAL_SETTINGS.push({
		_tab: "data",
		type: "element",
		name: "资源缓存和VFS静态服务",
		element: <div className={"choice-scroll row"} ref={element} />
	});
	GLOBAL_SETTINGS.push({
		_tab: "data",
		id: "blobCacheCapacity",
		type: "number",
		name: "资源缓存容量",
		min: 0,
		max: 500,
		step: 10,
		default: 50,
		unit: "MiB",
		inline: true,
	});

	const cb = () => {
		if (!swc.controller) {
			element.replaceChildren(<button className={"btn primary"} onClick={() => enableBlobCache().then(cb)}>启用</button>);
		} else {
			EVENT_BUS.on(['vfsConfig'], vfs => sendMessage('vfs'));

			const size = $state(0);
			updateOnIntersected(element, () => getCacheSize().then(size1 => size.value = size1));
			$watch($derived(config.blobCacheCapacity), () => {
				setMaxCacheSize(config.blobCacheCapacity << 20).then(([before, after]) => {
					console.log("Size reduced: "+formatSize(before-after));
				});
			});

			element.replaceChildren(
				<button className="btn danger" title="关闭并清除缓存" onClick={() => unregisterCache().then((removed) => {
					if (removed) location.reload();
				})}>关闭</button>,
				<span style="font-size:14px">已用：{() => formatSize(unconscious(size))}</span>,
			);
		}
	};
	onLoad(() => swc.addEventListener('message', (event) => {
		const [id, value] = event.data;
		const data = transactions.get(id);
		if (data) {
			transactions.delete(id);
			clearTimeout(data[0]);
			data[1](value);
		}
	}));
	onLoad(cb);
}


let id = 0;
let swReady = null;
const transactions = new Map();

/**
 * 等待 SW 激活并拿到 controller
 * @returns {Promise<ServiceWorkerRegistration>}
 */
const enableBlobCache = () => (
	swReady || (
		swReady = swc
			.register(SW_URL, {type: 'module'})
			.then((reg) => {
				if (reg.installing) {
					return new Promise((resolve) => {
						reg.installing.onstatechange = (e) => {
							if (e.target.state === 'activated') resolve(reg);
						};
					});
				}
				return reg;
			})
	)
);

/**
 * 向 SW 发送消息并等待对应类型的回复
 * @param {'get'|'set'|'del'|'vfs'} type - 请求类型
 * @param {*} [value] - 附加数据（SET_MAX_SIZE 时需要）
 * @returns {Promise<*>}
 */
const sendMessage = (type, value) => enableBlobCache().then((reg) => {
	return new Promise((resolve, reject) => {
		const key = id += 2;
		const timer = setTimeout(() => reject(new Error(`RPC ${type} Timeout`)), 3000);
		transactions.set(key, [timer, resolve]);
		swc.controller.postMessage([key, type, value]);
	})
});

/**
 * 获取当前 SW 缓存占用（字节）
 * @returns {Promise<number>}
 */
const getCacheSize = () => sendMessage('get');

/**
 * 设置最大缓存容量（字节）
 * @param {number} bytes - 最大字节数
 * @returns {Promise<[number, number]>}
 */
const setMaxCacheSize = bytes => sendMessage('set', bytes);

const unregisterCache = async () => {
	const registration = await swc.getRegistration(SW_URL);
	if (registration) return sendMessage('del').then(() => registration.unregister());
}

