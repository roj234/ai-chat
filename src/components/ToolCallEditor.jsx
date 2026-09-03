import './ToolCallCard.css';
import {$state, $update, $watch, appendChildren, isPureObject, unconscious} from "unconscious";
import {JsonEditor} from "./JsonEditor.jsx";
import {runTools, TOOL_NAME, tools, toolScriptRegistry} from "../toolset.js";
import {validateAndShowError} from "unconscious/common/json-schema-utils.js";
import {EVENT_BUS, selectedConversation, updateMessageUI} from "../states.js";
import {stringify} from "/common/json5-stringify.js";

/**
 *
 * @param {{
 * tool: OpenAI.ToolCall,
 * message: AiChat.AssistantMessage,
 * idx: number
 * }} props
 * @return {JSX.Element}
 */
export function ToolCallEditor(props) {
    const { tool: {
        function: fn
    }, message } = props;

    const formatJson = (s) => {
        try {
            return stringify(typeof s === "string" ? JSON.parse(s) : s, null, 2);
        } catch {
            return s;
        }
    }

    const index = () => message.tool_calls.indexOf(props.tool);

    const toolName = $state(fn.name);
    const nameError = $state();

    const initializeHtml = () => {
        const
            input = $state(),
            output = $state(),
            inputState = $state(),
            toolCallId = $state(props.tool.id);
        const reset = () => {
            toolName.value = fn.name;
            toolCallId.value = props.tool.id;
            input.value = formatJson(fn.arguments);
            output.value = formatJson(message.tool_responses[index()]?.content);
        };

        reset();
        $watch(toolName, () => {
            const def = toolScriptRegistry[unconscious(toolName)];
            nameError.value = !def;
        });

        let saveBtn;
        appendChildren(base, <>
            <div className="tool-body">
                <div className="args-title">
                    调用ID
                    <span className={"spacer"}></span>
                    <button className={"ri-dice-line ghost"} title={"随机生成"} onClick={e => {
                        toolCallId.value = Math.random().toString(36).slice(3);
                    }}></button>
                </div>
                <div className={"input-warp"}>
                    <input className={"text-input"} placeholder={"不能为空，点击骰子随机生成"} class:invalid={() => !unconscious(toolCallId)} value={toolCallId}
                           onInput={({target}) => toolCallId.value = target.value}/>
                </div>
            </div>
            <div className="tool-body">
                <div className="args-title">参数</div>
                <JsonEditor value={input} state={inputState}/>
                <div className={"args error"} style:display={() => inputState.error ? "" : "none"}>{() => inputState.error}</div>
            </div>
            <div className="tool-body">
                <div className="args-title">返回值 (可编辑, 可置空)<span className={"spacer"}></span>
                    <button className={"rerun-btn"}
                            disabled={() => !inputState.obj} onClick={({target}) => {
                        const idx = index();

                        const oldName = fn.name;
                        const oldArg = fn.arguments;
                        fn.name = unconscious(toolName);
                        fn.arguments = JSON.stringify(inputState.obj);

                        target.disabled = true;
                        target.innerText = "运行中";
                        runTools(message, unconscious(selectedConversation), idx, true).then(reset).finally(() => {
                            target.disabled = false;
                            target.innerText = "运行";
                            fn.name = oldName;
                            fn.arguments = oldArg;
                        });
                    }}>
                        运行
                        <span className={"tooltip"}>{"以当前参数运行工具\n会覆写返回值"}</span>
                    </button>
                </div>
                <JsonEditor value={output}/>
            </div>
            <div className="tool-body">
                <div style={"display:flex;gap:8px"}>
                    <button className={"btn danger"} onClick={() => {
                        const idx = index();
                        message.tool_calls.splice(idx, 1);
                        message.tool_responses.splice(idx, 1);
                        if (!message.tool_calls.length) {
                            delete message.tool_calls;
                            delete message.tool_responses;
                        }
                        $update(updateMessageUI);
                    }}>
                        删除
                    </button>
                    <span className={"spacer"}></span>
                    <button className={"btn secondary"} onClick={reset}>
                        重置
                        <span className={"tooltip"}>恢复上次保存的值</span>
                    </button>
                    <button className={"btn primary"} ref={saveBtn} onClick={({target}) => {
                        fn.name = unconscious(toolName);
                        fn.arguments = JSON.stringify(inputState.obj);

                        const outputValue = unconscious(output);
                        message.tool_responses[index()] = outputValue ? {
                            success: true,
                            time: Date.now(),
                            content: outputValue,
                            [TOOL_NAME]: fn.name
                        } : {
                            [TOOL_NAME]: fn.name
                        };

                        base.open = false;
                    }}>
                        保存
                    </button>
                </div>
            </div>
        </>);

        $watch([nameError, inputState], () => {
            const obj = inputState.obj;
            if (obj != null) {
                if (!isPureObject(obj)) {
                    inputState.value = {error: "顶层必须是JSON对象"};
                    return;
                }

                const schema = toolScriptRegistry[unconscious(toolName)]?.parameters;
                if (schema) {
                    const error = validateAndShowError(obj, schema);
                    if (error) inputState.value = {error};
                }
            }
        });

        $watch([nameError, inputState, toolCallId], () => {
            saveBtn.disabled = unconscious(nameError) || inputState.error || !unconscious(toolCallId);
        });
    };

    const base = <details className={"tool-call editing"} onClick.once={initializeHtml}>
        <summary className="tool-header">
            <div className="args-title">编辑工具</div>
            <div className={"input-warp"}>
                <input className={"text-input"} class:invalid={nameError} value={toolName} list={"DL-tools"}
                       onInput={({target}) => toolName.value = target.value}/>
            </div>
        </summary>
    </details>;

    return base;
}

EVENT_BUS.on('load', (app) => {
    app.append(<datalist id="DL-tools">{Object.keys(toolScriptRegistry).map(item =>
        <option value={item}>{tools[item]?.function.description?.slice(0, 80)}</option>)
    }</datalist>);
});