import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {createProxy} from '../server.mjs';
const publish='https://palmi-test.example';
const binary=Buffer.from([137,80,78,71,13,10,26,10,0,255,7]);
const requests=[];
const origin=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  requests.push({path:req.url,method:req.method,headers:req.headers,body});
  if(req.url.startsWith('/image')) {
    res.writeHead(req.headers.range?206:200,{'Content-Type':'image/png','Content-Length':binary.length,...(req.headers.range?{'Content-Range':'bytes 0-10/11'}:{})});res.end(binary);return;
  }
  if(req.url==='/redirect'){res.writeHead(302,{Location:upstream+'/#host'});res.end();return;}
  if(req.url==='/external'){res.writeHead(302,{Location:'https://external.example/login'});res.end();return;}
  if(req.url==='/gzip'){res.writeHead(200,{'Content-Type':'text/html','Content-Encoding':'gzip'});res.end(gzipSync('<a href="'+upstream+'/page">mock</a>'));return;}
  if(req.url==='/fail'){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5'});res.end('{"error":"later"}');return;}
  if(req.url==='/drop'){req.socket.destroy();return;}
  if(req.url==='/slow'){setTimeout(()=>{if(!res.destroyed)res.end('too late');},150).unref();return;}
  res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':['palmi-host=fake-test-cookie; Path=/; HttpOnly; SameSite=Strict; Secure','second=mock; Domain=127.0.0.1; Path=/; Secure'],ETag:'old-hash','Content-Security-Policy':"default-src 'self' "+upstream});
  res.end(JSON.stringify({url:upstream+'/asset',escaped:upstream.replaceAll('/','\\/'),method:req.method,body,origin:req.headers.origin,referer:req.headers.referer}));
});
await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
const upstream='http://127.0.0.1:'+origin.address().port;
const proxy=createProxy({publicOrigin:publish,upstream,probeOnly:false});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const port=proxy.address().port;
function get(path,headers={},method='GET',body='') {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{host:new URL(publish).host,...headers}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
    });req.on('error',reject);req.end(body);
  });
}
test('same-origin POST retains cookie and body, translates Origin/Referer once',async()=>{
  const payload=JSON.stringify({kind:'test-only',id:'mock'}),result=await get('/api/command',{'content-type':'application/json',origin:publish,referer:publish+'/page',cookie:'palmi-host=fake', 'x-palmi-token':'fake-test'},'POST',payload);
  assert.equal(result.status,200);const data=JSON.parse(result.body);
  assert.equal(requests.at(-1).headers.origin,upstream);assert.equal(requests.at(-1).headers.referer,upstream+'/page');assert.equal(data.body,payload);assert.equal(data.url,publish+'/asset');
  assert.equal(requests.at(-1).headers.cookie,'palmi-host=fake');assert.equal(requests.at(-1).headers['x-palmi-token'],'fake-test');assert.equal(requests.at(-1).headers.host,new URL(upstream).host);
  assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers.etag,undefined);
});
test('cookies retain protection and explicit Domain is scoped to new host',async()=>{
  const result=await get('/');assert.equal(result.headers['set-cookie'].length,2);
  assert.match(result.headers['set-cookie'][0],/HttpOnly; SameSite=Strict; Secure/);
  assert.match(result.headers['set-cookie'][1],/Domain=palmi-test.example/);
  assert.ok(result.headers['content-security-policy'].includes(publish));
});
test('foreign/null Origin and cross-site writes never reach upstream',async()=>{
  const before=requests.length;
  for(const origin of ['https://foreign.example','null'])assert.equal((await get('/api/command',{origin},'POST','{}')).status,403);
  assert.equal((await get('/api/command',{'sec-fetch-site':'cross-site'},'POST','{}')).status,403);
  assert.equal((await get('/api/command',{referer:'https://foreign.example/'},'POST','{}')).status,403);
  assert.equal(requests.length,before);
});
test('spoofed identity and forwarded headers stripped',async()=>{
  await get('/api/access',{'oai-authenticated-user-id':'spoof','oai-sites-authorization':'spoof','x-forwarded-host':'spoof','x-real-ip':'spoof',forwarded:'spoof'});
  for(const h of ['oai-authenticated-user-id','oai-sites-authorization','x-forwarded-host','x-real-ip','forwarded'])assert.equal(requests.at(-1).headers[h],undefined);
});
test('binary and byte ranges are byte-for-byte intact',async()=>{
  for(const headers of [{},{range:'bytes=0-10'}]){const result=await get('/image?test=1',headers);assert.deepEqual(result.body,binary);assert.equal(result.status,headers.range?206:200);}
});
test('redirects rewrite own origin, never external login destination',async()=>{
  assert.equal((await get('/redirect')).headers.location,publish+'/#host');
  assert.equal((await get('/external')).headers.location,'https://external.example/login');
});
test('upstream 503 and Retry-After preserved, write not retried',async()=>{
  const before=requests.length,result=await get('/fail',{},'POST','mock');assert.equal(result.status,503);assert.equal(result.headers['retry-after'],'5');assert.equal(requests.length,before+1);
});
test('wrong host, absolute target and declared oversized upload rejected',async()=>{
  assert.equal((await get('/',{host:'foreign.example'})).status,421);
  assert.equal((await get('http://foreign.example/')).status,400);
  assert.equal((await get('//foreign.example/')).status,400);
  assert.equal((await get('/api/voice',{'content-length':30*1024*1024},'POST')).status,413);
});
test('OPTIONS is proxied only for own origin',async()=>{
  assert.equal((await get('/api/access',{origin:publish},'OPTIONS')).status,200);
  assert.equal((await get('/api/access',{origin:'https://foreign.example'},'OPTIONS')).status,403);
});
test('compressed HTML decodes and rewrites without stale encoding',async()=>{
  const result=await get('/gzip');assert.equal(result.status,200);assert.equal(result.headers['content-encoding'],undefined);assert.ok(result.body.toString().includes(publish+'/page'));
});
test('HEAD has no body; query and escaped absolute URL preserve meaning',async()=>{
  const head=await get('/image',{},'HEAD');assert.equal(head.status,200);assert.equal(head.body.length,0);
  const result=await get('/query?one=1&two=2');assert.equal(requests.at(-1).path,'/query?one=1&two=2');assert.equal(JSON.parse(result.body).escaped,publish.replaceAll('/','\\/'));
});
test('dropped upstream write returns error and is never retried',async()=>{
  const before=requests.length,result=await get('/drop',{},'POST','mock');assert.equal(result.status,502);assert.equal(requests.length,before+1);
});
test('stalled upstream is bounded by a total deadline',async()=>{
  const bounded=createProxy({upstream,publicOrigin:publish,probeOnly:false,timeout:50});await new Promise(r=>bounded.listen(0,'127.0.0.1',r));
  try {
    const started=Date.now();const status=await new Promise((resolve,reject)=>{
      const req=http.get({hostname:'127.0.0.1',port:bounded.address().port,path:'/slow',headers:{host:new URL(publish).host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
    });
    assert.ok([502,504].includes(status),'Expected bounded upstream failure, got '+status);assert.ok(Date.now()-started<1500);
  }finally{bounded.closeAllConnections();await new Promise(r=>bounded.close(r));}
});
test('probe-only mode never forwards gameplay, health is not readiness',async()=>{
  const only=createProxy({upstream,probeOnly:true,diagnostics:()=>({status:'fail'})});await new Promise(r=>only.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+only.address().port;
  try {
    const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/не игровая версия/);
    assert.equal((await fetch(base+'/',{method:'POST'})).status,503);
    assert.equal((await fetch(base+'/api/command',{method:'POST'})).status,503);
    assert.equal((await fetch(base+'/__proxy/probe')).status,503);
    assert.equal((await (await fetch(base+'/__proxy/health')).json()).upstreamVerified,false);
  }finally{only.closeAllConnections();await new Promise(r=>only.close(r));}
});
test('cleanup',async()=>{proxy.closeAllConnections();origin.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>origin.close(r))]);});
