import './ToolCallCard.css';
import {$state, $update, appendChildren, unconscious} from "unconscious";
import {JsonEditor} from "./JsonEditor.jsx";
import {toolScriptRegistry} from "../skills.js";
import {updateMessageUI} from "./MessageList.jsx";

/**
 *
 * @param {{
 * tool: OpenAI.ToolCall,
 * message: AiChat.AssistantMessage,
 * idx: number
 * }} props
 * @return {JSX.Element}
 * @constructor
 */
export function ToolCallEditor(props) {
    const { tool: {
        function: fn
    }, message, idx } = props;

    const formatJson = (s) => {
        try {
            return JSON.stringify(typeof s === "string" ? JSON.parse(s) : s, null, 2);
        } catch {
            return s;
        }
    }

    const toolName = $state(fn.name);

    const initializeHtml = () => {
        const
            input = $state(),
            output = $state();
        const reset = () => {
            input.value = formatJson(fn.arguments);
            output.value = formatJson(message.tool_responses[idx].content);
        };

        reset();

        appendChildren(base, <>
                <div className="tool-body">
                    <div className="args-title">参数</div>
                    <JsonEditor value={input}/>
                </div>
                <div className="tool-body">
                    <div className="args-title">返回值</div>
                    <JsonEditor value={output}/>
                </div>
                <div className="tool-body">
                    <div className="args-title">小心修改参数</div>
                    <div style={"display:flex;gap:8px"}>
                        <button className={"btn warning"} onClick={reset}>重置</button>
                        <button className={"btn primary"} onClick={({target}) => {
                            let error;
                            if (!toolScriptRegistry[toolName.value]) {
                                error = "工具ID无效";
                            }

                            const inputValue = unconscious(input);
                            try {
                                JSON.parse(inputValue);
                            } catch {
                                error = "入参不合法";
                            }

                            if (!error) {
                                fn.name = toolName.name;
                                fn.arguments = inputValue;

                                const outputValue = unconscious(output);
                                message.tool_responses[idx] = outputValue ? {
                                    success: true,
                                    time: Date.now(),
                                    content: outputValue
                                } : {};

                                error = "已保存";
                            }

                            target.textContent = error;
                            target.disabled = true;
                            setTimeout(() => {
                                target.textContent = "保存";
                                target.disabled = false;
                            }, 1000);
                        }}>
                            保存
                        </button>
                        <button className={"btn danger"} onClick={({target}) => {
                            message.tool_calls.splice(idx, 1);
                            message.tool_responses.splice(idx, 1);
                            $update(updateMessageUI);
                        }}>
                            删除
                        </button>
                    </div>
                </div>
            </>
        );
    };

    const base = <details className={"tool-call tool-pending"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"编辑工具"}>
            工具ID: <input className={"text-input"} value={toolName} />
        </summary>
    </details>;

    return base;
}