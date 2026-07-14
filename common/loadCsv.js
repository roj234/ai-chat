
/**
 * Parse a single CSV line into an array of fields.
 * Handles delimiter and quote escaping correctly.
 */
function parseCsvLine(line, delimiter = ',', quote = '"') {
	const fields = [];
	let field = '';
	let inQuoted = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		const nextChar = line[i + 1];

		if (inQuoted) {
			if (char === quote) {
				if (nextChar === quote) {
					// Escaped quote inside quoted field
					field += quote;
					i++; // Skip next quote
				} else {
					// End of quoted section
					inQuoted = false;
				}
			} else {
				field += char;
			}
		} else {
			if (char === quote) {
				inQuoted = true;
			} else if (char === delimiter) {
				fields.push(field);
				field = '';
			} else {
				field += char;
			}
		}
	}
	fields.push(field);
	return fields;
}

/**
 * Parse a full CSV text into an array of objects.
 * @param {string} csvText - The raw CSV content
 * @param {object} options
 * @param {string} options.delimiter - Field delimiter (default ',')
 * @param {string} options.quote - Quoting character (default '"')
 * @returns {Array<string[]>} Array of row objects keyed by header
 */
export function parseCsv(csvText, { delimiter = ',', quote = '"' } = {}) {
	// Split into lines, handling Windows (\r\n) and Unix (\n) line endings
	const lines = csvText.split(/\r?\n/);
	const result = [];

	for (let i = 0; i < lines.length; i++) {
		// Skip empty lines (optional)
		if (lines[i].trim() === '') continue;
		result.push(parseCsvLine(lines[i], delimiter, quote));
	}

	return result;
}
