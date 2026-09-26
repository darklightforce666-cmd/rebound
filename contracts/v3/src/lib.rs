//! REBOUND rewards program V3 (policy rebound-v3.0).
//!
//! * Primary coin: the registered dedicated dev wallet makes HOLDER-ONLY deposits. The 15 % stays
//!   on the dev wallet off-chain; nothing here splits a primary deposit.
//! * Third-party coin: creator fees reach a per-mint intake PDA; a verifier-attested receipt moves
//!   them into the coin treasury and splits them ONCE, 85 % holder reserve / 15 % buyback reserve.
//! * Rounds: publisher + verifier commit an immutable Merkle-sum manifest of fixed awards for cycle
//!   n, only inside [cutoff(n), cutoff(n+1)). Payment is permissionless after scheduled_end(n),
//!   verifies membership, the exact recipient and a permanent receipt PDA, and — by policy —
//!   performs NO fresh holding or price check: a funded snapshot award survives later sales.
//! * The program proves funding limits, membership and replay protection. It does not prove
//!   historical economic loss; that is the indexer/publisher/verifier trust boundary.
#![allow(unexpected_cfgs)]
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
 account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, hash::hashv,
 instruction::{AccountMeta, Instruction}, program::{invoke, invoke_signed},
 program_error::ProgramError, pubkey::Pubkey, rent::Rent, system_instruction,
 system_program, sysvar::{self, Sysvar},
};
#[cfg(not(feature="no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const PRODUCTION_CYCLE:i64=1800; pub const PRODUCTION_LEAD:i64=60;
pub const TEST_CYCLE:i64=120; pub const TEST_LEAD:i64=30;
pub const MAX_INDEX_LAG:u64=96; pub const AUTH_LIFETIME:u64=20; pub const RESUME_DELAY:i64=86400;
pub const GLOBAL_LEN:usize=320; pub const COIN_LEN:usize=384; pub const ROUND_LEN:usize=320; pub const MAX_RECIPIENTS:u32=64_000; pub const RECEIPT_LEN:usize=128;
pub const JOB_LEN:usize=320; pub const MAX_PROOF:usize=20;
pub const PUMP:Pubkey=solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const FEES:Pubkey=solana_program::pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const AMM:Pubkey=solana_program::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const SOL:Pubkey=solana_program::pubkey!("So11111111111111111111111111111111111111112");
pub const TOKEN:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN22:Pubkey=solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA:Pubkey=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ED25519:Pubkey=solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const LOADER:Pubkey=solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const PRIMARY:u8=0; pub const THIRD_PARTY:u8=1;

#[repr(u32)]
#[derive(Debug,Clone,Copy,PartialEq)]
pub enum Error { Unauthorized=300,Account,Data,Arithmetic,Funds,Paused,Round,Proof,Settled,Stale,Kind,Inactive,TooSoon,TooLate,Routing,Buyback,Burn }
impl From<Error> for ProgramError { fn from(e:Error)->Self { Self::Custom(e as u32) } }
fn require(ok:bool,e:Error)->ProgramResult { if ok {Ok(())} else {Err(e.into())} }
fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(Error::Arithmetic.into())}
fn sub(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_sub(b).ok_or(Error::Funds.into())}
fn signer(a:&AccountInfo,k:&Pubkey)->ProgramResult{require(a.is_signer && a.key==k,Error::Unauthorized)}
fn wr(a:&AccountInfo)->ProgramResult{require(a.is_writable,Error::Account)}
fn key(data:&[u8],at:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(data.get(at..at+32).ok_or(Error::Data)?.try_into().map_err(|_|Error::Data)?))}
fn distinct(keys:&[Pubkey])->ProgramResult{for(i,k)in keys.iter().enumerate(){require(!keys[..i].contains(k),Error::Account)?;}Ok(())}
fn pda(program:&Pubkey,seeds:&[&[u8]])->(Pubkey,u8){Pubkey::find_program_address(seeds,program)}
pub fn global_address(p:&Pubkey)->(Pubkey,u8){pda(p,&[b"deployment-v3"])}
pub fn coin_address(p:&Pubkey,mint:&Pubkey)->(Pubkey,u8){pda(p,&[b"coin-v3",mint.as_ref()])}
pub fn intake_address(p:&Pubkey,mint:&Pubkey)->(Pubkey,u8){pda(p,&[b"intake-v3",mint.as_ref()])}
pub fn round_address(p:&Pubkey,coin:&Pubkey,cycle:u64)->(Pubkey,u8){pda(p,&[b"round-v3",coin.as_ref(),&cycle.to_le_bytes()])}
pub fn receipt_address(p:&Pubkey,coin:&Pubkey,event:&[u8;32])->(Pubkey,u8){pda(p,&[b"receipt-v3",coin.as_ref(),event])}
pub fn job_address(p:&Pubkey,coin:&Pubkey,id:u64)->(Pubkey,u8){pda(p,&[b"buyback-v3",coin.as_ref(),&id.to_le_bytes()])}
pub fn buyer_address(p:&Pubkey,job:&Pubkey)->(Pubkey,u8){pda(p,&[b"buyer-v3",job.as_ref()])}

#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,PartialEq)]
pub struct Deployment{pub magic:[u8;8],pub admin:Pubkey,pub publisher:Pubkey,pub verifier:Pubkey,pub guardian:Pubkey,pub policy:[u8;32],
 pub test_mode:bool,pub paused:bool,pub resume_at:i64,pub target_mint:Pubkey,pub target_token_program:Pubkey,pub config_version:u64}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,PartialEq)]
