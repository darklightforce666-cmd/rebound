const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, file) => `<style>\n${fs.readFileSync(path.join(root, file), 'utf8')}\n</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, file) => `<script>\n${fs.readFileSync(path.join(root, file), 'utf8')}\n</script>`);
fs.mkdirSync(path.join(root, 'preview'), {recursive: true});
fs.writeFileSync(path.join(root, 'preview/REBOUND.html'), html);
console.log('Built preview/REBOUND.html');
