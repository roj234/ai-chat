import {$computed, $watch, unconscious} from "unconscious";
import {config, Shared} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";
import {showToast} from "/src/components/Toast.js";
import {SETTINGS} from "/src/settings.js";

if (DB_MODE !== "local") {
	const {db_server, db_pat, _new: isNew} = config;

	onLoad(() => {
		if (isNew) {
			getKV("config").then(config_ => {
				if (!config_) throw "";
				config_.db_server = db_server;
				config_.db_pat = db_pat;
				config.value = config_;
			}).catch(() => {
				showToast("未能拉取配置\n可能之前未保存过\n正在使用切换前的配置", 'error');
			}).finally(Shared.SettingUI.sync);
		}

		let updated;
		$watch($computed(() => config.db_server), () => {
			const new_server = config.db_server;
			if (new_server === db_server || new_server === db_server+'/') return;
			if (updated) return;
			updated = true;

			const copyConfig = structuredClone(unconscious(config));
			SETTINGS.forEach(item => {
				if (item._sync === false)
					delete copyConfig[item.id];
			});

			setKV("config", copyConfig).then(() => {
				if (new_server !== ':idb:' && db_server !== ':idb:') delete config.db_pat;
				config._new = true;
				location.reload();
			})
		}, false);
	})
}