-- OUR HOME — initial schema
-- Ownership model: every user-visible record belongs to exactly one workspace.
-- A workspace is either 'personal' (owned by one user, visible only to that user)
-- or 'shared' (the household's US space, visible to every household member).
-- All authorization is derived from workspace_id; see server/lib/access.ts.


-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- sha256 of the cookie token
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE rate_limit_events (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_bucket_idx ON rate_limit_events (bucket, created_at);

CREATE TABLE households (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL DEFAULT 'Our home',
  timezone              text NOT NULL DEFAULT 'UTC',
  currency              text NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  auto_move_to_stock    boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE household_members (
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('primary', 'partner')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);
-- A person belongs to exactly one household.
CREATE UNIQUE INDEX household_members_user_idx ON household_members (user_id);

CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  email         text,
  invited_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    timestamptz
);

CREATE TABLE user_settings (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_mentions       boolean NOT NULL DEFAULT true,
  notify_replies        boolean NOT NULL DEFAULT true,
  notify_shared         boolean NOT NULL DEFAULT true,
  notify_assigned       boolean NOT NULL DEFAULT true,
  notify_reminders      boolean NOT NULL DEFAULT true,
  notify_calendar       boolean NOT NULL DEFAULT true,
  notify_decisions      boolean NOT NULL DEFAULT true,
  dashboard_sections    text[] NOT NULL DEFAULT ARRAY['today','upcoming','need','reminders','assigned','awaiting','recent']
);

-- -------------------------------------------------------------- workspaces
CREATE TABLE workspaces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('personal', 'shared')),
  owner_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX workspaces_personal_idx ON workspaces (owner_user_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX workspaces_shared_idx ON workspaces (household_id) WHERE kind = 'shared';
CREATE INDEX workspaces_household_idx ON workspaces (household_id);

CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module        text NOT NULL CHECK (module IN ('grocery','home','idea','task','inventory','expense','event')),
  group_name    text,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color         text NOT NULL DEFAULT '#8a8178',
  is_default    boolean NOT NULL DEFAULT false,
  sort_order    int NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_unique_idx ON categories (workspace_id, module, lower(name));

CREATE TABLE tags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX tags_unique_idx ON tags (workspace_id, lower(name));

-- ------------------------------------------------------------------- lists
CREATE TABLE lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module        text NOT NULL CHECK (module IN ('grocery','home','idea')),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_default    boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX lists_workspace_idx ON lists (workspace_id, module);
CREATE UNIQUE INDEX lists_default_idx ON lists (workspace_id, module) WHERE is_default;

-- Items: groceries (NEED/STOCK), home improvement, and the flexible
-- ideas/clothes/gifts/events collection. Module-specific fields are typed
-- columns, validated per module in server/lib/validation.ts.
CREATE TABLE items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id                uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  module                 text NOT NULL CHECK (module IN ('grocery','home','idea')),
  grocery_state          text CHECK (grocery_state IN ('need','stock')),
  title                  text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes                  text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  category_id            uuid REFERENCES categories(id) ON DELETE SET NULL,
  idea_type              text,
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  decision_status        text CHECK (decision_status IN ('idea','considering','discussing','approved','purchased','rejected')),
  purchase_stage         text CHECK (purchase_stage IN ('suggested','preferred','agreed','purchased')),
  quantity               numeric(12,3) CHECK (quantity IS NULL OR quantity >= 0),
  unit                   text,
  assigned_to            uuid REFERENCES users(id) ON DELETE SET NULL,
  intended_for_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  intended_for_name      text,
  link_url               text CHECK (link_url IS NULL OR link_url ~* '^https?://'),
  link_title             text,
  link_image_url         text,
  link_site_name         text,
  price_cents            bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  currency               text CHECK (currency IS NULL OR length(currency) = 3),
  room                   text,
  dimensions             text,
  color_material         text,
  store                  text,
  target_date            date,
  purchased_on           date,
  expires_on             date,
  storage_location       text,
  comparison_group_id    uuid,
  related_event_id       uuid,
  -- provenance / sharing
  origin_item_id         uuid REFERENCES items(id) ON DELETE SET NULL,
  origin_owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  shared_at              timestamptz,
  shared_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  CHECK ((module = 'grocery') = (grocery_state IS NOT NULL))
);
CREATE INDEX items_workspace_idx ON items (workspace_id, module, archived_at);
CREATE INDEX items_list_idx ON items (list_id);
CREATE INDEX items_origin_idx ON items (origin_item_id);
CREATE INDEX items_group_idx ON items (comparison_group_id) WHERE comparison_group_id IS NOT NULL;

CREATE TABLE item_tags (
  item_id  uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id   uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

-- ------------------------------------------------------------------ events
CREATE TABLE events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                    text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description              text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  location                 text NOT NULL DEFAULT '',
  notes                    text NOT NULL DEFAULT '',
  category                 text,
  all_day                  boolean NOT NULL DEFAULT false,
  time_unspecified         boolean NOT NULL DEFAULT false,
  start_date               date NOT NULL,           -- local (household tz) date
  end_date                 date,
  starts_at                timestamptz,             -- null when all-day or time unspecified
  ends_at                  timestamptz,
  participants             text[] NOT NULL DEFAULT '{}',
  availability_only        boolean NOT NULL DEFAULT false,
  for_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  source_type              text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','text','google','task')),
  -- Google provenance (read-only copy; never written back)
  google_connection_id     uuid,
  google_calendar_id       text,
  google_calendar_name     text,
  google_event_id          text,
  google_recurring_event_id text,
  google_recurrence        text[],
  source_snapshot          jsonb,                   -- last acknowledged state of the source event
  source_updated_at        timestamptz,
  imported_at              timestamptz,
  imported_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  locally_modified         boolean NOT NULL DEFAULT false,
  -- sharing provenance
  origin_event_id          uuid REFERENCES events(id) ON DELETE SET NULL,
  origin_owner_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  shared_at                timestamptz,
  shared_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX events_workspace_date_idx ON events (workspace_id, start_date);
-- Prevents duplicate imports of the same Google event into the same workspace,
-- including ones the household archived (so a refresh never resurrects them).
CREATE UNIQUE INDEX events_google_unique_idx
  ON events (workspace_id, google_connection_id, google_calendar_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

-- ------------------------------------------------------------------- tasks
CREATE TABLE tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description          text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  kind                 text NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo','maintenance')),
  due_date             date,
  due_time             time,
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  assignee             text NOT NULL DEFAULT 'none' CHECK (assignee IN ('none','user','both')),
  assigned_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','planned','in_progress','waiting','completed','archived')),
  reminder_at          timestamptz,
  reminder_sent_at     timestamptz,
  recurrence_unit      text CHECK (recurrence_unit IN ('day','week','month','year')),
  recurrence_interval  int CHECK (recurrence_interval IS NULL OR recurrence_interval BETWEEN 1 AND 365),
  related_event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  related_item_id      uuid REFERENCES items(id) ON DELETE SET NULL,
  completed_at         timestamptz,
  completed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  origin_task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  origin_owner_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  shared_at            timestamptz,
  shared_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  CHECK ((assignee = 'user') = (assigned_user_id IS NOT NULL)),
  CHECK ((recurrence_unit IS NULL) = (recurrence_interval IS NULL))
);
CREATE INDEX tasks_workspace_idx ON tasks (workspace_id, status);
CREATE INDEX tasks_reminder_idx ON tasks (reminder_at) WHERE reminder_sent_at IS NULL;

CREATE TABLE task_completions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date      date,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  completed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text
);
CREATE INDEX task_completions_task_idx ON task_completions (task_id);

-- --------------------------------------------------------------- inventory
CREATE TABLE inventory_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  room            text NOT NULL DEFAULT 'Other',
  category        text,
  brand           text,
  model           text,
  dimensions      text,
  purchase_date   date,
  price_cents     bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  currency        text,
  warranty_until  date,
  warranty_notes  text,
  manual_url      text CHECK (manual_url IS NULL OR manual_url ~* '^https?://'),
  notes           text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX inventory_workspace_idx ON inventory_items (workspace_id, room);

-- ---------------------------------------------------------------- receipts
CREATE TABLE receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  attachment_id   uuid,
  status          text NOT NULL DEFAULT 'review' CHECK (status IN ('review','confirmed','discarded')),
  processor       text NOT NULL CHECK (processor IN ('ai','text','manual')),
  processor_note  text,
  merchant        text,
  purchase_date   date,
  total_cents     bigint,
  tax_cents       bigint,
  currency        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX receipts_workspace_idx ON receipts (workspace_id, created_at DESC);

CREATE TABLE receipt_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id            uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position              int NOT NULL,
  raw_text              text,
  name                  text NOT NULL DEFAULT '',
  quantity              numeric(12,3),
  unit_price_cents      bigint,
  total_cents           bigint,
  category_id           uuid REFERENCES categories(id) ON DELETE SET NULL,
  needs_review          boolean NOT NULL DEFAULT false,
  review_reason         text,
  matched_need_item_id  uuid REFERENCES items(id) ON DELETE SET NULL,
  matched_stock_item_id uuid REFERENCES items(id) ON DELETE SET NULL
);
CREATE INDEX receipt_lines_receipt_idx ON receipt_lines (receipt_id, position);

