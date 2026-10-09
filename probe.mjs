import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
export const ORIGIN='https://palmi-quest-istra.slusarevzahar.chatgpt.site';
function signature(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'webp';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpeg';
  return null;
}
function check(entry,origin=ORIGIN) {
  return new Promise(resolve=>{
    const url=new URL(entry.path,origin),start=performance.now();
    const finish=result=>resolve({path:entry.path,required:entry.required,...result,ms:Math.round(performance.now()-start)});
    const request=https.get(url,{headers:{'accept-encoding':'identity','user-agent':'PalmiQuest-Regional-ReadOnly-Probe/1.0'},rejectUnauthorized:true},response=>{
      let size=0, sample=Buffer.alloc(0);
      response.on('data',chunk=>{size+=chunk.length;if(sample.length<65536)sample=Buffer.concat([sample,chunk.subarray(0,65536-sample.length)]);});
      response.on('end',()=>{
        const status=response.statusCode,mime=String(response.headers['content-type']||''),image=signature(sample);
        let valid=status===200, reason;
        if(entry.kind==='image')valid &&=!!image;
        else if(entry.kind==='html')valid &&=mime.includes('text/html')&&sample.toString().includes('ПальмиКвест')&&sample.toString().includes('host-login-form');
        else if(entry.kind==='json') {try{const data=JSON.parse(sample);valid &&=mime.includes('application/json')&&('canManage' in data);}catch{valid=false;}}
        else if(entry.kind==='css')valid &&=mime.includes('text/css')&&!sample.toString().includes('<!doctype');
        else if(entry.kind==='js')valid &&=/(javascript|ecmascript)/.test(mime)&&!sample.toString().includes('<!doctype');
        else if(entry.kind==='font')valid &&=!mime.includes('text/html')&&size>1000;
        if(!valid)reason=status!==200?'HTTP status or redirect':'Unexpected content; possible auth/HTML fallback';
        finish({ok:valid,status,mime,bytes:size,image,error:reason});
      });
      response.on('error',()=>finish({ok:false,status:response.statusCode,error:'Response interrupted'}));
    });
    const deadline=setTimeout(()=>request.destroy(new Error('timeout')),20000);deadline.unref();
    request.on('close',()=>clearTimeout(deadline));
    request.on('error',error=>finish({ok:false,error:error.code||'NETWORK_ERROR'}));
  });
}
export async function runProbe() {
  const manifest=JSON.parse(await readFile(new URL('./probe-manifest.json',import.meta.url),'utf8'));
  // Fail fast on the origin/API. Do not spend ten minutes trying every image
  // when the Russian node cannot establish even the primary connection.
  const initial=manifest.entries.filter(e=>['html','json'].includes(e.kind));
  const results=await Promise.all(initial.map(entry=>check(entry)));
  const queue=manifest.entries.filter(e=>!initial.includes(e));
  if(results.every(r=>r.ok))await Promise.all(Array.from({length:3},async()=>{while(queue.length)results.push(await check(queue.shift()));}));
  return {status:results.every(r=>!r.required||r.ok)&&queue.length===0?'pass':'fail',checkedAt:new Date().toISOString(),origin:ORIGIN,sourceVersion:manifest.sourceVersion,sourceCommit:manifest.sourceCommit,regionalVerification:'Confirm Russian deployment region in Timeweb; this probe does not infer country',method:'GET only; no login, session creation or reward writes',remainingNotChecked:queue.length,results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=await runProbe();console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='pass'?0:1;
}
