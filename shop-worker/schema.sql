-- Una fila por compra. El hash de la transacción es la clave: una transacción
-- paga una sola licencia (UNIQUE), así nadie la reusa.
CREATE TABLE IF NOT EXISTS orders (
  tx        TEXT PRIMARY KEY,   -- hash de la transacción, en minúsculas
  payer     TEXT,               -- dirección que pagó (dato público de la cadena)
  amount    INTEGER NOT NULL,   -- en unidades del token (USDC tiene 6 decimales)
  token     TEXT NOT NULL,      -- 'USDC'
  chain     TEXT NOT NULL,      -- 'base'
  dl_token  TEXT NOT NULL,      -- token de descarga que se le entrega al comprador
  uses_left INTEGER NOT NULL,   -- descargas que le quedan
  created   INTEGER NOT NULL,   -- epoch ms
  expires   INTEGER NOT NULL    -- epoch ms
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_dl_token ON orders(dl_token);

-- Cotizaciones de ETH entregadas al comprador. Sirven para aceptar el pago por
-- el monto que le dijimos, aunque el precio se haya movido desde entonces.
CREATE TABLE IF NOT EXISTS quotes (
  ref     TEXT PRIMARY KEY,
  wei     TEXT NOT NULL,
  rate    REAL NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_created ON quotes(created);
