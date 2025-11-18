import './ToolCallCard.css';
import {hljs} from "../assets/highlight.min.js";

const safeJsonStringify = (obj, space = 2) => {
    try {
        return JSON.stringify(JSON.parse(obj), null, space).replace(/\[(?:[\n ]+(\d+|".*"),)+[\n ]+(\d+|".*")[\n ]+]/g, function (a) {
            return a.replace(/[\n ]+/g, ' ');
        });
    } catch {
        return String(obj);
    }
};

/**
 *
 * @param {AiChat.ToolCall} tool
 * @return {JSX.Element}
 * @constructor
 */
export function ToolCallCard({ tool }) {
    const id = tool.id  || '';
    const name = tool.function?.name || 'unknown';
    const args = tool.function?.arguments ?? {};
    const prettyArgs = safeJsonStringify(args);
    const html = prettyArgs.length < 4096 ? hljs.highlight(prettyArgs, {language: "json", ignoreIllegals: true}).value : prettyArgs;

    return (
        <div className="tool-call" role="group" aria-label={`Tool call ${name}${id ? ` #${id}` : ''}`}>
            <div className="tool-header">
                <span className="tool-badge">{tool.type}</span>
                <span className="tool-name">{name}</span>
                {id ? <span className="tool-id">#{id}</span> : null}
            </div>
            <div className="tool-body">
                <div className="args-title">参数</div>
                <pre className="args" dangerouslySetInnerHTML={html}></pre>
            </div>
        </div>
    );
}