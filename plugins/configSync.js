import {$computed, $watch, unconscious} from "unconscious";
import {config, conversations} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {showToast} from "/src/components/Toast.js";
import {AsyncButton} from "/src/components/AsyncButton.jsx";
import {PRIVATE_CONFIG_KEY, SETTINGS} from "../src/settings.js";


const saveConfig = () => {
	const copyConfig = {...unconscious(config)};
	PRIVATE_CONFIG_KEY.forEach(key => delete copyConfig[key]);
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
	PRIVATE_CONFIG_KEY.forEach(key => newCfg[key] = oldCfg[key]);
	newCfg.db_server = db_server;
	newCfg.db_pat = db_pat;
	delete newCfg._new;

	config.value = newCfg;
	DI_settings.sync();
});

SETTINGS.push(
	{
		type: "element",
		_tab: ["general", "data"],
		_order: -1,
		name: "本地配置",
		element: <div className={"choice-scroll"}>
			<AsyncButton onClick={() => {
				let {db_server, db_pat} = config;
				return loadConfig(db_server, db_pat);
			}}>恢复</AsyncButton>
			<AsyncButton onClick={saveConfig}>备份</AsyncButton>
		</div>
	},
);

export const registerConfigSync = () => {
	let {db_server, db_pat, _new: isNew} = config;
	onLoad(() => {
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