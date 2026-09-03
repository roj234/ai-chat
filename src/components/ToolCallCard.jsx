import './ToolCallCard.css';
import {getToolInteractiveLevel, runTools, TOOL_IS_RUNNING, TOOL_NAME, toolScriptRegistry} from "../toolset.js";
import {config, messages, selectedConversation} from "../states.js";
import {$state, $update, $watch, appendChildren, debugSymbol, isReactive, unconscious} from "unconscious";
import {MORPH_CHILD_FUNCTION} from "../utils/utils.js";
import morphdom from "morphdom";
import {highlight, highlightJsonLike} from "../markdown/highlight.js";
import SimpleModal from "./SimpleModal.jsx";
import {markMessageDirty, updateConversation} from "../database.js";
import {BorderSpinner} from "./BorderSpinner.jsx";

const RESP_SYMBOL = debugSymbol("ToolResponseUpdate");

const formatDuration = ms => {
    if (!ms) return '—';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
    return ms + 'ms';
}

/**
 *
 * @param {{
 * tool: OpenAI.ToolCall,
 * message: AiChat.AssistantMessage,
 * idx: number
 * }} props
 * @return {JSX.Element}
 */
export function ToolCallCard(props) {
    const { tool, message, idx } = props;

    const name = message.tool_responses?.[idx]?.[TOOL_NAME] || tool.function.name;
    const reactiveResponse = $state();
    let toolResponse = message.tool_responses[idx];

    const initializeHtml = () => {
        base[RESP_SYMBOL] = reactiveResponse;

        const input = <pre className="args" />, output = <pre className="args" />;
        const duration = $state();

        appendChildren(base, <>
            <div className="tool-body">
                <div className="args-title">参数</div>
                {input}
            </div>
            <div className="tool-body">
                <div className="args-title">结果 {duration}
                    {isReactive(tool) ? null : <button className={"rerun-btn"} onClick={({target}) => {
                        const runOperation = () => {
                            target.disabled = true;
                            markMessageDirty(message);
                            runTools(message, unconscious(selectedConversation), idx, true).then(() => {
                                $update(messages);
                            }).finally(() => {
                                target.disabled = false;
                            });
                        }

                        if (toolResponse?.[TOOL_IS_RUNNING] && null == toolResponse.content) {
                            SimpleModal({
                                title: "并发警告",
                                message: "工具当前标记为【正在运行】，重复执行【可能】造成并发竞态，确认？",
                                onConfirm: runOperation
                            });
                        } else {
                            runOperation();
                        }
                    }}>
                        重新执行<span
                        className={"tooltip"}>{(toolScriptRegistry[name]?.undo ? `撤销工具的副作用并重新运行。` : `该工具不支持撤销副作用。
可能导致状态不一致或数据丢失。`)}</span></button>}
                </div>
                {output}
            </div>
        </>);

        // 什么都ondemand，算了，反正【我觉得爽也是一种优秀】
        if (isReactive(tool)) {
            $watch(tool, () => {
                highlight(tool.function.arguments, "json", input);
            });
        } else {
            const renderOutput =  toolScriptRegistry[name]?.renderOutput;

            $watch(reactiveResponse, () => {
                toolResponse = message.tool_responses[idx];
                duration.value = toolResponse && ("("+formatDuration(toolResponse.duration)+")");
                const isRunning = toolResponse?.[TOOL_IS_RUNNING];

                if (toolResponse && renderOutput && !base.classList.contains("pending")) {
                    try {
                        const result = renderOutput(toolResponse, output, isRunning, tool, message);
                        if (result !== false) {
                            output.replaceWith(result);
                            return;
                        }
                        base.lastElementChild.lastElementChild.replaceWith(output);
                    } catch (e) {
                        console.error("工具内容渲染失败", e);
                    }
                }

                const tmpContent = unconscious(toolResponse?.content) ?? (isRunning ? "/* 正在运行 */" : "/* 尚未运行 */");
                if (Array.isArray(tmpContent)) {
                    const elements = [];
                    for (let part of tmpContent) {
                        if (part.type === 'text') {
                            elements.push(part.text);
                        } else if (part.type === 'image_url') {
                            const url = part.image_url?.url;
                            url && elements.push(<img title={url.name} src={typeof url === "string" ? url : url.toUrl()}/>);
                        } else {
                            elements.push(<div dangerouslySetInnerHTML={highlightJsonLike(tmpContent)} />);
                        }
                    }
                    output.replaceChildren(<div className={"gallery"}>{elements}</div>);
                } else {
                    morphdom(output, `<pre class="args">${highlightJsonLike(tmpContent)}</pre>`);
                }
            });

            const renderInput =  toolScriptRegistry[name]?.renderInput;
            if (renderInput) {
                try {
                    const result = renderInput(toolResponse || {}, input, tool, message);
                    if (result !== false) {
                        if (result instanceof Node)
                            input.replaceWith(result);
                        return;
                    }
                } catch (e) {
                    console.error("工具内容渲染失败", e);
                }
            }
            // 这个函数自带JSON格式化，但是不应该在流式响应的时候使用它，不是么
            input.innerHTML = highlightJsonLike(tool.function.arguments);
        }
    };

    let title;
    try {
        title = !isReactive(tool) && toolScriptRegistry[name]?.title?.(tool, message.tool_responses[idx] || {});
    } catch (e) {
        console.error("工具标题渲染失败", e);
    }
    const base = <details className={"tool-call"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"展开工具参数\n"+name}>{title || name}</summary>
    </details>;

    morphToolCallCard(props, base);
    base[MORPH_CHILD_FUNCTION] = morphToolCallCard;

    if (config.expandToolCall && isReactive(tool)) {
        base.open = true;
        base.click();
    }
    return base;
}

