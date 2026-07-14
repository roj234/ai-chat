
/**
 *
 * @type {AiChat.FunctionTool}
 * @private
 */
export const RollDice = {
	name: "RollDice",
	description: "Produce random outcomes for probability-based events. Use only when an *actual random roll* is needed, not for deterministic math.",
	parameters: {
		type: "object",
		properties: {
			rolls: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: {
						count: {
							type: "integer",
							minimum: 1,
							maximum: 100,
						},
						sides: {
							type: "integer",
							minimum: 2,
						},
						modifier: {
							type: "integer",
							default: 0
						},
						label: {
							type: "string",
							//description: "Don't place expression (2d6) here",
							//example: "理智检定"
						},
						hidden: {
							type: "boolean",
							default: false
						}
					},
					required: ["count", "sides"]
				}
			}
		},
		required: ["rolls"]
	},

	script(parameters, response) {
		const rolls = response.rolls = [];

		return parameters.rolls.map(({count, sides, modifier = 0, label = "", hidden}) => {
			let score = modifier;
			const dices = [];
			for (let i = 0; i < count; i++) {
				const roll = Math.floor(Math.random() * sides) + 1;
				score += roll;
				dices.push(roll);
			}

			if (!hidden) rolls.push({ exp: count+"d"+sides+(modifier>0?"+"+modifier:modifier||""), dices, score });
			return [score+" = "+dices.join("+")+(label&&" ("+label+")")];
		}).join("\n");
	},
	keyFunc(keys, {rolls}) {
		keys.push(rolls);
	},
	renderer({rolls}) {
		return <div className={"rp-dice"}>
			{rolls.map(res => (
				<div>
					🎲{res.exp}
					<span className="ellipsis">[{res.dices.join('+')}]</span>
					<span style={{margin: "0 4px"}}>=</span>
					<strong>{res.score}</strong>
				</div>
			))}
		</div>;
	}
};
