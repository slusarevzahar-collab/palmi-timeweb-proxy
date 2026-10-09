import http from 'node:http';
import https from 'node:https';
import {Transform} from 'node:stream';
import {createGunzip,createBrotliDecompress,createInflate} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {runProbe, ORIGIN} from './probe.mjs';

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_UPLOAD = 24 * 1024 * 1024;
const CONNECTION_TEST=readFileSync(new URL('./connection-test.html',import.meta.url));
const unsafe = method => !['GET','HEAD','OPTIONS'].includes(method);

function cleanHeaders(input) {
  const forbidden = new Set([...HOP, ...String(input.connection || '').split(',').map(x=>x.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(input).filter(([key])=>!forbidden.has(key)));
}
export function rewriteText(text, upstream, publicOrigin) {
  const replacements = [
    [upstream.origin, publicOrigin.origin],
    [upstream.origin.replaceAll('/', '\\/'), publicOrigin.origin.replaceAll('/', '\\/')],
    [upstream.origin.replaceAll('/', '\\\\/'), publicOrigin.origin.replaceAll('/', '\\\\/')],
    ['//' + upstream.host, '//' + publicOrigin.host]
  ];
  for (const [oldValue,newValue] of replacements) text = text.replaceAll(oldValue,newValue);
  return text;
}
function cookieForProxy(cookie, upstream, publicOrigin) {
  return cookie.replace(/;\s*Domain=([^;]+)/ig,(whole,domain)=>{
    domain=domain.trim().replace(/^\./,'').toLowerCase();
    return upstream.hostname===domain || upstream.hostname.endsWith('.'+domain) ? '; Domain='+publicOrigin.hostname : whole;
  });
}
function reply(response,status,value) {
  if(response.destroyed || response.writableEnded)return;
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
  response.end(JSON.stringify(value));
}

// Test injection is only available to imports. The production entry point fixes
// the upstream; neither headers, query strings nor environment can select it.
export function createProxy({publicOrigin, upstream=ORIGIN, probeOnly=true, diagnostics=()=>({status:'pending'}), timeout=30000}={}) {
  const target=new URL(upstream), published=publicOrigin ? new URL(publicOrigin) : null;
  if(published && (published.pathname!=='/' || published.search || published.hash || published.username || published.password))throw new Error('PUBLIC_ORIGIN must contain only scheme and host');
  if(!probeOnly && !published)throw new Error('PUBLIC_ORIGIN required before enabling proxy');
  const transport=target.protocol==='https:'?https:http;
  const agent=target.protocol==='https:'?new https.Agent({keepAlive:true,maxSockets:64,maxFreeSockets:12}):new http.Agent({keepAlive:true,maxSockets:64,maxFreeSockets:12});
  const server=http.createServer(async(request,response)=>{
    let incoming;
    try {
      if(!request.url.startsWith('/') || request.url.startsWith('//'))throw new Error('absolute request target');
      incoming=new URL(request.url,'http://local.invalid');
      if(incoming.origin!=='http://local.invalid')throw new Error('invalid target');
    }catch{return reply(response,400,{error:'Invalid request target'});}
    const path=incoming.pathname;
    if(probeOnly&&path==='/'&&['GET','HEAD'].includes(request.method)) {
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':String(CONNECTION_TEST.length),'Referrer-Policy':'no-referrer'});
      return response.end(request.method==='HEAD'?undefined:CONNECTION_TEST);
    }
    if(path==='/__proxy/health' && ['GET','HEAD'].includes(request.method))return reply(response,200,{process:'up',mode:probeOnly?'probe':'proxy',upstreamVerified:false});
    if(path==='/__proxy/probe' && ['GET','HEAD'].includes(request.method)) {
      const result=diagnostics();
      return reply(response,result.status==='pass'?200:503,result);
    }
    if(probeOnly)return reply(response,503,{error:'Regional upstream verification mode; gameplay not enabled'});
    if(String(request.headers.host||'').toLowerCase()!==published.host)return reply(response,421,{error:'Unexpected host'});
    if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(request.method))return reply(response,405,{error:'Method not supported'});
    const origin=request.headers.origin;
    if(origin && origin!==published.origin)return reply(response,403,{error:'Cross-origin request rejected'});
    if(unsafe(request.method) && request.headers['sec-fetch-site']==='cross-site')return reply(response,403,{error:'Cross-site request rejected'});
    if(Number(request.headers['content-length'])>MAX_UPLOAD)return reply(response,413,{error:'Upload too large'});
    const headers=cleanHeaders(request.headers);
    for(const name of Object.keys(headers)) {
      if(/^(oai-|x-oai-|x-openai-|x-forwarded-)/.test(name) || ['forwarded','x-real-ip','x-original-url','x-rewrite-url','x-host'].includes(name))delete headers[name];
    }
    headers.host=target.host;
    headers['accept-encoding']='identity';
    if(origin)headers.origin=target.origin;
    if(headers.referer) {
      try {
        const ref=new URL(headers.referer);
        if(ref.origin===published.origin)headers.referer=target.origin+ref.pathname+ref.search;
        else if(unsafe(request.method))return reply(response,403,{error:'Foreign referer rejected'});
      }catch{delete headers.referer;}
    }
    // Never cache API/auth and never retry writes. There is no local database.
    if(path.startsWith('/api/')){delete headers['if-none-match'];delete headers['if-modified-since'];}
    let upstreamResponse;
    const fail=code=>{
      if(!response.headersSent)reply(response,code,{error:'Upstream connection failed; no request retry',code:'UPSTREAM_UNAVAILABLE'});
      else response.destroy();
    };
    const outgoing=transport.request({protocol:target.protocol,hostname:target.hostname,port:target.port||undefined,method:request.method,path:request.url,headers,agent,servername:target.hostname,rejectUnauthorized:true},async result=>{
      upstreamResponse=result;
      const status=result.statusCode || 502, output=cleanHeaders(result.headers);
      // Preserve platform security policy, only translate this exact origin.
      for(const name of ['location','content-location','refresh','content-security-policy','content-security-policy-report-only','link','access-control-allow-origin']) {
        if(typeof output[name]==='string')output[name]=rewriteText(output[name],target,published);
      }
      if(Array.isArray(output['set-cookie']))output['set-cookie']=output['set-cookie'].map(c=>cookieForProxy(c,target,published));
      delete output['alt-svc'];
      output['x-content-type-options']='nosniff';
      output['x-palmi-proxy']='1';
      if(path.startsWith('/api/') || path.startsWith('/signin-') || output['set-cookie'])output['cache-control']='no-store';
      // Secure context comes from the Timeweb HTTPS terminator. Do not remove
      // Permissions-Policy, CSP, SameSite or Secure to fake camera/auth support.
      const mime=String(output['content-type']||'');
      const text=/^(text\/|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)/i.test(mime);
      const canRewrite=text && !output['content-range'] && request.method!=='HEAD' && ![204,304].includes(status);
      if(canRewrite) {
        const chunks=[]; let size=0;
        try {
          let stream=result;
          if(output['content-encoding'] && output['content-encoding']!=='identity') {
            const decompressors={gzip:createGunzip,br:createBrotliDecompress,deflate:createInflate};
            const decoder=decompressors[output['content-encoding']]?.();
            if(!decoder)throw new Error('unsupported compression');
            result.on('error',()=>decoder.destroy());stream=result.pipe(decoder);
          }
          for await(const chunk of stream) {
            size+=chunk.length;
            if(size>MAX_TEXT)throw new Error('text limit');
            chunks.push(chunk);
          }
          const body=Buffer.from(rewriteText(Buffer.concat(chunks).toString('utf8'),target,published));
          delete output.etag;delete output['content-md5'];delete output['content-length'];delete output['content-encoding'];
          output['content-length']=String(body.length);
          response.writeHead(status,output);response.end(body);
        }catch{fail(502);}
      }else {
        response.writeHead(status,output);
        result.on('error',()=>response.destroy());
        result.pipe(response);
      }
    });
    outgoing.setTimeout(timeout,()=>outgoing.destroy(new Error('upstream timeout')));
    const deadline=setTimeout(()=>{outgoing.destroy();upstreamResponse?.destroy();fail(504);},timeout);
    deadline.unref();
    const finish=()=>clearTimeout(deadline);
    response.on('finish',finish);
    response.on('close',()=>{finish();if(!response.writableFinished){outgoing.destroy();upstreamResponse?.destroy();}});
    outgoing.on('error',()=>fail(502));
    request.on('aborted',()=>outgoing.destroy());
    request.on('error',()=>outgoing.destroy());
    let bytes=0;
    const limiter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>MAX_UPLOAD?new Error('upload limit'):null,chunk);}});
    limiter.on('error',()=>{outgoing.destroy();fail(413);});
    request.pipe(limiter).pipe(outgoing);
  });
  server.requestTimeout=45000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  server.on('upgrade',(request,socket)=>socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'));
  server.on('close',()=>agent.destroy());
  return server;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const probeOnly=process.env.PROBE_ONLY!=='false';
  const publicOrigin=process.env.PUBLIC_ORIGIN;
  if(!probeOnly && new URL(publicOrigin).protocol!=='https:')throw new Error('Production proxy requires HTTPS PUBLIC_ORIGIN');
  let report={status:'pending',checkedAt:null,regionalVerification:'Requires confirmation of Russian deployment region in Timeweb'};
  const server=createProxy({publicOrigin,probeOnly,diagnostics:()=>report});
  server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>{
    console.log(JSON.stringify({event:'started',mode:probeOnly?'probe':'proxy'}));
    runProbe().then(result=>{
      report=result;
      console.log(JSON.stringify({event:'upstream_probe',status:result.status,requiredFailures:result.results.filter(r=>r.required&&!r.ok).map(r=>({path:r.path,status:r.status,error:r.error,server:r.server,rejection:r.rejection}))}));
    }).catch(()=>{report={status:'fail',error:'Probe failed'};});
  });
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close();setTimeout(()=>process.exit(0),10000).unref();});
}
