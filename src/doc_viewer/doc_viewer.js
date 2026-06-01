import {chapterData} from "./documents.js";
import {renderMarkdownToElement} from "../markdown/markdown.js";
import {callOnLoadHandler} from "../plugin.js";

let hamburgerBtn, mainWrapper, markdownContent, navList, navNoResults, overlay, searchClear, searchInput, sidebar, sidebarNav, tocBadge, tocFab, tocList, tocMobileClose, tocMobileNav, tocMobilePanel, tocNav, tocSidebar;

const App = <>
	<div className="topbar" id="topbar">
		<button className="hamburger" ref={hamburgerBtn} aria-label="切换侧边栏" title="目录">
            <span className="ri-menu-line"></span>
		</button>
		<span className="topbar__logo"><span className="ri-ai">Chat</span> 文档</span>
	</div>

	<div className="overlay" ref={overlay}></div>

	<aside className="sidebar" ref={sidebar}>
		<div className="sidebar__header">
			<div className="sidebar__title">
				<span className="sidebar__title-icon"><span className="ri-ai"></span></span>
				AiChat 文档
			</div>
			<div className="sidebar__subtitle">适用版本: v{APP_VERSION}</div>
		</div>
		<div className="sidebar__search">
			<div className="search-wrapper">
				<span className="search-icon">🔍</span>
				<input
					type="text"
					className="search-input"
					ref={searchInput}
					placeholder="搜索章节..."
					autoComplete="off"
				/>
				<button className="search-clear" ref={searchClear} aria-label="清除搜索">✕</button>
			</div>
		</div>
		<nav className="sidebar__nav" ref={sidebarNav}>
			<div className="sidebar__section-label">文档导航</div>
			<ul className="nav-list" ref={navList} onClick={(e) => {
				const toggle = e.target.closest('.nav-toggle');
				if (toggle) {
					e.preventDefault();
					e.stopPropagation();
					const targetId = toggle.getAttribute('data-toggle-target');
					const childrenContainer = document.querySelector(`[data-nav-children="${targetId}"]`);
					if (childrenContainer) {
						const isCollapsed = childrenContainer.classList.contains('collapsed');
						if (isCollapsed) {
							childrenContainer.classList.remove('collapsed');
							toggle.classList.remove('collapsed');
						} else {
							childrenContainer.classList.add('collapsed');
							toggle.classList.add('collapsed');
						}
					}
					return;
				}

				const link = e.target.closest('[href]');
				if (link) {
					e.preventDefault();
					const href = link.getAttribute('href');
					if (href) {
						loadMarkdown(href);
						// 移动端关闭侧边栏
						if (window.innerWidth <= 1024 && sidebar.classList.contains('active')) {
							closeSidebar();
						}
					}
				}
			}}>
				{buildNavHTML(chapterData)}
			</ul>
			<div className="nav-no-results" ref={navNoResults}>
				😕 未找到匹配的章节
			</div>
		</nav>
	</aside>

	<div className="main-wrapper" ref={mainWrapper}>
		<main className="main-content">
			<div className="md" ref={markdownContent}></div>
		</main>
	</div>

	<aside className="toc-sidebar" ref={tocSidebar}>
		<div className="toc-sidebar__header">📑 快速导航</div>
		<nav className="toc-sidebar__nav" ref={tocNav}>
			<ul className="toc-list" ref={tocList} onClick={() => {
				// 移动端关闭TOC面板
				if (window.innerWidth <= 1024 && tocMobilePanel.classList.contains('active')) {
					closeTocMobile();
				}
			}}>
				<li className="toc-empty">正在加载导航...</li>
			</ul>
		</nav>
	</aside>

	<button className="toc-fab" ref={tocFab} aria-label="快速导航" title="快速导航">
		📑
		<span className="toc-fab__badge" ref={tocBadge} style="display:none;">0</span>
	</button>

	<div className="toc-mobile-panel" ref={tocMobilePanel}>
		<div className="toc-mobile-panel__header">
			<span className="toc-mobile-panel__title">📑 快速导航</span>
			<button className="toc-mobile-panel__close" ref={tocMobileClose} aria-label="关闭导航">✕</button>
		</div>
		<nav className="toc-mobile-panel__nav" ref={tocMobileNav}></nav>
	</div>
