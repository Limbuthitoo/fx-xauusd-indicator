INSERT INTO users (id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Personal Trader')
ON CONFLICT (id) DO NOTHING;

INSERT INTO instruments (symbol, display_name, base_asset, quote_currency, price_decimals, tick_size, pip_definition)
VALUES ('XAUUSD', 'Gold vs US Dollar', 'XAU', 'USD', 2, 0.01, 'BROKER_CONFIGURABLE')
ON CONFLICT (symbol) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_asset = EXCLUDED.base_asset,
  quote_currency = EXCLUDED.quote_currency,
  price_decimals = EXCLUDED.price_decimals,
  tick_size = EXCLUDED.tick_size,
  pip_definition = EXCLUDED.pip_definition;

INSERT INTO broker_specs (
  id, user_id, symbol, contract_size, minimum_lot, lot_step, maximum_lot,
  tick_size, tick_value, account_currency, commission_per_lot, typical_spread
)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000001',
  'XAUUSD', 100, 0.01, 0.01, 50, 0.01, 1, 'USD', 0, 0.25
)
ON CONFLICT (id) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  contract_size = EXCLUDED.contract_size,
  minimum_lot = EXCLUDED.minimum_lot,
  lot_step = EXCLUDED.lot_step,
  maximum_lot = EXCLUDED.maximum_lot,
  tick_size = EXCLUDED.tick_size,
  tick_value = EXCLUDED.tick_value,
  account_currency = EXCLUDED.account_currency,
  commission_per_lot = EXCLUDED.commission_per_lot,
  typical_spread = EXCLUDED.typical_spread,
  updated_at = now();
