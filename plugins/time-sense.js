import {registerToolset} from "/src/toolset.js";
import {EditableMessageRoles, EVENT_BUS, MessageRoles} from "/src/states.js";
import {getImmediateMessages} from "/src/database.js";
import {JsonEditor} from "/src/components/JsonEditor.jsx";

import "./time-sense.css";

const ID = "TimeSense";
const TIME_SENSE_ROLE = 'time-sense';

registerToolset(ID, '在结束超过1小时的对话上插入之前时间和当前时间', [], {
	default: true,
	hidden: "manual",
});

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	weekday: 'short',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});

const STEP = 3600000;

EVENT_BUS.on('beforeSend', (conv) => {
	if (conv?.activatedModules?.has(ID)) {
		const messages = getImmediateMessages(conv);

		const lastMessage = messages.findLast(s => s.time);
		const now = Date.now();
		if (lastMessage && now - lastMessage.time > STEP) {
			messages.push({
				role: TIME_SENSE_ROLE,
				time: now,
				content: {
					prev: lastMessage.time
				}
			})
		}
	}
});

function formatDuration(ms) {
	const totalMinutes = Math.floor(ms / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	const parts = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

function formatTimePair(prev, now) {
	const dPrev = new Date(prev);
	const dNow = new Date(now);
	const pad = n => String(n).padStart(2, '0');

	const sameYear = dPrev.getFullYear() === dNow.getFullYear();
	const sameDay = sameYear
		&& dPrev.getMonth() === dNow.getMonth()
		&& dPrev.getDate() === dNow.getDate();

	const fmt = (d) => {
		const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
		if (sameDay) return hm;
		const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
	};

	return { prevText: fmt(dPrev), nowText: fmt(dNow) };
}

EditableMessageRoles.add(TIME_SENSE_ROLE);
MessageRoles[TIME_SENSE_ROLE] = {
	name: "时间更新",
	compose(item, output) {
		const prev = item.content?.prev;
		const now = item.time;
		output.push({
			role: 'user',
			content: `<system-reminder>
Time update:
- Last reply: ${fullDateFormatter.format(new Date(prev))}
- Current time: ${fullDateFormatter.format(new Date(now))}
- Elapsed: ${(formatDuration(now - prev))}
</system-reminder>`,
		});
	},
	renderContent(item, chunks, index, isEditing) {
		const event = item.content;
		chunks.push({
			type: "html",
			key: item,
			edit: isEditing(item),
			html: () => {
				if (isEditing(item)) {
					return <JsonEditor value={event} onChange={(str, obj, error) => {
						if (!error) item.content = obj;
					}} />;
				}

				const prev = event.prev;
				const now = item.time;

				return (<div className="-time">
					<span className="tooltip">上条消息 {new Date(prev).toISOString()}</span>
					<i className="ri-time-line"/>
					+{formatDuration(now - prev)}
				</div>);
			}
		})
	},
	keyFunc(chunk, keys) {
		keys.push(chunk.key.time, chunk.edit);
		return keys;
	}
};
