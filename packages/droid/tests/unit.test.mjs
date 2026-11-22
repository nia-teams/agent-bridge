import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDroidRunner, resolveDroidBinary, validateDroidOptions } from '../dist/runner.js';
import { clientBranding } from '../dist/branding.js';
import { connectDaemonArgs } from '@nia-teams/agent-bridge-core';
import { fixture } from '../../core/tests/helpers.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/nia-droid.mjs', import.meta.url));
test('effort/autonomy validate eagerly and all Factory values are supported', () => {
  for (const effort of ['none','dynamic','off','minimal','low','medium','high','xhigh','max']) validateDroidOptions({cwd:'.',effort});
  for (const autonomy of ['off','low','medium','high']) validateDroidOptions({cwd:'.',autonomy});
  for (const options of [{effort:'unsafe'},{autonomy:'bypass'},{effort:''},{autonomy:''}]) assert.throws(() => createDroidRunner({cwd:'.',...options}), /Invalid/);
});
test('invite daemon arguments preserve Droid options without invite data', () => {
  const args = connectDaemonArgs({'config-dir':'/tmp/config','droid-bin':'/tmp/droid','effort':'high','autonomy':'off','full-auto':true,'group-link':'SECRET','agent-name':'Helper'});
  for (const value of ['--droid-bin','/tmp/droid','--effort','high','--autonomy','off','--full-auto']) assert.ok(args.includes(value));
  assert.ok(!args.includes('SECRET'));assert.ok(!args.includes('Alice'));
});
test('Factory branding is a 256x256 PNG below 64 KiB', () => {
  assert.equal(clientBranding.clientName,'Factory Droid');
  const bytes = Buffer.from(clientBranding.avatar.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a'); assert.ok(bytes.length<65536);
  assert.equal(bytes.readUInt32BE(16),256);assert.equal(bytes.readUInt32BE(20),256);
});
test('binary discovery accepts executable Unix Node scripts and rejects unreadable, missing, batch and non-executable scripts', async t => {
  const dir = await mkdtemp(join(tmpdir(),'droid-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path = join(dir,'mock.mjs');await writeFile(path,'#!/usr/bin/env node\n',{mode:0o755});
  assert.equal(await resolveDroidBinary(path),path);
  const bad = join(dir,'readable.mjs');await writeFile(bad,'',{mode:0o644});
  await assert.rejects(resolveDroidBinary(bad),/make .* executable/);
  await assert.rejects(resolveDroidBinary(join(dir,'missing')),/Cannot find droid/);
  const batch=join(dir,'droid.cmd');await writeFile(batch,'@echo off\n');
  await assert.rejects(resolveDroidBinary(batch),/native executable/);
  const old = process.env.DROID_BIN;process.env.DROID_BIN=path;
  try {assert.equal(await resolveDroidBinary(),path);}finally {if(old===undefined)delete process.env.DROID_BIN;else process.env.DROID_BIN=old;}
});
test('CLI help, pair branding, status, and invalid arguments', async t => {
  const f=await fixture(t);f.pendingPolls=0;
  const help=(await exec(process.execPath,[cli,'--help'])).stdout;
  for(const flag of ['connect','pair','status','start','--effort','--autonomy','--full-auto','--droid-bin','--daemon','--log-file'])assert.ok(help.includes(flag));
  await exec(process.execPath,[cli,'pair','--server-url',f.url,'--config-dir',f.dir,'--name','My Droid'],{env:{...process.env,NIA_NO_BROWSER:'1'}});
  assert.equal(f.registration.clientName,'Factory Droid');assert.equal(f.registration.avatar,clientBranding.avatar);
  f.credentials=JSON.parse(await readFile(join(f.dir,'credentials.json'),'utf8'));
  const status=(await exec(process.execPath,[cli,'status','--config-dir',f.dir])).stdout;
  assert.match(status,/Agent: Helper/);assert.ok(status.includes(f.url));assert.doesNotMatch(status,/PRIVATE KEY/);
  const envStatus=(await exec(process.execPath,[cli,'status'],{env:{...process.env,NIA_DROID_CONFIG_DIR:f.dir}})).stdout;
  assert.equal(envStatus,status);
  for(const args of [['unknown'],['pair','extra'],['connect'],['start','--effort','bad'],['start','--autonomy','bad'],['start','--droid-bin','/does/not/exist'],['start','--unsupported']])await assert.rejects(exec(process.execPath,[cli,...args]));
});

test('pairing default host label uses droid@ and preserves Factory branding', async t => {
  const f=await fixture(t);f.pendingPolls=0;
  await exec(process.execPath,[cli,'pair','--server-url',f.url,'--config-dir',f.dir],{env:{...process.env,NIA_NO_BROWSER:'1'}});
  assert.match(f.registration.hostLabel,/^droid@/);
  assert.equal(f.registration.clientName,'Factory Droid');
});
