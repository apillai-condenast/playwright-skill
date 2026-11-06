import http from 'node:http';
import { connect, call } from './mcp.mjs';
const client = await connect();
http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const { name, args } = JSON.parse(body);
    const output = await call(client, name, args);
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(output);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(8932, '127.0.0.1');
