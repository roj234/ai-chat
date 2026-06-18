
NodeList.prototype.includes = Array.prototype.includes;

/**
 * 创建拖动排序实例
 *
 * @param {HTMLElement} container - 包含可排序项的父容器
 * @param {Object} [options] - 配置选项
 * @param {string} [options.itemSelector] - 可排序子项的选择器（默认使用 container 的直接子元素）
 * @param {string} [options.handleSelector] - 拖拽手柄的选择器（在 item 内部），不设置则整个 item 都可拖拽
 * @param {boolean} [options.enabled=true] - 初始是否启用
 * @param {(dragElement: HTMLElement, container: HTMLElement) => boolean} [options.canDrag] - 判断元素是否可拖拽
 * @param {(dragElement: HTMLElement, targetElement: HTMLElement | null, container: HTMLElement) => boolean} [options.canDragTo] - 判断可拖拽元素是否可放到 targetElement 之前（targetElement 为 null 表示末尾）
 * @param {(dragElement: HTMLElement, targetElement: HTMLElement | null, container: HTMLElement) => void} [options.onMovedTo] - 元素成功移动后的回调
 */
export function createDragSort(container, {
	itemSelector,
	handleSelector,
	enabled= true,
	canDrag = (() => true),
	canDragTo= (() => true),
	onMovedTo= (() => {})
} = {}) {
	let _dragState = null;

	setEnabled(enabled);

	function _removeGlobalListeners() {
		document.removeEventListener('pointermove', _onPointerMove);
		document.removeEventListener('pointerup', _onPointerUp);
		document.body.style.touchAction = '';
	}

	function _resolveItem(e) {
		let el = e.target;

		if (handleSelector) {
			const handleEl = el.closest(handleSelector);
			if (!handleEl || !container.contains(handleEl)) return null;
			el = handleEl;
		}

		const item = el.closest(itemSelector);
		return item && container.contains(item) ? item : null;
	}

	// ==================== 指针事件处理 ====================

	function _onPointerDown(e) {
		if (_dragState) return;

		if (e.button !== 0) return;

		const item = _resolveItem(e);
		if (!item) return;

		if (!canDrag(item, container)) return;

		e.preventDefault();

		const rect = item.getBoundingClientRect();

		const shadow = <div className={"ds-shadow"} style={{width:rect.width+"px",height:rect.height+"px"}} />;
		container.insertBefore(shadow, item.nextSibling);

		// 将 item 变为固定定位，跟随指针
		item.classList.add("ds-drag");
		item.style.position = 'fixed';
		item.style.zIndex = '1000';
		item.style.pointerEvents = 'none';
		item.style.left = rect.left + 'px';
		item.style.top = rect.top + 'px';
		item.style.width = rect.width + 'px';
		item.style.height = rect.height + 'px';
		item.style.margin = '0';

		_dragState = {
			item,
			shadow,
			offsetX: e.clientX - rect.left,
			offsetY: e.clientY - rect.top
		};

		document.addEventListener('pointermove', _onPointerMove);
		document.addEventListener('pointerup', _onPointerUp);
		document.body.style.touchAction = 'none';
	}

	function _onPointerMove(e) {
		if (!_dragState) return;
		e.preventDefault();

		const { item, shadow, offsetX, offsetY } = _dragState;

		// 更新拖拽元素位置
		item.style.left = (e.clientX - offsetX) + 'px';
		item.style.top = (e.clientY - offsetY) + 'px';

		// 计算插入目标
		const elementsAtPoint = document.elementsFromPoint(e.clientX, e.clientY);
		const items = itemSelector ? container.querySelectorAll(itemSelector) : container.childNodes;

		let targetItem;
		for (const el of elementsAtPoint) {
			if (el !== item && items.includes(el)) {
				targetItem = el;
				break;
			}
		}
		if (!targetItem) return;

		let newTarget;
		const targetRect = targetItem.getBoundingClientRect();
		const midY = targetRect.top + targetRect.height / 2;
		if (e.clientY < midY) {
			newTarget = targetItem;
		} else {
			newTarget = targetItem.nextElementSibling;
			if (newTarget === shadow) {
				newTarget = newTarget.nextElementSibling;
			}
		}

		if (newTarget === _dragState.target) return;

		if (!item.classList.toggle('disallowed', !canDragTo(item, newTarget, container))) {
			_dragState.target = newTarget;
			if (newTarget === null) {
				container.appendChild(shadow);
			} else {
				container.insertBefore(shadow, newTarget);
			}
		}
	}

	function _onPointerUp() {_endDrag(false);}

	/**
	 * 结束拖拽，恢复 DOM 并在必要时执行移动
	 * @param {boolean=} abort - 是否强制取消（不执行移动）
	 */
	function _endDrag(abort) {
		_removeGlobalListeners();

		const {item, shadow, target} = _dragState;
		_dragState = null;

		// 恢复元素样式
		item.classList.remove("ds-drag");
		item.style.position = '';
		item.style.zIndex = '';
		item.style.pointerEvents = '';
		item.style.left = '';
		item.style.top = '';
		item.style.width = '';
		item.style.height = '';
		item.style.margin = '';

		if (abort || target === undefined) {
			shadow.remove();
			return;
		}

		shadow.replaceWith(item);
		onMovedTo(item, target, container);
	}

	/**
	 * 启用或禁用排序
	 * @param {boolean} enabled1
	 */
	function setEnabled(enabled1) {
		enabled = !!enabled1;
		container[enabled?"addEventListener":"removeEventListener"]('pointerdown', _onPointerDown);
		if (!enabled && _dragState) _endDrag(true);
	}

	return {setEnabled}
}