// Privy wallet island (spec §12): Privy's Solana wallet discovery/connection only. REBOUND does not
// use Privy login or embedded wallets; the selected external wallet signs SIWS for the Supabase
// session and signs exact transactions. Loaded on demand only when a Privy app id is configured.
import {createElement as h,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {PrivyProvider,useConnectWallet} from '@privy-io/react-auth';
import {toSolanaWalletConnectors,useWallets} from '@privy-io/react-auth/solana';

const bridge={ready:false,wallets:[],connect:null,listeners:new Set()};
function emit(){for(const fn of bridge.listeners)try{fn(bridge);}catch{}}

function Bridge(){
 const {connectWallet}=useConnectWallet();
 const {ready,wallets}=useWallets();
 useEffect(()=>{bridge.connect=()=>connectWallet({walletChainType:'solana-only'});emit();},[connectWallet]);
 useEffect(()=>{bridge.ready=ready;bridge.wallets=wallets;emit();},[ready,wallets]);
 return null;
}

export function mountPrivy(appId){
 if(bridge.root)return bridge;
 const el=document.createElement('div');el.id='privy-island';document.body.append(el);
 bridge.root=createRoot(el);
 bridge.root.render(h(PrivyProvider,{appId,config:{
  appearance:{walletChainType:'solana-only',theme:'light',accentColor:'#0F9D63',showWalletLoginFirst:true,
   // Solana wallets only: the ones installed in this browser first, then the common ones and WalletConnect.
   walletList:['detected_solana_wallets','phantom','solflare','backpack','jupiter','okx_wallet','wallet_connect_qr_solana']},
  loginMethods:['wallet'],
  externalWallets:{solana:{connectors:toSolanaWalletConnectors()}},
  embeddedWallets:{solana:{createOnLogin:'off'},ethereum:{createOnLogin:'off'}},
 }},h(Bridge)));
 return bridge;
}
