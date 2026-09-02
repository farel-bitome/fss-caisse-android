#!/usr/bin/env node
// Régénère android/app/src/main/assets/{file,dir}.list à partir du contenu réel de
// android/app/src/main/assets/www/nodejs-project.
//
// nodejs-mobile-cordova s'appuie normalement sur un hook Cordova ("prepare") pour générer ces
// deux fichiers automatiquement — hook qui ne s'exécute PAS sous Capacitor (cap sync n'invoque
// pas les hooks Cordova complets). Sans ces fichiers, le plugin retombe sur une énumération
// directe des assets Android au premier lancement, ce qui est connu pour être peu fiable sur les
// APK optimisés contenant beaucoup de fichiers (cas de node_modules). On les génère donc
// nous-mêmes, à chaque build.
//
// À exécuter depuis la racine du projet (fss-caisse-android/) :
//   node scripts/generate-node-asset-lists.js
// Le workflow GitHub Actions (.github/workflows/build-android.yml) l'appelle automatiquement
// avant la compilation Gradle.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www', 'nodejs-project');
const prefix = 'www/nodejs-project';
const outDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets');

if (!fs.existsSync(root)) {
  console.error('Introuvable : ' + root + ' — as-tu bien copié nodejs-project au bon endroit ?');
  process.exit(1);
}

const dirs = [];
const files = [];

function walk(dir, relBase) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = relBase ? relBase + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      dirs.push(prefix + '/' + rel);
      walk(abs, rel);
    } else {
      if (entry.name.endsWith('~') || entry.name.endsWith('.gz')) continue;
      files.push(prefix + '/' + rel);
    }
  }
}

walk(root, '');
dirs.sort();
files.sort();

fs.writeFileSync(path.join(outDir, 'dir.list'), dirs.join('\n'));
fs.writeFileSync(path.join(outDir, 'file.list'), files.join('\n'));

console.log('dir.list : ' + dirs.length + ' dossiers');
console.log('file.list : ' + files.length + ' fichiers');
