import {$computed, $watch, unconscious} from "unconscious";
import {config} from "/src/states.js";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";

if (DB_MODE !== "local") {
	const isNew = Object.keys(config.value).length === 2;
	const old = config._old_config;

	onLoad(() => {
		if (isNew) {
			const db_server = config.db_server;
			getKV("config").then(config_ => {
				if (!config_) config_ = {};
				config_.db_server = db_server;
				config.value = config_;
				location.reload();
			}).catch(() => {
				config.value = old;
				location.reload();
			});
		} else {
			let updated;
			$watch($computed(() => config.db_server), () => {
				if (updated) return;
				updated = true;

				setKV("config", unconscious(config)).then(() => {
					config.value = {db_server: config.db_server, _old_config: unconscious(config)};
					location.reload();
				})
			}, false);
		}
	})
}