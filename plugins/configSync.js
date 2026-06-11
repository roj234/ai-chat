import {$computed, $watch, unconscious} from "unconscious";
import {config, Shared} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";
import {showToast} from "../src/components/Toast.js";

if (DB_MODE !== "local") {
	const isNew = config._new;
	const db_server = config.db_server;

	onLoad(() => {
		if (isNew) {
			getKV("config").then(config_ => {
				if (!config_) throw "";
				config_.db_server = db_server;
				config.value = config_;
				showToast("成功拉取配置", 'ok');
			}).catch(() => {
				showToast("未能拉取配置\n可能之前未保存过\n正在使用切换前的配置", 'error');
			}).finally(Shared.SettingUI.sync);
		}

		let updated;
		$watch($computed(() => config.db_server), () => {
			if (config.db_server === db_server) return;
			if (updated) return;
			updated = true;

			setKV("config", unconscious(config)).then(() => {
				config._new = true;
				location.reload();
			})
		}, false);
	})
}