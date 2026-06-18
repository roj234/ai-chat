namespace Schema {
    type StoryTurn = {
        /** 展开思考和推理，设想本轮角色的行为，发生在何时、何地、做出什么动作，产生什么行动。时间需要前进 */
        reasoning: string;
        location: string;
        /** 日期与时间 */
        date: string;
        /** @items: [1, Infinity] */
        story: {
            /** 若是角色行动，填写姓名 */
            character: any;
            /** 描写文字或对话内容，可以使用 markdown */
            content: string;
            /** 可选：角色的表情/动作 */
            pose?: string;
        }[];
        /** 200字以内描述本轮发生了什么事情 */
        summary: string;
        /** Update structured state such as inventories, HP, scores, flags, and other simulation data.
         Variable naming: camelCase

         Operation semantics:

         - set     Overwrite: accepts any type. Missing intermediate objects are auto-created.
         Use `/-` as the final segment to append to an array (eg: `/inventory/items/-`).
         - plus    Numeric delta: target must be a number; `value` is added as an increment (negative = decrement). If the path does not exist, baseline is 0.
         - delete  Remove target: omit `value`.
         Array element target will be spliced: delete "/inventory/items/1" -> splice index 1

         Return value: the new value at the pointer after the operation completes. */
        variables: {
            operation: "set" | "plus" | "delete";
            /**
             * JSON Pointer like "/player/hp" or "/inventory/items/0";
             * @pattern: ^/[a-zA-Z0-9/]+-?$
             */
            pointer: any;
            /** One sentence human-readable summary of why change it. */
            explanation?: string;
            /** Omit for delete */
            value?: {} | any[] | string | number | boolean | null;
        }[];
        /**
         * 为{{user}}提供的选项建议（对话或行动），对话用“”包裹，行动不包裹。
         * @example: ["拔出腰间的生锈铁剑，正面迎战无头骑士。","“今天天气真不错，对吧？”"]
         * @items: [0, 4]
         */
        suggested_choices?: string[];
    }
}