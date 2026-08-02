INSERT INTO app_settings (key, value, category, description)
VALUES (
  'platform.business',
  '{
    "brandName": "XAUUSD Signal",
    "supportPhone": "+977-9800000000",
    "supportEmail": "support@xauusdsignal.local",
    "businessAddress": "Kathmandu, Nepal",
    "websiteUrl": "",
    "whatsappUrl": "",
    "supportHours": "New York session support, Monday-Friday",
    "helpText": "For account, subscription, signal, and notification help, contact support."
  }'::jsonb,
  'Platform',
  'Business contact/help information shown to subscribers in tenant dashboard and mobile app.'
)
ON CONFLICT (key) DO NOTHING;
