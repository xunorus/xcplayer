#!/usr/bin/env node
// Cifra el APK para distribuirlo por GitHub Pages sin liberarlo.
// Formato: "XCE1" (4B) + salt (16B) + iv (12B) + ciphertext+tag AES-256-GCM.
// La página docs/index.html lo descifra en el navegador con WebCrypto.
//
// Uso: node tools/encrypt-apk.js <password> [apk] [salida]
//      (defaults: xcplayer.apk → docs/xcplayer.apk.enc)
const crypto = require('crypto');
const fs = require('fs');

const pass = process.argv[2];
if (!pass) {
  console.error('Uso: node tools/encrypt-apk.js <password> [apk] [salida]');
  process.exit(1);
}
const inFile = process.argv[3] || 'xcplayer.apk';
const outFile = process.argv[4] || 'docs/xcplayer.apk.enc';

const ITERATIONS = 310000; // debe coincidir con docs/index.html
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(pass, salt, ITERATIONS, 32, 'sha256');

const data = fs.readFileSync(inFile);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

fs.writeFileSync(outFile, Buffer.concat([Buffer.from('XCE1'), salt, iv, ct]));
console.log('OK → ' + outFile + ' (' + (data.length / 1048576).toFixed(1) + ' MB cifrados)');
