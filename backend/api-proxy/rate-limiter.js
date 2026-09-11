
// =============================================================================
// Rate limiter — 滑动窗口
// =============================================================================

class RPMLimiter {
	#windowMs;
	#hits = [];
	#tokens = 0;

	constructor(windowMs) {
		this.#windowMs = windowMs;
	}

	rpm(rpm) {
		const now = Date.now();
		const cutoff = now - this.#windowMs;

		const pos = this.#hits.findIndex(s => s.time > cutoff);
		this.#hits.slice(0, pos).forEach(c => {
			this.#tokens -= c.tokens ?? 0;
		});

		this.#hits = pos < 0 ? [] : this.#hits.slice(pos);
		if (this.#hits.length >= rpm) return false;

		const state = {time: now};
		this.#hits.push(state);
		return state;
	}

	tpm(tpm, state, tokens) {
		if (this.#tokens + tokens > tpm) return false;
		this.#tokens += tokens;
		state.tokens = tokens;
		return true;
	}
}

const LIMITER = Symbol("RateLimiter-RPM");

export const getRPMLimit = opt => opt[LIMITER] ??= new RPMLimiter(60000);
