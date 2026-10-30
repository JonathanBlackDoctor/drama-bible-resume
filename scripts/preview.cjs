const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const routes = { '/watch': ['tests/browser-fixture.html', 'text/html; charset=utf-8'], '/drama-bible-resume.user.js': ['drama-bible-resume.user.js', 'text/javascript; charset=utf-8'] };
const server = http.createServer((req, res) => {
  const route = routes[new URL(req.url, 'http://localhost').pathname];
  if (!route) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(root, route[0])).pipe(res);
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/watch?v=jVO5lOOS37w&t=90s`));
