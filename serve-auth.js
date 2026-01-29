const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || 'index.html';
const PORT = parseInt(process.argv[3], 10) || 5501;
const USER = process.argv[4] || 'user';
const PASS = process.argv[5] || 'pass';

const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

function contentTypeFromName(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  // Basic auth
  const auth = req.headers['authorization'];
  if (!auth || auth !== EXPECTED_AUTH) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Protected"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Authentication required');
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/' + FILE;

  const safePath = path.normalize(urlPath).replace(/^\/+/, '');
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    const ct = contentTypeFromName(filePath);
    res.writeHead(200, { 'Content-Type': ct });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Auth-protected server running. File: '${FILE}' Port: ${PORT}`);
  console.log(`Credentials -> user: '${USER}' password: '${PASS}'`);
});