pub struct Coin{
 pub magic:[u8;8],pub mint:Pubkey,pub kind:u8,pub deployment:Pubkey,pub policy:[u8;32],pub active:bool,
 pub anchor:i64,pub cycle_seconds:i64,pub cutoff_lead:i64,pub funding_wallet:Pubkey,pub launcher:Pubkey,
 pub receipts:u64,pub deposits:u64,pub holder_unallocated:u64,pub holder_reserved:u64,pub holder_paid:u64,
 pub buyback_available:u64,pub buyback_reserved:u64,pub buyback_spent:u64,pub split_carry:u8,pub last_cycle:u64,pub next_job:u64,
}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,PartialEq)]
pub struct Round{pub magic:[u8;8],pub coin:Pubkey,pub cycle:u64,pub root:[u8;32],pub total:u64,pub remaining:u64,pub count:u32,pub paid_count:u32,
 pub cutoff_slot:u64,pub cutoff_time:i64,pub due_time:i64,pub snapshot:[u8;32],pub manifest:[u8;32],pub policy:[u8;32],pub verifier:Pubkey,
 /// Who paid the round's rent; CloseRound returns it there once every award is paid.
 pub rent_payer:Pubkey}
/// Paid flags live in the round account after the header: one bit per award (no account per recipient).
pub fn bitmap_len(count:u32)->usize{((count as usize)+7)/8}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,PartialEq)]
pub struct Receipt{pub magic:[u8;8],pub coin:Pubkey,pub event:[u8;32],pub amount:u64,pub holders:u64,pub buyback:u64,pub source_slot:u64}
/// Buyback job states: 0 reserved, 1 purchased (pending burn), 2 burned, 3 closed.
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,PartialEq)]
pub struct Job{pub magic:[u8;8],pub coin:Pubkey,pub id:u64,pub cycle:u64,pub target_mint:Pubkey,pub target_token_program:Pubkey,pub config_version:u64,
 pub budget:u64,pub state:u8,pub spent:u64,pub acquired:u64,pub burned:u64,pub max_slippage_bps:u16,pub max_impact_bps:u16,pub purchase_slot:u64,pub burn_slot:u64}

