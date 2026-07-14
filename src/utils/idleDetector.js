import {$state} from "unconscious";

export const isIdle = $state();

let abort;

export const initIdleDetector = async () => {
	if (abort) return;

	const state = await IdleDetector.requestPermission();
	if (state === 'denied') return;

	const idleDetector = new IdleDetector();

	idleDetector.addEventListener("change", () => {
		// 是否活动状态 active or idle
		const userState = idleDetector.userState;
		// 是否锁屏 locked or unlocked
		const screenState = idleDetector.screenState;
		isIdle.value = userState === 'idle';
		console.log(`Idle change: %s, %s.`, userState, screenState);
	});

	abort = new AbortController();
	const signal = abort.signal;

	return idleDetector.start({
		threshold: 60000,
		signal,
	});
}