import { createProxyServer } from './src/tools/network/script-proxy/server.js';
import { createServer as createTcpServer } from 'node:net';
import http from 'node:http';

const echo = createTcpServer((s)=>s.pipe(s));
await new Promise<void>((r)=>echo.listen(0,'127.0.0.1',()=>r()));
const echoAddr = echo.address();
if (!echoAddr || typeof echoAddr === 'string') throw new Error('echo addr');
const echoPort = echoAddr.port;

const proxy = createProxyServer();
proxy.on('connect', (req)=>{
  console.log('connect event req.url=', req.url);
});
await new Promise<void>((r)=>proxy.listen(0,'127.0.0.1',()=>r()));
const proxyAddr = proxy.address();
if (!proxyAddr || typeof proxyAddr === 'string') throw new Error('proxy addr');
const proxyPort = proxyAddr.port;

const req = http.request({
  host: '127.0.0.1',
  port: proxyPort,
  method: 'CONNECT',
  path: `127.0.0.1:${echoPort}`,
});
req.on('connect', (res, socket, head)=>{
  console.log('connect response status', res.statusCode, 'headlen', head.length);
  socket.write('hello');
  socket.once('data', (d)=>{
    console.log('echo back', d.toString());
    socket.destroy();
    proxy.close();
    echo.close();
  });
});
req.on('response', (res)=>{
  console.log('response status', res.statusCode);
});
req.on('error', (e)=>{console.error('req err', e); process.exitCode=1;});
req.end();