</>;

const app = document.getElementById("app");
app.replaceChildren(...App);

// ==================== 渲染章节列表 ====================
function buildNavHTML(chapters, depth = 0) {
	return chapters.map((ch, index) => {
		const hasChildren = ch.children && ch.children.length > 0;
		const uniqueId = `nav-${depth}-${index}-${ch.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '-')}`;
		const linkClass = depth === 0 ? 'nav-link nav-link--parent' :
			depth === 1 ? 'nav-link nav-link--child' :
				'nav-link nav-link--grandchild';
		const iconSpan = ch.icon ? <span style="flex-shrink:0;font-size:14px;">{ch.icon}</span> : null;

		return <li class="nav-item" data-nav-item={true} data-title={ch.title} data-depth={depth}>
			<a class={linkClass} href={ch.href} data-nav-toggle={uniqueId} style="display:flex;align-items:center;gap:8px;">
				{hasChildren ?
					<span class="nav-toggle" data-toggle-target={uniqueId} aria-label="展开/折叠">▼</span> :
					depth > 0 ? <span style="width:20px;flex-shrink:0;"></span> : null}
				{iconSpan}<span class="nav-link-text">{ch.title}</span>
			</a>

			{hasChildren ?
				<ul class="nav-children" data-nav-children={uniqueId} style="list-style:none;padding:0;margin:0;">
					{buildNavHTML(ch.children, depth + 1)}
				</ul>
				: null
			}
		</li>;
	});
}

// ==================== 滚动到目标 ====================
function scrollToTarget(path) {
	const target = document.getElementById(decodeURI(path));
	if (target) {
		const offset = window.innerWidth <= 1024 ? 70 : 20;
		const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
		window.scrollTo({ top, behavior: 'smooth' });
	}
}

// ==================== 搜索功能 ====================
function filterChapters(query) {
	const normalizedQuery = query.toLowerCase().trim();
	const allItems = navList.querySelectorAll('[data-nav-item]');
	const allChildrenContainers = navList.querySelectorAll('[data-nav-children]');
	let hasVisible = false;

	if (!normalizedQuery) {
		// 显示全部
		allItems.forEach(item => item.style.display = '');
		allChildrenContainers.forEach(c => c.classList.remove('collapsed'));
		navList.querySelectorAll('.nav-toggle').forEach(t => t.classList.remove('collapsed'));
		navNoResults.classList.remove('visible');
		searchClear.classList.remove('visible');
		return;
	}

	searchClear.classList.add('visible');

	// 收集匹配的item
	const matchedItems = new Set();
	allItems.forEach(item => {
		const title = (item.getAttribute('data-title') || '').toLowerCase();
		if (title.includes(normalizedQuery)) {
			matchedItems.add(item);
			// 标记所有祖先
			let parent = item.parentElement;
			while (parent && parent !== navList) {
				const parentItem = parent.closest('[data-nav-item]');
				if (parentItem) {
					matchedItems.add(parentItem);
					parent = parentItem.parentElement;
				} else {
					break;
				}
			}
		}
	});

	// 显示/隐藏
	allItems.forEach(item => {
		if (matchedItems.has(item)) {
			item.style.display = '';
		} else {
			item.style.display = 'none';
		}
	});

	// 展开包含匹配项的折叠容器
	allChildrenContainers.forEach(container => {
		const hasVisibleChild = container.querySelector('[data-nav-item][style*="display:"]') ===
			null &&
			container.querySelectorAll('[data-nav-item]').length > 0 &&
			Array.from(container.querySelectorAll('[data-nav-item]')).some(
				item => matchedItems.has(item) && item.style.display !== 'none'
			);
		const hasDirectVisible = Array.from(container.querySelectorAll('[data-nav-item]')).some(
			item => matchedItems.has(item)
		);
		if (hasDirectVisible) {
			container.classList.remove('collapsed');
			const toggleId = container.getAttribute('data-nav-children');
			const toggle = document.querySelector(`[data-toggle-target="${toggleId}"]`);
			if (toggle) toggle.classList.remove('collapsed');
		}
	});

	const anyVisible = navList.querySelector('[data-nav-item][style*="display:"]') === null &&
		Array.from(allItems).some(item => item.style.display !== 'none');

	if (!anyVisible && allItems.length > 0 &&
		Array.from(allItems).every(item => item.style.display === 'none')) {
		navNoResults.classList.add('visible');
	} else {
		navNoResults.classList.remove('visible');
	}
}

