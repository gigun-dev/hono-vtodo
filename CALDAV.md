# CalDAV (iOS Reminders) Setup

This server expects CalDAV Basic Auth with an independent token (stored as a hash).

## 1) Create a CalDAV user

```sql
insert into caldav_users (username, display_name)
values ('your-username', 'Your Name');
```

## 2) Create a token for that user

Generate a random token and store a bcrypt hash:

```sql
insert into caldav_tokens (user_id, token_hash)
select id, '<BCRYPT_HASH>'
from caldav_users
where username = 'your-username';
```

Example (Node):

```ts
import bcrypt from "bcryptjs";
const token = crypto.randomUUID();
const hash = await bcrypt.hash(token, 10);
console.log({ token, hash });
```

## 3) Create a project

```sql
insert into caldav_projects (owner_id, name)
select id, 'Inbox'
from caldav_users
where username = 'your-username';
```

## 4) iOS Reminders settings

- Server: `https://<your-domain>/.well-known/caldav`
- Username: `your-username`
- Password: the generated token

## 5) Schema

See `src/db/schema.sql` for the full schema.
