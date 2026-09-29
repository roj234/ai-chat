import {$derived, $watch, unconscious} from "unconscious";
import {config, conversations} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import {showToast} from "/src/components/Toast.js";
import {AsyncButton} from "/src/components/AsyncButton.jsx";
import {GLOBAL_SETTINGS, PRIVATE_CONFIG_KEY} from "/src/settings.js";
import {deepEqual} from "unconscious/common/deepEqual.js";


const saveConfig = () => {
	const copyConfig = {...unconscious(config)};
	PRIVATE_CONFIG_KEY.forEach(key => delete copyConfig[key]);
	return setKV("config", copyConfig);
};

const loadConfig = (db_servers, db_pat) => getKV("config").catch((err) => {
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
	newCfg.db_servers = db_servers;
	newCfg.db_pat = db_pat;
	delete newCfg._new;

	config.value = newCfg;
	DI_settings.sync();
});

GLOBAL_SETTINGS.push(
	{
		type: "element",
		_tab: ["general", "data"],
		_order: -1,
		name: "本地配置",
		element: <div className={"choice-scroll"}>
			<AsyncButton onClick={() => {
				let {db_servers, db_pat} = config;
				return loadConfig(db_servers, db_pat);
			}}>恢复</AsyncButton>
			<AsyncButton onClick={saveConfig}>备份</AsyncButton>
		</div>
	},
);

export const registerConfigSync = () => {
	let servers = [...(config.db_servers || [])];
	let {db_pat, _new: isNew} = config;

	onLoad(() => {
		if (isNew) loadConfig(servers, db_pat);

		$watch($derived(config.db_servers), () => {
			const b = config.db_servers;
			if (deepEqual(servers, b)) return;
			servers = [...b];

			// 对话尚未加载完成时不处理（多为启动阶段的配置恢复）
			if (!unconscious(conversations)) return;

			saveConfig().then(() => {
				config._new = true;
				location.reload();
			})
		}, false);
	});
}