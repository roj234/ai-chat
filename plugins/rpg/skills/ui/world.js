import {$foreach, unconscious} from "unconscious";
import {createReactiveMarkdown} from "/common/ReactiveJSON.js";

import "./world.css";

// ---------- 流式渲染函数 ----------
function renderWorld(val) {
	return [
		// 世界观标题
		<header className="world-name">
			🌍 {() => unconscious(val.name) || "生成中…"}
		</header>,

		// 核心主题（响应式列表）
		<div className="world-themes">
			<h3>核心主题</h3>
			<div className="theme-tags">
				{$foreach(val.theme, (tag) => (
					<span className="tag">{tag}</span>
				))}
			</div>
		</div>,

		// 文风基调 - 流式 Markdown
		<section className="world-style">
			<h3>文风基调</h3>
			{createReactiveMarkdown(<div className="md" />, val.style)}
		</section>,

		// 核心摘要
		<section className="world-description">
			<h3>核心摘要</h3>
			{createReactiveMarkdown(<div className="md" />, val.description)}
		</section>,

		// 时代背景
		<section className="world-age">
			<h3>时代背景</h3>
			{createReactiveMarkdown(<div className="md" />, val.age)}
		</section>,

		// 地理格局
		<section className="world-geography">
			<h3>地理格局</h3>
			{createReactiveMarkdown(<div className="md" />, val.geography)}
		</section>,

		// 能力体系
		<section className="world-leveling">
			<h3>能力体系</h3>
			{createReactiveMarkdown(<div className="md" />, val.leveling)}
		</section>,

		// 社会规则
		<section className="world-social">
			<h3>社会规则</h3>
			{createReactiveMarkdown(<div className="md" />, val.social)}
		</section>,

		// 主要派系
		<section className="world-factions">
			<h3>主要派系</h3>
			{$foreach(val.factions, (faction) => (
				<div className="faction-card">
					<h4>{faction.name}</h4>
					{createReactiveMarkdown(
						<div className="md" />,
						faction.description
					)}
				</div>
			))}
		</section>,

		// 属性体系
		<section className="world-attributes">
			<h3>属性体系</h3>
			<table className="attribute-table">
				<thead>
				<tr>
					<th>ID</th>
					<th>名称</th>
					<th>描述</th>
					<th>值域</th>
					<th>类型</th>
					<th>颜色</th>
				</tr>
				</thead>
				<tbody>
				{$foreach(val.attribute_schema, (attr) => (
					<tr>
						<td>{attr.id}</td>
						<td>{attr.name}</td>
						<td>{attr.description}</td>
						<td>{attr.rank_rule}</td>
						<td>{attr.type}</td>
						<td style={() => `color:#${unconscious(attr.color)}`}>
							{attr.color}
						</td>
					</tr>
				))}
				</tbody>
			</table>
		</section>
	];
}
