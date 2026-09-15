//! Conditional SOL rewards. Offchain facts require an independent verifier.
//! No receipt is inferred from total balances; no historical proof alone pays.
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
pub const CYCLE:i64=1800;
pub const MAX_INDEX_LAG:u64=96;
pub const AUTH_LIFETIME:u64=20;
pub const RESUME_DELAY:i64=86400;
pub const GLOBAL_LEN:usize=256;
pub const COIN_LEN:usize=320;
pub const ROUND_LEN:usize=256;
pub const POSITION_LEN:usize=160;
pub const ALLOCATION_LEN:usize=160;
pub const RECEIPT_LEN:usize=128;
pub const MAX_PROOF:usize=16;
pub const PUMP:Pubkey=solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const FEES:Pubkey=solana_program::pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const AMM:Pubkey=solana_program::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const SOL:Pubkey=solana_program::pubkey!("So11111111111111111111111111111111111111112");
pub const TOKEN:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN22:Pubkey=solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA:Pubkey=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ED25519:Pubkey=solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const LOADER:Pubkey=solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
#[repr(u32)]
#[derive(Debug,Clone,Copy,PartialEq)]
pub enum Error { Unauthorized=200,Account,Data,Arithmetic,Funds,Paused,Round,Proof,Settled,Stale,Version,Disqualified,Holding,Routing,Registration,TooSoon }
impl From<Error> for ProgramError { fn from(e:Error)->Self { Self::Custom(e as u32) } }
fn require(ok:bool,e:Error)->ProgramResult { if ok {Ok(())} else {Err(e.into())} }
fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(Error::Arithmetic.into())}
fn sub(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_sub(b).ok_or(Error::Funds.into())}
fn signer(a:&AccountInfo,k:&Pubkey)->ProgramResult{require(a.is_signer && a.key==k,Error::Unauthorized)}
fn wr(a:&AccountInfo)->ProgramResult{require(a.is_writable,Error::Account)}
fn key(data:&[u8],at:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(data.get(at..at+32).ok_or(Error::Data)?.try_into().map_err(|_|Error::Data)?))}
fn distinct(keys:&[Pubkey])->ProgramResult{for(i,k)in keys.iter().enumerate(){require(!keys[..i].contains(k),Error::Account)?;}Ok(())}
fn pda(program:&Pubkey,seeds:&[&[u8]])->(Pubkey,u8){Pubkey::find_program_address(seeds,program)}
pub fn global_address(program:&Pubkey)->(Pubkey,u8){pda(program,&[b"deployment-v2"])}
pub fn coin_address(program:&Pubkey,mint:&Pubkey)->(Pubkey,u8){pda(program,&[b"coin-v2",mint.as_ref()])}
pub fn intake_address(program:&Pubkey,mint:&Pubkey)->(Pubkey,u8){pda(program,&[b"intake-v2",mint.as_ref()])}
pub fn round_address(program:&Pubkey,coin:&Pubkey,id:u64)->(Pubkey,u8){pda(program,&[b"round-v2",coin.as_ref(),&id.to_le_bytes()])}
pub fn position_address(program:&Pubkey,coin:&Pubkey,wallet:&Pubkey)->(Pubkey,u8){pda(program,&[b"position-v2",coin.as_ref(),wallet.as_ref()])}
pub fn allocation_address(program:&Pubkey,round:&Pubkey,index:u32)->(Pubkey,u8){pda(program,&[b"award-v2",round.as_ref(),&index.to_le_bytes()])}
pub fn receipt_address(program:&Pubkey,coin:&Pubkey,event:&[u8;32])->(Pubkey,u8){pda(program,&[b"receipt-v2",coin.as_ref(),event])}