searchInput.addEventListener('input', function() {
	filterChapters(this.value);
});

searchInput.addEventListener('keydown', function(e) {
	if (e.key === 'Escape') {
		this.value = '';
		filterChapters('');
		this.blur();
	}
});

searchClear.addEventListener('click', function() {
	searchInput.value = '';
	filterChapters('');
	searchInput.focus();
});

// ==================== TOC 生成（快速导航栏） ====================
function generateTOC() {
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
		if (!heading.querySelector('.header-anchor')) {
			const anchor = <a className={"header-anchor"} href={"#"+markdownUrl+":"+id} title={"复制链接"} onClick={(e) => {
				navigator.clipboard.writeText(anchor.href);
			}}>🔗</a>;
			heading.appendChild(anchor);
		}

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

function renderTOC(tocItems) {
	const buildTOCLinks = (items) => {
		if (items.length === 0) {
			return [<li class="toc-empty">📭 当前页面无标题</li>];
		}
		return items.map(item => {
			const linkClass = item.level === 1 ? 'toc-link' :
				item.level === 2 ? 'toc-link toc-link--h2' :
					'toc-link toc-link--h3';
			return <li><a class={linkClass} href={"#"+markdownUrl+":"+item.id}>{item.text}</a></li>;
		});
	};

	const linksHTML = buildTOCLinks(tocItems);
	tocList.replaceChildren(...linksHTML);

	// 更新徽章数量
	if (tocItems.length > 0) {
		tocBadge.textContent = tocItems.length;
		tocBadge.style.display = 'flex';
	} else {
		tocBadge.style.display = 'none';
	}
}

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

	const link = tocList.querySelector('[href='+JSON.stringify("#"+markdownUrl+":"+activeId)+']');

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

// 初始化TOC
function initTOC() {
	const tocItems = generateTOC();
	renderTOC(tocItems);
	setupScrollSpy(tocItems);
	return tocItems;
}

let tocItems;

// ==================== 侧边栏切换（移动端） ====================
function openSidebar() {
	sidebar.classList.add('active');
	overlay.classList.add('active');
	hamburgerBtn.classList.add('active');
	document.body.style.overflow = 'hidden';
	// 关闭TOC移动面板
	if (tocMobilePanel.classList.contains('active')) {
		closeTocMobile(false);
	}
}

function closeSidebar() {
	sidebar.classList.remove('active');
	overlay.classList.remove('active');
	hamburgerBtn.classList.remove('active');
	// 检查是否还有其他面板打开
	if (!tocMobilePanel.classList.contains('active')) {
		document.body.style.overflow = '';
	}
}

hamburgerBtn.addEventListener('click', function() {
	if (sidebar.classList.contains('active')) {
		closeSidebar();
	} else {
		openSidebar();
	}
});

// ==================== 移动端TOC面板 ====================
function openTocMobile() {
	tocMobilePanel.classList.add('active');
	overlay.classList.add('active');
	document.body.style.overflow = 'hidden';
	// 关闭侧边栏
	if (sidebar.classList.contains('active')) {
		closeSidebar();
	}
}

function closeTocMobile(restoreScroll = true) {
	tocMobilePanel.classList.remove('active');
	overlay.classList.remove('active');
	if (restoreScroll && !sidebar.classList.contains('active')) {
		document.body.style.overflow = '';
	}
}

tocFab.addEventListener('click', function() {
	if (tocMobilePanel.classList.contains('active')) {
		closeTocMobile();
	} else {
		openTocMobile();
	}
});

tocMobileClose.addEventListener('click', function() {
	closeTocMobile();
});

// ==================== 遮罩层点击 ====================
overlay.addEventListener('click', function() {
	if (sidebar.classList.contains('active')) {
		closeSidebar();
	}
	if (tocMobilePanel.classList.contains('active')) {
		closeTocMobile();
	}
});

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', function(e) {
	// Escape 关闭所有面板
	if (e.key === 'Escape') {
		if (tocMobilePanel.classList.contains('active')) {
			closeTocMobile();
		}
		if (sidebar.classList.contains('active')) {
			closeSidebar();
		}
		if (document.activeElement === searchInput) {
			searchInput.blur();
		}
	}
	// Ctrl/Cmd + K 聚焦搜索
	if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
		e.preventDefault();
		searchInput.focus();
		searchInput.select();
		if (window.innerWidth <= 1024 && !sidebar.classList.contains('active')) {
			openSidebar();
			setTimeout(() => {
				searchInput.focus();
				searchInput.select();
			}, 350);
		}
	}
	// Ctrl/Cmd + Shift + T 切换移动端TOC
	if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
		e.preventDefault();
		if (window.innerWidth <= 1024) {
			if (tocMobilePanel.classList.contains('active')) {
				closeTocMobile();
			} else {
				openTocMobile();
			}
		}
	}
});