/**
 *
 * @param {OpenAI.ToolCall} tool
 * @param {AiChat.AssistantMessage} message
 * @param {number} idx
 * @param {HTMLDetailsElement} element
 */
const morphToolCallCard = ({tool, message, idx}, element) => {
    const conv = unconscious(selectedConversation);
    const resp = message.tool_responses[idx] || {};
    const {success, content, [TOOL_NAME]: tool_name} = resp;

    const is_running = !!resp[TOOL_IS_RUNNING];
    const is_errored = false === success;
    const is_success = true === success;

    const secure = getToolInteractiveLevel(resp, tool, conv);
    const pending = !!(tool_name && secure !== true && !is_running && null == success);
    const is_secure_pending = !!(pending && secure);

    // 清空状态类并打上当前唯一确定的状态 Class
    const classList = element.classList;

    classList.toggle("running", is_running);
    classList.toggle("t-error", is_errored);
    classList.toggle("secure", is_secure_pending);
    classList.toggle("pending", pending);
    classList.toggle("t-success", is_success);

    const needApproval = "need-approval";
    if (message.finish_reason && pending && !classList.contains(needApproval)) {
        classList.add(needApproval);

        let rejectReasonText;
        const setAuditState = (target, allowUnsafe) => runTools(message, conv, idx, allowUnsafe, rejectReasonText).then(() => $update(messages));
        const granted = conv.grantedTools?.has(tool_name);

        element.open = true;
        element.click();
        element.append(<div className={"tool-body"+(secure?" audit":"")}>
            <div className="args-title">{secure ? "敏感操作需要批准" : "工具执行已暂停"}</div>
            <div className={"audit-box"}>
                <button className={"btn primary"} onClick={({target}) => {
                    setAuditState(target, true);
                }}>
                    {secure ? "本次允许" : "执行"}
                </button>
                {secure && <button className={"btn warning"} disabled={granted} onClick={({target}) => {
                    const grantedTools = conv.grantedTools;
                    if (!grantedTools) conv.grantedTools = new Set([tool_name]);
                    else grantedTools.add(tool_name);
                    updateConversation(conv);

                    target.previousElementSibling.click();
                }}>
                    总是允许
                    <div className={"tooltip"}>{granted ? "已在当前对话中允许该工具" : "当前对话中不再询问"}</div>
                </button>}
                <button className={"btn danger"} onClick={({target}) => {
                    setAuditState(target, false);
                }}>
                    拒绝
                </button>
                <div className={"input-warp"}>
                    <input className={"text-input"} placeholder={"拒绝理由 (可选)"}
                           onInput={({target}) => rejectReasonText = target.value}/>
                </div>
            </div>
        </div>)
        return;
    } else if (!pending && classList.contains(needApproval)) {
        classList.remove(needApproval);
        element.lastElementChild.remove();
    }

    const title = element.firstElementChild;
    const spinner = title.querySelector(".border-spinner");
    if (is_running) {
        if (!spinner) title.prepend(<BorderSpinner color={"#818cf8"} borderRadius={"4px"} />);
    } else {
        spinner?.remove();
    }

    const updateResponse = element[RESP_SYMBOL];
    if (updateResponse) {
        updateResponse.value = content ?? !resp[TOOL_IS_RUNNING];
    } else {
        if (message === messages.at(-1) && is_errored) {
            element.open = true;
            element.click(); // call initializeHtml
        }
    }
}