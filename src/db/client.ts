import { Client } from "pg";

import type { CaldavEnv } from "../types/env";

export async function withDb<T>(
	env: CaldavEnv,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({
		connectionString: env.HYPERDRIVE.connectionString,
	});

	await client.connect();

	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}
