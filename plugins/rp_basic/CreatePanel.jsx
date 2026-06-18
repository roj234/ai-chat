import {$state} from "unconscious";

export function createPanel(constructor) {
	const isOpen = $state(false);
	let self;

	const open = (preset) => {
		if (!self) document.body.append(self = constructor(preset, isOpen, close));
		requestAnimationFrame(() => {
			isOpen.value = true;
		});
	};
	const close = () => {
		isOpen.value = false;
		setTimeout(() => {
			if (!isOpen.value) {
				self?.remove();
				self = null;
			}
		}, 300);
	};

	return {open, close};
}