// ==================== 响应式处理 ====================
function handleResize() {
	const isMobile = window.innerWidth <= 1024;

	if (!isMobile) {
		// PC端：确保移动端面板关闭
		if (tocMobilePanel.classList.contains('active')) {
			closeTocMobile(false);
		}
		if (sidebar.classList.contains('active')) {
			closeSidebar();
		}
		document.body.style.overflow = '';
		// 调整主内容区边距
		mainWrapper.style.marginRight = '';
		tocNav.append(tocList);
	} else {
		// 移动端
		mainWrapper.style.marginRight = '0';
		tocMobileNav.append(tocList);
	}
}

window.addEventListener('resize', debounce(handleResize, 200));
handleResize(); // 初始调用

// ==================== 工具函数 ====================
function debounce(fn, delay) {
	let timer;
	return function(...args) {
		clearTimeout(timer);
		timer = setTimeout(() => fn.apply(this, args), delay);
	};
}

let markdownUrl;

const loadMarkdown = async (url) => {
	if (url === markdownUrl) return;

	navList.querySelector('.active')?.classList.remove("active");
	const existing = navList.querySelector('[href='+JSON.stringify(url)+']');

	let md;
	if (!existing) {
		md = "# 404\n## 文档不存在";
	} else {
		existing.classList.add("active");
		if (markdownUrl) history.replaceState(null, "", "#"+url);

		try {
			const res = await fetch(url, {
				referrerPolicy: "no-referrer"
			});
			if (!res.ok) {
				md = "# 加载失败\nHTTP "+res.status;
			} else {
				md = await res.text();
				markdownUrl = url;
			}
		} catch (e) {
			md = "# 加载失败\n"+e.message;
		}
	}

	markdownContent.replaceChildren();
	renderMarkdownToElement(markdownContent, md.replaceAll('\r', ''), {
		trusted: true
	});
	tocItems = initTOC();
}


// ==================== 初始化 ====================
function init() {
	const [markdown, path] = location.hash.slice(1).split(":");

	loadMarkdown(markdown || "documents/usage.md").then(() => scrollToTarget(path));
}

addEventListener("hashchange", init);
init();

callOnLoadHandler(app);