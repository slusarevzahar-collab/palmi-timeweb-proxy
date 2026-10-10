import {readFileSync,mkdirSync,createReadStream,createWriteStream,openSync,readSync,closeSync} from 'node:fs';
import {createDecipheriv,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';

// Probe remains the fail-closed default. No upstream or game data migration.
if(process.env.RUN_MODE!=='quest')await import('./server.mjs').then(()=>{const child=spawn(process.execPath,['server.mjs'],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));});
else{
  try{
    const key=Buffer.from(process.env.PALMI_PACKAGE_KEY||'','hex');if(key.length!==32)throw Error('Package key missing');
    const manifest=JSON.parse(readFileSync('quest-v25.manifest.json','utf8')),header=Buffer.alloc(36),fd=openSync('quest-v25.enc','r');
    try{if(readSync(fd,header,0,36,0)!==36)throw Error('Truncated package');}finally{closeSync(fd);}
    const checksum=createHash('sha256');for await(const chunk of createReadStream('quest-v25.enc'))checksum.update(chunk);
    if(header.subarray(0,8).toString()!=='PALMI001'||checksum.digest('hex')!==manifest.sha256)throw Error('Package integrity mismatch');
    console.log(JSON.stringify({event:'quest_package_verified',bytes:manifest.bytes,rss:process.memoryUsage().rss}));
    const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8,20));decipher.setAuthTag(header.subarray(20,36));
    const destination=resolve('runtime'),archive=resolve('private-quest.tar.gz');mkdirSync(destination,{recursive:true,mode:0o700});
    // Bound memory during startup: never retain the encrypted and decrypted archive in RAM.
    await pipeline(createReadStream('quest-v25.enc',{start:36}),decipher,createWriteStream(archive,{mode:0o600}));
    key.fill(0);
    console.log(JSON.stringify({event:'quest_package_decrypted',rss:process.memoryUsage().rss}));
    const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:1024*1024}).trim().split('\n');
    for(const entry of entries){const clean=entry.replace(/\r$/,'').replace(/^\.\//,'');if(clean.startsWith('/')||clean.includes('\\')||clean.split('/').includes('..')||!(/^(game\/|schema\/|runtime\.mjs$|server\.mjs$|backup-tools\.mjs$|maintenance\.html$|package\.json$)/.test(clean)))throw Error('Invalid package entry');}
    execFileSync('tar',['-xzf',archive,'--no-same-owner','-C',destination]);
    console.log(JSON.stringify({event:'quest_package_extracted',rss:process.memoryUsage().rss}));
    process.env.DATA_DIR=resolve('data');mkdirSync(process.env.DATA_DIR,{recursive:true,mode:0o700});
    // Never pass the decryption key on to the web application or its children.
    const env={...process.env};delete env.PALMI_PACKAGE_KEY;
    if(process.env.PALMI_BIND_PORT)env.PORT=process.env.PALMI_BIND_PORT;
    const child=spawn(process.execPath,[resolve(destination,'server.mjs')],{stdio:'inherit',env});
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
    child.on('exit',code=>process.exit(code??1));
  }catch(error){console.error(JSON.stringify({event:'quest_start_failed',error:error.message}));process.exit(1);}
}
