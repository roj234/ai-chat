/**
 * Weather MCP
 *
 * 提供天气预报功能.
 * https://open-meteo.com/en/docs
 * 每天 10000 次 API 调用
 */

import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {WeatherCode} from "./weatherCode.js";

const { MCPServer, jsonFetch, cachePreparedSql, LRUCache } = globalThis.AiChatAPI;

const mcp = new MCPServer({
	name: 'Weather-MCP',
	version: '1.0.0',
});

/** @type {DatabaseSync} */
let db;

const convertToCamelCase = str => str.replace(/[-_]([a-z])/g, (match, letter) => letter.toUpperCase());

const DAY = 86400_000;

const cache = new LRUCache(500);

mcp.tool(
	'SearchLocation',
	'Search latitude and longitude and other information.',
	{
		type: 'object',
		properties: {
			locationName: {
				type: 'string',
				description: 'An empty string or only 1 character will return an empty result. 2 characters will only match exact matching locations. 3 and more characters will perform fuzzy matching. The search string can be a location name or a postal code.'
			},
			countryCode: {
				type: 'string',
				description: 'ISO-3166-1 alpha2 country code, which the results will be filtered for.',
			},
			language: {
				type: 'string',
				default: 'en',
				description: 'Return translated results, if available, otherwise return english or the native location name. Lower-cased.',
			},
			count: {
				type: 'integer',
				default: 10,
				maximum: 100
			},
		},
		required: ['locationName']
	},
	async ({ locationName, countryCode, language = 'en', count = 10 }) => {
		const cacheKey = `geo:${locationName}:${countryCode||''}:${language}:${count}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		let url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=${count}&language=${encodeURIComponent(language)}&format=json`;
		if (countryCode) url += "&countryCode="+encodeURIComponent(countryCode.toLowerCase());

		const ac = new AbortController();

		setTimeout(() => {
			ac.abort();
		}, 10000);

		const json = await jsonFetch(url, {
			signal: ac.signal,
		});

		if (!json.results) {
			const result = 'No results found.';
			cache.set(cacheKey, result, 0);
			return result;
		}

		const result = json.results.map(item => {
			const admins = [item.admin1, item.admin2, item.admin3, item.admin4].filter(s=>s?.trim()).join('/');
			return `Name: ${item.name}, latitude: ${item.latitude}, longitude: ${item.longitude}, elevation: ${item.elevation}m, country: ${item.country}, timezone: ${item.timezone}, location: ${admins}`;
		}).join("\n");

		cache.set(cacheKey, result, 0);
		return result;
	}
);

mcp.tool(
	'ListSavedLocations',
	'List all previous saved locations, call this for current location, home location, company location, etc.',
	{
		type: 'object',
		properties: {},
		required: []
	},
	async ({}) => {
		const rows = db.prepare(`
SELECT locationName, latitude, longitude, note, savedAt
	FROM saved_locations
	ORDER BY savedAt DESC
	LIMIT 50
`).all();

		if (rows.length === 0) {
			return 'No saved locations yet. Use SaveLocation to add one.';
		}

		return rows.map(r =>
			`${r.locationName} (lat=${r.latitude}, lon=${r.longitude})${r.note ? ' — ' + r.note : ''}`
		).join('\n');
	}
);

mcp.tool(
	'DeleteSavedLocation',
	'Delete saved location.',
	{
		type: 'object',
		properties: {
			locationName: {
				type: 'string',
			},
		},
		required: ['locationName']
	},
	async ({ locationName }) => {
		const result = db.prepare(`DELETE FROM saved_locations WHERE locationName = ?`).run(locationName);
		if (result.changes === 0) return MCPServer.toolError(`Location not found`);
		return `Deleted`;
	}
);

mcp.tool(
	'SaveLocation',
	'Save location to database.',
	{
		type: 'object',
		properties: {
			locationName: {
				type: 'string',
			},
			latitude: {
				type: 'number',
			},
			longitude: {
				type: 'number',
			},
			note: {
				type: 'string',
			},
		},
		required: ['locationName', 'latitude', 'longitude']
	},
	async ({ locationName, latitude, longitude, note }) => {
		db.prepare(`
INSERT INTO saved_locations (locationName, latitude, longitude, note, savedAt)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(locationName) DO UPDATE SET
		latitude = excluded.latitude,
		longitude = excluded.longitude,
		note = excluded.note,
		savedAt = excluded.savedAt
`).run(locationName, latitude, longitude, note || '', Date.now());
		return `Saved`;
	}
);

mcp.tool(
	'SearchAQI',
	'Query Air Quality information (PM10, CO2, UV Index, etc.)',
	{
		type: 'object',
		properties: {
			latitude: {
				type: 'number',
			},
			longitude: {
				type: 'number',
			},
			timezone: {
				type: 'string',
				example: 'Asia/Shanghai',
				description: 'Omit to use GMT timestamp.',
			},
		},
		required: ['latitude', 'longitude']
	},
	async ({ latitude, longitude, timezone }) => {
		const cacheKey = `aqi:${latitude}:${longitude}:${timezone||''}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		let url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=european_aqi,us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,aerosol_optical_depth,dust,uv_index,uv_index_clear_sky&forecast_days=1&domains=cams_global`;
		if (timezone) url += "&timezone="+encodeURIComponent(timezone);

		const ac = new AbortController();

		setTimeout(() => {
			ac.abort();
		}, 10000);

		const json = await jsonFetch(url, {
			signal: ac.signal,
		});

		const {time, interval, ...current} = json.current;
		const {us_aqi: unused1, european_aqi: unused2, ...currentUnits} = json.current_units;

		let str = `${time}\n`;
		for (const key of Object.keys(current)) {
			str += convertToCamelCase(key)+": "+current[key]+(currentUnits[key]||'')+'\n';
		}
		const result = str.trim();
		cache.set(cacheKey, result, 15 * 60_000);
		return result;
	}
);

