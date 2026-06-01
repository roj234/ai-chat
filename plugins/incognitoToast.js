import {config} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {$computed, $watch} from "unconscious";
import {onLoad} from "/src/plugin.js";

onLoad(() => {
	let incognitoToast;
	$watch($computed(() => config.incognito), () => {
		const incognito = config.incognito;
		if (incognito) {
			incognitoToast = showToast("无痕模式", "error", 0);
		} else if (incognitoToast) {
			incognitoToast();
			incognitoToast = null;
		}
	});
});