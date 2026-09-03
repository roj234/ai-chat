import {$state, unconscious} from "unconscious";

export function createPanel(constructor) {
	const isOpen = $state(false);
	let self;

	const open = (preset) => {
		if (!self) self = constructor(preset, isOpen, close);
		document.body.append(self);
		requestAnimationFrame(() => {
			isOpen.value = true;
		});
	};
	const close = () => {
		let resolve;
		isOpen.value = false;
		setTimeout(() => {
			const closed = !unconscious(isOpen);
			if (closed) {
				self?.remove();
				self = null;
			}
			resolve(closed);
		}, 300);
		return new Promise(r => resolve = r);
	};

	return {open, close, isOpen};
}