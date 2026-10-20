-- Debut: remove seeded mock:// demo partners (quotes only via ALLOW_MOCK_RATES, forbidden in prod).
DELETE FROM partner_contacts
WHERE partner_id IN (
  SELECT id FROM partners
  WHERE code IN ('demo_express', 'silk_road', 'eastgate')
     OR api_base_url LIKE 'mock://%'
);

DELETE FROM partners
WHERE code IN ('demo_express', 'silk_road', 'eastgate')
   OR api_base_url LIKE 'mock://%';
