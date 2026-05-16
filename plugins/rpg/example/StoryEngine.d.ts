namespace Schema {
    type StoryEngine = {
        reasoning: string;  // 展开思考和推理，设想接本轮非玩家角色（NPC）的行为，发生在何时、何地、做出什么动作，产生什么行动。时间需要前进
        location: string;
        date: string;  // 日期与时间
        story: Array<{
            character: "narrator" | string;  // 若是角色行动，填写姓名
            content: string;  // 描写文字或对话内容，可以使用 markdown
            pose?: string;  // 可选：角色的表情/动作
        }>;
        summary: string;  // 200字以内描述本轮发生了什么事情
        variables: Array<{
            name: string;
            action: "get" | "set" | "add" | "append" | "merge" | "delete";
            value?: any;
        }>;  // 变量更新
        suggested_choices?: Array<string>;  // 如果该回合有{{user}}参与，为{{user}}提供的选项建议（对话或行动），对话用“”包裹，行动不包裹。
    }
}