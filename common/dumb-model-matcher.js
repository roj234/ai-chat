
const getWords = str => (str.match(/[A-Za-z]+/g) || []).map(w => w.toLowerCase());

export function isSameModel(source, target) {
	const srcWords = getWords(source);
	const tgtWords = getWords(target);

	const srcSet = new Set(srcWords);
	const tgtSet = new Set(tgtWords);
	return tgtWords.every(w => srcSet.has(w)) || srcWords.every(w => tgtSet.has(w));
}
