# XC Player 🪂

Cross country player — reproductor de música local con descarga por link (yt-dlp).

## Descargar el APK

**https://xunorus.github.io/xcplayer/** — el APK está en este repo pero cifrado
(AES-256-GCM); la página lo descifra en el navegador con la contraseña. El código
es libre, el APK no.

El APK está firmado con la clave de release **energiaSonora** (alias `xcplayer` en
`~/xunserver/keys/energiasonora.keystore`; credenciales en `android/keystore.properties`,
fuera de git). SHA-256 del certificado:
`303689b31c4083edb6ee9146665d4fc5c9c2e6812139cd352abbb0c827c82db1`

Para re-publicar tras un rebuild:

```bash
npm run apk:release                      # build firmado → xcplayer.apk
node tools/encrypt-apk.js "<password>"   # xcplayer.apk → docs/xcplayer.apk.enc
git add docs/xcplayer.apk.enc && git commit -m "apk vX.Y" && git push
```

### Enlaces de invitación

`node tools/invite.js` imprime un link con la contraseña en el hash
(`…/#p=<base64url>`): la página la lee, esconde el campo y arranca la descarga
sola. El hash no viaja al server y se borra de la barra apenas se usa, pero
**quien tenga ese link puede bajar el APK sin saber la contraseña**: para
revocarlo, cambiar la pass y re-cifrar.

## Métricas de descarga

Pages no da estadísticas, así que la página manda eventos anónimos al Worker
`stats-worker/` (Cloudflare + D1). Dashboard: `/stats?k=<token>` del Worker, con
el token en `.stats-token.txt` (fuera de git).

Se guarda por evento: día (hora argentina), tipo (`page_view`, `dl_start`,
`dl_ok`, `dl_badpass`, `dl_err`), versión, origen (`invite`/`manual`), plataforma
gruesa, país (lo da Cloudflare) y un id al azar **por carga de página**, que no se
persiste en el navegador y sólo sirve para saber si esa visita terminó la
descarga. **No** se guarda IP, user-agent, referer ni ningún id de dispositivo, y
la app (el APK) todavía no reporta nada.

```bash
cd stats-worker                                            # node 22+, wrangler lo exige
npx wrangler d1 execute xcplayer-stats --remote --file=schema.sql
npx wrangler secret put STATS_TOKEN
npx wrangler deploy
```

## Cómo funciona

Dos modos de descarga (se elige en ⚙ Ajustes; el APK usa "teléfono" por defecto):

- **En el teléfono (APK, v1.1+)**: yt-dlp real embebido vía `youtubedl-android`
  (plugin nativo `YtDlpPlugin.java`). No necesita la Mac para nada. El botón
  "Actualizar yt-dlp" en Ajustes actualiza el binario sin recompilar el APK.
- **Con el server de la Mac**: **`server.js`** recibe el link, descarga con `yt-dlp`
  a `music/` como mp3 y la app se copia los archivos. Es el único modo en la web.

En ambos casos cada mp3 queda guardado **localmente en el dispositivo** (IndexedDB)
y reproduce offline, sin server ni red.
- Muestra: cantidad de tracks, duración total y espacio usado. Permite eliminar y
  reordenar (arrastrar desde el handle ≡).

## Uso

```bash
node server.js          # → http://192.168.1.33:8977 (o localhost en la Mac)
```

- **Web**: abrir http://192.168.1.33:8977 en cualquier navegador de la red.
- **APK**: instalar `android/app/build/outputs/apk/debug/app-debug.apk` en el teléfono.
  En ⚙ Ajustes se configura la URL del server (default `http://192.168.1.33:8977`) y se
  pueden importar los mp3 que ya estén en la carpeta `music/`.
- Eliminar un track lo saca de la app; el archivo queda en `music/` como respaldo.

## Rebuild del APK

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
export JAVA_HOME="$HOME/.local/jdks/jdk-21.0.11+10/Contents/Home"
npm run apk    # copia www/ + gradlew assembleDebug
```

Instalar: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
