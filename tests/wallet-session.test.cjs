'use strict';
// The browser session module binds the Supabase session to exactly the selected wallet.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
globalThis.location={host:'rebound.wtf',origin:'https://rebound.wtf',href:'https://rebound.wtf/#launch'};
const load=()=>import(pathToFileURL(path.join(__dirname,'../src/auth/wallet-session.js')).href);
function fakeSupabase({sessionFor=null,signInAs}={}){
 const calls=[];let session=sessionFor?{access_token:'t'}:null,user=sessionFor?{identities:[{provider:'web3',id:'web3:solana:'+sessionFor}]}:null;
 return{calls,auth:{
  async getSession(){return{data:{session}};},async getUser(){return{data:{user}};},
  async signOut(o){calls.push(['signOut',o]);session=null;user=null;},
  async signInWithWeb3(req){calls.push(['signIn',req]);assert.equal(req.chain,'solana');assert.equal(req.signature.length,64);
   const who=signInAs||req.message.split('\n')[1];user={identities:[{provider:'web3',id:'web3:solana:'+who}]};session={access_token:'new'};return{data:{user,session},error:null};},
 }};
}
const wallet=(address,sig=new Uint8Array(64))=>({address,signMessage:async()=>({signature:sig})});
test('adapter exposes only the selected wallet and rejects a changed account or bad signature',async()=>{
 const m=await load();const w=wallet('AAAA');const a=m.supabaseWalletAdapter(w);
 assert.equal(a.publicKey.toBase58(),'AAAA');assert.equal((await a.signMessage(new Uint8Array(3))).length,64);
 await assert.rejects(m.supabaseWalletAdapter(wallet('A',new Uint8Array(10))).signMessage(new Uint8Array(1)),/invalid signature/);
 const changing={address:'X',signMessage:async()=>{changing.address='Y';return new Uint8Array(64);}};
 await assert.rejects(m.supabaseWalletAdapter(changing).signMessage(new Uint8Array(1)),/changed while signing/);
 assert.throws(()=>m.supabaseWalletAdapter({}),/Select a Solana wallet/);
 assert.match(m.SIGN_IN_STATEMENT,/does not send a transaction/);
});
test('an existing session for another wallet is signed out before signing in the selected one',async()=>{
 const m=await load(),sb=fakeSupabase({sessionFor:'OTHER'});
 await m.signInWithSelectedWallet(sb,wallet('MINE'));
 assert.deepEqual(sb.calls.map(c=>c[0]),['signOut','signIn']);
 const same=fakeSupabase({sessionFor:'MINE'});await m.signInWithSelectedWallet(same,wallet('MINE'));assert.equal(same.calls.length,0);
});
test('a session that does not match the selected wallet is rejected and discarded',async()=>{
 const m=await load(),sb=fakeSupabase({signInAs:'SOMEONE_ELSE'});
 await assert.rejects(m.signInWithSelectedWallet(sb,wallet('MINE')),/does not match/);assert.equal(sb.calls.at(-1)[0],'signOut');
 const changed=fakeSupabase({sessionFor:'MINE'});let canceled=false;await m.onWalletChanged(changed,'NEW',{cancelPending:()=>{canceled=true;}});
 assert.equal(canceled,true);assert.equal(changed.calls[0][0],'signOut');
 const disc=fakeSupabase({sessionFor:'MINE'});await m.onWalletChanged(disc,null);assert.equal(disc.calls[0][0],'signOut');
});

// The SIWS grammar as wallets parse it (@solana/wallet-standard-util): fields in this order, each optional.
const SIWS=new RegExp('^(?<domain>[^\\n]+?) wants you to sign in with your Solana account:\\n(?<address>[^\\n]+)(?:\\n|$)(?:\\n(?<statement>[\\S\\s]*?)(?:\\n|$))??'+
 '(?:\\nURI: (?<uri>[^\\n]+))?(?:\\nVersion: (?<version>[^\\n]+))?(?:\\nChain ID: (?<chainId>[^\\n]+))?(?:\\nNonce: (?<nonce>[^\\n]+))?'+
 '(?:\\nIssued At: (?<issuedAt>[^\\n]+))?(?:\\nExpiration Time: (?<expirationTime>[^\\n]+))?(?:\\nNot Before: (?<notBefore>[^\\n]+))?(?:\\nRequest ID: (?<requestId>[^\\n]+))?(?:\\nResources:(?<resources>(?:\\n- [^\\n]+)*))?\\n*$');
test('the sign-in message follows the SIWS grammar wallets check (URI before Version, bare host, origin URI)',async()=>{
 const m=await load(),sb=fakeSupabase();await m.signInWithSelectedWallet(sb,wallet('MINE'));
 const msg=sb.calls[0][1].message,g=SIWS.exec(msg)?.groups;
 assert.ok(g,'parses as SIWS');assert.equal(g.domain,'rebound.wtf');assert.equal(g.address,'MINE');assert.equal(g.uri,'https://rebound.wtf/');assert.equal(g.version,'1');
 assert.equal(g.statement,m.SIGN_IN_STATEMENT);assert.ok(!Number.isNaN(Date.parse(g.issuedAt)));
 const supabaseOrder=msg.replace(/URI: (.*)\nVersion: 1/,'Version: 1\nURI: $1');assert.equal(SIWS.exec(supabaseOrder)?.groups?.uri,undefined,'Version before URI does not parse');
});
