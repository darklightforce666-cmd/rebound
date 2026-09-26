//! Third-party 15 % buyback of the PRIMARY mint and a real burn (spec §10.3).
//! Durable two-step flow: reserved → purchased (pending burn) → burned → closed.
//! * ReserveBuyback (publisher): moves `amount` of the coin's buyback reserve into a per-job,
//!   system-owned buyer PDA; the job stores the target mint, its token program and the deployment
//!   config version at that moment — later target changes never retarget it.
//! * BuybackSwap (publisher): CPI into Pump `buy_exact_sol_in` (curve) or PumpSwap
//!   `buy_exact_quote_in` (canonical pool) with instruction data built HERE; the program validates
//!   program ids, mint, token program, buyer, buyer token account and canonical market, then
//!   measures the real token delta and SOL spent. `min_out` must be > 0 and ≤ acquired;
//!   spent ≤ budget. Only a `reserved` job can swap, so a failed burn never triggers a second buy.
//! * BuybackBurn (permissionless): `burn_checked` of exactly the acquired amount through the mint's
//!   own token program, verified by account and supply deltas. Not a transfer to a dead address.
//! * CloseBuyback (permissionless): returns the unspent budget to the coin's buyback reserve
//!   (never to holders, never split again) and the rent top-up to the payer.
use super::*;

const JOB_RESERVED:u8=0; const JOB_PURCHASED:u8=1; const JOB_BURNED:u8=2; const JOB_CLOSED:u8=3;
const CURVE_BUY:[u8;8]=[56,252,116,8,158,223,205,95];
const AMM_BUY:[u8;8]=[198,46,21,82,180,217,232,112];

fn token_amount(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey,program:&Pubkey)->Result<u64,ProgramError>{
 require(a.owner==program&&!a.executable,Error::Buyback)?;let d=a.try_borrow_data()?;
 require(d.len()>=165&&key(&d,0)?==*mint&&key(&d,32)?==*owner&&d[108]==1,Error::Buyback)?;
 Ok(u64::from_le_bytes(d[64..72].try_into().map_err(|_|Error::Data)?))
}
fn mint_supply(a:&AccountInfo,program:&Pubkey)->Result<(u64,u8),ProgramError>{
 require(a.owner==program&&!a.executable,Error::Burn)?;let d=a.try_borrow_data()?;require(d.len()>=82&&d[45]==1,Error::Burn)?;
 Ok((u64::from_le_bytes(d[36..44].try_into().map_err(|_|Error::Data)?),d[44]))
}
pub fn ata(owner:&Pubkey,mint:&Pubkey,token_program:&Pubkey)->Pubkey{pda(&ATA,&[owner.as_ref(),token_program.as_ref(),mint.as_ref()]).0}
pub fn pump_pool(mint:&Pubkey)->Pubkey{
 let authority=pda(&PUMP,&[b"pool-authority",mint.as_ref()]).0;
 pda(&AMM,&[b"pool",&0u16.to_le_bytes(),authority.as_ref(),mint.as_ref(),SOL.as_ref()]).0
}
fn job(program:&Pubkey,a:&AccountInfo,c:&AccountInfo)->Result<Job,ProgramError>{
 let j:Job=load(program,a,JOB_LEN,b"RBD3JOB0")?;require(j.coin==*c.key&&job_address(program,c.key,j.id).0==*a.key,Error::Account)?;Ok(j)
}

/// Pure state transitions (unit-tested).
pub fn reserve(c:&mut Coin,amount:u64)->ProgramResult{require(c.kind==THIRD_PARTY&&amount>0,Error::Kind)?;c.buyback_available=sub(c.buyback_available,amount)?;c.buyback_reserved=add(c.buyback_reserved,amount)?;conservation(c)}
pub fn purchased(j:&mut Job,spent:u64,acquired:u64,min_out:u64,slot:u64)->ProgramResult{
 require(j.state==JOB_RESERVED,Error::Buyback)?;require(min_out>0&&acquired>=min_out&&acquired>0&&spent<=j.budget,Error::Buyback)?;
 j.spent=spent;j.acquired=acquired;j.state=JOB_PURCHASED;j.purchase_slot=slot;Ok(())
}
pub fn burned(j:&mut Job,amount:u64,slot:u64)->ProgramResult{require(j.state==JOB_PURCHASED&&amount==j.acquired,Error::Burn)?;j.burned=amount;j.state=JOB_BURNED;j.burn_slot=slot;Ok(())}
pub fn close(c:&mut Coin,j:&mut Job)->Result<u64,ProgramError>{
 require(j.state==JOB_BURNED,Error::Buyback)?;let unspent=sub(j.budget,j.spent)?;
 c.buyback_reserved=sub(c.buyback_reserved,j.budget)?;c.buyback_spent=add(c.buyback_spent,j.spent)?;c.buyback_available=add(c.buyback_available,unspent)?;
 j.state=JOB_CLOSED;conservation(c)?;Ok(unspent)
}

