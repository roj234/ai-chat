export const Icon_warning = () => <svg className="icon" viewBox="0 0 20 20" fill="currentColor">
	<path fill-rule="evenodd" clip-rule="evenodd"
		  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"/>
</svg>;

export const Icon_search = () => <svg className="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
		  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
</svg>;

export const Icon_branch = (props) => <svg className="icon" {...props} viewBox="0 0 24 24"
										   fill="none" stroke="currentColor"
										   stroke-width="2">
	<circle cx="18" cy="18" r="3"></circle>
	<circle cx="6" cy="6" r="3"></circle>
	<path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
	<line x1="6" y1="9" x2="6" y2="21"></line>
</svg>;


export const Icon_save = () => <svg className="icon" viewBox="0 0 24 24"
									fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
									stroke-linejoin="round">
	<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-5-5z"/>
	<rect x="7" y="3" width="8" height="5" rx="1" fill="currentColor" fill-opacity="0.2"/>
	<rect x="6.5" y="12" width="11" height="6.5" rx="1.5" fill="currentColor" fill-opacity="0.15"/>
</svg>

export const Icon_lightning = (props) => <svg className="icon" viewBox="0 0 24 24" fill="currentColor" {...props}>
	<path d="M13 2L3 14h7v8l10-12h-7z"/>
</svg>;

export const Icon_exportChat = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
										  xmlns="http://www.w3.org/2000/svg">
	<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
		<rect x="1.5" y="1.5" width="7.5" height="6.5" rx="1.8"/>
		<path d="M3.6 8v2.2L6.1 8"/>
		<path d="M12 9.25v4.5"/>
		<path d="M10.4 12.15 12 13.75l1.6-1.6"/>
	</g>
</svg>;

export const Icon_exportChats = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
										   xmlns="http://www.w3.org/2000/svg">
	<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
		<path d="M4.25 2.25h3.25a1.75 1.75 0 0 1 1.75 1.75v3"/>
		<rect x="1.5" y="4.5" width="6" height="5.25" rx="1.5"/>
		<path d="M3.5 9.75v1.9L5.6 9.75"/>
		<path d="M12 9.25v4.5"/>
		<path d="M10.4 12.15 12 13.75l1.6-1.6"/>
	</g>
</svg>;

export const Icon_exportProviders = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
											   xmlns="http://www.w3.org/2000/svg">
	<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
		<rect x="1.5" y="2.25" width="7.5" height="3" rx="1"/>
		<rect x="1.5" y="6.75" width="7.5" height="3" rx="1"/>
		<path d="M12 9.25v4.5"/>
		<path d="M10.4 12.15 12 13.75l1.6-1.6"/>
	</g>
	<circle cx="3.3" cy="3.75" r=".6" fill="currentColor"/>
	<circle cx="3.3" cy="8.25" r=".6" fill="currentColor"/>
</svg>;

export const Icon_exportAll = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
										 xmlns="http://www.w3.org/2000/svg">
	<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
		<ellipse cx="5" cy="3" rx="3.5" ry="1.4"/>
		<path d="M1.5 3v6.3a3.5 1.4 0 0 0 7 0V3"/>
		<path d="M12 9.25v4.5"/>
		<path d="M10.4 12.15 12 13.75l1.6-1.6"/>
	</g>
</svg>;

export const Icon_PTC = () => (
	<svg
		width="24"
		height="24"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		className="icon"
		stroke-width={2}
	>
		<path d="M2 3v9a5 5 0 0 0 5 5h11" />
		<path d="M16 13l4 4-4 4" />
	</svg>
);