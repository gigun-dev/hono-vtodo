import type { Context, Hono } from "hono";
import { decodeBase64 } from "hono/utils/encode";

import { authenticateBasicUser } from "../auth/caldav-token";
import type { CaldavUser } from "./schema";
import type { CaldavEnv } from "../types/env";
import { withDb } from "../db/client";
import {
	buildCalendarData,
	parseVtodo,
} from "./ical";
import {
	buildCalendarCollectionResponse,
	buildCalendarMultigetResponse,
	buildCalendarQueryResponse,
	buildEntryResponse,
	buildPrincipalResponse,
	buildProjectCollectionResponse,
	buildProjectResponse,
	buildTaskResponse,
	buildUnauthorizedResponse,
	getDepthHeader,
} from "./xml";
import {
	createTask,
	deleteTask,
	getProjectById,
	getProjectsForUser,
	getTaskByUid,
	getTasksForProject,
	updateTask,
} from "./storage";

const DAV_HEADERS = {
	DAV: "1, 2, calendar-access",
	Allow: "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE",
};

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
	const decoded = decodeBase64(value);
	const idx = decoded.indexOf(":");
	if (idx === -1) {
		return null;
	}
	return {
		username: decoded.slice(0, idx),
		password: decoded.slice(idx + 1),
	};
}

async function requireAuth(
	c: Context<{ Bindings: CaldavEnv }>,
): Promise<CaldavUser | null> {
	const auth = parseBasicAuth(c.req.header("authorization"));
	if (!auth) {
		return null;
	}
	return await withDb(c.env, async (client) =>
		authenticateBasicUser(client, auth.username, auth.password),
	);
}

export function registerCaldavRoutes(app: Hono<{ Bindings: CaldavEnv }>) {
	app.on("OPTIONS", "/dav/*", (c) =>
		c.body(null, 204, DAV_HEADERS),
	);

	app.on("OPTIONS", "/.well-known/caldav", (c) =>
		c.body(null, 204, DAV_HEADERS),
	);

	app.get("/.well-known/caldav", (c) =>
		c.redirect("/dav/", 301),
	);

	app.on("PROPFIND", "/.well-known/caldav", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return buildPrincipalResponse(c, user);
	});

	app.on("PROPFIND", "/dav", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return buildEntryResponse(c, user);
	});

	app.on("PROPFIND", "/dav/principals/:username", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		return buildPrincipalResponse(c, user);
	});

	app.on("PROPFIND", "/dav/projects", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const depth = getDepthHeader(c.req.header("depth"));
		return await withDb(c.env, async (client) => {
			const projects = await getProjectsForUser(client, user.id);
			return buildProjectCollectionResponse(c, user, projects, depth);
		});
	});

	app.on("PROPFIND", "/dav/projects/:projectId", async (c) => {
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
	});

	app.on("REPORT", "/dav/projects/:projectId", async (c) => {
		const user = await requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const body = await c.req.text();
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
			const withCalendarData = body.includes("calendar-data");
			if (body.includes("calendar-multiget")) {
				return buildCalendarMultigetResponse(
					c,
					project,
					tasks,
					body,
					withCalendarData,
				);
			}
			return buildCalendarQueryResponse(
				c,
				project,
				tasks,
				withCalendarData,
			);
		});
	});

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
			const uid = c.req.param("uid").replace(/\.ics$/, "");
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
			const uid = c.req.param("uid").replace(/\.ics$/, "");
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
		const content = await c.req.text();
		const parsed = parseVtodo(content);
		return await withDb(c.env, async (client) => {
			const project = await getProjectById(
				client,
				user.id,
				Number(c.req.param("projectId")),
			);
			if (!project) {
				return c.text("Project not found", 404);
			}
			const uid = c.req.param("uid").replace(/\.ics$/, "");
			const existing = await getTaskByUid(client, project.id, uid);
			const taskInput = {
				...parsed,
				projectId: project.id,
				uid,
			};
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
			const uid = c.req.param("uid").replace(/\.ics$/, "");
			const task = await getTaskByUid(client, project.id, uid);
			if (!task) {
				return c.text("Task not found", 404);
			}
			await deleteTask(client, task.id);
			return c.body(null, 204);
		});
	});
}
