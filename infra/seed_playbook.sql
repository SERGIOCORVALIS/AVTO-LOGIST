INSERT INTO playbook_versions (name, version, body, status, canary_pct)
VALUES (
  'default',
  'v1',
  '{"tone":"commercial","discount_steps":[0,3,5],"ask_max_questions":3}'::jsonb,
  'active',
  10
)
ON CONFLICT (name, version) DO NOTHING;
