import {isMobile} from "../states.js";

/**
 * @type {AudioContext|Promise<void>|WakeLockSentinel}
 */
let wakelock;
/**
 *
 * @param {boolean} active
 */
export const setWakeLock = (active) => {
	if (isMobile) {
		if (!active === !wakelock) return;

		if (active) {
			wakelock = navigator.wakeLock.request().then(lock => {
				if (wakelock) wakelock = lock;
				else lock.release();
			});
		} else {
			wakelock?.release();
			wakelock = null;
		}
	} else {
		if (!wakelock) {
			if (!active) return;

			wakelock = new AudioContext();
			const gainNode = wakelock.createGain();
			gainNode.gain.value = 0;
			gainNode.connect(wakelock.destination);

			const bufferSource = wakelock.createBufferSource();
			bufferSource.buffer = wakelock.createBuffer(1, 1, 8000);
			bufferSource.loop = true;
			bufferSource.connect(gainNode);
			bufferSource.start();
		}
		if (active) wakelock.resume();
		else wakelock.suspend();
	}
}
