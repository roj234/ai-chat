import {$computed, $watch, unconscious} from "unconscious";
import {config, Shared} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";
import {showToast} from "/src/components/Toast.js";

const LOCAL_CONFIG = "theme uiAutoHideInput checkUpdate width sound expandThinkBlock expandToolCall backgroundFit db_server db_pat".split(" ");

if (DB_MODE !== "local") {
	let {db_server, db_pat, _new: isNew} = config;

	onLoad(() => {
		if (isNew) {
			getKV("config").then(newCfg => {
				if (!newCfg) throw "";
				const oldCfg = unconscious(config);
				LOCAL_CONFIG.forEach(key => newCfg[key] = oldCfg[key]);
				newCfg.db_server = db_server;
				newCfg.db_pat = db_pat;

				config.value = newCfg;
				Shared.SettingUI.sync();
			}).catch(() => {
				showToast("未能拉取配置\n可能之前未保存过\n正在使用切换前的配置", 'error');
			});
		}

		let updated;
		$watch($computed(() => config.db_server), () => {
			let new_server = config.db_server;
			if (new_server === db_server) return;
			if (updated) return;
			updated = true;

			const copyConfig = structuredClone(unconscious(config));
			LOCAL_CONFIG.forEach(key => delete copyConfig[key]);

			setKV("config", copyConfig).then(() => {
				if (new_server !== ':idb:' && db_server !== ':idb:' && new_server) delete config.db_pat;
				config._new = true;
				location.reload();
			})
		}, false);
	})
}