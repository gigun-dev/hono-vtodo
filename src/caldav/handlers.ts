import type { Context, Hono } from "hono";
import { decodeBase64 } from "hono/utils/encode";

import { authenticateBasicUser } from "../auth/caldav-token";
import type { CaldavUser } from "./schema.js";
import { withDb } from "../db/client";
import { buildCalendarData, parseVtodo } from "./ical.js";
import {
	buildCalendarCollectionResponse,
	buildCalendarMultigetResponse,
	buildCalendarQueryResponse,
	buildSyncCollectionResponse,
	buildEntryResponse,
	buildPrincipalResponse,
	buildProjectCollectionResponse,
	buildProjectResponse,
	buildPropPatchResponse,
	buildTaskResponse,
	buildUnauthorizedResponse,
	getDepthHeader,
	projectCollectionProps,
} from "./xml.js";
import {
	createTask,
	deleteTaskByUid,
	getProjectById,
	getProjectsForUser,
	getTaskByUid,
	getTasksForProject,
	getDeletedTasksForProject,
	updateTask,
	updateProjectDisplayName,
} from "./storage.js";

const MAX_BODY_SIZE = 256 * 1024; // 256KB

async function readBodyWithLimit(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<{ body: string } | { error: Response }> {
	const contentLength = c.req.header("content-length");
	if (contentLength) {
		const len = parseInt(contentLength, 10);
		if (Number.isNaN(len) || len > MAX_BODY_SIZE) {
			return { error: c.text("Request Entity Too Large", 413) };
		}
	}
	const body = await c.req.text();
	if (body.length > MAX_BODY_SIZE) {
		return { error: c.text("Request Entity Too Large", 413) };
	}
	return { body };
}

const DAV_HEADERS = {
	DAV: "1, 2, calendar-access, sync-collection",
	Allow: "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, PROPPATCH",
};

/** Parse PROPPATCH body (RFC 4918 propertyupdate), return displayname if set. */
function parseProppatchDisplayName(body: string): string | null {
	const m = body.match(
		/<(?:[^:>]+:)?displayname[^>]*>([^<]*)<\/(?:[^:>]+:)?displayname>/i,
	);
	if (!m || m[1] === undefined) {
		return null;
	}
	const value = m[1].trim();
	return value === "" ? null : value;
}

function parseBasicAuth(header: string | undefined): {
	username: string;
	password: string;
} | null {
	if (!header) {
		return null;
	}
	const [scheme, value] = header.split(" ");
	if (!scheme || scheme.toLowerCase() !== "basic" || !value) {
		return null;
	}
	const decoded = new TextDecoder().decode(decodeBase64(value));
	const idx = decoded.indexOf(":");
	if (idx === -1) {
		return null;
	}
	return {
		username: decoded.slice(0, idx),
		password: decoded.slice(idx + 1),
	};
}

function normalizeHrefUid(hrefValue: string): string | null {
	let path = hrefValue;
	if (hrefValue.startsWith("http://") || hrefValue.startsWith("https://")) {
		try {
			path = new URL(hrefValue).pathname;
		} catch {
			path = hrefValue;
		}
	}
	const rawLast = path.split("/").pop();
	if (!rawLast) {
		return null;
	}
	const uid = decodeURIComponent(rawLast).replace(/\.ics$/i, "");
	return uid || null;
}

function normalizeUidParam(rawValue: string): string | null {
	const uid = decodeURIComponent(rawValue).replace(/\.ics$/i, "");
	return uid || null;
}

async function requireAuth(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<CaldavUser | null> {
	const auth = parseBasicAuth(c.req.header("authorization"));
	if (!auth) {
		return null;
	}
	return await withDb(c.env, async (client) =>
		authenticateBasicUser(client, auth.username, auth.password),
	);
}

export function registerCaldavRoutes(
	app: Hono<{ Bindings: CloudflareBindings }>,
) {
	app.on("OPTIONS", "/dav/*", (c) => c.body(null, 204, DAV_HEADERS));

	app.on("OPTIONS", "/.well-known/caldav", (c) =>
		c.body(null, 204, DAV_HEADERS),
	);

	app.get("/.well-known/caldav", (c) => c.redirect("/dav/", 301));

	app.get("/.well-known/caldav/", (c) => c.redirect("/dav/", 301));

	const handlePrincipal = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return buildPrincipalResponse(c, user);
	};

	const handleEntry = async (c: Context<{ Bindings: CloudflareBindings }>) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return buildEntryResponse(c, user);
	};

	const handleProjects = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const depth = getDepthHeader(c.req.header("depth"));
		return await withDb(c.env, async (client) => {
			const projects = await getProjectsForUser(client, user.id);
			return buildProjectCollectionResponse(c, user, projects, depth);
		});
	};

	const handleProject = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const depth = getDepthHeader(c.req.header("depth"));
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			if (depth === "1") {
				const tasks = await getTasksForProject(client, project.id);
				return buildCalendarCollectionResponse(c, project, tasks);
			}
			return buildProjectResponse(c, project);
		});
	};

	const handleReport = async (c: Context<{ Bindings: CloudflareBindings }>) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const body = read.body;
		console.log("caldav_report_body", body);
		const isSyncCollection = body.includes("sync-collection");
		const hasCalendarData = body.includes("calendar-data");
		const isMultiget = body.includes("calendar-multiget");
		const syncTokenMatch =
			body.match(/<d:sync-token>([^<]+)<\/d:sync-token>/i) ??
			body.match(/<sync-token>([^<]+)<\/sync-token>/i);
		const requestSyncToken = syncTokenMatch?.[1];
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const tasks = await getTasksForProject(client, project.id);
			const deletions = await getDeletedTasksForProject(client, project.id);
			const withCalendarData = true;
			const requestTokenMs = requestSyncToken
				? Number(requestSyncToken)
				: Number.NaN;
			const since =
				Number.isFinite(requestTokenMs) && requestTokenMs > 0
					? new Date(requestTokenMs)
					: null;
			const syncToken = isSyncCollection
				? String(
						Math.max(
							project.updatedAt.getTime(),
							...tasks.map((task) => task.updatedAt.getTime()),
							...deletions.map((entry) => entry.deletedAt.getTime()),
						),
					)
				: undefined;
			console.log("caldav_report", {
				projectId: project.id,
				isSyncCollection,
				isMultiget,
				hasCalendarData,
				taskCount: tasks.length,
				requestSyncToken,
			});
			if (isSyncCollection) {
				const tasksForResponse = since
					? tasks.filter((task) => task.updatedAt > since)
					: tasks;
				const deletedUids = since
					? deletions
							.filter((entry) => entry.deletedAt > since)
							.map((entry) => entry.uid)
					: deletions.map((entry) => entry.uid);
				return buildSyncCollectionResponse(
					c,
					project,
					tasksForResponse,
					deletedUids,
					withCalendarData,
					syncToken,
				);
			}
			if (isMultiget) {
				const hrefs = Array.from(
					body.matchAll(
						/<(?:[^:>]+:)?href\b[^>]*>([^<]+)<\/(?:[^:>]+:)?href>/g,
					),
					(match) => match[1],
				);
				const taskUidSet = new Set(tasks.map((task) => task.uid.toUpperCase()));
				let matchedCount = 0;
				let missingCount = 0;
				const missingSamples: string[] = [];
				for (const hrefValue of hrefs) {
					const uid = normalizeHrefUid(hrefValue);
					if (!uid) {
						missingCount += 1;
						if (missingSamples.length < 5) {
							missingSamples.push(hrefValue);
						}
						continue;
					}
					if (taskUidSet.has(uid.toUpperCase())) {
						matchedCount += 1;
					} else {
						missingCount += 1;
						if (missingSamples.length < 5) {
							missingSamples.push(hrefValue);
						}
					}
				}
				console.log(
					`caldav_report_multiget requested=${hrefs.length} matched=${matchedCount} missing=${missingCount} samples=${JSON.stringify(
						missingSamples,
					)}`,
				);
				return buildCalendarMultigetResponse(
					c,
					project,
					tasks,
					deletions.map((entry) => entry.uid),
					body,
					withCalendarData,
					syncToken,
				);
			}
			return buildCalendarQueryResponse(
				c,
				project,
				tasks,
				withCalendarData,
				syncToken,
			);
		});
	};

	const handleProjectPropPatch = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const displayName = parseProppatchDisplayName(read.body);
		const projectId = Number(c.req.param("projectId"));
		const hrefValue = `/dav/projects/${projectId}/`;
		if (displayName !== null) {
			const project = await withDb(c.env, (client) =>
				updateProjectDisplayName(client, user.id, projectId, displayName),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			return buildPropPatchResponse(
				c,
				hrefValue,
				projectCollectionProps(project),
			);
		}
		return buildPropPatchResponse(c, hrefValue);
	};

	app.on("PROPFIND", "/.well-known/caldav", (c) => c.redirect("/dav/", 301));
	app.on("PROPFIND", "/.well-known/caldav/", (c) => c.redirect("/dav/", 301));

	app.on("PROPFIND", "/dav", handleEntry);
	app.on("PROPFIND", "/dav/", handleEntry);

	app.on("PROPFIND", "/dav/principals/:username", handlePrincipal);
	app.on("PROPFIND", "/dav/principals/:username/", handlePrincipal);

	app.on("PROPFIND", "/dav/projects", handleProjects);
	app.on("PROPFIND", "/dav/projects/", handleProjects);

	app.on("PROPFIND", "/dav/projects/:projectId", handleProject);
	app.on("PROPFIND", "/dav/projects/:projectId/", handleProject);

	app.on("REPORT", "/dav/projects/:projectId", handleReport);
	app.on("REPORT", "/dav/projects/:projectId/", handleReport);

	app.on("PROPPATCH", "/dav/projects/:projectId", handleProjectPropPatch);
	app.on("PROPPATCH", "/dav/projects/:projectId/", handleProjectPropPatch);

	app.get("/dav/projects/:projectId/:uid", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const uid = normalizeUidParam(c.req.param("uid"));
			if (!uid) {
				return c.text("Task not found", 404);
			}
			const task = await getTaskByUid(client, project.id, uid);
			if (!task) {
				return c.text("Task not found", 404);
			}
			const calendar = buildCalendarData(project.name, task);
			const etag = `"${task.updatedAt.getTime()}"`;
			return c.text(calendar, 200, {
				ETag: etag,
				"Content-Type": "text/calendar; charset=utf-8",
			});
		});
	});

	app.on("PROPFIND", "/dav/projects/:projectId/:uid", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const uid = normalizeUidParam(c.req.param("uid"));
			if (!uid) {
				return c.text("Task not found", 404);
			}
			const task = await getTaskByUid(client, project.id, uid);
			if (!task) {
				return c.text("Task not found", 404);
			}
			return buildTaskResponse(c, project, task);
		});
	});

	app.put("/dav/projects/:projectId/:uid", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const content = read.body;
		let parsed;
		try {
			parsed = parseVtodo(content);
		} catch (error) {
			return c.text(
				error instanceof Error ? error.message : "Invalid VTODO",
				400,
			);
		}
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const uid = normalizeUidParam(c.req.param("uid"));
			if (!uid) {
				return c.text("Invalid UID", 400);
			}
			const existing = await getTaskByUid(client, project.id, uid);
			const taskInput = {
				...parsed,
				projectId: project.id,
				uid,
			};
			if (existing && parsed.description === undefined) {
				taskInput.description = existing.description;
			}
			const task = existing
				? await updateTask(client, user.id, existing.id, taskInput)
				: await createTask(client, user.id, taskInput);
			const calendar = buildCalendarData(project.name, task);
			const etag = `"${task.updatedAt.getTime()}"`;
			return c.text(calendar, existing ? 200 : 201, {
				ETag: etag,
				"Content-Type": "text/calendar; charset=utf-8",
			});
		});
	});

	app.delete("/dav/projects/:projectId/:uid", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const uid = normalizeUidParam(c.req.param("uid"));
			if (!uid) {
				return c.text("Task not found", 404);
			}
			const deleted = await deleteTaskByUid(client, project.id, uid);
			if (!deleted) {
				console.log(
					`caldav_delete_not_found projectId=${project.id} uid=${uid}`,
				);
				return c.text("Task not found", 404);
			}
			console.log(`caldav_delete projectId=${project.id} uid=${uid}`);
			return c.body(null, 204);
		});
	});
}
