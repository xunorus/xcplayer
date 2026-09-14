-- Un renglón por evento. Nada acá identifica a nadie: no hay IP, ni user-agent
-- crudo, ni referer, ni ningún id que sobreviva a recargar la página.
CREATE TABLE IF NOT EXISTS ev (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- epoch ms
  day     TEXT NOT NULL,      -- YYYY-MM-DD en hora argentina (UTC-3, sin DST)
  ev      TEXT NOT NULL,      -- page_view|dl_start|dl_ok|dl_badpass|dl_err
  ver     TEXT,               -- versión publicada al momento del evento
  src     TEXT,               -- invite|manual
  plat    TEXT,               -- android|desktop|other
  country TEXT,               -- lo da Cloudflare (request.cf.country), agregado
  sid     TEXT,               -- random POR CARGA DE PÁGINA, no persistido en el cliente
  ms      INTEGER             -- duración de la descarga (sólo dl_ok)
);
CREATE INDEX IF NOT EXISTS ev_day ON ev(day, ev);