fn load<T:BorshDeserialize>(program:&Pubkey,a:&AccountInfo,len:usize,magic:&[u8;8])->Result<T,ProgramError>{
 require(a.owner==program && !a.executable && a.data_len()==len,Error::Account)?;
 let data=a.try_borrow_data()?;require(data.get(..8)==Some(magic),Error::Data)?;
 let mut rest=&data[..];let v=T::deserialize(&mut rest).map_err(|_|Error::Data)?;require(rest.iter().all(|b|*b==0),Error::Data)?;Ok(v)
}
fn store<T:BorshSerialize>(a:&AccountInfo,v:&T)->ProgramResult{
 wr(a)?;let bytes=borsh::to_vec(v).map_err(|_|Error::Data)?;require(bytes.len()<=a.data_len(),Error::Account)?;
 let mut d=a.try_borrow_mut_data()?;d.fill(0);d[..bytes.len()].copy_from_slice(&bytes);Ok(())
}
fn deployment(program:&Pubkey,a:&AccountInfo)->Result<Deployment,ProgramError>{require(global_address(program).0==*a.key,Error::Account)?;load(program,a,GLOBAL_LEN,b"RBD3DEP0")}
fn coin(program:&Pubkey,a:&AccountInfo,g:&AccountInfo)->Result<Coin,ProgramError>{
 let c:Coin=load(program,a,COIN_LEN,b"RBD3COIN")?;require(c.deployment==*g.key&&coin_address(program,&c.mint).0==*a.key,Error::Account)?;
 conservation(&c)?;backing(&c,a)?;Ok(c)
}
fn round(program:&Pubkey,a:&AccountInfo,c:&AccountInfo)->Result<Round,ProgramError>{
 require(a.owner==program&&!a.executable&&a.data_len()>=ROUND_LEN,Error::Account)?;
 let r:Round={let data=a.try_borrow_data()?;require(data.get(..8)==Some(b"RBD3ROND"),Error::Data)?;
  let mut rest=&data[..ROUND_LEN];let v=Round::deserialize(&mut rest).map_err(|_|Error::Data)?;require(rest.iter().all(|b|*b==0),Error::Data)?;v};
 require(a.data_len()==ROUND_LEN+bitmap_len(r.count),Error::Account)?;
 require(r.coin==*c.key&&round_address(program,c.key,r.cycle).0==*a.key&&r.remaining<=r.total&&r.paid_count<=r.count,Error::Account)?;Ok(r)
}
/// Write the round header without touching the paid bitmap that follows it.
fn store_round(a:&AccountInfo,v:&Round)->ProgramResult{
 wr(a)?;let bytes=borsh::to_vec(v).map_err(|_|Error::Data)?;require(bytes.len()<=ROUND_LEN&&a.data_len()>=ROUND_LEN,Error::Account)?;
 let mut d=a.try_borrow_mut_data()?;d[..ROUND_LEN].fill(0);d[..bytes.len()].copy_from_slice(&bytes);Ok(())
}
fn paid_flag(a:&AccountInfo,index:u32)->Result<bool,ProgramError>{let d=a.try_borrow_data()?;let at=ROUND_LEN+(index as usize)/8;require(at<d.len(),Error::Account)?;Ok(d[at]&(1u8<<(index%8))!=0)}
fn set_paid_flag(a:&AccountInfo,index:u32)->ProgramResult{wr(a)?;let mut d=a.try_borrow_mut_data()?;let at=ROUND_LEN+(index as usize)/8;require(at<d.len(),Error::Account)?;d[at]|=1u8<<(index%8);Ok(())}
/// Conservation: every credited lamport is in exactly one bucket.
pub fn conservation(c:&Coin)->ProgramResult{
 let holders=add(add(c.holder_unallocated,c.holder_reserved)?,c.holder_paid)?;
 let buyback=add(add(c.buyback_available,c.buyback_reserved)?,c.buyback_spent)?;
 match c.kind{
  PRIMARY=>require(c.deposits==holders&&c.receipts==0&&buyback==0&&c.split_carry==0,Error::Arithmetic),
  THIRD_PARTY=>require(c.receipts==add(holders,buyback)?&&c.deposits==0&&c.split_carry<100,Error::Arithmetic),
  _=>Err(Error::Kind.into()),
 }
}
/// Backing: the coin treasury holds its rent plus every liability that has not left it.
fn backing(c:&Coin,treasury:&AccountInfo)->ProgramResult{
 let owed=add(add(c.holder_unallocated,c.holder_reserved)?,c.buyback_available)?;
 require(treasury.lamports()>=add(Rent::get()?.minimum_balance(COIN_LEN),owed)?,Error::Funds)
}
fn pay(from:&AccountInfo,to:&AccountInfo,n:u64)->ProgramResult{
 wr(from)?;wr(to)?;require(from.key!=to.key&&!to.executable,Error::Account)?;
 let a=sub(from.lamports(),n)?;let b=add(to.lamports(),n)?;**from.try_borrow_mut_lamports()?=a;**to.try_borrow_mut_lamports()?=b;Ok(())
}
fn create<'a>(program:&Pubkey,payer:&AccountInfo<'a>,target:&AccountInfo<'a>,system:&AccountInfo<'a>,seeds:&[&[u8]],len:usize)->ProgramResult{
 require(payer.is_signer&&payer.owner==&system_program::id()&&payer.data_is_empty(),Error::Unauthorized)?;
 wr(payer)?;wr(target)?;require(*system.key==system_program::id()&&system.executable,Error::Account)?;distinct(&[*payer.key,*target.key,*system.key])?;
 require(target.owner==&system_program::id()&&target.data_is_empty()&&!target.executable,Error::Settled)?;
 let rent=Rent::get()?.minimum_balance(len).saturating_sub(target.lamports());
 if rent>0{invoke(&system_instruction::transfer(payer.key,target.key,rent),&[payer.clone(),target.clone(),system.clone()])?;}
 invoke_signed(&system_instruction::allocate(target.key,len as u64),&[target.clone(),system.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(target.key,program),&[target.clone(),system.clone()],&[seeds])
}
fn clock()->Result<Clock,ProgramError>{let c=Clock::get()?;require(c.unix_timestamp>=0,Error::Data)?;Ok(c)}
/// Third-party split, once, with persistent per-mint carry.
pub fn credit(c:&mut Coin,n:u64)->Result<(u64,u64),ProgramError>{
 require(n>0&&c.kind==THIRD_PARTY,Error::Data)?;
 let t=(n as u128)*85+(c.split_carry as u128);let holders=u64::try_from(t/100).map_err(|_|Error::Arithmetic)?;let buyback=sub(n,holders)?;
 c.split_carry=(t%100)as u8;c.receipts=add(c.receipts,n)?;c.holder_unallocated=add(c.holder_unallocated,holders)?;c.buyback_available=add(c.buyback_available,buyback)?;
 conservation(c)?;Ok((holders,buyback))
}
/// Primary holder-only deposit: never split.
pub fn deposit(c:&mut Coin,n:u64)->ProgramResult{
 require(n>0&&c.kind==PRIMARY,Error::Kind)?;c.deposits=add(c.deposits,n)?;c.holder_unallocated=add(c.holder_unallocated,n)?;conservation(c)
}
pub fn cutoff(c:&Coin,cycle:u64)->Result<i64,ProgramError>{
 let n=i64::try_from(cycle).map_err(|_|Error::Arithmetic)?;
 c.anchor.checked_add(n.checked_mul(c.cycle_seconds).ok_or(Error::Arithmetic)?).and_then(|e|e.checked_sub(c.cutoff_lead)).ok_or(Error::Arithmetic.into())
}
pub fn due(c:&Coin,cycle:u64)->Result<i64,ProgramError>{let n=i64::try_from(cycle).map_err(|_|Error::Arithmetic)?;c.anchor.checked_add(n.checked_mul(c.cycle_seconds).ok_or(Error::Arithmetic)?).ok_or(Error::Arithmetic.into())}
/// Funding window for cycle n: [cutoff(n), cutoff(n+1)).
pub fn funding_window(c:&Coin,cycle:u64,now:i64)->ProgramResult{
 require(cycle>=1&&cycle>c.last_cycle,Error::Round)?;
 let open=cutoff(c,cycle)?;let close=cutoff(c,cycle.checked_add(1).ok_or(Error::Arithmetic)?)?;
 require(now>=open,Error::TooSoon)?;require(now<close,Error::TooLate)
}
pub fn fresh(now:u64,through:u64,issued:u64,expires:u64)->ProgramResult{
 require(through<=issued&&issued<=now&&issued-through<=MAX_INDEX_LAG&&expires>=issued&&expires-issued<=AUTH_LIFETIME&&now<=expires&&now-issued<=AUTH_LIFETIME,Error::Stale)
}
fn attest(sys:&AccountInfo,expected:&Pubkey,message:&[u8])->ProgramResult{
 require(*sys.key==sysvar::instructions::id(),Error::Account)?;
 let current=sysvar::instructions::load_current_index_checked(sys)?;require(current>0,Error::Unauthorized)?;
 let ix=sysvar::instructions::load_instruction_at_checked((current-1)as usize,sys)?;
 require(ix.program_id==ED25519&&ix.accounts.is_empty()&&ix.data.len()>=16&&ix.data[0]==1&&ix.data[1]==0,Error::Unauthorized)?;
 let u=|at:usize|->Result<usize,ProgramError>{Ok(u16::from_le_bytes(ix.data.get(at..at+2).ok_or(Error::Data)?.try_into().map_err(|_|Error::Data)?)as usize)};
 require(u(4)?==65535&&u(8)?==65535&&u(14)?==65535,Error::Unauthorized)?;
 let sig=u(2)?;let pk=u(6)?;let msg=u(10)?;let len=u(12)?;
 require(ix.data.get(sig..sig+64).is_some()&&ix.data.get(pk..pk+32)==Some(expected.as_ref())&&len==message.len()&&ix.data.get(msg..msg+len)==Some(message),Error::Unauthorized)
}
fn valid_mint(a:&AccountInfo)->ProgramResult{
 require(!a.executable&&(a.owner==&TOKEN||a.owner==&TOKEN22),Error::Account)?;let d=a.try_borrow_data()?;
 require(d.len()>=82&&d[45]==1,Error::Data)?;if a.owner==&TOKEN{require(d.len()==82,Error::Data)?;}else if d.len()>82{require(d.get(165)==Some(&1),Error::Data)?;}Ok(())
}
fn curve_creator(mint:&Pubkey,a:&AccountInfo)->Result<Pubkey,ProgramError>{
 require(a.owner==&PUMP&&pda(&PUMP,&[b"bonding-curve",mint.as_ref()]).0==*a.key&&!a.executable,Error::Routing)?;let d=a.try_borrow_data()?;
 require(d.len()>=125&&d[..8]==hashv(&[b"account:BondingCurve"]).to_bytes()[..8]&&d[81]==0&&d[82]==0&&d[124]==0,Error::Routing)?;
 require(key(&d,83)?==Pubkey::default(),Error::Routing)?;key(&d,49)
}
fn sharing(mint:&Pubkey,intake:&Pubkey,a:&AccountInfo,locked:bool)->ProgramResult{
 require(a.owner==&FEES&&pda(&FEES,&[b"sharing-config",mint.as_ref()]).0==*a.key&&!a.executable,Error::Routing)?;let d=a.try_borrow_data()?;
 require(d.len()>=114&&d[..8]==[216,74,9,0,56,140,93,75]&&d[9]==2&&d[10]==1&&key(&d,11)?==*mint,Error::Routing)?;
 require(u32::from_le_bytes(d[76..80].try_into().map_err(|_|Error::Data)?)==1&&key(&d,80)?==*intake&&u16::from_le_bytes(d[112..114].try_into().map_err(|_|Error::Data)?)==10000,Error::Routing)?;
 require(if locked{d[75]==1}else{d[75]==0&&key(&d,43)?==*intake},Error::Routing)
}

#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,Copy,PartialEq)]
pub struct Node{pub hash:[u8;32],pub sum:u64}
pub fn leaf(program:&Pubkey,c:&Coin,cycle:u64,index:u32,wallet:&Pubkey,n:u64)->Node{
 Node{hash:hashv(&[b"REBOUND:leaf:v3",program.as_ref(),c.deployment.as_ref(),c.mint.as_ref(),&c.policy,&cycle.to_le_bytes(),&index.to_le_bytes(),wallet.as_ref(),&n.to_le_bytes()]).to_bytes(),sum:n}
}
pub fn parent(a:Node,b:Node)->Result<Node,ProgramError>{
 let(l,r)=if(a.hash,a.sum)<=(b.hash,b.sum){(a,b)}else{(b,a)};
 Ok(Node{hash:hashv(&[b"REBOUND:node:v3",&l.hash,&l.sum.to_le_bytes(),&r.hash,&r.sum.to_le_bytes()]).to_bytes(),sum:add(l.sum,r.sum)?})
}
pub fn verify(program:&Pubkey,c:&Coin,r:&Round,index:u32,wallet:&Pubkey,n:u64,nodes:&[Node])->ProgramResult{
 require(n>0&&nodes.len()<=MAX_PROOF&&index<r.count,Error::Proof)?;let mut at=leaf(program,c,r.cycle,index,wallet,n);
 for s in nodes{at=parent(at,*s)?;}require(at.hash==r.root&&at.sum==r.total,Error::Proof)
}
/// Pure settlement state change for one award (tested natively and in SVM).
pub fn settle(c:&mut Coin,r:&mut Round,n:u64)->ProgramResult{
 r.remaining=sub(r.remaining,n)?;r.paid_count=r.paid_count.checked_add(1).ok_or(Error::Arithmetic)?;require(r.paid_count<=r.count,Error::Round)?;
 c.holder_reserved=sub(c.holder_reserved,n)?;c.holder_paid=add(c.holder_paid,n)?;conservation(c)
}

#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct ReceiptAuth{pub domain:[u8;8],pub program:Pubkey,pub deployment:Pubkey,pub mint:Pubkey,pub asset:u8,pub signature:[u8;64],pub instruction_path:[u8;32],pub amount:u64,pub through:u64,pub issued:u64,pub expires:u64}
impl ReceiptAuth{pub fn event(&self)->[u8;32]{hashv(&[b"REBOUND:receipt:v3",&self.signature,&self.instruction_path,self.mint.as_ref()]).to_bytes()}}

#[derive(BorshSerialize,BorshDeserialize,Debug)]
pub enum Command{
 Initialize{publisher:Pubkey,verifier:Pubkey,guardian:Pubkey,policy:[u8;32],test_mode:bool},
 RegisterPrimary{funding_wallet:Pubkey},
 StartPrimary,
 SetFundingWallet{funding_wallet:Pubkey},
 DepositHolders{amount:u64},
 PrepareCoin,
 CreateSharing,
 LockSharing,
 Activate,
 Credit{authorization:ReceiptAuth},
 Fund{cycle:u64,root:Node,count:u32,cutoff_slot:u64,snapshot:[u8;32],manifest:[u8;32]},
 Pay{cycle:u64,index:u32,amount:u64,proof:Vec<Node>},
 Pause,
 RequestResume,
 Resume,
 SetAuthorities{publisher:Pubkey,verifier:Pubkey,guardian:Pubkey},
 SetBuybackTarget{target_mint:Pubkey},
 ReserveBuyback{cycle:u64,amount:u64,max_slippage_bps:u16,max_impact_bps:u16},
 BuybackSwap{min_out:u64},
 BuybackBurn,
 CloseBuyback,
 /// Close a fully paid round and return its rent to whoever paid it (permissionless).
 CloseRound{cycle:u64},
}

pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let command=Command::try_from_slice(data).map_err(|_|Error::Data)?;
 match command{
 Command::Initialize{publisher,verifier,guardian,policy,test_mode}=>{
  require(accounts.len()==5,Error::Account)?;
  let(admin,g,self_program,program_data,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4]);
  // Admin must be the program's retained upgrade authority (governance).
  require(admin.is_signer&&self_program.key==program&&self_program.executable&&self_program.owner==&LOADER&&program_data.owner==&LOADER,Error::Unauthorized)?;
  let pd=self_program.try_borrow_data()?;require(pd.len()==36&&pd[..4]==2u32.to_le_bytes()&&key(&pd,4)?==*program_data.key,Error::Account)?;drop(pd);
  require(pda(&LOADER,&[program.as_ref()]).0==*program_data.key,Error::Account)?;
  let ad=program_data.try_borrow_data()?;require(ad.len()>=45&&ad[..4]==3u32.to_le_bytes()&&ad[12]==1&&key(&ad,13)?==*admin.key,Error::Unauthorized)?;drop(ad);
  distinct(&[*admin.key,publisher,verifier,guardian])?;require([publisher,verifier,guardian].iter().all(|k|*k!=Pubkey::default())&&policy!=[0;32],Error::Data)?;
  let(expected,bump)=global_address(program);require(expected==*g.key,Error::Account)?;
  create(program,admin,g,system,&[b"deployment-v3",&[bump]],GLOBAL_LEN)?;
  store(g,&Deployment{magic:*b"RBD3DEP0",admin:*admin.key,publisher,verifier,guardian,policy,test_mode,paused:false,resume_at:0,target_mint:Pubkey::default(),target_token_program:Pubkey::default(),config_version:0})
 },
 Command::RegisterPrimary{funding_wallet}=>{
  require(accounts.len()==5,Error::Account)?;
  let(admin,g,c,mint,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4]);
  let d=deployment(program,g)?;signer(admin,&d.admin)?;require(!d.paused,Error::Paused)?;valid_mint(mint)?;
  require(funding_wallet!=Pubkey::default()&&funding_wallet!=*admin.key,Error::Data)?;
  let(expected,bump)=coin_address(program,mint.key);require(expected==*c.key,Error::Account)?;
  create(program,admin,c,system,&[b"coin-v3",mint.key.as_ref(),&[bump]],COIN_LEN)?;
  let(cycle_seconds,cutoff_lead)=if d.test_mode{(TEST_CYCLE,TEST_LEAD)}else{(PRODUCTION_CYCLE,PRODUCTION_LEAD)};
  store(c,&Coin{magic:*b"RBD3COIN",mint:*mint.key,kind:PRIMARY,deployment:*g.key,policy:d.policy,active:false,anchor:0,cycle_seconds,cutoff_lead,funding_wallet,launcher:*admin.key,
   receipts:0,deposits:0,holder_unallocated:0,holder_reserved:0,holder_paid:0,buyback_available:0,buyback_reserved:0,buyback_spent:0,split_carry:0,last_cycle:0,next_job:0})
 },
 Command::StartPrimary=>{
  require(accounts.len()==3,Error::Account)?;let(admin,g,c)=(&accounts[0],&accounts[1],&accounts[2]);
  let d=deployment(program,g)?;signer(admin,&d.admin)?;require(!d.paused,Error::Paused)?;let mut s=coin(program,c,g)?;
  require(s.kind==PRIMARY&&!s.active,Error::Kind)?;s.active=true;s.anchor=clock()?.unix_timestamp;store(c,&s)?;
  solana_program::msg!("RBD3 primary started {} anchor {}",s.mint,s.anchor);Ok(())
 },
 Command::SetFundingWallet{funding_wallet}=>{
  require(accounts.len()==3,Error::Account)?;let(admin,g,c)=(&accounts[0],&accounts[1],&accounts[2]);
  let d=deployment(program,g)?;signer(admin,&d.admin)?;let mut s=coin(program,c,g)?;require(s.kind==PRIMARY&&funding_wallet!=Pubkey::default(),Error::Kind)?;
  s.funding_wallet=funding_wallet;store(c,&s)
 },
 Command::DepositHolders{amount}=>{
  // Holder-only primary deposit, signed by the registered dev funding wallet. No split.
  require(accounts.len()==4,Error::Account)?;let(wallet,g,c,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut s=coin(program,c,g)?;
  require(s.kind==PRIMARY,Error::Kind)?;signer(wallet,&s.funding_wallet)?;require(*system.key==system_program::id(),Error::Account)?;
  invoke(&system_instruction::transfer(wallet.key,c.key,amount),&[wallet.clone(),c.clone(),system.clone()])?;
  deposit(&mut s,amount)?;backing(&s,c)?;store(c,&s)?;solana_program::msg!("RBD3 holder deposit {} {}",s.mint,amount);Ok(())
 },
 Command::PrepareCoin=>{
  // Third-party coin, in the same transaction as the Pump creation: anchor = launch block time.
  require(accounts.len()==6,Error::Account)?;let(payer,g,c,intake,mint,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;
  require(mint.is_signer&&mint.owner==&system_program::id()&&mint.data_is_empty()&&payer.is_signer,Error::Unauthorized)?;
  let(expected,bump)=coin_address(program,mint.key);require(expected==*c.key&&intake_address(program,mint.key).0==*intake.key,Error::Account)?;
  require(intake.owner==&system_program::id()&&intake.data_is_empty()&&!intake.executable,Error::Account)?;
  create(program,payer,c,system,&[b"coin-v3",mint.key.as_ref(),&[bump]],COIN_LEN)?;
  let(cycle_seconds,cutoff_lead)=if d.test_mode{(TEST_CYCLE,TEST_LEAD)}else{(PRODUCTION_CYCLE,PRODUCTION_LEAD)};
  store(c,&Coin{magic:*b"RBD3COIN",mint:*mint.key,kind:THIRD_PARTY,deployment:*g.key,policy:d.policy,active:false,anchor:clock()?.unix_timestamp,cycle_seconds,cutoff_lead,funding_wallet:Pubkey::default(),launcher:*payer.key,
   receipts:0,deposits:0,holder_unallocated:0,holder_reserved:0,holder_paid:0,buyback_available:0,buyback_reserved:0,buyback_spent:0,split_carry:0,last_cycle:0,next_job:0})
 },
 Command::CreateSharing|Command::LockSharing=>{
  let locking=matches!(command,Command::LockSharing);require(accounts.len()==if locking{23}else{16},Error::Account)?;
  let(g,c,intake)=(&accounts[0],&accounts[1],&accounts[2]);let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut s=coin(program,c,g)?;
  require(s.kind==THIRD_PARTY,Error::Kind)?;
  let(forward,disc)=if locking{(&accounts[3..],vec![111,251,49,6,78,78,106,18])}else{(&accounts[3..],vec![195,78,86,76,111,52,251,213])};
  let(expected,bump)=intake_address(program,&s.mint);require(expected==*intake.key&&intake.owner==&system_program::id()&&intake.data_is_empty(),Error::Routing)?;
  require(*forward[1].key==FEES&&forward[1].executable&&forward[2].key==intake.key&&*forward[4].key==s.mint&&*forward[5].key==pda(&FEES,&[b"sharing-config",s.mint.as_ref()]).0,Error::Routing)?;
  valid_mint(&forward[4])?;let creator=curve_creator(&s.mint,&forward[if locking{6}else{7}])?;
  if locking{require(creator==*forward[5].key&&*forward[14].key==SOL&&*forward[15].key==TOKEN&&*forward[16].key==ATA&&*forward[12].key==AMM&&forward[19].key==intake.key,Error::Routing)?;sharing(&s.mint,intake.key,&forward[5],false)?;}
  else{require(creator==*intake.key||creator==*forward[5].key,Error::Routing)?;}
  let mut bytes=disc;if locking{bytes.extend(1u32.to_le_bytes());bytes.extend(intake.key.as_ref());bytes.extend(10000u16.to_le_bytes());}
  let metas=forward.iter().map(|a|AccountMeta{pubkey:*a.key,is_writable:a.is_writable,is_signer:a.key==intake.key}).collect();
  invoke_signed(&Instruction{program_id:FEES,accounts:metas,data:bytes},forward,&[&[b"intake-v3",s.mint.as_ref(),&[bump]]])?;
  if locking{sharing(&s.mint,intake.key,&forward[5],true)?;s.active=true;store(c,&s)?;}Ok(())
 },
 Command::Activate=>{
  require(accounts.len()==6,Error::Account)?;let(g,c,intake,mint,bc,sc)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut s=coin(program,c,g)?;require(s.kind==THIRD_PARTY,Error::Kind)?;
  require(*mint.key==s.mint&&intake_address(program,&s.mint).0==*intake.key,Error::Routing)?;valid_mint(mint)?;
  require(curve_creator(&s.mint,bc)?==*sc.key,Error::Routing)?;sharing(&s.mint,intake.key,sc,true)?;
  if !s.active{s.active=true;store(c,&s)?;}Ok(())
 },
 Command::Credit{authorization:a}=>{
  require(accounts.len()==7,Error::Account)?;
  let(payer,g,c,intake,receipt,system,instructions)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let d=deployment(program,g)?;let mut s=coin(program,c,g)?;require(!d.paused,Error::Paused)?;require(s.active&&s.kind==THIRD_PARTY,Error::Inactive)?;
  require(a.domain==*b"RBD3RCPT"&&a.program==*program&&a.deployment==*g.key&&a.mint==s.mint&&a.asset==0&&a.amount>0,Error::Data)?;
  fresh(clock()?.slot,a.through,a.issued,a.expires)?;attest(instructions,&d.verifier,&borsh::to_vec(&a).map_err(|_|Error::Data)?)?;
  let event=a.event();let(expected,rbump)=receipt_address(program,c.key,&event);require(expected==*receipt.key,Error::Account)?;require(receipt.owner!=program,Error::Settled)?;
  let(expected,ibump)=intake_address(program,&s.mint);require(expected==*intake.key&&intake.owner==&system_program::id()&&intake.data_is_empty(),Error::Account)?;
  require(intake.lamports()>=add(a.amount,Rent::get()?.minimum_balance(0))?,Error::Funds)?;
  create(program,payer,receipt,system,&[b"receipt-v3",c.key.as_ref(),&event,&[rbump]],RECEIPT_LEN)?;
  invoke_signed(&system_instruction::transfer(intake.key,c.key,a.amount),&[intake.clone(),c.clone(),system.clone()],&[&[b"intake-v3",s.mint.as_ref(),&[ibump]]])?;
  let(holders,buyback)=credit(&mut s,a.amount)?;backing(&s,c)?;
  store(receipt,&Receipt{magic:*b"RBD3RCPT",coin:*c.key,event,amount:a.amount,holders,buyback,source_slot:a.through})?;store(c,&s)?;
  solana_program::msg!("RBD3 receipt {} {} {} {}",receipt.key,a.amount,holders,buyback);Ok(())
 },
 Command::Fund{cycle,root,count,cutoff_slot,snapshot,manifest}=>{
  require(accounts.len()==7,Error::Account)?;
  let(payer,publisher,verifier,g,c,r,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let d=deployment(program,g)?;signer(publisher,&d.publisher)?;signer(verifier,&d.verifier)?;require(!d.paused,Error::Paused)?;
  let mut s=coin(program,c,g)?;require(s.active,Error::Inactive)?;let now=clock()?;
  funding_window(&s,cycle,now.unix_timestamp)?;
  require(cutoff_slot<=now.slot&&root.sum>0&&root.hash!=[0;32]&&count>0&&count<=MAX_RECIPIENTS&&snapshot!=[0;32]&&manifest!=[0;32],Error::Round)?;
  let(expected,bump)=round_address(program,c.key,cycle);require(expected==*r.key,Error::Account)?;
  create(program,payer,r,system,&[b"round-v3",c.key.as_ref(),&cycle.to_le_bytes(),&[bump]],ROUND_LEN+bitmap_len(count))?;
  s.holder_unallocated=sub(s.holder_unallocated,root.sum)?;s.holder_reserved=add(s.holder_reserved,root.sum)?;s.last_cycle=cycle;
  store_round(r,&Round{magic:*b"RBD3ROND",coin:*c.key,cycle,root:root.hash,total:root.sum,remaining:root.sum,count,paid_count:0,cutoff_slot,cutoff_time:cutoff(&s,cycle)?,due_time:due(&s,cycle)?,snapshot,manifest,policy:s.policy,verifier:d.verifier,rent_payer:*payer.key})?;
  conservation(&s)?;backing(&s,c)?;store(c,&s)?;solana_program::msg!("RBD3 funded {} cycle {} total {}",s.mint,cycle,root.sum);Ok(())
 },
 Command::Pay{cycle,index,amount,proof}=>{
  // Permissionless crank. No fresh holding/price check: the frozen snapshot award is payable.
  require(accounts.len()==4,Error::Account)?;
  let(g,c,r,wallet)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3]);
  distinct(&[*g.key,*c.key,*r.key,*wallet.key])?;
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut s=coin(program,c,g)?;let mut rd=round(program,r,c)?;
  require(rd.cycle==cycle,Error::Round)?;require(clock()?.unix_timestamp>=rd.due_time,Error::TooSoon)?;
  verify(program,&s,&rd,index,wallet.key,amount,&proof)?;
  require(!wallet.executable&&wallet.owner==&system_program::id(),Error::Account)?;
  require(!paid_flag(r,index)?,Error::Settled)?;
  settle(&mut s,&mut rd,amount)?;pay(c,wallet,amount)?;backing(&s,c)?;
  set_paid_flag(r,index)?;store_round(r,&rd)?;store(c,&s)?;
  solana_program::msg!("RBD3 paid {} {} {}",r.key,index,amount);Ok(())
 },
 Command::CloseRound{cycle}=>{
  require(accounts.len()==4,Error::Account)?;
  let(g,c,r,rent_to)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3]);
  distinct(&[*g.key,*c.key,*r.key,*rent_to.key])?;
  deployment(program,g)?;coin(program,c,g)?;let rd=round(program,r,c)?;
  require(rd.cycle==cycle&&rd.paid_count==rd.count&&rd.remaining==0,Error::Round)?;
  require(*rent_to.key==rd.rent_payer,Error::Account)?;wr(r)?;wr(rent_to)?;
  let rent=r.lamports();let to=add(rent_to.lamports(),rent)?;**r.try_borrow_mut_lamports()?=0;**rent_to.try_borrow_mut_lamports()?=to;
  r.try_borrow_mut_data()?.fill(0);
  solana_program::msg!("RBD3 round closed {} cycle {} rent {}",c.key,cycle,rent);Ok(())
 },
 Command::Pause|Command::RequestResume|Command::Resume=>{
  require(accounts.len()==2,Error::Account)?;let(authority,g)=(&accounts[0],&accounts[1]);let mut d=deployment(program,g)?;let now=clock()?.unix_timestamp;
  match command{
   Command::Pause=>{require(authority.is_signer&&(*authority.key==d.admin||*authority.key==d.guardian),Error::Unauthorized)?;d.paused=true;d.resume_at=0;}
   Command::RequestResume=>{signer(authority,&d.admin)?;require(d.paused,Error::Data)?;d.resume_at=now.checked_add(RESUME_DELAY).ok_or(Error::Arithmetic)?;}
   _=>{signer(authority,&d.admin)?;require(d.paused&&d.resume_at>0&&now>=d.resume_at,Error::TooSoon)?;d.paused=false;d.resume_at=0;}
  }store(g,&d)
 },
 Command::SetAuthorities{publisher,verifier,guardian}=>{
  // Rotation requires the retained governance (admin) and the system to be paused.
  require(accounts.len()==2,Error::Account)?;let(admin,g)=(&accounts[0],&accounts[1]);let mut d=deployment(program,g)?;signer(admin,&d.admin)?;
  require(d.paused,Error::Paused)?;distinct(&[d.admin,publisher,verifier,guardian])?;require([publisher,verifier,guardian].iter().all(|k|*k!=Pubkey::default()),Error::Data)?;
  d.publisher=publisher;d.verifier=verifier;d.guardian=guardian;store(g,&d)
 },
 Command::SetBuybackTarget{target_mint}=>{
  // Prospective: already reserved jobs keep their stored target and config version.
  require(accounts.len()==3,Error::Account)?;let(admin,g,mint)=(&accounts[0],&accounts[1],&accounts[2]);let mut d=deployment(program,g)?;signer(admin,&d.admin)?;
  require(*mint.key==target_mint,Error::Account)?;valid_mint(mint)?;
  d.target_mint=target_mint;d.target_token_program=*mint.owner;d.config_version=add(d.config_version,1)?;store(g,&d)
 },
 Command::ReserveBuyback{..}|Command::BuybackSwap{..}|Command::BuybackBurn|Command::CloseBuyback=>buyback::process(program,accounts,command),
 }
}

