// Local server: node dev.js  ->  http://localhost:3000  (Vercel serves the same files in production)
const http = require('http');
const fs = require('fs');
const api = require('./api/index.js');

http.createServer((req, res) => {
  if (req.url.startsWith('/api')) return api(req, res);
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync('public/index.html'));
}).listen(3000, () => console.log('http://localhost:3000'));
