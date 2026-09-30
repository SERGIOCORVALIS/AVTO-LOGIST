-- Attachment kind: payments; backfill client_id and reclassify by filename.
-- Apply via pnpm db:migrate.

ALTER TABLE mail_attachments DROP CONSTRAINT IF EXISTS mail_attachments_kind_check;
ALTER TABLE mail_attachments ADD CONSTRAINT mail_attachments_kind_check
  CHECK (kind IN ('kp', 'contracts', 'invoices', 'payments', 'customs', 'client', 'other'));

UPDATE mail_attachments a
SET client_id = m.client_id
FROM mail_messages m
WHERE a.mail_message_id = m.id
  AND a.client_id IS NULL
  AND m.client_id IS NOT NULL;

UPDATE mail_attachments SET kind = 'contracts'
WHERE kind <> 'contracts'
  AND filename ~* 'договор|contract|соглашени';

UPDATE mail_attachments SET kind = 'payments'
WHERE kind NOT IN ('contracts', 'payments')
  AND filename ~* 'платеж|платёж|платежн|поручен|payment|квитанц|(^|[^[:alnum:]])пп([^[:alnum:]]|$)';

UPDATE mail_attachments SET kind = 'invoices'
WHERE kind NOT IN ('contracts', 'payments', 'invoices')
  AND filename ~* 'сч[её]т|invoice|упд|счет-фактур|(^|[^[:alnum:]])сф([^[:alnum:]]|$)|акт';

UPDATE mail_attachments SET kind = 'kp'
WHERE kind IN ('client', 'other')
  AND filename ~* '(^|[^[:alpha:]])кп([^[:alpha:]]|$)|расч[её]т|offer|quote';
