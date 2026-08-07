import './ToolCallCard.css';
import {runTools, TOOL_IS_RUNNING, TOOL_NAME, toolScriptRegistry} from "../toolset.js";
import {config, messages, selectedConversation} from "../states.js";
import {$state, $update, $watch, appendChildren, isReactive, unconscious} from "unconscious";
import {MORPH_CHILD_FUNCTION} from "../utils/utils.js";
import morphdom from "morphdom";
import {highlight, highlightJsonLike} from "../markdown/highlight.js";
import SimpleModal from "./SimpleModal.jsx";
import {markMessageDirty, updateConversation} from "../database.js";

const morph = (input, data) => morphdom(input, `<pre class="args">${highlightJsonLike(data)}</pre>`);

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
    const toolContent = $state();

    const initializeHtml = () => {
        const toolResponse = message.tool_responses[idx];

        base._content = toolContent;
        toolContent.value = toolResponse?.content;

        let input, output;

        appendChildren(base, <>
                <div className="tool-body">
                    <div className="args-title">参数</div>
                    <pre className="args" ref={input}></pre>
                </div>
                <div className="tool-body">
                    <div className="args-title">返回值
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
                        重新执行<span className={"tooltip"}>{`撤销工具调用并重新执行。
某些工具不支持撤销，此时会重复执行，
可能导致状态不一致或数据丢失。`}</span></button>}
                    </div>
                    <pre ref={output} className="args" dangerouslySetInnerHTML={highlightJsonLike(unconscious(toolContent) ?? (toolResponse?.[TOOL_IS_RUNNING] ? "/* 正在运行 */" : "/* 尚未运行 */"))}></pre>
                    {() => Array.isArray(unconscious(toolContent)) ? <div className="gallery">{unconscious(toolContent).map(part => {
                        const url = part.image_url?.url;
                        return url && <img src={typeof url === "string" ? url : url.toUrl()}/>;
                    })}</div> : null}
                </div>
            </>
        );

        // 什么都ondemand，算了，反正【我觉得爽也是一种优秀】
        if (isReactive(tool)) {
            $watch(tool, () => {
                highlight(tool.function.arguments, "json", input);
            });
        } else {
            // 这个函数自带JSON格式化，但是不应该在流式响应的时候使用它，不是么
            input.innerHTML = highlightJsonLike(tool.function.arguments);

            $watch(toolContent, () => {
                morph(output, unconscious(toolContent));
            }, false);
        }
    };

    let title;
    try {
        title = !isReactive(tool) && toolScriptRegistry[name]?.title?.(tool, message.tool_responses[idx] || {});
    } catch (e) {
        console.error("工具标题生成异常", e);
    }
    const base = <details className={"tool-call"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"展开工具参数\n"+name}><b>{title || name}</b></summary>
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
    const {success, content, time, [TOOL_NAME]: tool_name} = resp;

    const is_errored = false === success;

    const classList = element.classList;
    classList.toggle("tool-error", is_errored);

    const secure = toolScriptRegistry[tool_name]?.interactive;
    let pending = tool_name && secure !== true && null == time && null == success;
    classList.toggle("pending", pending);
    classList.toggle("secure", !!(pending && secure));

    const setAuditState = (target, allowUnsafe) => runTools(message, conv, idx, allowUnsafe).then(() => $update(messages));

    const pend_class_name = "pend-expand";
    if (message.finish_reason && pending && !classList.contains(pend_class_name)) {
        classList.add(pend_class_name);

        const granted = conv.grantedTools?.has(tool_name);

        element.open = true;
        element.click();
        element.append(<div className={"tool-body"}>
            <div className="args-title">{secure ? "需要批准敏感操作" : "工具执行已暂停"}</div>
            <div style={"display:flex;gap:8px"}>
                <button className={"btn warning"} onClick={({target}) => {
                    setAuditState(target, true);
                }}>
                    允许
                    <div className={"tooltip"}>仅本次允许</div>
                </button>
                {secure && <button className={"btn primary"} disabled={granted} onClick={({target}) => {
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
            </div>
        </div>)
        return;
    } else if (!pending && classList.contains(pend_class_name)) {
        classList.remove(pend_class_name);
        element.lastElementChild.remove();
    }

    const is_ever_opened = element.childElementCount > 1;
    if (is_ever_opened) {
        element._content.value = content ?? (resp[TOOL_IS_RUNNING] ? "/* 正在运行 */" : "/* 尚未运行 */");
    } else {
        if (message === messages.at(-1) && is_errored) {
            element.open = true;
            element.click(); // call initializeHtml
        }
    }
}