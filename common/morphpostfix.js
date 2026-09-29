
const copiedAttributes = ['className', 'style'];

/**
 * 结构一致就原地更新 oldNode，返回 false 表示分叉，调用方需要替换掉它
 * @param {Node} oldNode
 * @param {Node} newNode
 * @return {boolean}
 */
const patchNode = (oldNode, newNode) => {
	if (oldNode.nodeType !== newNode.nodeType) return false;

	if (oldNode.nodeType === Node.TEXT_NODE) {
		if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
		return true;
	}

	if (oldNode.tagName !== newNode.tagName) return false;

	for (const attr of copiedAttributes) {
		if (newNode[attr] !== oldNode[attr])
			newNode[attr] = oldNode[attr];
	}

	patchChildren(oldNode, newNode);
	return true;
};

/**
 * 从第一个子节点开始同步比较，一致的前缀沿用旧节点，分叉点之后的部分整体替换
 * @param {Node} oldParent
 * @param {Node} newParent
 */
export const patchChildren = (oldParent, newParent) => {
	const oldNodes = oldParent.childNodes;
	const newNodes = newParent.childNodes;

	const lim = Math.min(oldNodes.length, newNodes.length);
	let i = 0;
	while (i < lim && patchNode(oldNodes[i], newNodes[i])) i++;

	if (i === oldNodes.length && i === newNodes.length) return;

	// 删除分叉点之后的老节点
	while (oldNodes.length > i) oldNodes[oldNodes.length - 1].remove();

	// 补上新节点：每次都取下标 i，被移走的节点会让后面的补上来
	while (newNodes.length > i) oldParent.appendChild(newNodes[i]);
};
