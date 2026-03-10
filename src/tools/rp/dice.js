
/**
 *
 * @type {AiChat.FunctionTool}
 * @private
 */
export const dice = {
	name: "roll_dice",
	description: "扔骰子",
	parameters: {
		type: "object",
		properties: {
			rolls: {
				type: "array",
				description: "一次掷骰",
				minItems: 1,
				maxItems: 9,
				items: {
					type: "object",
					properties: {
						count: {
							type: "integer",
							maximum: 100,
							description: "骰子个数",
						},
						sides: {
							type: "integer",
							minimum: 2,
							description: "骰子面数",
						},
						modifier: {
							type: "integer",
							description: "修正加值",
							default: 0
						},
					},
					required: ["count", "sides"]
				}
			}
		},
		required: ["rolls"]
	},

	script(parameters, response) {
		const rolls = response.rolls = [];

		return parameters.rolls.map(({count, sides, modifier = 0}) => {
			if (count < 1 || count > 100 || sides <= 1) throw new Error("无效的输入");

			let score = modifier;
			const dices = [];
			for (let i = 0; i < count; i++) {
				const roll = Math.floor(Math.random() * sides) + 1;
				score += roll;
				dices.push(roll);
			}

			rolls.push({ exp: count+"d"+sides+(modifier>0?"+"+modifier:modifier||""), dices, score });
			return score;
		});
	},
	keyFunc(keys, {rolls}) {
		keys.push(rolls);
	},
	renderer({rolls}) {
		return <div className={"dice-list"}>
			{rolls.map(res => (
				<div className="dice-row">
					🎲{res.exp}
					<span className="dice-detail">[{res.dices.join('+')}]</span>
					<span style={{margin: "0 4px"}}>=</span>
					<span className="dice-result">{res.score}</span>
				</div>
			))}
		</div>;
	}
};