pub fn process(program:&Pubkey,accounts:&[AccountInfo],command:Command)->ProgramResult{
 match command{
 Command::ReserveBuyback{cycle,amount,max_slippage_bps,max_impact_bps}=>{
  require(accounts.len()==7,Error::Account)?;
  let(payer,publisher,g,c,jb,buyer,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let d=deployment(program,g)?;signer(publisher,&d.publisher)?;require(!d.paused,Error::Paused)?;
  require(d.target_mint!=Pubkey::default()&&max_slippage_bps>0&&max_slippage_bps<=300&&max_impact_bps>0&&max_impact_bps<=1000,Error::Buyback)?;
  let mut s=coin(program,c,g)?;require(s.active&&s.kind==THIRD_PARTY&&s.mint!=d.target_mint,Error::Kind)?;
  let id=s.next_job;let(expected,bump)=job_address(program,c.key,id);require(expected==*jb.key,Error::Account)?;
  let(expected_buyer,_)=buyer_address(program,jb.key);require(expected_buyer==*buyer.key&&buyer.owner==&system_program::id()&&buyer.data_is_empty(),Error::Account)?;
  create(program,payer,jb,system,&[b"buyback-v3",c.key.as_ref(),&id.to_le_bytes(),&[bump]],JOB_LEN)?;
  reserve(&mut s,amount)?;s.next_job=add(s.next_job,1)?;
  // Budget leaves the treasury; the buyer PDA also receives a rent top-up from the payer so its
  // balance can never fall into a rent-paying state (operating cost, not budget).
  // CPI first, then the direct lamport move (the runtime rejects a CPI after an unsynced debit).
  let rent=Rent::get()?.minimum_balance(0);
  invoke(&system_instruction::transfer(payer.key,buyer.key,rent),&[payer.clone(),buyer.clone(),system.clone()])?;
  pay(c,buyer,amount)?;
  backing(&s,c)?;store(c,&s)?;
  store(jb,&Job{magic:*b"RBD3JOB0",coin:*c.key,id,cycle,target_mint:d.target_mint,target_token_program:d.target_token_program,config_version:d.config_version,budget:amount,state:JOB_RESERVED,spent:0,acquired:0,burned:0,max_slippage_bps,max_impact_bps,purchase_slot:0,burn_slot:0})?;
  solana_program::msg!("RBD3 buyback reserved {} job {} {}",s.mint,id,amount);Ok(())
 },
 Command::BuybackSwap{min_out}=>{
  // accounts: publisher, deployment, coin, job, buyer, then the forwarded market accounts.
  require(accounts.len()>=5+16,Error::Account)?;
  let(publisher,g,c,jb,buyer)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4]);let fwd=&accounts[5..];
  let d=deployment(program,g)?;signer(publisher,&d.publisher)?;require(!d.paused,Error::Paused)?;let _s=coin(program,c,g)?;let mut j=job(program,jb,c)?;
  require(j.state==JOB_RESERVED,Error::Buyback)?;let(expected_buyer,bump)=buyer_address(program,jb.key);require(expected_buyer==*buyer.key,Error::Account)?;
  let rent=Rent::get()?.minimum_balance(0);let seeds:&[&[u8]]=&[b"buyer-v3",jb.key.as_ref(),&[bump]];
  let spendable=j.budget;let mut data=Vec::with_capacity(25);
  let (program_id,out_account,sol_before,token_program)=if *fwd[11].key==PUMP{
   // Pump bonding curve: 0 global,1 fee_recipient,2 mint,3 bonding_curve,4 associated_bonding_curve,5 associated_user,
   // 6 user,7 system,8 token_program,9 creator_vault,10 event_authority,11 program,12..15 accumulators/fee config/program.
   require(*fwd[2].key==j.target_mint&&*fwd[6].key==*buyer.key&&*fwd[8].key==j.target_token_program&&*fwd[7].key==system_program::id(),Error::Routing)?;
   require(*fwd[3].key==pda(&PUMP,&[b"bonding-curve",j.target_mint.as_ref()]).0&&*fwd[5].key==ata(buyer.key,&j.target_mint,&j.target_token_program)&&*fwd[15].key==FEES,Error::Routing)?;
   data.extend_from_slice(&CURVE_BUY);(PUMP,5usize,buyer.lamports(),j.target_token_program)
  }else{
   // PumpSwap canonical pool: 0 pool,1 user,2 global_config,3 base_mint,4 quote_mint,5 user_base,6 user_quote,…,11 base_token_program,
   // 12 quote_token_program,13 system,14 ATA program,16 program,22 fee program. Quote is WSOL held by the buyer.
   require(fwd.len()>=23&&*fwd[16].key==AMM&&*fwd[0].key==pump_pool(&j.target_mint)&&*fwd[1].key==*buyer.key&&*fwd[3].key==j.target_mint&&*fwd[4].key==SOL,Error::Routing)?;
   require(*fwd[11].key==j.target_token_program&&*fwd[12].key==TOKEN&&*fwd[5].key==ata(buyer.key,&j.target_mint,&j.target_token_program)&&*fwd[6].key==ata(buyer.key,&SOL,&TOKEN)&&*fwd[22].key==FEES,Error::Routing)?;
   // Wrap exactly the budget into the buyer's WSOL account, then sync.
   invoke_signed(&system_instruction::transfer(buyer.key,fwd[6].key,spendable),&[buyer.clone(),fwd[6].clone(),fwd[13].clone()],&[seeds])?;
   invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*fwd[6].key,false)],data:vec![17]},&[fwd[6].clone(),fwd[12].clone()])?;
   data.extend_from_slice(&AMM_BUY);let wsol=token_amount(&fwd[6],&SOL,buyer.key,&TOKEN)?;(AMM,5usize,wsol,j.target_token_program)
  };
  data.extend_from_slice(&spendable.to_le_bytes());data.extend_from_slice(&min_out.to_le_bytes());data.push(0);
  require(min_out>0,Error::Buyback)?;
  let before=token_amount(&fwd[out_account],&j.target_mint,buyer.key,&token_program)?;
  let metas=fwd.iter().map(|a|AccountMeta{pubkey:*a.key,is_writable:a.is_writable,is_signer:a.key==buyer.key}).collect();
  invoke_signed(&Instruction{program_id,accounts:metas,data},fwd,&[seeds])?;
  let after=token_amount(&fwd[out_account],&j.target_mint,buyer.key,&token_program)?;
  let sol_after=if program_id==PUMP{buyer.lamports()}else{token_amount(&fwd[6],&SOL,buyer.key,&TOKEN)?};
  require(buyer.lamports()>=rent,Error::Funds)?;
  let spent=sub(sol_before,sol_after)?;let acquired=sub(after,before)?;
  purchased(&mut j,spent,acquired,min_out,clock()?.slot)?;store(jb,&j)?;
  solana_program::msg!("RBD3 buyback purchased job {} spent {} acquired {}",j.id,spent,acquired);Ok(())
 },
 Command::BuybackBurn=>{
  require(accounts.len()==7,Error::Account)?;
  let(g,c,jb,buyer,holding,mint,token_program)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5],&accounts[6]);
  let _d=deployment(program,g)?;let _s=coin(program,c,g)?;let mut j=job(program,jb,c)?;require(j.state==JOB_PURCHASED,Error::Burn)?;
  let(expected_buyer,bump)=buyer_address(program,jb.key);require(expected_buyer==*buyer.key&&*mint.key==j.target_mint&&*token_program.key==j.target_token_program,Error::Burn)?;
  require(*holding.key==ata(buyer.key,&j.target_mint,&j.target_token_program),Error::Burn)?;
  let before=token_amount(holding,&j.target_mint,buyer.key,&j.target_token_program)?;let(supply_before,decimals)=mint_supply(mint,&j.target_token_program)?;
  require(before>=j.acquired,Error::Burn)?;
  let mut data=vec![15u8];data.extend_from_slice(&j.acquired.to_le_bytes());data.push(decimals);   // BurnChecked
  invoke_signed(&Instruction{program_id:j.target_token_program,accounts:vec![AccountMeta::new(*holding.key,false),AccountMeta::new(*mint.key,false),AccountMeta::new_readonly(*buyer.key,true)],data},
   &[holding.clone(),mint.clone(),buyer.clone(),token_program.clone()],&[&[b"buyer-v3",jb.key.as_ref(),&[bump]]])?;
  let after=token_amount(holding,&j.target_mint,buyer.key,&j.target_token_program)?;let(supply_after,_)=mint_supply(mint,&j.target_token_program)?;
  require(sub(before,after)?==j.acquired&&sub(supply_before,supply_after)?==j.acquired,Error::Burn)?;
  let amount=j.acquired;burned(&mut j,amount,clock()?.slot)?;store(jb,&j)?;solana_program::msg!("RBD3 buyback burned job {} {}",j.id,j.acquired);Ok(())
 },
 Command::CloseBuyback=>{
  require(accounts.len()==6,Error::Account)?;let(payer,g,c,jb,buyer,system)=(&accounts[0],&accounts[1],&accounts[2],&accounts[3],&accounts[4],&accounts[5]);
  let _d=deployment(program,g)?;let mut s=coin(program,c,g)?;let mut j=job(program,jb,c)?;
  let(expected_buyer,bump)=buyer_address(program,jb.key);require(expected_buyer==*buyer.key&&payer.is_signer,Error::Account)?;
  let unspent=close(&mut s,&mut j)?;let seeds:&[&[u8]]=&[b"buyer-v3",jb.key.as_ref(),&[bump]];
  require(buyer.lamports()>=unspent,Error::Funds)?;
  if unspent>0{invoke_signed(&system_instruction::transfer(buyer.key,c.key,unspent),&[buyer.clone(),c.clone(),system.clone()],&[seeds])?;}
  let rest=buyer.lamports();if rest>0{invoke_signed(&system_instruction::transfer(buyer.key,payer.key,rest),&[buyer.clone(),payer.clone(),system.clone()],&[seeds])?;}
  backing(&s,c)?;store(c,&s)?;store(jb,&j)?;solana_program::msg!("RBD3 buyback closed job {} unspent {}",j.id,unspent);Ok(())
 },
 _=>Err(Error::Data.into()),
 }
}

