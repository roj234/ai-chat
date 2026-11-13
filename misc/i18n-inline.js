import t from "@babel/types";

export default function (_, options) {
	return {
		name: 'i18n-inline',
		visitor: {
			CallExpression(path, state) {
				const { node } = path;
				if (!t.isIdentifier(node.callee, { name: 'TR' })) return

				const binding = path.scope.getBinding('TR');
				if (binding?.kind !== "module") return false;

				const source = binding.path.parent.source.value;
				if (!source.endsWith("/common/i18n.js")) return false;

				const [def, id] = node.arguments;
				if (!t.isStringLiteral(id) || !t.isStringLiteral(def)) {
					throw path.buildCodeFrameError('T() 只接受两个字面量')
				}

				if (!options.i18n) path.replaceWith(def);
			},
		},
	}
}