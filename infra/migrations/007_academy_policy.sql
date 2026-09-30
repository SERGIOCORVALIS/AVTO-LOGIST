-- Academy of the logist: runtime toggles (env ACADEMY_* also supported).
-- Apply on existing DBs (init.sql only runs on a fresh postgres volume).

INSERT INTO policy_config (key, value) VALUES
  ('academy_enabled', 'true'),
  ('academy_in_kp', 'true'),
  ('academy_in_rfq', 'true'),
  ('academy_in_prompts', 'true'),
  ('academy_in_voice', 'true')
ON CONFLICT (key) DO NOTHING;
