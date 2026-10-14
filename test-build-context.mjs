import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';

// This repository intentionally uses an explicit allowlist. A newly copied
// runtime file must be present in both Git and the Docker build context.
const rules=readFileSync('.dockerignore','utf8').split(/\r?\n/).filter(Boolean);
assert.equal(rules[0],'*');
const allowed=new Set(rules.filter(s=>s.startsWith('!')).map(s=>s.slice(1)));
const sources=readFileSync('Dockerfile','utf8').split(/\r?\n/)
 .filter(line=>line.startsWith('COPY '))
 .flatMap(line=>line.trim().split(/\s+/).slice(1,-1).filter(s=>!s.startsWith('--')));
for(const source of sources){assert.ok(existsSync(source),'Missing COPY source: '+source);assert.ok(allowed.has(source),'COPY source excluded by .dockerignore: '+source);}
assert.ok(readFileSync('Dockerfile','utf8').includes('HEALTHCHECK '),'Explicit health check missing');
console.log('PASS explicit Docker COPY sources, build-context allowlist and healthcheck: '+sources.length+' runtime files');