pub mod buyback;

#[cfg(test)]
mod tests{
 use super::*;
 fn coin(kind:u8)->Coin{Coin{magic:*b"RBD3COIN",mint:Pubkey::new_unique(),kind,deployment:Pubkey::new_unique(),policy:[3;32],active:true,anchor:1_000_000,cycle_seconds:1800,cutoff_lead:60,funding_wallet:Pubkey::new_unique(),launcher:Pubkey::new_unique(),receipts:0,deposits:0,holder_unallocated:0,holder_reserved:0,holder_paid:0,buyback_available:0,buyback_reserved:0,buyback_spent:0,split_carry:0,last_cycle:0,next_job:0}}
 #[test]fn paid_bitmap_is_tiny(){assert_eq!(bitmap_len(1),1);assert_eq!(bitmap_len(8),1);assert_eq!(bitmap_len(9),2);assert!(ROUND_LEN+bitmap_len(MAX_RECIPIENTS)<=10_240,"round must fit a CPI-created account");}
 #[test]fn third_party_split_once_with_carry(){
  let mut c=coin(THIRD_PARTY);assert_eq!(credit(&mut c,1_000_000_000).unwrap(),(850_000_000,150_000_000));
  let mut t=coin(THIRD_PARTY);for _ in 0..100{credit(&mut t,1).unwrap();}assert_eq!((t.holder_unallocated,t.buyback_available,t.split_carry),(85,15,0));
  assert!(credit(&mut coin(PRIMARY),1).is_err());
 }
 #[test]fn primary_deposit_is_holder_only(){
  let mut c=coin(PRIMARY);deposit(&mut c,850_000_000).unwrap();assert_eq!((c.holder_unallocated,c.buyback_available,c.deposits,c.receipts),(850_000_000,0,850_000_000,0));
  assert!(deposit(&mut coin(THIRD_PARTY),1).is_err());
 }
 #[test]fn schedule_and_funding_window(){
  let c=coin(PRIMARY);assert_eq!(cutoff(&c,1).unwrap(),1_000_000+1800-60);assert_eq!(due(&c,1).unwrap(),1_001_800);
  assert!(funding_window(&c,1,1_001_739).is_err());assert!(funding_window(&c,1,1_001_740).is_ok());assert!(funding_window(&c,1,1_003_539).is_ok());assert!(funding_window(&c,1,1_003_540).is_err());
  let mut done=c.clone();done.last_cycle=1;assert!(funding_window(&done,1,1_001_740).is_err());assert!(funding_window(&c,0,1_001_740).is_err());
 }
 #[test]fn settlement_conserves_and_cannot_overpay(){
  let mut c=coin(PRIMARY);deposit(&mut c,100).unwrap();c.holder_unallocated-=60;c.holder_reserved=60;
  let mut r=Round{magic:*b"RBD3ROND",coin:Pubkey::new_unique(),cycle:1,root:[1;32],total:60,remaining:60,count:2,paid_count:0,cutoff_slot:1,cutoff_time:1,due_time:2,snapshot:[1;32],manifest:[1;32],policy:c.policy,verifier:Pubkey::new_unique(),rent_payer:Pubkey::new_unique()};
  settle(&mut c,&mut r,40).unwrap();settle(&mut c,&mut r,20).unwrap();assert_eq!((c.holder_reserved,c.holder_paid,r.remaining,r.paid_count),(0,60,0,2));
  assert!(settle(&mut c,&mut r,1).is_err());
 }
 #[test]fn leaves_bind_mint_cycle_index_wallet_amount(){
  let c=coin(PRIMARY);let p=Pubkey::new_unique();let w=Pubkey::new_unique();let base=leaf(&p,&c,1,0,&w,10);
  let mut other=c.clone();other.mint=Pubkey::new_unique();
  for x in [leaf(&p,&other,1,0,&w,10),leaf(&p,&c,2,0,&w,10),leaf(&p,&c,1,1,&w,10),leaf(&p,&c,1,0,&Pubkey::new_unique(),10),leaf(&p,&c,1,0,&w,11)]{assert_ne!(x,base);}
 }
 #[test]fn state_sizes_fit(){
  assert!(borsh::to_vec(&coin(PRIMARY)).unwrap().len()<=COIN_LEN);
  let d=Deployment{magic:[0;8],admin:Pubkey::default(),publisher:Pubkey::default(),verifier:Pubkey::default(),guardian:Pubkey::default(),policy:[0;32],test_mode:false,paused:false,resume_at:0,target_mint:Pubkey::default(),target_token_program:Pubkey::default(),config_version:0};assert!(borsh::to_vec(&d).unwrap().len()<=GLOBAL_LEN);
  let r=Round{magic:[0;8],coin:Pubkey::default(),cycle:0,root:[0;32],total:0,remaining:0,count:0,paid_count:0,cutoff_slot:0,cutoff_time:0,due_time:0,snapshot:[0;32],manifest:[0;32],policy:[0;32],verifier:Pubkey::default(),rent_payer:Pubkey::default()};assert!(borsh::to_vec(&r).unwrap().len()<=ROUND_LEN);
  let j=Job{magic:[0;8],coin:Pubkey::default(),id:0,cycle:0,target_mint:Pubkey::default(),target_token_program:Pubkey::default(),config_version:0,budget:0,state:0,spent:0,acquired:0,burned:0,max_slippage_bps:0,max_impact_bps:0,purchase_slot:0,burn_slot:0};assert!(borsh::to_vec(&j).unwrap().len()<=JOB_LEN);
 }
}