#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Deployment {pub magic:[u8;8],pub admin:Pubkey,pub publisher:Pubkey,pub verifier:Pubkey,pub guardian:Pubkey,pub operations:Pubkey,pub policy:[u8;32],pub paused:bool,pub resume_at:i64}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Coin {
 pub magic:[u8;8],pub mint:Pubkey,pub launcher:Pubkey,pub deployment:Pubkey,pub operations:Pubkey,pub policy:[u8;32],
 pub active:bool,pub receipts:u64,pub unallocated:u64,pub reserved:u64,pub paid:u64,pub operations_payable:u64,pub operations_paid:u64,
 pub split_remainder:u8,pub last_round:u64,pub last_operations_cycle:u64,pub activation_slot:u64,pub funding_epoch:u64,pub pending_registrations:u64,
}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Round {pub magic:[u8;8],pub coin:Pubkey,pub id:u64,pub root:[u8;32],pub total:u64,pub remaining:u64,pub registered:u64,pub cutoff_slot:u64,pub cutoff_time:i64,pub manifest:[u8;32],pub verifier:Pubkey,pub policy:[u8;32]}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Position {pub magic:[u8;8],pub coin:Pubkey,pub wallet:Pubkey,pub version:u64,pub paid:u64,pub active:u64,pub disqualified:bool,pub first_exit:[u8;32]}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Allocation {pub magic:[u8;8],pub round:Pubkey,pub wallet:Pubkey,pub index:u32,pub maximum:u64,pub paid:u64,pub released:u64,pub settled:bool}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct Receipt {pub magic:[u8;8],pub coin:Pubkey,pub event:[u8;32],pub amount:u64,pub source_slot:u64}
fn load<T:BorshDeserialize>(program:&Pubkey,a:&AccountInfo,len:usize,magic:&[u8;8])->Result<T,ProgramError>{
 require(a.owner==program && !a.executable && a.data_len()==len,Error::Account)?;
 let data=a.try_borrow_data()?;require(data.get(..8)==Some(magic),Error::Data)?;
 let mut remaining=&data[..];let result=T::deserialize(&mut remaining).map_err(|_|Error::Data)?;
 require(remaining.iter().all(|v|*v==0),Error::Data)?;Ok(result)
}
fn store<T:BorshSerialize>(a:&AccountInfo,value:&T)->ProgramResult{
 wr(a)?;let bytes=borsh::to_vec(value).map_err(|_|Error::Data)?;require(bytes.len()<=a.data_len(),Error::Account)?;
 let mut data=a.try_borrow_mut_data()?;data.fill(0);data[..bytes.len()].copy_from_slice(&bytes);Ok(())
}
fn deployment(program:&Pubkey,a:&AccountInfo)->Result<Deployment,ProgramError>{
 require(global_address(program).0==*a.key,Error::Account)?;load(program,a,GLOBAL_LEN,b"RBD2DEP0")
}
fn coin(program:&Pubkey,a:&AccountInfo,g:&AccountInfo)->Result<Coin,ProgramError>{
 let c:Coin=load(program,a,COIN_LEN,b"RBD2COIN")?;
 require(c.deployment==*g.key && coin_address(program,&c.mint).0==*a.key,Error::Account)?;
 conservation(&c)?;backing(&c,a)?;Ok(c)
}
fn round(program:&Pubkey,a:&AccountInfo,c:&AccountInfo)->Result<Round,ProgramError>{
 let r:Round=load(program,a,ROUND_LEN,b"RBD2ROND")?;
 require(r.coin==*c.key&&round_address(program,c.key,r.id).0==*a.key&&r.remaining<=r.total&&r.registered<=r.total,Error::Account)?;Ok(r)
}
fn position(program:&Pubkey,a:&AccountInfo,c:&AccountInfo,wallet:&Pubkey)->Result<Position,ProgramError>{
 let p:Position=load(program,a,POSITION_LEN,b"RBD2POS0")?;
 require(p.coin==*c.key && p.wallet==*wallet && position_address(program,c.key,wallet).0==*a.key,Error::Account)?;Ok(p)
}
pub fn conservation(c:&Coin)->ProgramResult{
 let liability=add(add(c.unallocated,c.reserved)?,c.operations_payable)?;
 require(c.receipts==add(liability,add(c.paid,c.operations_paid)?)? && c.split_remainder<100,Error::Arithmetic)
}
fn backing(c:&Coin,vault:&AccountInfo)->ProgramResult{
 require(vault.lamports()>=add(Rent::get()?.minimum_balance(COIN_LEN),add(add(c.unallocated,c.reserved)?,c.operations_payable)?)?,Error::Funds)
}
fn pay(from:&AccountInfo,to:&AccountInfo,n:u64)->ProgramResult{
 wr(from)?;wr(to)?;require(from.key!=to.key && !to.executable,Error::Account)?;
 let a=sub(from.lamports(),n)?;let b=add(to.lamports(),n)?;
 **from.try_borrow_mut_lamports()?=a;**to.try_borrow_mut_lamports()?=b;Ok(())
}
fn create<'a>(program:&Pubkey,payer:&AccountInfo<'a>,target:&AccountInfo<'a>,system:&AccountInfo<'a>,seeds:&[&[u8]],len:usize)->ProgramResult{
 require(payer.is_signer && payer.owner==&system_program::id() && payer.data_is_empty(),Error::Unauthorized)?;
 wr(payer)?;wr(target)?;require(*system.key==system_program::id()&&system.executable,Error::Account)?;
 distinct(&[*payer.key,*target.key,*system.key])?;
 require(target.owner==&system_program::id()&&target.data_is_empty()&&!target.executable,Error::Account)?;
 let rent=Rent::get()?.minimum_balance(len).saturating_sub(target.lamports());
 if rent>0{invoke(&system_instruction::transfer(payer.key,target.key,rent),&[payer.clone(),target.clone(),system.clone()])?;}
 invoke_signed(&system_instruction::allocate(target.key,len as u64),&[target.clone(),system.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(target.key,program),&[target.clone(),system.clone()],&[seeds])
}
pub fn credit(c:&mut Coin,n:u64)->ProgramResult{
 require(n>0,Error::Data)?;
 let numerator=(n as u128)*85+(c.split_remainder as u128);
 let holders=u64::try_from(numerator/100).map_err(|_|Error::Arithmetic)?;
 c.split_remainder=(numerator%100)as u8;
 c.receipts=add(c.receipts,n)?;c.unallocated=add(c.unallocated,holders)?;c.operations_payable=add(c.operations_payable,sub(n,holders)?)?;
 conservation(c)
}
fn clock()->Result<Clock,ProgramError>{let c=Clock::get()?;require(c.unix_timestamp>=0,Error::Data)?;Ok(c)}
pub fn fresh(now:u64,through:u64,issued:u64,expires:u64)->ProgramResult{
 require(through<=issued && issued<=now && issued-through<=MAX_INDEX_LAG && expires>=issued && expires-issued<=AUTH_LIFETIME && now<=expires && now-issued<=AUTH_LIFETIME,Error::Stale)
}
fn attest(sys:&AccountInfo,expected:&Pubkey,message:&[u8])->ProgramResult{
 require(*sys.key==sysvar::instructions::id(),Error::Account)?;
 let current=sysvar::instructions::load_current_index_checked(sys)?;require(current>0,Error::Unauthorized)?;
 let ix=sysvar::instructions::load_instruction_at_checked((current-1)as usize,sys)?;
 require(ix.program_id==ED25519 && ix.accounts.is_empty() && ix.data.len()>=16 && ix.data[0]==1 && ix.data[1]==0,Error::Unauthorized)?;
 let u=|at:usize|->Result<usize,ProgramError>{Ok(u16::from_le_bytes(ix.data.get(at..at+2).ok_or(Error::Data)?.try_into().map_err(|_|Error::Data)?)as usize)};
 require(u(4)?==65535&&u(8)?==65535&&u(14)?==65535,Error::Unauthorized)?;
 let sig=u(2)?;let pk=u(6)?;let msg=u(10)?;let len=u(12)?;
 require(ix.data.get(sig..sig+64).is_some()&&ix.data.get(pk..pk+32)==Some(expected.as_ref())&&len==message.len()&&ix.data.get(msg..msg+len)==Some(message),Error::Unauthorized)
}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct ReceiptAuth {pub domain:[u8;8],pub program:Pubkey,pub deployment:Pubkey,pub mint:Pubkey,pub asset:u8,pub signature:[u8;64],pub instruction_path:[u8;32],pub amount:u64,pub through:u64,pub issued:u64,pub expires:u64}
impl ReceiptAuth{pub fn event(&self)->[u8;32]{hashv(&[b"REBOUND:receipt:v2",&self.signature,&self.instruction_path,self.mint.as_ref()]).to_bytes()}}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone)]
pub struct PaymentAuth {
 pub domain:[u8;8],pub program:Pubkey,pub deployment:Pubkey,pub mint:Pubkey,pub asset:u8,pub round:u64,pub index:u32,pub wallet:Pubkey,pub maximum:u64,
 pub payable:u64,pub cost:u64,pub value:u64,pub holding:u64,pub through:u64,pub issued:u64,pub expires:u64,pub version:u64,pub epoch:u64,pub outcome:u8,pub evidence:[u8;32],
}
#[derive(BorshSerialize,BorshDeserialize,Debug,Clone,Copy,PartialEq)]
pub struct Node{pub hash:[u8;32],pub sum:u64}
pub fn leaf(program:&Pubkey,c:&Coin,rid:u64,index:u32,wallet:&Pubkey,n:u64)->Node{
 Node{hash:hashv(&[b"REBOUND:leaf:v2",program.as_ref(),c.deployment.as_ref(),c.mint.as_ref(),&[0],&c.policy,&rid.to_le_bytes(),&index.to_le_bytes(),wallet.as_ref(),&n.to_le_bytes()]).to_bytes(),sum:n}
}
pub fn parent(a:Node,b:Node)->Result<Node,ProgramError>{
 let(l,r)=if(a.hash,a.sum)<=(b.hash,b.sum){(a,b)}else{(b,a)};
 Ok(Node{hash:hashv(&[b"REBOUND:node:v2",&l.hash,&l.sum.to_le_bytes(),&r.hash,&r.sum.to_le_bytes()]).to_bytes(),sum:add(l.sum,r.sum)?})
}
fn proof(program:&Pubkey,c:&Coin,r:&Round,index:u32,wallet:&Pubkey,n:u64,nodes:&[Node])->ProgramResult{
 require(n>0&&nodes.len()<=MAX_PROOF,Error::Proof)?;let mut at=leaf(program,c,r.id,index,wallet,n);
 for sibling in nodes{at=parent(at,*sibling)?;}require(at.hash==r.root&&at.sum==r.total,Error::Proof)
}
pub fn cap(p:&Position,a:&Allocation,cost:u64,value:u64)->Result<u64,ProgramError>{
 let others=sub(p.active,a.maximum)?;let compensated=add(p.paid,others)?;
 Ok(a.maximum.min(cost.saturating_sub(add(value,compensated)?)))
}
pub fn settle_state(c:&mut Coin,r:&mut Round,p:&mut Position,a:&mut Allocation,n:u64,exit:Option<[u8;32]>)->ProgramResult{
 require(!a.settled,Error::Settled)?;require(n<=a.maximum,Error::Funds)?;
 if let Some(evidence)=exit{require(n==0&&evidence!=[0;32],Error::Data)?;if !p.disqualified{p.first_exit=evidence;p.disqualified=true;}}
 else{require(!p.disqualified,Error::Disqualified)?;}
 let released=sub(a.maximum,n)?;
 c.reserved=sub(c.reserved,a.maximum)?;c.unallocated=add(c.unallocated,released)?;c.paid=add(c.paid,n)?;
 r.remaining=sub(r.remaining,a.maximum)?;p.active=sub(p.active,a.maximum)?;p.paid=add(p.paid,n)?;p.version=add(p.version,1)?;
 a.settled=true;a.paid=n;a.released=released;conservation(c)
}
fn holdings(accounts:&[AccountInfo],mint:&Pubkey,wallet:&Pubkey)->Result<u64,ProgramError>{
 require(!accounts.is_empty()&&accounts.len()<=12,Error::Holding)?;let mut total=0;let mut seen=Vec::new();
 for a in accounts{
  require(!seen.contains(a.key),Error::Account)?;seen.push(*a.key);
  require(!a.executable&&(a.owner==&TOKEN||a.owner==&TOKEN22),Error::Holding)?;
  let data=a.try_borrow_data()?;require(data.len()>=165&&key(&data,0)?==*mint&&key(&data,32)?==*wallet&&data[108]!=0,Error::Holding)?;
  if a.owner==&TOKEN22 && data.len()>165{require(data.get(165)==Some(&2),Error::Holding)?;}
  total=add(total,u64::from_le_bytes(data[64..72].try_into().map_err(|_|Error::Data)?))?;
 }Ok(total)
}
fn valid_mint(a:&AccountInfo)->ProgramResult{
 require(!a.executable&&(a.owner==&TOKEN||a.owner==&TOKEN22),Error::Account)?;
 let data=a.try_borrow_data()?;require(data.len()>=82&&data[44]==6&&data[45]==1,Error::Data)?;
 if a.owner==&TOKEN {require(data.len()==82,Error::Data)?;}else if data.len()>82{require(data.get(165)==Some(&1),Error::Data)?;}Ok(())
}
fn curve(mint:&Pubkey,a:&AccountInfo)->Result<Pubkey,ProgramError>{
 require(a.owner==&PUMP && pda(&PUMP,&[b"bonding-curve",mint.as_ref()]).0==*a.key&&!a.executable,Error::Routing)?;
 let data=a.try_borrow_data()?;
 require(data.len()>=125 && data[..8]==hashv(&[b"account:BondingCurve"]).to_bytes()[..8]&&data[81]==0&&data[82]==0&&data[124]==0,Error::Routing)?;
 require(key(&data,83)?==Pubkey::default(),Error::Routing)?;key(&data,49)
}
fn sharing(mint:&Pubkey,intake:&Pubkey,a:&AccountInfo,locked:bool)->ProgramResult{
 require(a.owner==&FEES&&pda(&FEES,&[b"sharing-config",mint.as_ref()]).0==*a.key&&!a.executable,Error::Routing)?;
 let data=a.try_borrow_data()?;
 require(data.len()>=114&&data[..8]==[216,74,9,0,56,140,93,75]&&data[9]==2&&data[10]==1&&key(&data,11)?==*mint,Error::Routing)?;
 require(u32::from_le_bytes(data[76..80].try_into().map_err(|_|Error::Data)?)==1&&key(&data,80)?==*intake&&u16::from_le_bytes(data[112..114].try_into().map_err(|_|Error::Data)?)==10000,Error::Routing)?;
 require(if locked{data[75]==1}else{data[75]==0&&key(&data,43)?==*intake},Error::Routing)
}
fn position_init<'a>(program:&Pubkey,payer:&AccountInfo<'a>,a:&AccountInfo<'a>,c:&AccountInfo<'a>,wallet:&Pubkey,system:&AccountInfo<'a>)->Result<Position,ProgramError>{
 let(expected,bump)=position_address(program,c.key,wallet);require(expected==*a.key,Error::Account)?;
 if a.owner==program{return position(program,a,c,wallet);}
 create(program,payer,a,system,&[b"position-v2",c.key.as_ref(),wallet.as_ref(),&[bump]],POSITION_LEN)?;
 Ok(Position{magic:*b"RBD2POS0",coin:*c.key,wallet:*wallet,version:0,paid:0,active:0,disqualified:false,first_exit:[0;32]})
}
#[derive(BorshSerialize,BorshDeserialize,Debug)]
pub enum Command{
 Initialize{publisher:Pubkey,verifier:Pubkey,guardian:Pubkey,operations:Pubkey,policy:[u8;32]},
 PrepareCoin,
 CreateSharing,
 LockSharing,
 Activate,
 Credit{authorization:ReceiptAuth},
 Fund{id:u64,root:Node,cutoff_slot:u64,cutoff_time:i64,manifest:[u8;32]},
 Register{index:u32,amount:u64,proof:Vec<Node>},
 Settle{authorization:PaymentAuth},
 PayOperations,
 RecordExit{authorization:PaymentAuth},
 Pause,
 RequestResume,
 Resume,
 RegisterExisting{launcher:Pubkey},
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let command=Command::try_from_slice(data).map_err(|_|Error::Data)?;
 match command{
 Command::Initialize{publisher,verifier,guardian,operations,policy}=>{
  require(accounts.len()==5,Error::Account)?;
  let(admin,g,self_program,program_data,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4]);
  require(admin.is_signer && self_program.key==program && self_program.executable && self_program.owner==&LOADER&&program_data.owner==&LOADER,Error::Unauthorized)?;
  let pd=self_program.try_borrow_data()?;require(pd.len()==36&&pd[..4]==2u32.to_le_bytes()&&key(&pd,4)?==*program_data.key,Error::Account)?;drop(pd);
  require(pda(&LOADER,&[program.as_ref()]).0==*program_data.key,Error::Account)?;
  let authority_data=program_data.try_borrow_data()?;
  require(authority_data.len()>=45&&authority_data[..4]==3u32.to_le_bytes()&&authority_data[12]==1&&key(&authority_data,13)?==*admin.key,Error::Unauthorized)?;drop(authority_data);
  distinct(&[*admin.key,publisher,verifier,guardian,operations])?;
  require([publisher,verifier,guardian,operations].iter().all(|k|*k!=Pubkey::default())&&policy!=[0;32],Error::Data)?;
  let(expected,bump)=global_address(program);require(expected==*g.key,Error::Account)?;
  create(program,admin,g,system,&[b"deployment-v2",&[bump]],GLOBAL_LEN)?;
  store(g,&Deployment{magic:*b"RBD2DEP0",admin:*admin.key,publisher,verifier,guardian,operations,policy,paused:false,resume_at:0})
 },
 Command::PrepareCoin | Command::RegisterExisting{..}=>{
  let existing=matches!(command,Command::RegisterExisting{..});
  require(accounts.len()==if existing{8}else{6},Error::Account)?;
  let(payer,g,c,intake,mint,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;
  let launcher=if let Command::RegisterExisting{launcher}=command{
   signer(&accounts[6],&d.publisher)?;signer(&accounts[7],&d.verifier)?;valid_mint(mint)?;launcher
  }else{require(mint.is_signer&&mint.owner==&system_program::id()&&mint.data_is_empty()&&payer.is_signer,Error::Unauthorized)?;*payer.key};
  let(expected,bump)=coin_address(program,mint.key);require(expected==*c.key&&intake_address(program,mint.key).0==*intake.key,Error::Account)?;
  require(intake.owner==&system_program::id()&&intake.data_is_empty()&&!intake.executable,Error::Account)?;
  create(program,payer,c,system,&[b"coin-v2",mint.key.as_ref(),&[bump]],COIN_LEN)?;
  store(c,&Coin{magic:*b"RBD2COIN",mint:*mint.key,launcher,deployment:*g.key,operations:d.operations,policy:d.policy,active:false,receipts:0,unallocated:0,reserved:0,paid:0,operations_payable:0,operations_paid:0,split_remainder:0,last_round:0,last_operations_cycle:0,activation_slot:0,funding_epoch:0,pending_registrations:0})
 },
 Command::CreateSharing | Command::LockSharing=>{
  let locking=matches!(command,Command::LockSharing);require(accounts.len()==if locking{23}else{16},Error::Account)?;
  let(g,c,intake)=(&accounts[0],&accounts[1],&accounts[2]);let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut state=coin(program,c,g)?;
  let(forward,disc)=if locking{(&accounts[3..],vec![111,251,49,6,78,78,106,18])}else{(&accounts[3..],vec![195,78,86,76,111,52,251,213])};
  let(expected,bump)=intake_address(program,&state.mint);require(expected==*intake.key&&intake.owner==&system_program::id()&&intake.data_is_empty(),Error::Routing)?;
  require(*forward[1].key==FEES&&forward[1].executable&&forward[2].key==intake.key&&*forward[4].key==state.mint&&*forward[5].key==pda(&FEES,&[b"sharing-config",state.mint.as_ref()]).0,Error::Routing)?;
  valid_mint(&forward[4])?;
  let creator=curve(&state.mint,&forward[if locking{6}else{7}])?;
  if locking{
   require(creator==*forward[5].key && *forward[14].key==SOL&&*forward[15].key==TOKEN&&*forward[16].key==ATA&&*forward[12].key==AMM&&forward[19].key==intake.key,Error::Routing)?;
   sharing(&state.mint,intake.key,&forward[5],false)?;
  }else{require(creator==*intake.key||creator==*forward[5].key,Error::Routing)?;}
  let mut bytes=disc;if locking{bytes.extend(1u32.to_le_bytes());bytes.extend(intake.key.as_ref());bytes.extend(10000u16.to_le_bytes());}
  let metas=forward.iter().map(|a|AccountMeta{pubkey:*a.key,is_writable:a.is_writable,is_signer:a.key==intake.key}).collect();
  invoke_signed(&Instruction{program_id:FEES,accounts:metas,data:bytes},forward,&[&[b"intake-v2",state.mint.as_ref(),&[bump]]])?;
  if locking{sharing(&state.mint,intake.key,&forward[5],true)?;state.active=true;state.activation_slot=clock()?.slot;store(c,&state)?;}
  Ok(())
 },
 Command::Activate=>{
  require(accounts.len()==6,Error::Account)?;
  let(g,c,intake,mint,bc,sc)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut state=coin(program,c,g)?;
  require(*mint.key==state.mint&&intake_address(program,&state.mint).0==*intake.key,Error::Routing)?;
  valid_mint(mint)?;require(curve(&state.mint,bc)?==*sc.key,Error::Routing)?;sharing(&state.mint,intake.key,sc,true)?;
  if !state.active{state.active=true;state.activation_slot=clock()?.slot;store(c,&state)?;}Ok(())
 },
 Command::Credit{authorization:a}=>{
  require(accounts.len()==7,Error::Account)?;
  let(payer,g,c,intake,receipt,system,instructions)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let d=deployment(program,g)?;let mut state=coin(program,c,g)?;require(!d.paused&&state.active,Error::Paused)?;
  require(a.domain==*b"RBD2RCPT"&&a.program==*program&&a.deployment==*g.key&&a.mint==state.mint&&a.asset==0&&a.amount>0,Error::Data)?;
  fresh(clock()?.slot,a.through,a.issued,a.expires)?;attest(instructions,&d.verifier,&borsh::to_vec(&a).map_err(|_|Error::Data)?)?;
  let event=a.event();let(expected,rbump)=receipt_address(program,c.key,&event);require(expected==*receipt.key,Error::Account)?;
  require(receipt.owner!=program,Error::Settled)?;
  let(expected,ibump)=intake_address(program,&state.mint);require(expected==*intake.key&&intake.owner==&system_program::id()&&intake.data_is_empty(),Error::Account)?;
  require(intake.lamports()>=add(a.amount,Rent::get()?.minimum_balance(0))?,Error::Funds)?;
  create(program,payer,receipt,system,&[b"receipt-v2",c.key.as_ref(),&event,&[rbump]],RECEIPT_LEN)?;
  invoke_signed(&system_instruction::transfer(intake.key,c.key,a.amount),&[intake.clone(),c.clone(),system.clone()],&[&[b"intake-v2",state.mint.as_ref(),&[ibump]]])?;
  credit(&mut state,a.amount)?;backing(&state,c)?;
  store(receipt,&Receipt{magic:*b"RBD2RCPT",coin:*c.key,event,amount:a.amount,source_slot:a.through})?;store(c,&state)?;
  solana_program::msg!("RBD2 receipt {} {}",receipt.key,a.amount);Ok(())
 },
 Command::Fund{id,root,cutoff_slot,cutoff_time,manifest}=>{
  require(accounts.len()==7,Error::Account)?;
  let(payer,publisher,verifier,g,c,r,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let d=deployment(program,g)?;signer(publisher,&d.publisher)?;signer(verifier,&d.verifier)?;let mut state=coin(program,c,g)?;let now=clock()?;
  require(!d.paused&&state.active,Error::Paused)?;
  require(id>state.last_round&&id==(now.unix_timestamp/CYCLE)as u64&&cutoff_slot<=now.slot&&now.slot-cutoff_slot<=MAX_INDEX_LAG&&cutoff_time<=now.unix_timestamp&&now.unix_timestamp-cutoff_time<=60,Error::Stale)?;
  require(root.sum>0&&root.hash!=[0;32]&&manifest!=[0;32],Error::Round)?;
  let(expected,bump)=round_address(program,c.key,id);require(expected==*r.key,Error::Account)?;
  create(program,payer,r,system,&[b"round-v2",c.key.as_ref(),&id.to_le_bytes(),&[bump]],ROUND_LEN)?;
  state.unallocated=sub(state.unallocated,root.sum)?;state.reserved=add(state.reserved,root.sum)?;state.last_round=id;state.funding_epoch=add(state.funding_epoch,1)?;state.pending_registrations=add(state.pending_registrations,1)?;
  store(r,&Round{magic:*b"RBD2ROND",coin:*c.key,id,root:root.hash,total:root.sum,remaining:root.sum,registered:0,cutoff_slot,cutoff_time,manifest,verifier:d.verifier,policy:state.policy})?;
  conservation(&state)?;backing(&state,c)?;store(c,&state)
 },
 Command::Register{index,amount,proof:nodes}=>{
  require(accounts.len()==8,Error::Account)?;
  let(payer,g,c,r,p,a,wallet,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6],&accounts[7]);
  let _=deployment(program,g)?;let mut state=coin(program,c,g)?;let mut round=round(program,r,c)?;
  proof(program,&state,&round,index,wallet.key,amount,&nodes)?;
  let(expected,bump)=allocation_address(program,r.key,index);require(expected==*a.key,Error::Account)?;
  require(a.owner!=program,Error::Settled)?;
  let mut pos=position_init(program,payer,p,c,wallet.key,system)?;
  create(program,payer,a,system,&[b"award-v2",r.key.as_ref(),&index.to_le_bytes(),&[bump]],ALLOCATION_LEN)?;
  round.registered=add(round.registered,amount)?;require(round.registered<=round.total,Error::Funds)?;
  if round.registered==round.total{state.pending_registrations=sub(state.pending_registrations,1)?;}
  pos.active=add(pos.active,amount)?;pos.version=add(pos.version,1)?;
  store(a,&Allocation{magic:*b"RBD2AWRD",round:*r.key,wallet:*wallet.key,index,maximum:amount,paid:0,released:0,settled:false})?;
  store(p,&pos)?;store(r,&round)?;store(c,&state)
 },
 Command::Settle{authorization:auth}=>{
  require(accounts.len()>=7,Error::Account)?;
  let(g,c,r,p,a,wallet,instructions)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  distinct(&[*g.key,*c.key,*r.key,*p.key,*a.key,*wallet.key,*instructions.key])?;
  let d=deployment(program,g)?;let mut state=coin(program,c,g)?;let mut round=round(program,r,c)?;let mut pos=position(program,p,c,wallet.key)?;
  let mut award:Allocation=load(program,a,ALLOCATION_LEN,b"RBD2AWRD")?;
  require(award.round==*r.key&&award.wallet==*wallet.key&&allocation_address(program,r.key,award.index).0==*a.key&&!award.settled,Error::Settled)?;
  require(state.pending_registrations==0&&round.registered==round.total,Error::Registration)?;
  require(auth.domain==*b"RBD2PAY0"&&auth.program==*program&&auth.deployment==*g.key&&auth.mint==state.mint&&auth.asset==0&&auth.round==round.id&&auth.index==award.index&&auth.wallet==*wallet.key&&auth.maximum==award.maximum,Error::Data)?;
  require(auth.version==pos.version&&auth.epoch==state.funding_epoch,Error::Version)?;
  fresh(clock()?.slot,auth.through,auth.issued,auth.expires)?;
  attest(instructions,&round.verifier,&borsh::to_vec(&auth).map_err(|_|Error::Data)?)?;
  require(auth.outcome<=2&&auth.evidence!=[0;32],Error::Data)?;
  if auth.outcome==1{require(auth.payable==0,Error::Disqualified)?;}
  else{
   require(!pos.disqualified&&auth.payable<=cap(&pos,&award,auth.cost,auth.value)?,Error::Funds)?;
   require(if auth.outcome==0{auth.payable==award.maximum}else{auth.payable<award.maximum},Error::Data)?;
   if auth.payable>0{require(!d.paused&&auth.holding>0&&holdings(&accounts[7..],&state.mint,wallet.key)?>=auth.holding,Error::Holding)?;}
  }
  settle_state(&mut state,&mut round,&mut pos,&mut award,auth.payable,if auth.outcome==1{Some(auth.evidence)}else{None})?;
  if auth.payable>0{pay(c,wallet,auth.payable)?;}backing(&state,c)?;
  store(a,&award)?;store(p,&pos)?;store(r,&round)?;store(c,&state)?;
  solana_program::msg!("RBD2 settlement {} {} {}",a.key,award.paid,award.released);Ok(())
 },
 Command::PayOperations=>{
  require(accounts.len()==3,Error::Account)?;let(g,c,ops)=(&accounts[0],&accounts[1],&accounts[2]);
  let d=deployment(program,g)?;require(!d.paused,Error::Paused)?;let mut state=coin(program,c,g)?;
  require(*ops.key==state.operations&&ops.key!=c.key,Error::Unauthorized)?;
  let cycle=(clock()?.unix_timestamp/CYCLE)as u64;require(cycle>state.last_operations_cycle&&state.operations_payable>0,Error::TooSoon)?;
  let n=state.operations_payable;state.operations_payable=0;state.operations_paid=add(state.operations_paid,n)?;state.last_operations_cycle=cycle;
  pay(c,ops,n)?;conservation(&state)?;backing(&state,c)?;store(c,&state)?;
  solana_program::msg!("RBD2 operations {} {} {}",c.key,cycle,n);Ok(())
 },
 Command::RecordExit{authorization:auth}=>{
  require(accounts.len()==6,Error::Account)?;let(payer,g,c,p,system,instructions)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let d=deployment(program,g)?;let state=coin(program,c,g)?;
  require(auth.domain==*b"RBD2EXIT"&&auth.program==*program&&auth.deployment==*g.key&&auth.mint==state.mint&&auth.asset==0&&auth.outcome==1&&auth.payable==0&&auth.evidence!=[0;32],Error::Data)?;
  fresh(clock()?.slot,auth.through,auth.issued,auth.expires)?;attest(instructions,&d.verifier,&borsh::to_vec(&auth).map_err(|_|Error::Data)?)?;
  let mut pos=position_init(program,payer,p,c,&auth.wallet,system)?;
  require(auth.version==pos.version,Error::Version)?;
  if !pos.disqualified{pos.disqualified=true;pos.first_exit=auth.evidence;pos.version=add(pos.version,1)?;store(p,&pos)?;}Ok(())
 },
 Command::Pause | Command::RequestResume | Command::Resume=>{
  require(accounts.len()==2,Error::Account)?;let(authority,g)=(&accounts[0],&accounts[1]);let mut d=deployment(program,g)?;let now=clock()?.unix_timestamp;
  match command{
   Command::Pause=>{require(authority.is_signer&&(*authority.key==d.admin||*authority.key==d.guardian),Error::Unauthorized)?;d.paused=true;d.resume_at=0;}
   Command::RequestResume=>{signer(authority,&d.admin)?;require(d.paused,Error::Data)?;d.resume_at=now.checked_add(RESUME_DELAY).ok_or(Error::Arithmetic)?;}
   _=>{signer(authority,&d.admin)?;require(d.paused&&d.resume_at>0&&now>=d.resume_at,Error::TooSoon)?;d.paused=false;d.resume_at=0;}
  }store(g,&d)
 },
 }
}
#[cfg(test)]
mod tests{
 use super::*;
 fn coin()->Coin{Coin{magic:*b"RBD2COIN",mint:Pubkey::new_unique(),launcher:Pubkey::new_unique(),deployment:Pubkey::new_unique(),operations:Pubkey::new_unique(),policy:[2;32],active:true,receipts:0,unallocated:0,reserved:0,paid:0,operations_payable:0,operations_paid:0,split_remainder:0,last_round:0,last_operations_cycle:0,activation_slot:1,funding_epoch:0,pending_registrations:0}}
 #[test]fn three_coins_and_carried_split(){for(n,h,o)in[(10_000_000_000,8_500_000_000,1_500_000_000),(800_000_000,680_000_000,120_000_000),(6_300_000_000,5_355_000_000,945_000_000)]{let mut c=coin();credit(&mut c,n).unwrap();assert_eq!((c.unallocated,c.operations_payable),(h,o));}let mut c=coin();for _ in 0..100{credit(&mut c,1).unwrap();}assert_eq!((c.unallocated,c.operations_payable,c.split_remainder),(85,15,0));}
 #[test]fn freshness_boundaries(){assert!(fresh(116,0,96,116).is_ok());assert!(fresh(117,0,96,116).is_err());assert!(fresh(100,0,97,117).is_err());assert!(fresh(99,100,100,120).is_err());assert!(fresh(100,90,100,121).is_err());}
 #[test]fn loss_cap_excludes_own_reservation(){let p=Position{magic:*b"RBD2POS0",coin:Pubkey::new_unique(),wallet:Pubkey::new_unique(),version:0,paid:1,active:3,disqualified:false,first_exit:[0;32]};let a=Allocation{magic:*b"RBD2AWRD",round:Pubkey::new_unique(),wallet:p.wallet,index:0,maximum:2,paid:0,released:0,settled:false};assert_eq!(cap(&p,&a,10,7).unwrap(),1);assert_eq!(cap(&p,&a,10,5).unwrap(),2);}
 #[test]fn reduced_settlement_conserves_and_releases_once(){
 let mut c=coin();credit(&mut c,100).unwrap();c.unallocated-=40;c.reserved=40;
 let mut r=Round{magic:*b"RBD2ROND",coin:Pubkey::new_unique(),id:1,root:[1;32],total:40,remaining:40,registered:40,cutoff_slot:1,cutoff_time:1,manifest:[2;32],verifier:Pubkey::new_unique(),policy:c.policy};
 let mut p=Position{magic:*b"RBD2POS0",coin:r.coin,wallet:Pubkey::new_unique(),version:0,paid:0,active:40,disqualified:false,first_exit:[0;32]};
 let mut a=Allocation{magic:*b"RBD2AWRD",round:Pubkey::new_unique(),wallet:p.wallet,index:0,maximum:40,paid:0,released:0,settled:false};
 settle_state(&mut c,&mut r,&mut p,&mut a,15,None).unwrap();assert_eq!((c.unallocated,c.reserved,c.paid,c.operations_payable),(70,0,15,15));assert_eq!((a.paid,a.released,p.version),(15,25,1));assert!(settle_state(&mut c,&mut r,&mut p,&mut a,15,None).is_err());assert!(!p.disqualified);
 }
 #[test]fn merkle_domains_do_not_cross_mints(){let c=coin();let mut other=c.clone();other.mint=Pubkey::new_unique();let p=Pubkey::new_unique();let w=Pubkey::new_unique();assert_ne!(leaf(&p,&c,1,0,&w,10),leaf(&p,&other,1,0,&w,10));assert_ne!(leaf(&p,&c,1,0,&w,10),leaf(&p,&c,1,1,&w,10));}
 #[test]fn state_sizes_fit(){assert!(borsh::to_vec(&coin()).unwrap().len()<=COIN_LEN);}
}
