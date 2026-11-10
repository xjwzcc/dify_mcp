'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createMock} = require('./helpers/oss-mock.cjs');
const {OssJournal} = require('../storage/oss.cjs');
const {snapshot} = require('../storage/database.cjs');
const {exportEcs} = require('../scripts/export-ecs.cjs');
const {clientAddress} = require('../storage/client-address.cjs');
test('ECS export preserves accounts, classroom state and approvals without writing OSS', async t => {
  const mock = await createMock(); t.after(()=>mock.close());
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ecs-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={...mock.env,TEACHER_PASSWORD:'test-password',CATERING_CLASS_CODE:'catering-test',HOTEL_CLASS_CODE:'hotel-test'};
  for(const ns of ['catering','hotel','accounts']) {
    const db=new DatabaseSync(':memory:');
    db.exec(ns==='accounts' ? "CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT); INSERT INTO accounts VALUES('1','teacher_admin'); CREATE TABLE invitations(hash TEXT PRIMARY KEY,creator TEXT,used_by TEXT); INSERT INTO invitations VALUES('teacher-approved:1','console-admin','1');" : "CREATE TABLE users(id TEXT PRIMARY KEY,state TEXT); INSERT INTO users VALUES('student','saved work');");
    await new OssJournal(ns,env).initialize(snapshot(db));db.close();
  }
  const before=[...mock.objects].map(([k,v])=>[k,Buffer.from(v)]);
  const target=path.join(root,'export'),m=await exportEcs(target,env);
  assert.equal(m.databases.accounts.counts.accounts,1);
  for(const entry of Object.values(m.databases)) {
    const db=new DatabaseSync(path.join(target,entry.filename),{readOnly:true});
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  }
  const db=new DatabaseSync(path.join(target,'accounts/accounts.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT creator FROM invitations').get().creator,'console-admin');db.close();
  assert.deepEqual([...mock.objects],before);
  assert.ok(fs.existsSync(path.join(target,'EXPORT_COMPLETE')));
  await assert.rejects(exportEcs(target,env),/EEXIST/);
  for(const key of [...mock.objects.keys()])if(key.includes('/accounts/'))mock.objects.delete(key);
  const incomplete=path.join(root,'incomplete');await assert.rejects(exportEcs(incomplete,env));
  assert.equal(fs.existsSync(path.join(incomplete,'EXPORT_COMPLETE')),false);
});
test('only explicitly trusted local proxy can supply a client address',()=>{
  const req=(peer,ip)=>({socket:{remoteAddress:peer},headers:{'x-real-ip':ip}});
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.7'),{TRUST_LOCAL_PROXY:'1'}),'203.0.113.7');
  assert.equal(clientAddress(req('203.0.113.8','203.0.113.7'),{TRUST_LOCAL_PROXY:'1'}),'203.0.113.8');
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.7'),{}),'127.0.0.1');
  assert.equal(clientAddress(req('127.0.0.1','bad, address'),{TRUST_LOCAL_PROXY:'1'}),'127.0.0.1');
});
