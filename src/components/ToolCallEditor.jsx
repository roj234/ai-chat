import './ToolCallCard.css';
import {$state, $update, $watch, appendChildren, isPureObject, unconscious} from "unconscious";
import {JsonEditor} from "./JsonEditor.jsx";
import {runTools, TOOL_NAME, toolScriptRegistry} from "../skills.js";
import {updateMessageUI} from "./MessageList.jsx";
import {validateAndShowError} from "unconscious/common/json-schema-utils.js";
import {onLoad} from "../plugin.js";
import {selectedConversation} from "../states.js";

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
            return JSON.stringify(typeof s === "string" ? JSON.parse(s) : s, null, 2);
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
                <div className="args-title">调用ID</div>
                <div className={"input-warp"}>
                    <input className={"text-input"} class:invalid={() => !unconscious(toolCallId)} value={toolCallId}
                           onInput={({target}) => toolCallId.value = target.value}/>
                    {() => !unconscious(toolCallId) ? <div className={"input-warning"}>不能为空</div> : null}
                </div>
            </div>
            <div className="tool-body">
                <div className="args-title">参数</div>
                <JsonEditor value={input} state={inputState}/>
                <div className={"args error"} style:display={() => inputState.error ? "" : "none"}>{() => inputState.error}</div>
            </div>
            <div className="tool-body">
                <div className="args-title">返回值</div>
                <JsonEditor value={output}/>
            </div>
            <div className="tool-body">
                <div className="args-title">小心修改参数</div>
                <div style={"display:flex;gap:8px"}>
                    <button className={"btn warning"} onClick={reset}>重置</button>
                    <button className={"btn primary"} ref={saveBtn} onClick={({target}) => {
                        fn.name = unconscious(toolName);
                        fn.arguments = JSON.stringify(inputState.obj);

                        const outputValue = unconscious(output);
                        message.tool_responses[index()] = outputValue ? {
                            success: true,
                            time: Date.now(),
                            content: outputValue,
                            [TOOL_NAME]: fn.name
                        } : {};

                        base.open = false;
                    }}>
                        保存
                    </button>
                    <button className={"btn warning"} title={"以当前参数（无需保存）执行工具"}
                            disabled={() => !inputState.obj} onClick={({target}) => {
                        const idx = index();

                        const oldName = fn.name;
                        const oldArg = fn.arguments;
                        fn.name = unconscious(toolName);
                        fn.arguments = JSON.stringify(inputState.obj);

                        target.disabled = true;
                        runTools(message, unconscious(selectedConversation), idx, true).then(reset).finally(() => {
                            target.disabled = false;
                            fn.name = oldName;
                            fn.arguments = oldArg;
                        });
                    }}>
                        执行
                    </button>
                    <button className={"btn danger"} onClick={() => {
                        const idx = index();
                        message.tool_calls.splice(idx, 1);
                        message.tool_responses.splice(idx, 1);
                        $update(updateMessageUI);
                    }}>
                        删除
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

    const base = <details className={"tool-call tool-pending"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"编辑工具"}>
            <div className="args-title">工具名称</div>
            <div className={"input-warp"}>
                <input className={"text-input"} class:invalid={nameError} value={toolName} list={"tce-tool-names"}
                       onInput={({target}) => toolName.value = target.value}/>
                {() => unconscious(nameError) ? <div className={"input-warning"}>工具名称无效</div> : null}
            </div>
        </summary>
    </details>;

    return base;
}

onLoad((app) => {
    app.append(<datalist id="tce-tool-names">{Object.keys(toolScriptRegistry).map(item =>
        <option value={item} />)
    }</datalist>);
})