import {readFileSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {createDecipheriv,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

// Probe remains the fail-closed default. No upstream or game data migration.
if(process.env.RUN_MODE!=='quest')await import('./server.mjs').then(()=>{const child=spawn(process.execPath,['server.mjs'],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));});
else{
  try{
    const key=Buffer.from(process.env.PALMI_PACKAGE_KEY||'','hex');if(key.length!==32)throw Error('Package key missing');
    const payload=readFileSync('quest-v25.enc'),manifest=JSON.parse(readFileSync('quest-v25.manifest.json','utf8'));
    if(payload.subarray(0,8).toString()!=='PALMI001'||createHash('sha256').update(payload).digest('hex')!==manifest.sha256)throw Error('Package integrity mismatch');
    const decipher=createDecipheriv('aes-256-gcm',key,payload.subarray(8,20));decipher.setAuthTag(payload.subarray(20,36));
    const plaintext=Buffer.concat([decipher.update(payload.subarray(36)),decipher.final()]);
    const destination=resolve('runtime'),archive=resolve('private-quest.tar.gz');mkdirSync(destination,{recursive:true,mode:0o700});writeFileSync(archive,plaintext,{mode:0o600});
    const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:1024*1024}).trim().split('\n');
    for(const entry of entries){const clean=entry.replace(/\r$/,'').replace(/^\.\//,'');if(clean.startsWith('/')||clean.includes('\\')||clean.split('/').includes('..')||!(/^(game\/|schema\/|runtime\.mjs$|server\.mjs$|package\.json$)/.test(clean)))throw Error('Invalid package entry');}
    execFileSync('tar',['-xzf',archive,'--no-same-owner','-C',destination]);
    process.env.DATA_DIR=resolve('data');mkdirSync(process.env.DATA_DIR,{recursive:true,mode:0o700});
    // Never pass the decryption key on to the web application or its children.
    const env={...process.env};delete env.PALMI_PACKAGE_KEY;
    const child=spawn(process.execPath,[resolve(destination,'server.mjs')],{stdio:'inherit',env});
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
    child.on('exit',code=>process.exit(code??1));
  }catch(error){console.error(JSON.stringify({event:'quest_start_failed',error:error.message}));process.exit(1);}
}
