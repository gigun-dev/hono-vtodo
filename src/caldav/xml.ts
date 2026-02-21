import type { Context } from "hono";

import type { CaldavProject, CaldavTask, CaldavUser } from "./schema.js";
import { buildCalendarData } from "./ical.js";

const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const DAV_HEADERS = {
	DAV: "1, 2, calendar-access",
};

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function href(path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	if (normalized.endsWith("/") || normalized.endsWith(".ics")) {
		return normalized;
	}
	return `${normalized}/`;
}

function propstatOk(props: string): string {
	return `
    <d:propstat>
      <d:prop>
${props}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>`;
}

function responseFor(hrefValue: string, props: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>${propstatOk(props)}
  </d:response>`;
}

function responseNotFound(hrefValue: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>`;
}

function responseGone(hrefValue: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>
    <d:status>HTTP/1.1 410 Gone</d:status>
  </d:response>`;
}

function multistatus(responses: string, syncToken?: string): string {
	const token = syncToken
		? `
  <d:sync-token>${xmlEscape(syncToken)}</d:sync-token>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}" xmlns:cs="http://calendarserver.org/ns/">
${token}
${responses}
</d:multistatus>`;
}

function collectionProps(
	displayName: string,
	resType: string,
	extra: string = "",
	ctag?: string,
): string {
	const ctagProp = ctag
		? `
        <cs:getctag xmlns:cs="http://calendarserver.org/ns/">${xmlEscape(ctag)}</cs:getctag>`
		: "";
	return `
        <d:displayname>${xmlEscape(displayName)}</d:displayname>
        <d:resourcetype>${resType}</d:resourcetype>${ctagProp}
        ${extra}`.trimEnd();
}

function etag(updatedAt: Date): string {
	return `"${updatedAt.getTime()}"`;
}

function taskProps(task: CaldavTask, calendarData?: string): string {
	const content = calendarData ?? buildCalendarData("", task);
	return `
        <d:getetag>${etag(task.updatedAt)}</d:getetag>
        <d:getcontenttype>text/calendar; charset=utf-8; component=VTODO</d:getcontenttype>
        <d:getcontentlength>${content.length}</d:getcontentlength>
        <d:getlastmodified>${task.updatedAt.toUTCString()}</d:getlastmodified>`;
}

export function getDepthHeader(depthHeader?: string): "0" | "1" {
	if (!depthHeader) {
		return "0";
	}
	return depthHeader.includes("1") ? "1" : "0";
}

export function buildUnauthorizedResponse(c: Context) {
	return c.text("Unauthorized", 401, {
		"WWW-Authenticate": 'Basic realm="CalDAV"',
	});
}

export function buildEntryResponse(c: Context, user: CaldavUser) {
	const props = collectionProps(
		"CalDAV",
		"<d:collection/>",
		`
        <d:current-user-principal>
          <d:href>${href(`/dav/principals/${user.username}`)}</d:href>
        </d:current-user-principal>`,
	);
	return c.body(multistatus(responseFor(href("/dav/"), props)), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildPrincipalResponse(c: Context, user: CaldavUser) {
	const props = collectionProps(
		user.displayName ?? user.username,
		"<d:collection/><d:principal/>",
		`
        <c:calendar-home-set>
          <d:href>${href("/dav/projects/")}</d:href>
        </c:calendar-home-set>
        <d:current-user-principal>
          <d:href>${href(`/dav/principals/${user.username}`)}</d:href>
        </d:current-user-principal>`,
	);
	return c.body(
		multistatus(responseFor(href(`/dav/principals/${user.username}`), props)),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildProjectCollectionResponse(
	c: Context,
	user: CaldavUser,
	projects: CaldavProject[],
	depth: "0" | "1",
) {
	let responses = responseFor(
		href("/dav/projects/"),
		collectionProps(
			`${user.username} Calendars`,
			"<d:collection/>",
			`
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
        </c:supported-calendar-component-set>`,
		),
	);

	if (depth === "1") {
		for (const project of projects) {
			const resType = "<d:collection/><c:calendar/>";
			const extra = `
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
        </c:supported-calendar-component-set>`;
			responses += responseFor(
				href(`/dav/projects/${project.id}`),
				collectionProps(project.name, resType, extra, project.ctag),
			);
		}
	}

	return c.body(multistatus(responses), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

const PROJECT_COLLECTION_EXTRA = `
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
        </c:supported-calendar-component-set>`;

export function projectCollectionProps(project: CaldavProject): string {
	return collectionProps(
		project.name,
		"<d:collection/><c:calendar/>",
		PROJECT_COLLECTION_EXTRA,
		project.ctag,
	);
}

export function buildProjectResponse(c: Context, project: CaldavProject) {
	const props = projectCollectionProps(project);
	return c.body(
		multistatus(responseFor(href(`/dav/projects/${project.id}`), props)),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildCalendarCollectionResponse(
	c: Context,
	project: CaldavProject,
	tasks: CaldavTask[],
) {
	let responses = responseFor(
		href(`/dav/projects/${project.id}`),
		projectCollectionProps(project),
	);
	for (const task of tasks) {
		const calendarData = buildCalendarData(project.name, task);
		responses += responseFor(
			href(`/dav/projects/${project.id}/${task.uid}.ics`),
			taskProps(task, calendarData),
		);
	}
	return c.body(multistatus(responses), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildTaskResponse(
	c: Context,
	project: CaldavProject,
	task: CaldavTask,
) {
	const props = taskProps(task, buildCalendarData(project.name, task));
	return c.body(
		multistatus(
			responseFor(href(`/dav/projects/${project.id}/${task.uid}.ics`), props),
		),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildPropPatchResponse(
	c: Context,
	hrefValue: string,
	props?: string,
) {
	return c.body(multistatus(responseFor(hrefValue, props ?? "")), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildCalendarQueryResponse(
	c: Context,
	project: CaldavProject,
	tasks: CaldavTask[],
	withCalendarData: boolean,
	syncToken?: string,
) {
	let responses = "";
	for (const task of tasks) {
		const calendarData = buildCalendarData(project.name, task);
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(calendarData)}</c:calendar-data>`
			: "";
		responses += responseFor(
			href(`/dav/projects/${project.id}/${task.uid}.ics`),
			taskProps(task, calendarData) + extra,
		);
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildSyncCollectionResponse(
	c: Context,
	project: CaldavProject,
	tasks: CaldavTask[],
	deletedUids: string[],
	withCalendarData: boolean,
	syncToken?: string,
) {
	let responses = "";
	for (const task of tasks) {
		const calendarData = buildCalendarData(project.name, task);
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(calendarData)}</c:calendar-data>`
			: "";
		responses += responseFor(
			href(`/dav/projects/${project.id}/${task.uid}.ics`),
			taskProps(task, calendarData) + extra,
		);
	}
	for (const uid of deletedUids) {
		responses += responseGone(href(`/dav/projects/${project.id}/${uid}.ics`));
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildCalendarMultigetResponse(
	c: Context,
	project: CaldavProject,
	tasks: CaldavTask[],
	deletedUids: string[],
	body: string,
	withCalendarData: boolean,
	syncToken?: string,
) {
	const hrefs = Array.from(
		body.matchAll(/<(?:[^:>]+:)?href\b[^>]*>([^<]+)<\/(?:[^:>]+:)?href>/g),
		(match) => match[1],
	);
	const taskMap = new Map(tasks.map((task) => [task.uid.toUpperCase(), task]));
	const deletedSet = new Set(deletedUids.map((uid) => uid.toUpperCase()));
	let responses = "";
	for (const hrefValue of hrefs) {
		let path = hrefValue;
		if (hrefValue.startsWith("http://") || hrefValue.startsWith("https://")) {
			try {
				path = new URL(hrefValue).pathname;
			} catch {
				path = hrefValue;
			}
		}
		const rawLast = path.split("/").pop();
		const uid = rawLast
			? decodeURIComponent(rawLast).replace(/\.ics$/i, "")
			: "";
		if (!uid) {
			continue;
		}
		const task = taskMap.get(uid.toUpperCase());
		if (!task) {
			const normalized = uid.toUpperCase();
			responses += deletedSet.has(normalized)
				? responseGone(hrefValue)
				: responseNotFound(hrefValue);
			continue;
		}
		const calendarData = buildCalendarData(project.name, task);
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(calendarData)}</c:calendar-data>`
			: "";
		responses += responseFor(hrefValue, taskProps(task, calendarData) + extra);
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}
