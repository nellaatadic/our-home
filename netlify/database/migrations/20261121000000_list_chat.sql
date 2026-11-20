-- One conversation per list (the "@groceries" chat on Home), in addition to
-- conversations about single items.
ALTER TABLE threads DROP CONSTRAINT threads_entity_type_check;
ALTER TABLE threads ADD CONSTRAINT threads_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic','pin','list'));
ALTER TABLE reactions DROP CONSTRAINT reactions_entity_type_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_entity_type_check CHECK (entity_type IN ('item','task','event','inventory','expense','topic','pin','list'));
-- Any event can get a checklist and its own lists now; those are treated as plans.
UPDATE events e SET is_plan = true
 WHERE NOT is_plan AND (EXISTS (SELECT 1 FROM tasks t WHERE t.related_event_id = e.id) OR EXISTS (SELECT 1 FROM lists l WHERE l.event_id = e.id));
