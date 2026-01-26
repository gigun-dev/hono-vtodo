import type { Client } from "pg";

import type {
	CaldavLabel,
	CaldavProject,
	CaldavReminder,
	CaldavRelation,
	CaldavTask,
	CaldavTaskInput,
} from "./schema.js";

const DEFAULT_REPEAT_MODE = "default";

function toDate(value: string | null): Date | null {
	return value ? new Date(value) : null;
}

function normalizeTaskRow(row: any): CaldavTask {
	return {
		id: row.id,
		projectId: row.project_id,
		uid: row.uid,
		title: row.title,
		description: row.description ?? "",
		dueAt: toDate(row.due_at),
		startAt: toDate(row.start_at),
		endAt: toDate(row.end_at),
		completedAt: toDate(row.completed_at),
		priority: row.priority ?? null,
		percentDone: row.percent_done ?? null,
		color: row.color ?? null,
		repeatAfter: row.repeat_after ?? null,
		repeatMode: row.repeat_mode ?? null,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
		labels: [],
		reminders: [],
		relations: [],
	};
}

export async function getProjectsForUser(
	client: Client,
	userId: string,
): Promise<CaldavProject[]> {
	const result = await client.query(
		`select id, name, owner_id, created_at, updated_at
		   from caldav_projects
		  where owner_id = $1
		  order by id asc`,
		[userId],
	);
	return result.rows.map((row) => ({
		id: row.id,
		name: row.name,
		ownerId: row.owner_id,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	}));
}

export async function getProjectById(
	client: Client,
	userId: string,
	projectId: number,
): Promise<CaldavProject | null> {
	const result = await client.query(
		`select id, name, owner_id, created_at, updated_at
		   from caldav_projects
		  where id = $1 and owner_id = $2`,
		[projectId, userId],
	);
	if (result.rows.length === 0) {
		return null;
	}
	return {
		id: result.rows[0].id,
		name: result.rows[0].name,
		ownerId: result.rows[0].owner_id,
		createdAt: new Date(result.rows[0].created_at),
		updatedAt: new Date(result.rows[0].updated_at),
	};
}

export async function getTasksForProject(
	client: Client,
	projectId: number,
): Promise<CaldavTask[]> {
	const result = await client.query(
		`select *
		   from caldav_tasks
		  where project_id = $1
		  order by updated_at desc`,
		[projectId],
	);
	const tasks = result.rows.map(normalizeTaskRow);
	await hydrateTaskMeta(client, tasks);
	return tasks;
}

export async function getTaskByUid(
	client: Client,
	projectId: number,
	uid: string,
): Promise<CaldavTask | null> {
	const result = await client.query(
		`select *
		   from caldav_tasks
		  where project_id = $1 and uid = $2`,
		[projectId, uid],
	);
	if (result.rows.length === 0) {
		return null;
	}
	const task = normalizeTaskRow(result.rows[0]);
	await hydrateTaskMeta(client, [task]);
	return task;
}

async function hydrateTaskMeta(client: Client, tasks: CaldavTask[]) {
	if (tasks.length === 0) {
		return;
	}
	const taskIds = tasks.map((task) => task.id);

	const labelsResult = await client.query(
		`select tl.task_id, l.id, l.title
		   from caldav_task_labels tl
		   join caldav_labels l on l.id = tl.label_id
		  where tl.task_id = any($1::bigint[])`,
		[taskIds],
	);

	const remindersResult = await client.query(
		`select task_id, reminder_at, relative_seconds, relative_to
		   from caldav_task_reminders
		  where task_id = any($1::bigint[])`,
		[taskIds],
	);

	const relationsResult = await client.query(
		`select task_id, related_uid, rel_type
		   from caldav_task_relations
		  where task_id = any($1::bigint[])`,
		[taskIds],
	);

	const taskMap = new Map(tasks.map((task) => [task.id, task]));

	for (const row of labelsResult.rows) {
		const task = taskMap.get(row.task_id);
		if (!task) continue;
		task.labels.push({ id: row.id, title: row.title });
	}

	for (const row of remindersResult.rows) {
		const task = taskMap.get(row.task_id);
		if (!task) continue;
		task.reminders.push({
			reminderAt: row.reminder_at ? new Date(row.reminder_at) : null,
			relativeSeconds: row.relative_seconds ?? null,
			relativeTo: row.relative_to ?? null,
		});
	}

	for (const row of relationsResult.rows) {
		const task = taskMap.get(row.task_id);
		if (!task) continue;
		task.relations.push({
			type: row.rel_type ?? "RELATED",
			uid: row.related_uid,
		});
	}
}

