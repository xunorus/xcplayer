#!/usr/bin/env node
// Arma el enlace de invitación de un click: la contraseña va en el hash (base64url),
// la página la lee, esconde el campo y arranca la descarga sola.
//   node tools/invite.js            → usa .secret-pass.txt
//   node tools/invite.js "otra-pass"
const fs = require('fs');
const path = require('path');

const BASE = 'https://xunorus.github.io/xcplayer/';
const passFile = path.join(__dirname, '..', '.secret-pass.txt');

let pass = process.argv[2];
if (!pass) {
  try { pass = fs.readFileSync(passFile, 'utf8'); }
  catch (e) {
    console.error('No hay contraseña: pasala como argumento o dejala en .secret-pass.txt');
    process.exit(1);
  }
}
pass = pass.trim();
if (!pass) { console.error('Contraseña vacía'); process.exit(1); }

const p = Buffer.from(pass, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(BASE + '#p=' + p);
