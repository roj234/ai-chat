import './ToolCallCard.css';
import {runTools} from "../skills.js";
import {config, messages} from "../states.js";
import {$state, $update, $watch, appendChildren, isReactive} from "unconscious";
import {highlightJsonLike, MORPH_CHILD_FUNCTION, throttled} from "../utils.js";
import morphdom from "morphdom";
import {updateMessageUI} from "./MessageList.jsx";

function morph(input, data) {
    morphdom(input, `<pre class="args">${highlightJsonLike(data)}</pre>`)
}

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
export function ToolCallCard(props) {
    const { tool, message, idx } = props;

    const {name, arguments: args} = tool.function;
    const response_content = $state();

    function initializeHtml() {
        base._content = response_content;
        response_content.value = message.tool_responses[idx]?.content;

        let input, output;

        appendChildren(base, <>
                <div className="tool-body">
                    <div className="args-title">参数</div>
                    <pre className="args" ref={input} dangerouslySetInnerHTML={highlightJsonLike(args)}></pre>
                </div>
                <div className="tool-body">
                    <div className="args-title">返回值
                        {isReactive(tool)/* || (message !== messages[messages.length-1] && !config.debug)*/ ? null : <button className={"rerun-btn"} onClick={({target}) => {
                            target.disabled = true;
                            runTools(message, idx).then(() => {
                                $update(messages);
                            }).finally(() => {
                                target.disabled = false;
                            });
                        }} title={"重新执行该工具，返回值可能改变\n警告：无法撤销工具导致的外部更改"}>重新执行
                        </button>}
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
            const update = throttled(() => {
                morph(input, tool.function.arguments);
            }, 50);
            $watch(tool, update, false);
        } else {
            $watch(response_content, () => {
                morph(output, response_content.value);
            }, false);
        }
    }

    const base = <details className={"tool-call"} onClick.once={initializeHtml}>
        <summary className="tool-header" title={"展开工具参数"}><b>{name}</b></summary>
    </details>;

    morphToolCallCard(props, base);
    base[MORPH_CHILD_FUNCTION] = morphToolCallCard;
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
    const {success, content, time} = message.tool_responses[idx] || {};
    const is_errored = false === success;

    element.classList.toggle("tool-error", is_errored);
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