(function(root){
'use strict';
function createWallet({providers,isAddress,onChange}){
 let provider=null,address=null,pending=false,generation=0,listeners=[];
 function detach(){for(const[name,fn]of listeners)provider?.removeListener?.(name,fn);listeners=[];}
 function clear(){detach();provider=null;address=null;onChange(null);}
 async function connect(which){
  if(pending)return;
  const candidate=providers()[which];if(!candidate?.connect)throw Error('Open rebound in a browser with this Solana wallet installed.');
  const epoch=++generation;pending=true;
  try{
   const result=await candidate.connect();if(epoch!==generation)return;
   const next=(result?.publicKey||candidate.publicKey)?.toString();if(!isAddress(next))throw Error('The wallet returned an invalid Solana address.');
   detach();provider=candidate;address=next;
   const disconnected=()=>{generation++;clear();};
   const changed=key=>{address=isAddress(key?.toString())?key.toString():null;onChange(address);};
   if(provider.on){listeners=[['disconnect',disconnected],['accountChanged',changed]];for(const[name,fn]of listeners)provider.on(name,fn);}
   onChange(address);
  }catch(error){if(epoch===generation)clear();throw Error(error?.code===4001?'Wallet connection was declined.':error.message||'Could not connect the wallet.');}
  finally{pending=false;}
 }
 async function disconnect(){generation++;const old=provider;clear();try{await old?.disconnect?.();}catch{}}
 return{connect,disconnect,get address(){return address;}};
}
if(typeof module==='object'&&module.exports)module.exports={createWallet};else root.ReboundWallet={createWallet};
})(typeof window==='object'?window:globalThis);

