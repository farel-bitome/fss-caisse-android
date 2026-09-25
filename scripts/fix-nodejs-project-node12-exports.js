#!/usr/bin/env node
// Corrige un bug réel et vérifié d'incompatibilité entre le Node.js embarqué (bundlé par
// nodejs-mobile-cordova@0.4.3) et les dépendances modernes de nodejs-project (express, socket.io).
//
// ===================== Le bug (vérifié, pas une supposition) =====================
//
// nodejs-mobile-cordova@0.4.3 embarque **Node.js 12.19.0** (vérifié directement dans
// node_modules/nodejs-mobile-cordova/libs/android/libnode/include/node/node_version.h —
// NODE_MAJOR_VERSION 12, NODE_MINOR_VERSION 19). C'est un Node ancien (fin 2020), dont le
// support du champ "exports" du package.json (résolution conditionnelle de modules, apparue
// progressivement entre Node 12.7 et Node 14+) est connu pour être incomplet/bogué sur certaines
// formes de mapping conditionnel ("require"/"import"/"types" sans "default").
//
// socket.io@4.7.5 → engine.io@6.6.x (et plusieurs de leurs propres dépendances : ws, ee-first
// via side-channel*, etc.) déclarent un champ "exports" de cette forme, par exemple
// (node_modules/engine.io/package.json) :
//   "main": "./build/engine.io.js",
//   "exports": { "types": "...", "import": "./wrapper.mjs", "require": "./build/engine.io.js" }
//
// Sur le Node 12.19 embarqué, ça provoque une erreur "Cannot find module
// '.../node_modules/engine.io/build/engine.io.js'" (via createEsmNotFoundErr dans
// internal/modules/cjs/loader.js) **alors même que ce fichier existe bel et bien sur le disque du
// TPE** (vérifié : présent dans file.list/dir.list, copié sans erreur par NodeJS.java — voir
// scripts/patch-nodejs-plugin-diagnostics.js pour la panne précédente, différente, déjà réglée).
// Le "main" pointe vers EXACTEMENT le même fichier que la condition "require" du champ "exports" —
// donc la résolution via "main" seul (mécanisme CommonJS basique, pris en charge sans le moindre
// souci par Node 12.19) donnerait un résultat rigoureusement identique.
//
// ===================== La correction =====================
//
// Ce script supprime le champ "exports" de tout package.json de nodejs-project/node_modules
// **uniquement quand** la cible de la condition "require" (ou "default", ou un mapping "exports"
// sous forme de simple chaîne) est EXACTEMENT le même fichier que "main" — dans ce cas précis,
// supprimer "exports" ne change RIEN au fichier réellement chargé par require(), ça fait juste
// retomber Node sur l'algorithme de résolution CommonJS classique (toujours fiable, y compris sur
// Node 12.19), en évitant le chemin de code bogué de la résolution conditionnelle "exports".
//
// Un paquet dont l'exports ne correspond PAS à "main" (ou n'a pas de "main" du tout — cas des
// paquets qui n'exposent que des sous-chemins, ex: "dunder-proto/get") est laissé intact et
// listé en avertissement : le corriger à l'aveugle pourrait changer le fichier réellement chargé.
//
// À relancer après toute réinstallation/mise à jour des dépendances de nodejs-project (le dossier
// node_modules qu'il contient est commité tel quel dans le dépôt, embarqué directement dans
// l'APK — il n'y a pas de "npm install" pour lui dans le CI, voir README.md).

const fs = require('fs');
const path = require('path');

const NODE_MODULES_DIR = path.join(
  __dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'nodejs-project', 'node_modules'
);

if (!fs.existsSync(NODE_MODULES_DIR)) {
  console.error('Introuvable : ' + NODE_MODULES_DIR);
  process.exit(1);
}

function normalize(p) {
  if (typeof p !== 'string') return p;
  if (!p.startsWith('.')) p = './' + p;
  return path.normalize(p);
}

function requireTargetOf(exportsField) {
  if (typeof exportsField === 'string') return exportsField;
  if (exportsField && typeof exportsField === 'object') {
    const dot = exportsField['.'];
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') return dot.require || dot.default || null;
    return exportsField.require || exportsField.default || null;
  }
  return null;
}

function walk(dir, packageJsons) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, packageJsons);
    } else if (entry.name === 'package.json') {
      packageJsons.push(full);
    }
  }
}

const packageJsons = [];
walk(NODE_MODULES_DIR, packageJsons);

const fixed = [];
const skipped = [];

for (const pjPath of packageJsons) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  } catch (e) {
    continue;
  }
  if (!('exports' in data) || !('main' in data)) continue;

  const requireTarget = requireTargetOf(data.exports);
  if (requireTarget == null) {
    skipped.push([pjPath, 'aucune condition require/default exploitable (probablement des sous-chemins uniquement, ex: "pkg/sub") — laissé intact']);
    continue;
  }
  if (normalize(requireTarget) !== normalize(data.main)) {
    skipped.push([pjPath, `cible "require" (${requireTarget}) different de "main" (${data.main}) — a verifier manuellement, laisse intact`]);
    continue;
  }

  delete data.exports;
  fs.writeFileSync(pjPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fixed.push(pjPath);
}

console.log('Champs "exports" supprimés (identiques à "main", sans risque) : ' + fixed.length);
for (const p of fixed) console.log('  - ' + path.relative(process.cwd(), p));

if (skipped.length) {
  console.log('\nIgnorés (' + skipped.length + ') :');
  for (const [p, reason] of skipped) {
    console.log('  - ' + path.relative(process.cwd(), p) + ' : ' + reason);
  }
}
