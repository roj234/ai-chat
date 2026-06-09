import './ToolCallCard.css';
import {runTools, TOOL_NAME, toolScriptRegistry} from "../skills.js";
import {config, messages, selectedConversation} from "../states.js";
import {$state, $update, $watch, appendChildren, isReactive, unconscious} from "unconscious";
import {MORPH_CHILD_FUNCTION} from "../utils/utils.js";
import morphdom from "morphdom";
import {highlight, highlightJsonLike} from "../markdown/highlight.js";

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

    const {name} = tool.function;
    const response_content = $state();

    const initializeHtml = () => {
        base._content = response_content;
        response_content.value = message.tool_responses[idx]?.content;

        let input, output;

        appendChildren(base, <>
                <div className="tool-body">
                    <div className="args-title">参数</div>
                    <pre className="args" ref={input}></pre>
                </div>
                <div className="tool-body">
                    <div className="args-title">返回值
                        {isReactive(tool) ? null : <button className={"rerun-btn"} onClick={({target}) => {
                            target.disabled = true;
                            runTools(message, unconscious(selectedConversation), idx, true).then(() => {
                                $update(messages);
                            }).finally(() => {
                                target.disabled = false;
                            });
                        }} title={"执行该工具，返回值可能改变\n警告：无法撤销工具导致的外部更改"}>
                        重新执行</button>}
                    </div>
                    <pre ref={output} className="args" dangerouslySetInnerHTML={highlightJsonLike(response_content.value ?? "/* 尚未运行 */")}></pre>
                    {() => Array.isArray(response_content.value) ? <div className="gallery">{response_content.value.map(part => {
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

            $watch(response_content, () => {
                morph(output, response_content.value);
            }, false);
        }
    };

    const base = <details className={"tool-call"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"展开工具参数"}><b>{name}</b></summary>
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
    const {success, content, time, [TOOL_NAME]: tool_name} = message.tool_responses[idx] || {};
    const is_errored = false === success;

    const classList = element.classList;
    classList.toggle("tool-error", is_errored);

    const interactive = toolScriptRegistry[tool.function.name]?.interactive;
    let pending = interactive === "secure" && null == time;
    classList.toggle("tool-pending", pending);

    const setAuditState = (target, allowUnsafe) => {
        runTools(message, unconscious(selectedConversation), idx, allowUnsafe).then(() => {
            $update(messages);
        });
    };

    const pend_class_name = "pend-expand";
    if (message.finish_reason && pending && !classList.contains(pend_class_name)) {
        classList.add(pend_class_name);

        element.open = true;
        element.click();
        element.append(<div className={"tool-body"}>
            <div className="args-title">敏感操作需要批准</div>
            <div style={"display:flex;gap:8px"}>
                <button className={"btn warning"} onClick={({target}) => {
                    setAuditState(target, true);
                }}>
                    允许一次
                </button>
                <button className={"btn primary"} onClick={({target}) => {
                    target.previousElementSibling.click();

                    const grantedTools = selectedConversation.grantedTools;
                    if (!grantedTools) selectedConversation.grantedTools = new Set([tool_name]);
                    else grantedTools.add(tool_name);
                }} title={"在该对话中一直允许"}>
                    一直允许
                </button>
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
        element._content.value = content ?? (time ? "/* 正在运行 */" : "/* 尚未运行 */");
    } else {
        if (message === messages[messages.length - 1] && is_errored) {
            element.open = true;
            element.click(); // call initializeHtml
        }
    }
}