import { createProxyServer } from './src/tools/network/script-proxy/server.js';
import { createServer as createTcpServer, connect as connectNet } from 'node:net';

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

const socket = connectNet(proxyPort,'127.0.0.1',()=>{
  const target = `127.0.0.1:${echoPort}`;
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
});

socket.on('data',(chunk)=>{
  console.log('response', JSON.stringify(chunk.toString()));
  socket.destroy();
  proxy.close();
  echo.close();
});
socket.on('error',(e)=>{console.error(e);process.exitCode=1;});
