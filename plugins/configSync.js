import {$computed, $watch, appendChildren, unconscious} from "unconscious";
import {config, conversations} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {showToast} from "/src/components/Toast.js";

const LOCAL_CONFIG = `theme
checkUpdate
width
sidebarWidth
sound
expandThinkBlock
expandToolCall
backgroundFit
db_server
db_pat`.split("\n");

const saveConfig = () => {
	const copyConfig = structuredClone(unconscious(config));
	delete copyConfig._new;
	LOCAL_CONFIG.forEach(key => delete copyConfig[key]);

	return setKV("config", copyConfig);
};

const loadConfig = (db_server, db_pat) => getKV("config").catch((err) => {
	if (err.status === 401) return 0;
}).then(newCfg => {
	if (!newCfg) {
		if (newCfg === 0) return;

		showToast("未能拉取配置\n可能之前未保存过\n正在使用切换前的配置", 'error');
		delete config._new;
		return;
	}

	const oldCfg = unconscious(config);
	LOCAL_CONFIG.forEach(key => newCfg[key] = oldCfg[key]);
	newCfg.db_server = db_server;
	newCfg.db_pat = db_pat;
	delete newCfg._new;

	config.value = newCfg;
	DI_settings.sync();
});

/**
 * @param {string} text
 * @param {string} pendingText
 * @param {string} okText
 * @param {string} failText
 * @param {string} className
 * @param {function(): Promise<any>} onClick
 * @constructor
 */
const AsyncButton = ({ pendingText, okText, failText = '操作失败', onClick, className = 'btn ghost' }, text) => {
	return <button className={className} onClick={({target}) => {
		target.textContent = pendingText;
		target.disabled = true;
		onClick().then(() => {
			target.textContent = okText;
		}, () => {
			target.textContent = failText;
		}).finally(() => setTimeout(() => {
			target.textContent = text;
			target.disabled = false;
		}, 1000));
	}}>{text}</button>;
}

export const registerConfigSync = () => {
	let {db_server, db_pat, _new: isNew} = config;
	onLoad(() => {
		const presetButtons = DI_settings.byId("pb");
		appendChildren(presetButtons, <>
			<AsyncButton pendingText={'读取中'} okText={'已读取'} onClick={() => {
				let {db_server, db_pat} = config;
				return loadConfig(db_server, db_pat);
			}}>读取配置</AsyncButton>
			<AsyncButton pendingText={'保存中'} okText={'已保存'} onClick={saveConfig}>保存配置</AsyncButton>
		</>);

		if (isNew) loadConfig(db_server, db_pat);

		let updated;
		$watch($computed(() => config.db_server), () => {
			let new_server = config.db_server;
			if (new_server === db_server || !unconscious(conversations)) return;
			if (updated) return;
			updated = true;

			saveConfig().then(() => {
				if (new_server !== ':idb:' && db_server !== ':idb:' && new_server) delete config.db_pat;
				config._new = true;
				location.reload();
			})
		}, false);
	});
}