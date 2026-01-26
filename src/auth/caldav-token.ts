import bcrypt from "bcryptjs";
import type { Client } from "pg";

import type { CaldavUser } from "../caldav/schema";

export async function authenticateBasicUser(
	client: Client,
	username: string,
	password: string,
): Promise<CaldavUser | null> {
	const userResult = await client.query(
		"select id, username, display_name from caldav_users where username = $1",
		[username],
	);
	if (userResult.rows.length === 0) {
		return null;
	}

	const user: CaldavUser = {
		id: userResult.rows[0].id,
		username: userResult.rows[0].username,
		displayName: userResult.rows[0].display_name ?? null,
	};

	const tokenResult = await client.query(
		`select token_hash
		   from caldav_tokens
		  where user_id = $1
		    and revoked_at is null`,
		[user.id],
	);

	for (const row of tokenResult.rows) {
		const ok = await bcrypt.compare(password, row.token_hash);
		if (ok) {
			return user;
		}
	}

	return null;
}
