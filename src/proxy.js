const http = require('http');
const net = require('net');
const url = require('url');

function createProxyServer(metricsCallback) {
  const proxy = http.createServer((req, res) => {
    try {
      const parsedUrl = url.parse(req.url);
      
      let requestBytes = JSON.stringify(req.headers).length;
      metricsCallback({ bytes: requestBytes, status: 'online' });

      req.on('data', (chunk) => {
        metricsCallback({ bytes: chunk.length, status: 'online' });
      });

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: req.method,
        headers: req.headers
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        let responseHeadersBytes = JSON.stringify(proxyRes.headers).length;
        metricsCallback({ bytes: responseHeadersBytes, status: 'online' });

        proxyRes.on('data', (chunk) => {
          metricsCallback({ bytes: chunk.length, status: 'online' });
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          res.end();
        });
      });

      proxyReq.on('error', (err) => {
        metricsCallback({ bytes: 0, status: 'offline' });
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Link Error: ' + err.message);
      });

      req.pipe(proxyReq);
    } catch (e) {
      metricsCallback({ bytes: 0, status: 'offline' });
    }
  });

  // Handle HTTPS Tunneling (CONNECT method)
  proxy.on('connect', (req, clientSocket, head) => {
    try {
      const parts = req.url.split(':');
      const targetHost = parts[0];
      const targetPort = parseInt(parts[1], 10) || 443;

      let tunnelBytes = req.url.length + JSON.stringify(req.headers).length;
      metricsCallback({ bytes: tunnelBytes, status: 'online' });

      const serverSocket = net.connect(targetPort, targetHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) {
          metricsCallback({ bytes: head.length, status: 'online' });
          serverSocket.write(head);
        }
      });

      clientSocket.on('data', (chunk) => {
        metricsCallback({ bytes: chunk.length, status: 'online' });
      });

      serverSocket.on('data', (chunk) => {
        metricsCallback({ bytes: chunk.length, status: 'online' });
      });

      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);

      clientSocket.on('error', () => metricsCallback({ bytes: 0, status: 'offline' }));
      serverSocket.on('error', () => metricsCallback({ bytes: 0, status: 'offline' }));
    } catch (err) {
      metricsCallback({ bytes: 0, status: 'offline' });
    }
  });

  return proxy;
}

// Kept matching your original named export object format
module.exports = { createProxyServer };