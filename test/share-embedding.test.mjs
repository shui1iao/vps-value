import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAppServer} from '../server.mjs';

test('only public share PNGs allow cross-origin embedding and anonymous image fetches',async()=>{
 const storageDir=await mkdtemp(path.join(tmpdir(),'vps-embed-'));
 const server=createAppServer({storageDir,publicDir:path.resolve('public')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const response=await fetch(base+'/api/shares',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Markdown test',amount:120,currency:'CNY',billingCycle:'custom',customDays:30,endAt:'2026-09-20',valuedAt:'2026-09-05'})});
  assert.equal(response.status,201);const body=await response.json();
  for(const method of ['GET','HEAD']){
   const image=await fetch(body.imageUrl,{method,headers:{origin:'https://forum.example',referer:'https://forum.example/post','sec-fetch-site':'cross-site','sec-fetch-dest':'image'}});
   assert.equal(image.status,200);assert.equal(image.headers.get('cross-origin-resource-policy'),'cross-origin');assert.equal(image.headers.get('access-control-allow-origin'),'*');
   assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control'),/immutable/);assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  }
  for(const route of ['/','/app.mjs','/health','/.env','/shares/.fx-cache.json','/shares/not-found.png']){
   const privateResponse=await fetch(base+route);assert.equal(privateResponse.headers.get('cross-origin-resource-policy'),'same-origin',route);assert.equal(privateResponse.headers.get('access-control-allow-origin'),null,route);
   if(route.includes('.env')||route.includes('.fx-cache')||route.includes('not-found'))assert.equal(privateResponse.status,404);
  }
  assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(response.headers.get('access-control-allow-origin'),null);
 }finally{await new Promise(r=>server.close(r));await rm(storageDir,{recursive:true,force:true});}
});
