const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness(provider){
  const elements=new Map(),events={};
  function element(){return {innerHTML:'',textContent:'',open:false,dataset:{},children:[],classList:{toggle(){}},addEventListener(){},setAttribute(){},removeAttribute(){},append(e){this.children.push(e);},remove(){},showModal(){this.open=true;},close(){this.open=false;}};}
  const get=s=>{if(!elements.has(s))elements.set(s,element());return elements.get(s);};
  const document={querySelector:get,querySelectorAll:()=>[],createElement:element,addEventListener:(name,fn)=>events[name]=fn,body:element()};
  const ctx={document,location:{hash:'#explore'},localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>0,addEventListener(){},scrollTo(){},phantom:{solana:provider},console,URL};ctx.window=ctx;vm.createContext(ctx);
  for(const file of ['engine.cjs','fixtures.cjs','app.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),ctx);
  const click=dataset=>events.click({target:{closest:()=>({dataset})}});
  return {ctx,get,click};
}
test('wallet popup connects a Solana address without signing or changing demo funds',async()=>{
  let connects=0,disconnects=0,signs=0;const listeners={};
  const provider={connect:async()=>{connects++;return {publicKey:{toString:()=> '11111111111111111111111111111111'}};},disconnect:async()=>{disconnects++;},on:(name,fn)=>listeners[name]=fn,removeListener:name=>delete listeners[name],signTransaction:()=>{signs++;throw Error('Unexpected signature');}};
  const h=harness(provider);h.click({action:'wallet'});assert.match(h.get('#dialog-body').innerHTML,/wallet-connect/);assert.equal(h.get('#dialog').open,true);
  h.click({wallet:'phantom'});await new Promise(setImmediate);assert.equal(connects,1);assert.equal(signs,0);assert.equal(h.get('#dialog').open,false);assert.match(h.get('.wallet-button').innerHTML,/1111/);assert.equal(h.ctx.ReboundDemo.inspect().demoBalances.SOL,20000000000n);
  listeners.accountChanged({toString:()=> 'invalid'});assert.match(h.get('.wallet-button').innerHTML,/Connect wallet/);
  h.click({action:'disconnect'});await new Promise(setImmediate);assert.equal(disconnects,1);assert.deepEqual(Object.keys(listeners),[]);
});
test('wallet refusals and invalid addresses never establish a connection',async()=>{
  for(const connect of [async()=>{throw Object.assign(Error('Rejected'),{code:4001});},async()=>({publicKey:{toString:()=> '0x1234'}})]){
    const h=harness({connect});h.click({wallet:'phantom'});await new Promise(setImmediate);assert.match(h.get('.wallet-button').innerHTML,/Connect wallet/);assert.ok(h.get('#toasts').children.length>0);
  }
});
