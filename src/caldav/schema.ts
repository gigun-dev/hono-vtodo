export type CaldavUser = {
	id: string;
	username: string;
	displayName: string | null;
};

export type CaldavProject = {
	id: number;
	name: string;
	ownerId: string;
	ctag: string;
	createdAt: Date;
	updatedAt: Date;
};

export type CaldavLabel = {
	id: number;
	title: string;
};

export type CaldavReminder = {
	reminderAt: Date | null;
	relativeSeconds: number | null;
	relativeTo: "start" | "end" | "due" | null;
};

export type CaldavRelation = {
	type: "PARENT" | "CHILD" | "RELATED";
	uid: string;
};

export type CaldavTask = {
	id: number;
	projectId: number;
	uid: string;
	title: string;
	description: string;
	dueAt: Date | null;
	startAt: Date | null;
	endAt: Date | null;
	completedAt: Date | null;
	priority: number | null;
	percentDone: number | null;
	color: string | null;
	repeatAfter: number | null;
	repeatMode: "default" | "month" | "from_current" | null;
	sequence: number;
	dtstamp: Date;
	createdAt: Date;
	updatedAt: Date;
	labels: CaldavLabel[];
	reminders: CaldavReminder[];
	relations: CaldavRelation[];
};

export type CaldavTaskInput = Omit<
	CaldavTask,
	"id" | "sequence" | "dtstamp" | "createdAt" | "updatedAt" | "description"
> & {
	description?: string;
	createdAt?: Date;
	updatedAt?: Date;
};