export async function createTask(
	client: Client,
	userId: string,
	input: CaldavTaskInput,
): Promise<CaldavTask> {
	const now = new Date();
	const uid = input.uid ?? crypto.randomUUID();
	const createdAt = input.createdAt ?? now;
	const updatedAt = input.updatedAt ?? now;

	await client.query("BEGIN");
	try {
		const insert = await client.query(
			`insert into caldav_tasks (
				project_id, uid, title, description, due_at, start_at, end_at,
				completed_at, priority, percent_done, color, repeat_after,
				repeat_mode, created_at, updated_at
			)
			values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			returning *`,
			[
				input.projectId,
				uid,
				input.title ?? "",
				input.description ?? "",
				input.dueAt,
				input.startAt,
				input.endAt,
				input.completedAt,
				input.priority ?? null,
				input.percentDone ?? null,
				input.color ?? null,
				input.repeatAfter ?? null,
				input.repeatMode ?? DEFAULT_REPEAT_MODE,
				createdAt,
				updatedAt,
			],
		);
		const task = normalizeTaskRow(insert.rows[0]);
		task.labels = await upsertLabels(client, userId, input.labels ?? []);
		await replaceTaskLabels(client, task.id, task.labels);
		task.reminders = await replaceTaskReminders(
			client,
			task.id,
			input.reminders ?? [],
		);
		task.relations = await replaceTaskRelations(
			client,
			task.id,
			input.relations ?? [],
		);
		await client.query("COMMIT");
		return task;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

export async function updateTask(
	client: Client,
	userId: string,
	taskId: number,
	input: CaldavTaskInput,
): Promise<CaldavTask> {
	const updatedAt = input.updatedAt ?? new Date();

	await client.query("BEGIN");
	try {
		const update = await client.query(
			`update caldav_tasks
			    set title = $1,
			        description = $2,
			        due_at = $3,
			        start_at = $4,
			        end_at = $5,
			        completed_at = $6,
			        priority = $7,
			        percent_done = $8,
			        color = $9,
			        repeat_after = $10,
			        repeat_mode = $11,
			        updated_at = $12
			  where id = $13
			  returning *`,
			[
				input.title ?? "",
				input.description ?? "",
				input.dueAt,
				input.startAt,
				input.endAt,
				input.completedAt,
				input.priority ?? null,
				input.percentDone ?? null,
				input.color ?? null,
				input.repeatAfter ?? null,
				input.repeatMode ?? DEFAULT_REPEAT_MODE,
				updatedAt,
				taskId,
			],
		);
		const task = normalizeTaskRow(update.rows[0]);
		task.labels = await upsertLabels(client, userId, input.labels ?? []);
		await replaceTaskLabels(client, task.id, task.labels);
		task.reminders = await replaceTaskReminders(
			client,
			task.id,
			input.reminders ?? [],
		);
		task.relations = await replaceTaskRelations(
			client,
			task.id,
			input.relations ?? [],
		);
		await client.query("COMMIT");
		return task;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

export async function deleteTask(client: Client, taskId: number) {
	await client.query("BEGIN");
	try {
		await client.query("delete from caldav_task_labels where task_id = $1", [
			taskId,
		]);
		await client.query("delete from caldav_task_reminders where task_id = $1", [
			taskId,
		]);
		await client.query("delete from caldav_task_relations where task_id = $1", [
			taskId,
		]);
		await client.query("delete from caldav_tasks where id = $1", [taskId]);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function upsertLabels(
	client: Client,
	userId: string,
	labels: CaldavLabel[],
): Promise<CaldavLabel[]> {
	if (!labels || labels.length === 0) {
		return [];
	}

	const titles = labels.map((label) => label.title);
	const existing = await client.query(
		`select id, title from caldav_labels
		  where owner_id = $1 and title = any($2::text[])`,
		[userId, titles],
	);
	const map = new Map(existing.rows.map((row) => [row.title, row.id]));

	const result: CaldavLabel[] = [];
	for (const label of labels) {
		const found = map.get(label.title);
		if (found) {
			result.push({ id: found, title: label.title });
			continue;
		}
		const insert = await client.query(
			`insert into caldav_labels (owner_id, title)
			 values ($1, $2)
			 returning id, title`,
			[userId, label.title],
		);
		result.push({
			id: insert.rows[0].id,
			title: insert.rows[0].title,
		});
	}
	return result;
}

async function replaceTaskLabels(
	client: Client,
	taskId: number,
	labels: CaldavLabel[],
) {
	await client.query("delete from caldav_task_labels where task_id = $1", [
		taskId,
	]);
	for (const label of labels) {
		await client.query(
			`insert into caldav_task_labels (task_id, label_id)
			 values ($1, $2)`,
			[taskId, label.id],
		);
	}
}

async function replaceTaskReminders(
	client: Client,
	taskId: number,
	reminders: CaldavReminder[],
): Promise<CaldavReminder[]> {
	await client.query("delete from caldav_task_reminders where task_id = $1", [
		taskId,
	]);
	if (!reminders || reminders.length === 0) {
		return [];
	}
	for (const reminder of reminders) {
		await client.query(
			`insert into caldav_task_reminders (task_id, reminder_at, relative_seconds, relative_to)
			 values ($1, $2, $3, $4)`,
			[
				taskId,
				reminder.reminderAt,
				reminder.relativeSeconds,
				reminder.relativeTo,
			],
		);
	}
	return reminders;
}

async function replaceTaskRelations(
	client: Client,
	taskId: number,
	relations: CaldavRelation[],
): Promise<CaldavRelation[]> {
	await client.query("delete from caldav_task_relations where task_id = $1", [
		taskId,
	]);
	if (!relations || relations.length === 0) {
		return [];
	}
	for (const relation of relations) {
		await client.query(
			`insert into caldav_task_relations (task_id, related_uid, rel_type)
			 values ($1, $2, $3)`,
			[taskId, relation.uid, relation.type],
		);
	}
	return relations;
}
