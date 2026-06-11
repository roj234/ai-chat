import {$foreach, $state, appendChild} from "unconscious";

const errors = $state([]);
const testRunner = {
	tests: [],
	running: false,

	push(fn, name) {
		if (typeof fn !== 'function') {
			console.error('testRunner.push: 参数必须是函数');
			return;
		}
		totalCountEl.textContent = this.tests.push([fn, name || fn.name]);
	},

	async run() {
		if (this.running) {
			console.warn('测试正在运行中，请稍后...');
			return;
		}
		this.running = true;
		this.results = {
			passed: 0,
			failed: 0,
			errors
		};
		errors.length = 0;
		updateUI();
		setRunButtonDisabled(true);

		// 遍历所有测试
		for (let i = 0; i < this.tests.length; i++) {
			const [fn, name] = this.tests[i];

			try {
				// 执行测试函数
				const result = fn();

				// 判断是否为 Promise (thenable)
				if (result && typeof result.then === 'function') {
					try {
						const awaitedValue = await result;
						if (awaitedValue === true) {
							this.results.passed++;
						} else {
							this.results.failed++;
							this.results.errors.push(
								`测试 ${name}: 期望得到 true，但 Promise resolve 的值为 ${JSON.stringify(awaitedValue)}`
							);
						}
					} catch (promiseError) {
						this.results.failed++;
						const errorMsg = promiseError instanceof Error ? promiseError.message : String(promiseError);
						this.results.errors.push(`测试 ${name}: Promise 被拒绝，错误信息: ${errorMsg}`);
					}
				} else {
					// 同步返回值
					if (result === true) {
						this.results.passed++;
					} else {
						this.results.failed++;
						this.results.errors.push(
							`测试 ${name}: 期望得到 true，但返回值为 ${JSON.stringify(result)}`
						);
					}
				}
			} catch (syncError) {
				this.results.failed++;
				const errorMsg = syncError instanceof Error ? syncError.message : String(syncError);
				this.results.errors.push(`测试 ${name}: 抛出异常: ${errorMsg}`);
			}

			// 实时更新 UI，让用户看到进度
			updateUI();
		}

		this.running = false;
		setRunButtonDisabled(false);
		updateUI();

		// 全部完成后的提示
		if (this.results.failed === 0 && this.tests.length > 0) {
			console.log('🎉 所有测试通过！');
		} else if (this.tests.length === 0) {
			console.log('⚠️ 没有可运行的测试，请先添加测试函数。');
		}
	}
};

// DOM 元素引用
const passCountEl = document.getElementById('passCount');
const failCountEl = document.getElementById('failCount');
const totalCountEl = document.getElementById('totalCount');
const errorListEl = document.getElementById('errorList');
const errorBadgeEl = document.getElementById('errorBadge');
const progressBarEl = document.getElementById('progressBar');
const runBtn = document.getElementById('runBtn');

appendChild(errorListEl, $foreach(errors, err => <li className={"error-item"}>{err}</li>));

// 更新界面函数
function updateUI() {
	const { passed, failed, errors } = testRunner.results;
	const total = testRunner.tests.length;

	passCountEl.textContent = passed;
	failCountEl.textContent = failed;
	errorBadgeEl.textContent = errors.length;

	// 更新进度条
	const runTotal = passed + failed;
	const percent = (runTotal / total) * 100;
	progressBarEl.style.width = percent + '%';
	if (failed > 0) {
		progressBarEl.style.background = '#ef4444';
	} else if (runTotal === total && failed === 0) {
		progressBarEl.style.background = '#10b981';
	} else {
		progressBarEl.style.background = '#6366f1';
	}
}

function setRunButtonDisabled(disabled) {
	runBtn.disabled = disabled;
	runBtn.textContent = disabled ? '⏳ 运行中...' : '▶️ 开始测试';
}

// 事件绑定
runBtn.addEventListener('click', () => {
	testRunner.run();
});

export {testRunner};

import("./tests.js");