const test=require('node:test'),assert=require('node:assert/strict');
const {createWallet}=require('../src/wallet.js'),{isAddress}=require('../src/live-data.js');
const address='3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump';
test('wallet connection only requests a public address; disconnect detaches events',async()=>{
 let signs=0,disconnects=0;const listeners={},changes=[];
 const provider={connect:async()=>({publicKey:{toString:()=>address}}),on:(n,fn)=>listeners[n]=fn,removeListener:n=>delete listeners[n],disconnect:async()=>disconnects++,signTransaction:()=>signs++,signAndSendTransaction:()=>signs++,signMessage:()=>signs++};
 const wallet=createWallet({providers:()=>({phantom:provider}),isAddress,onChange:a=>changes.push(a)});
 await wallet.connect('phantom');assert.equal(wallet.address,address);assert.equal(signs,0);
 listeners.accountChanged({toString:()=> '11111111111111111111111111111111'});assert.equal(wallet.address,'11111111111111111111111111111111');
 listeners.accountChanged({toString:()=> 'bad'});assert.equal(wallet.address,null);
 await wallet.disconnect();assert.equal(disconnects,1);assert.deepEqual(listeners,{});assert.equal(changes.at(-1),null);
});
test('wallet refusals and malformed public keys never establish a connection',async()=>{
 for(const connect of [async()=>{throw Object.assign(Error('No'),{code:4001});},async()=>({publicKey:{toString:()=> '1'.repeat(44)}})]){
  const wallet=createWallet({providers:()=>({phantom:{connect}}),isAddress,onChange:()=>{}});
  await assert.rejects(wallet.connect('phantom'));assert.equal(wallet.address,null);
 }
});
test('disconnect while wallet approval is pending prevents a stale reconnection',async()=>{
 let resolve;const wallet=createWallet({providers:()=>({phantom:{connect:()=>new Promise(r=>resolve=r)}}),isAddress,onChange:()=>{}});
 const pending=wallet.connect('phantom');await wallet.disconnect();resolve({publicKey:{toString:()=>address}});await pending;assert.equal(wallet.address,null);
});
