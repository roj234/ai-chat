import "./MarkdownViewer.css";

// ==================== TOC 生成（快速导航栏） ====================
function generateTOC(markdownUrl, markdownContent) {
	const headings = markdownContent.querySelectorAll('h1, h2, h3');
	const tocItems = [];
	const usedIds = new Set();

	headings.forEach((heading, index) => {
		const level = parseInt(heading.tagName.charAt(1)); // 1, 2, 或 3
		const text = heading.textContent.replace(/\s+/g, ' ').trim();

		// 确保标题有 id
		let id = heading.id;
		if (!id) {
			id = generateSlug(text);
			// 处理重复id
			let uniqueId = id;
			let counter = 1;
			while (usedIds.has(uniqueId)) {
				uniqueId = `${id}-${counter}`;
				counter++;
			}
			id = uniqueId;
			heading.setAttribute('id', id);
		}
		usedIds.add(id);

		// 为标题添加锚点链接
		if (false && !heading.querySelector('.header-anchor')) {
			const anchor = <a className={"header-anchor"} href={"#"+markdownUrl+":"+id} title={"复制链接"} onClick={(e) => {
				navigator.clipboard.writeText(anchor.href);
			}}>🔗</a>;
			heading.appendChild(anchor);
		}
		heading.dataset.id = id;

		tocItems.push({
			level,
			text,
			id,
			element: heading,
		});
	});

	return tocItems;
}

function generateSlug(text) {
	return text
			.toLowerCase()
			.replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
			.replace(/[\s_]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
		|| 'heading';
}


export function createMarkdownViewer(el, actionBar) {
	let markdownUrl = 'mymd';

	// ==================== Intersection Observer - 高亮当前TOC项 ====================
	let currentActiveTocId = null;

	function setupScrollSpy(tocItems) {
		if (tocItems.length === 0) return;

		const observer = new IntersectionObserver((entries) => {
			// 找到所有当前在视口上方或视口内的标题
			const visibleHeadings = entries
				.filter(entry => entry.isIntersecting)
				.map(entry => entry.target);

			if (visibleHeadings.length > 0) {
				// 取最靠上的那个
				const topHeading = visibleHeadings.reduce((closest, current) => {
					const closestTop = closest.getBoundingClientRect().top;
					const currentTop = current.getBoundingClientRect().top;
					return currentTop < closestTop ? current : closest;
				});
				const activeId = topHeading.id;
				setActiveTocItem(activeId);
			}
		});

		const headingElements = tocItems.map(item => item.element);
		headingElements.forEach(el => observer.observe(el));
	}

	function setActiveTocItem(activeId) {
		if (currentActiveTocId === activeId) return;
		currentActiveTocId = activeId;

		tocList.querySelector('.active')?.classList.remove("active");

		const link = tocList.querySelector('[data-id='+JSON.stringify(activeId)+']');

		link.classList.add('active');
		// 滚动到可视区域
		if (link && tocNav) {
			const linkRect = link.getBoundingClientRect();
			const navRect = tocNav.getBoundingClientRect();
			if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
				link.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		}
	}

	const tocItems = generateTOC("mymd", el);
	setupScrollSpy(tocItems);

	let tocNav, tocList, tocPanel;

	actionBar.prepend(
		<button className="toc-fab btn ri-align-left" title="章节导航" onClick={() => {
			tocPanel.classList.toggle('open');
		}}></button>
	);

	return <>
		{tocItems.length && <div className="toc-panel" ref={tocPanel}>
			<div className="-header">
				<span className="-title">章节导航</span>
				<button className="ri-close-line ghost" onClick={() => {
					tocPanel.classList.toggle('open');
				}} title="关闭章节导航"/>
			</div>
			<nav className="-nav" ref={tocList} onClick.delegate{'a'}={e => {
				e.preventDefault();
				const dom = el.querySelector(`[data-id=${JSON.stringify(e.delegateTarget.dataset.id)}]`);
				dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
			}}>
				{tocItems.map(item => {
					const linkClass = item.level === 1 ? 'toc-link' : item.level === 2 ? 'toc-link -h2' : 'toc-link -h3';
					return <li><a className={linkClass} data-id={item.id} href={"#"+markdownUrl+":"+item.id}>{item.text}</a></li>;
				})}
			</nav>
		</div>}
		{<div className="scroll">{el}</div>}
	</>;
}
