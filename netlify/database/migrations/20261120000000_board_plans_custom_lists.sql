-- Custom lists, plans (events with a checklist, lists and their own page),
-- the Board (sticky notes, photos, links, words) and chat replies that are
-- copied from the main chat into the card they are about.

-- ------------------------------------------------------------ custom lists
-- Built-in lists keep their module (grocery/home/idea). Lists the household
-- makes itself use module 'custom' and are identified by list id. A list with
-- an event_id belongs to a plan and is shown only on that plan's page.
ALTER TABLE lists DROP CONSTRAINT lists_module_check;
ALTER TABLE lists ADD CONSTRAINT lists_module_check CHECK (module IN ('grocery','home','idea','custom'));
ALTER TABLE lists
  ADD COLUMN emoji      text CHECK (emoji IS NULL OR length(emoji) <= 16),
  ADD COLUMN color      text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN event_id   uuid REFERENCES events(id) ON DELETE CASCADE,
  ADD COLUMN position   int NOT NULL DEFAULT 100,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE lists ADD CONSTRAINT lists_event_custom_check CHECK (event_id IS NULL OR module = 'custom');
CREATE INDEX lists_event_idx ON lists (event_id) WHERE event_id IS NOT NULL;

ALTER TABLE items DROP CONSTRAINT items_module_check;
ALTER TABLE items ADD CONSTRAINT items_module_check CHECK (module IN ('grocery','home','idea','custom'));
CREATE INDEX items_list_archived_idx ON items (list_id, archived_at);

-- Sections of a custom list belong to that list.
ALTER TABLE categories DROP CONSTRAINT categories_module_check;
ALTER TABLE categories ADD CONSTRAINT categories_module_check CHECK (module IN ('grocery','home','idea','task','inventory','expense','event','custom'));
ALTER TABLE categories ADD COLUMN list_id uuid REFERENCES lists(id) ON DELETE CASCADE;
ALTER TABLE categories ADD CONSTRAINT categories_custom_list_check CHECK ((module = 'custom') = (list_id IS NOT NULL));
DROP INDEX categories_unique_idx;
CREATE UNIQUE INDEX categories_unique_idx ON categories (workspace_id, module, lower(name)) WHERE list_id IS NULL;
CREATE UNIQUE INDEX categories_list_unique_idx ON categories (list_id, lower(name)) WHERE list_id IS NOT NULL;

-- ------------------------------------------------------------------- plans
ALTER TABLE events
  ADD COLUMN is_plan boolean NOT NULL DEFAULT false,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN archive_prompt_dismissed_at timestamptz;
CREATE INDEX tasks_related_event_idx ON tasks (related_event_id) WHERE related_event_id IS NOT NULL;
CREATE INDEX events_plan_idx ON events (workspace_id, start_date) WHERE is_plan AND archived_at IS NULL;

-- ------------------------------------------------------------------- board
-- Positions are in "wall units": the wall is 1200 units wide and grows down.
CREATE TABLE pins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','photo','link','text')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 5000),
  color           text NOT NULL DEFAULT 'butter' CHECK (color IN ('butter','blush','sage','sky','lilac','paper','ink')),
  link_url        text CHECK (link_url IS NULL OR length(link_url) <= 2000),
  link_title      text,
  link_image_url  text,
  link_site_name  text,
  x               int NOT NULL DEFAULT 40 CHECK (x BETWEEN 0 AND 1200),
  y               int NOT NULL DEFAULT 40 CHECK (y BETWEEN 0 AND 50000),
  w               int NOT NULL DEFAULT 240 CHECK (w BETWEEN 120 AND 1200),
  h               int NOT NULL DEFAULT 220 CHECK (h BETWEEN 80 AND 1600),
  rotation        real NOT NULL DEFAULT 0 CHECK (rotation BETWEEN -8 AND 8),
  z               int NOT NULL DEFAULT 0,
  tags            text[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX pins_workspace_idx ON pins (workspace_id, archived_at);

ALTER TABLE threads DROP CONSTRAINT threads_entity_type_check;
ALTER TABLE threads ADD CONSTRAINT threads_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic','pin'));
ALTER TABLE reactions DROP CONSTRAINT reactions_entity_type_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic','pin'));
ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','receipt','message','topic','pin'));

-- ------------------------------------------------- copied chat replies
-- When a message in the main chat references a card and someone replies to
-- it, the message and its replies are copied into that card's conversation.
ALTER TABLE messages ADD COLUMN mirrored_from_id uuid REFERENCES messages(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX messages_mirror_idx ON messages (thread_id, mirrored_from_id) WHERE mirrored_from_id IS NOT NULL;
CREATE INDEX messages_mirrored_from_idx ON messages (mirrored_from_id) WHERE mirrored_from_id IS NOT NULL;
