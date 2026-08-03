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
