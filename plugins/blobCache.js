const SW_URL = './sw.js';

import {SETTINGS} from "/src/settings.js";
import {onLoad} from "/src/plugin.js";
import {$computed, $state, $watch, unconscious} from "unconscious";
import {formatSize} from "unconscious/common/Utils.js";
import {config} from "/src/states.js";

let element;


if (DB_MODE !== 'local') {
	SETTINGS.push({
		type: "element",
		name: "远程文件缓存",
		_tab: "data",
		element: <div className={"choice-scroll"} ref={element} />
	});
	SETTINGS.push({
		id: "blobCacheCapacity",
		type: "number",
		name: "容量限制（MB）",
		min: 10,
		max: 500,
		step: 10,
		_tab: "data"
	});

	const cb = () => {
		if (!navigator.serviceWorker?.controller) {
			element.replaceChildren(<button className={"btn primary"} onClick={() => enableBlobCache().then(cb)}>启用</button>);
		} else {
			const size = $state(0);
			const im = new IntersectionObserver((entries) => {
				if (!entries.at(-1).isIntersecting) return;
				getCacheSize().then(size1 => size.value = size1);
			});
			im.observe(element);
			$watch($computed(() => config.blobCacheCapacity), () => {
				const cap = config.blobCacheCapacity;
				if (cap) setMaxCacheSize(cap << 20).then(([before, after]) => {
					console.log("Size reduced: "+formatSize(before-after));
				});
			});

			element.replaceChildren(
				<span>已用空间：{() => formatSize(unconscious(size))}</span>,
				<button className={"btn danger"} onClick={() => unregisterCache().then((removed) => {
					if (removed) location.reload();
				})}>卸载</button>
			);
		}
	};
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
		swReady = navigator.serviceWorker
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
 * @param {'get'|'set'|'del'} type - 请求类型
 * @param {*} [value] - 附加数据（SET_MAX_SIZE 时需要）
 * @returns {Promise<*>}
 */
const sendMessage = (type, value) => enableBlobCache().then((reg) => {
	return new Promise((resolve, reject) => {
		const key = id++;
		transactions.set(key, resolve);
		navigator.serviceWorker.controller.postMessage([key, type, value]);
		setTimeout(() => {
			if (transactions.delete(key)) {
				reject(new Error(`Timeout`));
			}
		}, 10000);
	})
});

navigator.serviceWorker.addEventListener('message', (event) => {
	const [id, value] = event.data;
	const resolve = transactions.get(id);
	if (resolve) {
		transactions.delete(id);
		resolve(value);
	}
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
	const registration = await navigator.serviceWorker.getRegistration(SW_URL);
	if (registration) return sendMessage('del').then(() => registration.unregister());
}

