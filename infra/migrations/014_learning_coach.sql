-- Staff-room training: faster lookups + default communication policy keys.
CREATE INDEX IF NOT EXISTS idx_learning_events_staff_training
  ON learning_events (event_type, deal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_staff_global
  ON learning_events (event_type, created_at DESC)
  WHERE event_type = 'staff_room_training' AND deal_id IS NULL;

INSERT INTO policy_config (key, value) VALUES
  ('comm_tone', '"commercial"'),
  ('always_ask_client', '["weight_kg","ready_date"]'),
  ('client_do_not_say', '["внутренние ставки поставщиков","маржа","себестоимость RFQ"]'),
  ('staff_coaching_rules', '["Один уточняющий вопрос за раз","Не выдумывать ставки","Клиенту — только белые схемы"]'),
  ('staff_coach_ttl_days', '30')
ON CONFLICT (key) DO NOTHING;
