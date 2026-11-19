-- Redesign: three same-structure lists, shared-unless-locked items,
-- reminder fields and subtasks on items, chat topics, dashboard preferences.

-- Household defaults: Toronto and Canadian dollars.
ALTER TABLE households ALTER COLUMN timezone SET DEFAULT 'America/Toronto';
ALTER TABLE households ALTER COLUMN currency SET DEFAULT 'CAD';
UPDATE households SET timezone = 'America/Toronto' WHERE timezone = 'UTC';
UPDATE households SET currency = 'CAD' WHERE currency = 'EUR';

-- Every list (groceries, home & gadgets, shopping & other) now has NEED / STOCK.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_check;
UPDATE items SET grocery_state = CASE WHEN decision_status = 'purchased' THEN 'stock' ELSE 'need' END WHERE grocery_state IS NULL;
ALTER TABLE items ALTER COLUMN grocery_state SET DEFAULT 'need';
ALTER TABLE items ALTER COLUMN grocery_state SET NOT NULL;

-- Reminder-style details.
ALTER TABLE items
  ADD COLUMN due_date date,
  ADD COLUMN due_time time,
  ADD COLUMN urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN repeat_unit text CHECK (repeat_unit IN ('day','week','month','year')),
  ADD COLUMN early_reminder_minutes int CHECK (early_reminder_minutes IS NULL OR early_reminder_minutes BETWEEN 0 AND 43200),
  ADD COLUMN reminder_at timestamptz,
  ADD COLUMN reminder_sent_at timestamptz,
  ADD CONSTRAINT items_time_needs_date CHECK (due_time IS NULL OR due_date IS NOT NULL);
CREATE INDEX items_reminder_idx ON items (reminder_at) WHERE reminder_sent_at IS NULL AND reminder_at IS NOT NULL;
CREATE INDEX items_due_idx ON items (workspace_id, due_date) WHERE due_date IS NOT NULL AND archived_at IS NULL;

CREATE TABLE subtasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done          boolean NOT NULL DEFAULT false,
  position      int NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subtasks_item_idx ON subtasks (item_id, position);

-- Chat topics: conversations that are not about one record. One "general"
-- topic per household holds the ongoing chat on the Chat page.
CREATE TABLE topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  is_general    boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE UNIQUE INDEX topics_general_idx ON topics (workspace_id) WHERE is_general;

ALTER TABLE threads DROP CONSTRAINT threads_entity_type_check;
ALTER TABLE threads ADD CONSTRAINT threads_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic'));
ALTER TABLE reactions DROP CONSTRAINT reactions_entity_type_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic'));
ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','receipt','message','topic'));

-- Birthdays and anniversaries repeat every year.
ALTER TABLE events ADD COLUMN yearly boolean NOT NULL DEFAULT false;

-- Dashboard widget preferences and opt-in "show my private time as Busy".
ALTER TABLE user_settings
  ADD COLUMN dashboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN share_availability boolean NOT NULL DEFAULT false;

-- New categories for Home & Gadgets and Shopping & Other in existing spaces.
INSERT INTO categories (workspace_id, module, name, is_default, sort_order)
SELECT w.id, v.module, v.name, true, v.ord
  FROM workspaces w
 CROSS JOIN (VALUES
   ('home','Furniture',0), ('home','Lighting',1), ('home','Storage',2), ('home','Decor',3), ('home','Textiles',4),
   ('home','Kitchen',5), ('home','Appliances',6), ('home','Electronics & gadgets',7), ('home','Tools',8), ('home','Repairs',9), ('home','Other',10),
   ('idea','Clothing',0), ('idea','Shoes & accessories',1), ('idea','Beauty & care',2), ('idea','Gifts',3), ('idea','Books & media',4),
   ('idea','Sports & outdoors',5), ('idea','Travel',6), ('idea','Pets',7), ('idea','Other',8)
 ) AS v(module, name, ord)
ON CONFLICT (workspace_id, module, lower(name)) DO NOTHING;
