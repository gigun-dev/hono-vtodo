import bcrypt from "bcryptjs";
import type { Client } from "pg";

import type { CaldavUser } from "../caldav/schema";

export async function authenticateBasicUser(
	client: Client,
	username: string,
	password: string,
): Promise<CaldavUser | null> {
	// トークンは十分にランダムなUUIDなので、平文で保存して直接比較
	// bcryptは遅すぎてCloudflare WorkersのCPU制限を超える
	const result = await client.query(
		`select u.id, u.username, u.display_name
		   from caldav_users u
		   join caldav_tokens t on u.id = t.user_id
		  where u.username = $1
		    and t.token_hash = $2
		    and t.revoked_at is null
		  limit 1`,
		[username, password],
	);

	if (result.rows.length === 0) {
		return null;
	}

	return {
		id: result.rows[0].id,
		username: result.rows[0].username,
		displayName: result.rows[0].display_name ?? null,
	};
}