mcp.tool(
	'WeatherForecastPerHour',
	'Per hour weather forecast.',
	{
		type: 'object',
		properties: {
			latitude: {
				type: 'number',
			},
			longitude: {
				type: 'number',
			},
			timezone: {
				type: 'string',
				example: 'Asia/Shanghai',
				description: 'Omit to use GMT timestamp.',
			},
			date: {
				type: 'string',
				description: 'ISO8601 date: yyyy-mm-dd, omit to use today.'
			}
		},
		required: ['latitude', 'longitude']
	},
	async ({ latitude, longitude, timezone, date }) => {
		const cacheKey = `hourly:${latitude}:${longitude}:${timezone||''}:${date||''}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		let url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=sunset,sunrise,uv_index_max,uv_index_clear_sky_max,daylight_duration,sunshine_duration&hourly=temperature_2m,surface_pressure,weather_code,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation_probability,precipitation,snow_depth,visibility`;

		if (timezone) url += "&timezone="+encodeURIComponent(timezone);
		if (date) url += `&start_date=${date}&end_date=${date}`;
		else url += `&forecast_days=1`;

		const ac = new AbortController();

		setTimeout(() => {
			ac.abort();
		}, 10000);

		const json = await jsonFetch(url, {
			signal: ac.signal,
		});

		let str = '';
		const {time: unuseda, sunset: unusedb, sunrise: unusedc, ...dailyUnits} = json.daily_units;
		for (const key of Object.keys(json.daily)) {
			str += convertToCamelCase(key)+": "+json.daily[key][0]+(dailyUnits[key]||'')+'\n';
		}

		const {time: times, ...hourly} = json.hourly;
		const {weather_code: unused1, ...hourlyUnits} = json.hourly_units;
		const keys = Object.keys(hourly);

		for (let i = 0; i < times.length; i++) {
			str += '\n'+times[i]+'\n';
			for (const key of keys) {
				let value = hourly[key][i];
				if (key === 'weather_code') value = WeatherCode[parseInt(value)] ?? value;
				str += convertToCamelCase(key)+": "+value+(hourlyUnits[key]||'')+'\n';
			}
		}

		const result = str.trim();
		// Historical data is finalized
		cache.set(cacheKey, result, (Date.now() - new Date(date)) / DAY > 1 ? 0 : 3600_000);
		return result;
	}
);
mcp.tool(
	'WeatherForecastPerDay',
	'Per day weather forecast.',
	{
		type: 'object',
		properties: {
			latitude: {
				type: 'number',
			},
			longitude: {
				type: 'number',
			},
			timezone: {
				type: 'string',
				example: 'Asia/Shanghai',
				description: 'Omit to use GMT timestamp.',
			},
			startDate: {
				type: 'string',
				description: 'ISO8601 date: yyyy-mm-dd, can be previous date, omit to use next 7 days'
			},
			endDate: {
				type: "string",
				default: "startDate"
			}
		},
		required: ['latitude', 'longitude']
	},
	async ({ latitude, longitude, timezone, startDate, endDate }) => {
		let arg = '';
		if (null == endDate && null == startDate) {
			arg += `&forecast_days=7`;
		} else {
			const duration = endDate && new Date(endDate) - new Date(startDate);
			if (isNaN(duration)) throw 'Invalid date';
			if (duration > DAY * 31) throw 'Duration too big (max 31 days)';
			arg = `&start_date=${startDate}&end_date=${endDate||startDate}`;
		}

		const cacheKey = `daily:${latitude}:${longitude}:${timezone||''}:${arg}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		let url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}${arg}&daily=uv_index_clear_sky_max,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,precipitation_hours`;
		if (timezone) url += "&timezone="+encodeURIComponent(timezone);

		const ac = new AbortController();

		setTimeout(() => {
			ac.abort();
		}, 10000);

		const json = await jsonFetch(url, {
			signal: ac.signal,
		});

		let str = '';

		const {time: times, ...daily} = json.daily;
		const {weather_code: unused1, ...dailyUnits} = json.daily_units;
		const keys = Object.keys(daily);

		for (let i = 0; i < times.length; i++) {
			str += '\n'+times[i]+'\n';
			for (const key of keys) {
				let value = daily[key][i];
				if (key === 'weather_code') value = WeatherCode[parseInt(value)] ?? value;
				str += convertToCamelCase(key)+": "+value+(dailyUnits[key]||'')+'\n';
			}
		}

		const result = str.trim();
		cache.set(cacheKey, result, (Date.now() - new Date(endDate)) / DAY > 1 ? 0 : DAY);
		return result;
	}
);

/**
 * @param {AiChatBackend.Router} router
 * @param {string} workspace
 */
export default (router, workspace) => {
	db = new DatabaseSync(path.join(workspace, 'weather-mcp.db'));
	cachePreparedSql(db);
	// 不需要 WAL
	db.exec(`
	CREATE TABLE IF NOT EXISTS saved_locations (
		locationName TEXT PRIMARY KEY,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		note TEXT DEFAULT '',
		savedAt INTEGER NOT NULL
	) WITHOUT ROWID
`);
	mcp.mount(router, 'mcp/weather');
}