-- ---------------------------------------------------------------- expenses
CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  currency        text NOT NULL,
  purchase_date   date NOT NULL,
  purchaser_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  category        text,
  notes           text NOT NULL DEFAULT '',
  receipt_id      uuid REFERENCES receipts(id) ON DELETE SET NULL,
  split_mode      text NOT NULL DEFAULT 'individual' CHECK (split_mode IN ('individual','equal','custom')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX expenses_workspace_idx ON expenses (workspace_id, purchase_date DESC);

CREATE TABLE expense_allocations (
  expense_id    uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (expense_id, user_id)
);

-- ------------------------------------------------------------- attachments
-- entity_type/entity_id point at the owning record; workspace_id is copied
-- from the owner so authorization never depends on the polymorphic link.
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('item','task','event','inventory','expense','receipt','message')),
  entity_id     uuid NOT NULL,
  blob_key      text NOT NULL UNIQUE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    int NOT NULL CHECK (size_bytes > 0),
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);

-- ----------------------------------------------------------- conversations
CREATE TABLE threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('item','task','event','inventory','expense')),
  entity_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(body) <= 5000),
  reply_to_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz,
  deleted_at   timestamptz
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE mentions (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE thread_reads (
  thread_id     uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE reactions (
  entity_type  text NOT NULL CHECK (entity_type IN ('item','task','event','inventory','expense')),
  entity_id    uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction     text NOT NULL CHECK (reaction IN ('love','yes','unsure','no')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, user_id)
);

-- ----------------------------------------------------------- notifications
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('mention','reply','shared','assigned','reminder','calendar','decision')),
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  entity_type   text,
  entity_id     uuid,
  message_id    uuid REFERENCES messages(id) ON DELETE CASCADE,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ------------------------------------------------------- activity & recall
CREATE TABLE activity (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity_idx ON activity (entity_type, entity_id, created_at DESC);
CREATE INDEX activity_workspace_idx ON activity (workspace_id, created_at DESC);

CREATE TABLE favorites (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE TABLE recently_viewed (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- ------------------------------------------------------- google calendars
CREATE TABLE google_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_sub         text NOT NULL,
  google_email       text NOT NULL,
  access_token_enc   text,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reauth','disconnected')),
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_sub)
);

CREATE TABLE google_calendars (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       uuid NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
  google_calendar_id  text NOT NULL,
  summary             text NOT NULL,
  color               text,
  access_role         text NOT NULL,
  is_primary          boolean NOT NULL DEFAULT false,
  selected            boolean NOT NULL DEFAULT false,
  last_import_at      timestamptz,
  UNIQUE (connection_id, google_calendar_id)
);

CREATE TABLE oauth_states (
  state_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('import','export')),
  code_verifier  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_exports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id       uuid REFERENCES google_connections(id) ON DELETE SET NULL,
  google_calendar_id  text NOT NULL,
  google_event_id     text NOT NULL,
  html_link           text,
  exported_title      text NOT NULL,
  exported_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_exports_event_idx ON event_exports (event_id, user_id);
