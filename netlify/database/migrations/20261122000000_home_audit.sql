-- Home audit: recently completed items, activity notifications, card styles
-- and chats for the Important Dates / To do cards, Board stickies linked to
-- items, and scheduled nicknames.

-- Items ticked off stay visible under "Completed" for a while (undo typos).
ALTER TABLE items ADD COLUMN completed_at timestamptz;
ALTER TABLE items ADD COLUMN completed_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX items_completed_idx ON items (list_id, completed_at DESC) WHERE completed_at IS NOT NULL;

-- "Nella marked Milk as urgent in @Groceries" style activity for the partner.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('mention','reply','shared','assigned','reminder','calendar','decision','activity'));
ALTER TABLE user_settings ADD COLUMN notify_activity boolean NOT NULL DEFAULT true;

-- The Important Dates and To do & Reminders cards: each has a chat (a topic)
-- and its own emoji and colour, like a list.
ALTER TABLE topics ADD COLUMN card_key text CHECK (card_key IS NULL OR card_key IN ('dates','todos'));
ALTER TABLE topics ADD COLUMN emoji text CHECK (emoji IS NULL OR length(emoji) <= 16);
ALTER TABLE topics ADD COLUMN color text CHECK (color IS NULL OR length(color) <= 40);
CREATE UNIQUE INDEX topics_card_idx ON topics (workspace_id, card_key) WHERE card_key IS NOT NULL;

-- A sticky can stand for an item that is already on a list ("committed");
-- stickies without one are ideas still floating around.
ALTER TABLE pins ADD COLUMN item_id uuid REFERENCES items(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX pins_item_idx ON pins (item_id) WHERE item_id IS NOT NULL AND archived_at IS NULL;

-- Names you see for your partner on certain days ("Big Friday" every Friday).
-- Only the person who made a rule ever sees it.
CREATE TABLE nicknames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  rule text NOT NULL CHECK (rule IN ('weekly','yearly','once')),
  weekday int CHECK (weekday BETWEEN 0 AND 6),
  month_day text CHECK (month_day ~ '^\d{2}-\d{2}$'),
  on_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((rule = 'weekly' AND weekday IS NOT NULL) OR (rule = 'yearly' AND month_day IS NOT NULL) OR (rule = 'once' AND on_date IS NOT NULL))
);
CREATE INDEX nicknames_owner_idx ON nicknames (owner_id);
