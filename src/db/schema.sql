create table if not exists caldav_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists caldav_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references caldav_users(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists caldav_projects (
  id bigserial primary key,
  owner_id uuid not null references caldav_users(id) on delete cascade,
  name text not null,
  ctag bigint not null default extract(epoch from now() at time zone 'UTC')::bigint * 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists caldav_tasks (
  id bigserial primary key,
  project_id bigint not null references caldav_projects(id) on delete cascade,
  uid text not null unique,
  title text not null,
  description text,
  due_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  completed_at timestamptz,
  priority int,
  percent_done int,
  color text,
  repeat_after int,
  repeat_mode text,
  sequence int not null default 0,
  dtstamp timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_caldav_tasks_sequence on caldav_tasks(sequence);

create table if not exists caldav_labels (
  id bigserial primary key,
  owner_id uuid not null references caldav_users(id) on delete cascade,
  title text not null
);

create table if not exists caldav_task_labels (
  task_id bigint not null references caldav_tasks(id) on delete cascade,
  label_id bigint not null references caldav_labels(id) on delete cascade,
  primary key (task_id, label_id)
);

create table if not exists caldav_task_reminders (
  task_id bigint not null references caldav_tasks(id) on delete cascade,
  reminder_at timestamptz,
  relative_seconds int,
  relative_to text
);

create table if not exists caldav_task_relations (
  task_id bigint not null references caldav_tasks(id) on delete cascade,
  related_uid text not null,
  rel_type text not null
);

create table if not exists caldav_task_deletions (
  project_id bigint not null references caldav_projects(id) on delete cascade,
  uid text not null,
  deleted_at timestamptz not null default now(),
  primary key (project_id, uid)
);

-- CTag auto-update trigger function
create or replace function update_project_ctag()
returns trigger as $$
begin
  update caldav_projects
  set ctag = extract(epoch from now() at time zone 'UTC')::bigint * 1000,
      updated_at = now()
  where id = coalesce(new.project_id, old.project_id);
  return coalesce(new, old);
end;
$$ language plpgsql;

-- CTag triggers
create trigger if not exists trigger_task_insert_update_ctag
after insert or update on caldav_tasks
for each row execute function update_project_ctag();

create trigger if not exists trigger_task_delete_update_ctag
after delete on caldav_tasks
for each row execute function update_project_ctag();

create trigger if not exists trigger_deletion_update_ctag
after insert on caldav_task_deletions
for each row execute function update_project_ctag();
