const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.cjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const server = http.createServer((req, res) => {
  let relative;
  try {relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';}
  catch {res.writeHead(400).end();return;}
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || relative.startsWith('.') || !['index.html','src','assets','preview'].includes(relative.split('/')[0])) {res.writeHead(404).end();return;}
  fs.readFile(file, (error, data) => {
    if (error) {res.writeHead(404).end();return;}
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(data);
  });
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('REBOUND preview: http://127.0.0.1:' + server.address().port));
