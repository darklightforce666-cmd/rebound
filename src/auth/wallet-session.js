// Supabase session bound to ONE selected wallet (spec §12).
// `wallet` is the exact wallet the user selected through Privy's Solana wallet discovery
// (Wallet Standard): { address: string, signMessage(bytes: Uint8Array) -> Uint8Array | {signature} }.
// No global (window.solana) is read or mutated. The signature proves control for sign-in only:
// it cannot move SOL or tokens and grants no future spending authority.
export const SIGN_IN_STATEMENT='Sign in to REBOUND. This signature does not send a transaction, move SOL or tokens, or authorize future spending.';

export function supabaseWalletAdapter(wallet){
 if(!wallet||typeof wallet.address!=='string'||typeof wallet.signMessage!=='function')throw new Error('Select a Solana wallet that supports message signing.');
 const address=wallet.address;
 return{
  publicKey:{toBase58:()=>address},
  async signMessage(bytes){
   const out=await wallet.signMessage(bytes);
   const sig=out instanceof Uint8Array?out:out?.signature instanceof Uint8Array?out.signature:out?.signature?new Uint8Array(out.signature):null;
   if(!sig||sig.length!==64)throw new Error('The wallet returned an invalid signature.');
   if(wallet.address!==address)throw new Error('The selected wallet changed while signing.');
   return sig;
  },
 };
}

// Returns the verified Solana addresses of a Supabase user (server-set provider ids only).
export function verifiedAddresses(user){
 return(user?.identities||[]).filter(i=>i.provider==='web3').map(i=>/^web3:solana:(.+)$/.exec(i.id||i.provider_id||'')?.[1]).filter(Boolean);
}

// Sign in (or reuse a session) for exactly `wallet`. A session belonging to another wallet
// is signed out first, so the app never acts for an address the user did not select.
export async function signInWithSelectedWallet(supabase,wallet,{statement=SIGN_IN_STATEMENT}={}){
 const current=(await supabase.auth.getSession()).data.session;
 if(current){
  const {data}=await supabase.auth.getUser();
  if(verifiedAddresses(data?.user).includes(wallet.address))return current;
  await supabase.auth.signOut({scope:'local'});
 }
 const {data,error}=await supabase.auth.signInWithWeb3({chain:'solana',statement,wallet:supabaseWalletAdapter(wallet)});
 if(error)throw new Error(error.status===400&&/URI|domain/i.test(error.message)?'Sign-in is not enabled for this site address yet.':error.message||'Sign-in failed.');
 if(!verifiedAddresses(data.user).includes(wallet.address)){await supabase.auth.signOut({scope:'local'});throw new Error('Signed-in account does not match the selected wallet.');}
 return data.session;
}

// Call when Privy reports a disconnect or a different active address.
export async function onWalletChanged(supabase,nextAddress,{cancelPending}={}){
 cancelPending?.();
 const {data}=await supabase.auth.getUser();
 if(!nextAddress||!verifiedAddresses(data?.user).includes(nextAddress))await supabase.auth.signOut({scope:'local'});
}
