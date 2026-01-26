import * as ICAL from "ical.js";

import type { CaldavLabel, CaldavReminder, CaldavRelation, CaldavTask, CaldavTaskInput } from "./schema";

function mapPriorityToCaldav(priority: number | null): number | null {
	if (!priority) {
		return null;
	}
	switch (priority) {
		case 1:
			return 9;
		case 2:
			return 5;
		case 3:
			return 3;
		case 4:
			return 2;
		case 5:
			return 1;
		default:
			return 0;
	}
}

function parseVtodoPriority(priority: number | null): number | null {
	if (!priority) {
		return null;
	}
	switch (priority) {
		case 1:
			return 5;
		case 2:
			return 4;
		case 3:
		case 4:
			return 3;
		case 5:
			return 2;
		default:
			return 1;
	}
}

function toJsDate(value: ICAL.Time | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	return value.toJSDate();
}

function getColor(vtodo: ICAL.Component): string | null {
	const colorProps = [
		"X-APPLE-CALENDAR-COLOR",
		"X-OUTLOOK-COLOR",
		"X-FUNAMBOL-COLOR",
		"COLOR",
	];
	for (const name of colorProps) {
		const prop = vtodo.getFirstProperty(name);
		if (!prop) continue;
		const value = prop.getFirstValue();
		if (typeof value === "string") {
			return value.replace(/^#/, "").slice(0, 6);
		}
	}
	return null;
}

function parseRelations(vtodo: ICAL.Component): CaldavRelation[] {
	const relations: CaldavRelation[] = [];
	for (const prop of vtodo.getAllProperties("related-to")) {
		const uid = String(prop.getFirstValue() ?? "");
		if (!uid) continue;
		const reltype = prop.getParameter("reltype");
		switch (String(reltype || "").toUpperCase()) {
			case "PARENT":
				relations.push({ type: "PARENT", uid });
				break;
			case "CHILD":
				relations.push({ type: "CHILD", uid });
				break;
			default:
				relations.push({ type: "RELATED", uid });
		}
	}
	return relations;
}

function parseReminders(vtodo: ICAL.Component): CaldavReminder[] {
	const reminders: CaldavReminder[] = [];
	for (const alarm of vtodo.getAllSubcomponents("valarm")) {
		const trigger = alarm.getFirstProperty("trigger");
		if (!trigger) continue;
		const related = trigger.getParameter("related");
		const valueType = trigger.getParameter("value");
		const firstValue = trigger.getFirstValue();

		if (valueType === "DATE-TIME" && firstValue instanceof ICAL.Time) {
			reminders.push({
				reminderAt: firstValue.toJSDate(),
				relativeSeconds: null,
				relativeTo: null,
			});
			continue;
		}

		if (firstValue instanceof ICAL.Duration) {
			const seconds = Math.trunc(firstValue.toSeconds());
			if (related === "END") {
				reminders.push({
					reminderAt: null,
					relativeSeconds: seconds,
					relativeTo: "end",
				});
			} else {
				reminders.push({
					reminderAt: null,
					relativeSeconds: seconds,
					relativeTo: "start",
				});
			}
		}
	}
	return reminders;
}

function parseRrule(vtodo: ICAL.Component): {
	repeatAfter: number | null;
	repeatMode: "default" | "month" | "from_current" | null;
} {
	const rrule = vtodo.getFirstPropertyValue("rrule");
	if (!rrule || !(rrule instanceof ICAL.Recur)) {
		return { repeatAfter: null, repeatMode: null };
	}
	const interval = rrule.interval ?? 1;
	switch (rrule.freq) {
		case "MONTHLY":
			return { repeatAfter: null, repeatMode: "month" };
		case "WEEKLY":
			return { repeatAfter: interval * 7 * 24 * 60 * 60, repeatMode: "default" };
		case "DAILY":
			return { repeatAfter: interval * 24 * 60 * 60, repeatMode: "default" };
		case "HOURLY":
			return { repeatAfter: interval * 60 * 60, repeatMode: "default" };
		case "MINUTELY":
			return { repeatAfter: interval * 60, repeatMode: "default" };
		case "SECONDLY":
			return { repeatAfter: interval, repeatMode: "default" };
		default:
			return { repeatAfter: null, repeatMode: null };
	}
}

function parseCategories(vtodo: ICAL.Component): CaldavLabel[] {
	const prop = vtodo.getFirstProperty("categories");
	if (!prop) {
		return [];
	}
	const values = prop.getValues();
	return values.map((value) => ({
		id: 0,
		title: String(value),
	}));
}

export function parseVtodo(ics: string): CaldavTaskInput {
	const jcal = ICAL.parse(ics);
	const component = new ICAL.Component(jcal);
	const vtodo = component.getFirstSubcomponent("vtodo");
	if (!vtodo) {
		throw new Error("VTODO not found");
	}

	const uid = String(vtodo.getFirstPropertyValue("uid") ?? "");
	const summary = String(vtodo.getFirstPropertyValue("summary") ?? "");
	const description = String(vtodo.getFirstPropertyValue("description") ?? "");
	const status = String(vtodo.getFirstPropertyValue("status") ?? "");
	const percentDoneRaw = Number(
		vtodo.getFirstPropertyValue("percent-complete") ?? 0,
	);
	const priority = parseVtodoPriority(
		Number(vtodo.getFirstPropertyValue("priority") ?? 0),
	);

	const completedAt = toJsDate(vtodo.getFirstPropertyValue("completed"));
	const dueAt = toJsDate(vtodo.getFirstPropertyValue("due"));
	const startAt = toJsDate(vtodo.getFirstPropertyValue("dtstart"));
	const endAt = toJsDate(vtodo.getFirstPropertyValue("dtend"));
	const createdAt = toJsDate(vtodo.getFirstPropertyValue("created"));
	const updatedAt =
		toJsDate(vtodo.getFirstPropertyValue("last-modified")) ||
		toJsDate(vtodo.getFirstPropertyValue("dtstamp"));
	const { repeatAfter, repeatMode } = parseRrule(vtodo);

	return {
		projectId: 0,
		uid,
		title: summary,
		description,
		dueAt,
		startAt,
		endAt,
		completedAt: status === "COMPLETED" ? completedAt : null,
		priority,
		percentDone: Number.isFinite(percentDoneRaw) ? percentDoneRaw : null,
		color: getColor(vtodo),
		repeatAfter,
		repeatMode,
		createdAt: createdAt ?? undefined,
		updatedAt: updatedAt ?? undefined,
		labels: parseCategories(vtodo),
		reminders: parseReminders(vtodo),
		relations: parseRelations(vtodo),
	};
}

export function buildCalendarData(projectName: string, task: CaldavTask): string {
	const vcal = new ICAL.Component(["vcalendar", [], []]);
	vcal.updatePropertyWithValue("prodid", "-//vtodo//EN");
	vcal.updatePropertyWithValue("version", "2.0");
	if (projectName) {
		vcal.updatePropertyWithValue("x-wr-calname", projectName);
	}
	vcal.updatePropertyWithValue("x-published-ttl", "PT4H");

	const vtodo = new ICAL.Component("vtodo");
	vtodo.updatePropertyWithValue("uid", task.uid);
	vtodo.updatePropertyWithValue(
		"dtstamp",
		ICAL.Time.fromJSDate(task.updatedAt, true),
	);
	vtodo.updatePropertyWithValue(
		"last-modified",
		ICAL.Time.fromJSDate(task.updatedAt, true),
	);
	if (task.title) {
		vtodo.updatePropertyWithValue("summary", task.title);
	}
	if (task.description) {
		vtodo.updatePropertyWithValue("description", task.description);
	}
	if (task.createdAt) {
		vtodo.updatePropertyWithValue(
			"created",
			ICAL.Time.fromJSDate(task.createdAt, true),
		);
	}
	if (task.completedAt) {
		vtodo.updatePropertyWithValue(
			"completed",
			ICAL.Time.fromJSDate(task.completedAt, true),
		);
		vtodo.updatePropertyWithValue("status", "COMPLETED");
	} else {
		vtodo.updatePropertyWithValue("status", "NEEDS-ACTION");
	}
	if (task.dueAt) {
		vtodo.updatePropertyWithValue("due", ICAL.Time.fromJSDate(task.dueAt, true));
	}
	if (task.startAt) {
		vtodo.updatePropertyWithValue(
			"dtstart",
			ICAL.Time.fromJSDate(task.startAt, true),
		);
	}
	if (task.endAt) {
		vtodo.updatePropertyWithValue(
			"dtend",
			ICAL.Time.fromJSDate(task.endAt, true),
		);
	}
	if (task.repeatMode === "month" && (task.dueAt || task.startAt)) {
		const base = task.dueAt ?? task.startAt ?? task.updatedAt;
		vtodo.updatePropertyWithValue(
			"rrule",
			new ICAL.Recur({ freq: "MONTHLY", bymonthday: [base.getUTCDate()] }),
		);
	} else if (task.repeatAfter && task.repeatAfter > 0) {
		let freq = "SECONDLY";
		let interval = task.repeatAfter;
		if (task.repeatAfter % (60 * 60 * 24 * 7) === 0) {
			freq = "WEEKLY";
			interval = task.repeatAfter / (60 * 60 * 24 * 7);
		} else if (task.repeatAfter % (60 * 60 * 24) === 0) {
			freq = "DAILY";
			interval = task.repeatAfter / (60 * 60 * 24);
		} else if (task.repeatAfter % (60 * 60) === 0) {
			freq = "HOURLY";
			interval = task.repeatAfter / (60 * 60);
		} else if (task.repeatAfter % 60 === 0) {
			freq = "MINUTELY";
			interval = task.repeatAfter / 60;
		}
		vtodo.updatePropertyWithValue(
			"rrule",
			new ICAL.Recur({ freq, interval }),
		);
	}
	if (task.priority != null) {
		const caldavPriority = mapPriorityToCaldav(task.priority);
		if (caldavPriority != null) {
			vtodo.updatePropertyWithValue("priority", caldavPriority);
		}
	}
	if (task.percentDone != null) {
		vtodo.updatePropertyWithValue("percent-complete", task.percentDone);
	}
	if (task.color) {
		const color = `#${task.color}`.slice(0, 7);
		vtodo.addPropertyWithValue("x-apple-calendar-color", color);
		vtodo.addPropertyWithValue("x-outlook-color", color);
		vtodo.addPropertyWithValue("x-funambol-color", color);
		vtodo.addPropertyWithValue("color", color);
	}
	if (task.labels.length > 0) {
		const prop = new ICAL.Property("categories");
		prop.setValues(task.labels.map((label) => label.title));
		vtodo.addProperty(prop);
	}
	for (const relation of task.relations) {
		const prop = new ICAL.Property("related-to");
		prop.setValue(relation.uid);
		prop.setParameter("reltype", relation.type);
		vtodo.addProperty(prop);
	}
	for (const reminder of task.reminders) {
		const alarm = new ICAL.Component("valarm");
		const trigger = new ICAL.Property("trigger");
		if (reminder.reminderAt) {
			trigger.setValue(
				ICAL.Time.fromJSDate(reminder.reminderAt, true),
			);
			trigger.setParameter("value", "DATE-TIME");
		} else if (reminder.relativeSeconds != null) {
			const duration = ICAL.Duration.fromSeconds(reminder.relativeSeconds);
			trigger.setValue(duration);
			if (reminder.relativeTo === "end") {
				trigger.setParameter("related", "END");
			} else if (reminder.relativeTo === "start") {
				trigger.setParameter("related", "START");
			}
		}
		alarm.addProperty(trigger);
		alarm.addPropertyWithValue("action", "DISPLAY");
		alarm.addPropertyWithValue("description", task.title || "Reminder");
		vtodo.addSubcomponent(alarm);
	}

	vcal.addSubcomponent(vtodo);
	return vcal.toString();
}