#[cfg(test)]
mod tests{
 use super::*;
 fn coin()->Coin{Coin{magic:*b"RBD3COIN",mint:Pubkey::new_unique(),kind:THIRD_PARTY,deployment:Pubkey::new_unique(),policy:[3;32],active:true,anchor:0,cycle_seconds:1800,cutoff_lead:60,funding_wallet:Pubkey::default(),launcher:Pubkey::new_unique(),receipts:0,deposits:0,holder_unallocated:0,holder_reserved:0,holder_paid:0,buyback_available:0,buyback_reserved:0,buyback_spent:0,split_carry:0,last_cycle:0,next_job:0}}
 fn job(b:u64)->Job{Job{magic:*b"RBD3JOB0",coin:Pubkey::new_unique(),id:0,cycle:1,target_mint:Pubkey::new_unique(),target_token_program:TOKEN,config_version:1,budget:b,state:JOB_RESERVED,spent:0,acquired:0,burned:0,max_slippage_bps:100,max_impact_bps:200,purchase_slot:0,burn_slot:0}}
 #[test]fn lifecycle_conserves_and_burn_only_after_purchase(){
  let mut c=coin();credit(&mut c,1_000).unwrap();reserve(&mut c,150).unwrap();assert_eq!((c.buyback_available,c.buyback_reserved),(0,150));
  let mut j=job(150);assert!(burned(&mut j,1,1).is_err());assert!(purchased(&mut j,140,0,0,1).is_err());assert!(purchased(&mut j,160,10,1,1).is_err());
  purchased(&mut j,140,1000,900,5).unwrap();assert!(purchased(&mut j,140,1000,900,6).is_err());   // never buys twice
  assert!(close(&mut c,&mut j).is_err());assert!(burned(&mut j,999,7).is_err());burned(&mut j,1000,7).unwrap();
  assert_eq!(close(&mut c,&mut j).unwrap(),10);assert_eq!((c.buyback_available,c.buyback_reserved,c.buyback_spent),(10,0,140));assert!(close(&mut c,&mut j).is_err());
 }
 #[test]fn reserve_cannot_exceed_available(){let mut c=coin();credit(&mut c,100).unwrap();assert!(reserve(&mut c,16).is_err());reserve(&mut c,15).unwrap();}
}
