//! SOL custody and Merkle-sum claims. Loss calculations are attested by the publisher.
//! No Pump CPI, trading, token custody, or administrator withdrawal instruction.
#![allow(unexpected_cfgs)]
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const WAIT: i64 = 600;
pub const HOUR: i64 = 3600;
pub const ROLE_DELAY: i64 = 86_400;
pub const MAX_PROOF: usize = 16;
pub const CONFIG_LEN: usize = 281;
pub const ROUND_LEN: usize = 153;
pub const RECEIPT_LEN: usize = 80;
const CONFIG_MAGIC: [u8; 8] = *b"RBDCFG01";
const ROUND_MAGIC: [u8; 8] = *b"RBDRND01";
const CLAIM_MAGIC: [u8; 8] = *b"RBDCLM01";

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    InvalidAccount,
    InvalidData,
    Arithmetic,
    InsufficientFunds,
    Paused,
    InvalidRound,
    Waiting,
    InvalidProof,
    AlreadyClaimed,
    Closed,
    StaleSnapshot,
    PendingRound,
    NoPendingRole,
    InvalidMint,
}
impl From<Error> for ProgramError {
    fn from(e: Error) -> Self {
        Self::Custom(e as u32)
    }
}
fn require(ok: bool, e: Error) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(e.into())
    }
}
fn add(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_add(b).ok_or(Error::Arithmetic.into())
}
fn sub(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_sub(b).ok_or(Error::InsufficientFunds.into())
}
fn signer(a: &AccountInfo) -> ProgramResult {
    require(a.is_signer, Error::Unauthorized)
}
fn writable(a: &AccountInfo) -> ProgramResult {
    require(a.is_writable, Error::InvalidAccount)
}
fn authority(a: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    signer(a)?;
    require(a.key == expected, Error::Unauthorized)
}
fn now() -> Result<i64, ProgramError> {
    let t = Clock::get()?.unix_timestamp;
    require(t >= 0, Error::InvalidData)?;
    Ok(t)
}
fn unique(accounts: &[&AccountInfo]) -> ProgramResult {
    for i in 0..accounts.len() {
        for j in i + 1..accounts.len() {
            require(accounts[i].key != accounts[j].key, Error::InvalidAccount)?;
        }
    }
    Ok(())
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Config {
    pub magic: [u8; 8],
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub publisher: Pubkey,
    pub guardian: Pubkey,
    pub operations: Pubkey,
    pub pending_publisher: Pubkey,
    pub publisher_at: i64,
    pub paused: bool,
    pub available: u64,
    pub reserved: u64,
    pub paid: u64,
    pub collected: u64,
    pub operations_paid: u64,
    pub dust: u64,
    pub next_round: u64,
    pub pending_until: i64,
    pub latest_snapshot: i64,
}
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Round {
    pub magic: [u8; 8],
    pub config: Pubkey,
    pub id: u64,
    pub root: [u8; 32],
    pub total: u64,
    pub remaining: u64,
    pub snapshot_at: i64,
    pub published_at: i64,
    pub claimable_at: i64,
    pub cancelled: bool,
    pub manifest_hash: [u8; 32],
}
#[derive(BorshSerialize, BorshDeserialize)]
struct Receipt {
    magic: [u8; 8],
    round: Pubkey,
    wallet: Pubkey,
    amount: u64,
}

pub fn config_address(program: &Pubkey, admin: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"rebound", admin.as_ref(), mint.as_ref()], program)
}
pub fn round_address(program: &Pubkey, config: &Pubkey, id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"round", config.as_ref(), &id.to_le_bytes()], program)
}
pub fn claim_address(program: &Pubkey, round: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"claim", round.as_ref(), wallet.as_ref()], program)
}
fn load_config(program: &Pubkey, a: &AccountInfo) -> Result<Config, ProgramError> {
    require(
        a.owner == program && a.data_len() == CONFIG_LEN && !a.executable,
        Error::InvalidAccount,
    )?;
    let c = Config::try_from_slice(&a.try_borrow_data()?).map_err(|_| Error::InvalidData)?;
    require(
        c.magic == CONFIG_MAGIC && config_address(program, &c.admin, &c.mint).0 == *a.key,
        Error::InvalidAccount,
    )?;
    require(
        c.collected
            == add(
                add(add(c.available, c.reserved)?, c.paid)?,
                add(c.operations_paid, c.dust)?,
            )?,
        Error::Arithmetic,
    )?;
    Ok(c)
}
fn load_round(program: &Pubkey, a: &AccountInfo, config: &Pubkey) -> Result<Round, ProgramError> {
    require(
        a.owner == program && a.data_len() == ROUND_LEN && !a.executable,
        Error::InvalidAccount,
    )?;
    let r = Round::try_from_slice(&a.try_borrow_data()?).map_err(|_| Error::InvalidData)?;
    require(
        r.magic == ROUND_MAGIC
            && r.config == *config
            && round_address(program, config, r.id).0 == *a.key,
        Error::InvalidAccount,
    )?;
    Ok(r)
}
fn store<T: BorshSerialize>(a: &AccountInfo, value: &T) -> ProgramResult {
    writable(a)?;
    let data = borsh::to_vec(value).map_err(|_| Error::InvalidData)?;
    require(data.len() == a.data_len(), Error::InvalidAccount)?;
    a.try_borrow_mut_data()?.copy_from_slice(&data);
    Ok(())
}
fn backing(c: &Config, vault: &AccountInfo) -> Result<u64, ProgramError> {
    let expected = add(
        Rent::get()?.minimum_balance(CONFIG_LEN),
        add(add(c.available, c.reserved)?, c.dust)?,
    )?;
    require(vault.lamports() >= expected, Error::InsufficientFunds)?;
    Ok(expected)
}
fn pay(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    writable(from)?;
    writable(to)?;
    require(from.key != to.key, Error::InvalidAccount)?;
    let left = sub(from.lamports(), amount)?;
    let right = add(to.lamports(), amount)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = right;
    Ok(())
}

// Allocate and assign, rather than create_account, so a pre-funded PDA cannot block setup.
fn create_pda<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    len: usize,
) -> ProgramResult {
    signer(payer)?;
    writable(payer)?;
    writable(target)?;
    unique(&[payer, target, system])?;
    require(
        *system.key == system_program::id() && system.executable,
        Error::InvalidAccount,
    )?;
    require(
        *payer.owner == system_program::id() && payer.data_is_empty(),
        Error::InvalidAccount,
    )?;
    require(
        *target.owner == system_program::id() && target.data_is_empty() && !target.executable,
        Error::InvalidAccount,
    )?;
    let need = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(target.lamports());
    if need > 0 {
        invoke(
            &system_instruction::transfer(payer.key, target.key, need),
            &[payer.clone(), target.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(target.key, len as u64),
        &[target.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(target.key, program),
        &[target.clone(), system.clone()],
        &[seeds],
    )?;
    Ok(())
}

pub fn split(amount: u64) -> (u64, u64, u64) {
    let holders = (u128::from(amount) * 8500 / 10000) as u64;
    let operations = (u128::from(amount) * 1500 / 10000) as u64;
    (holders, operations, amount - holders - operations)
}
fn credit(
    c: &mut Config,
    vault: &AccountInfo,
    operations: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    require(
        *operations.key == c.operations && !operations.executable,
        Error::InvalidAccount,
    )?;
    let (holders, ops, dust) = split(amount);
    c.available = add(c.available, holders)?;
    c.collected = add(c.collected, amount)?;
    c.operations_paid = add(c.operations_paid, ops)?;
    c.dust = add(c.dust, dust)?;
    pay(vault, operations, ops)?;
    backing(c, vault)?;
    store(vault, c)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Node {
    pub hash: [u8; 32],
    pub sum: u64,
}
pub fn leaf(program: &Pubkey, config: &Pubkey, id: u64, wallet: &Pubkey, amount: u64) -> Node {
    Node {
        hash: hashv(&[
            b"REBOUND:leaf:v1",
            program.as_ref(),
            config.as_ref(),
            &id.to_le_bytes(),
            wallet.as_ref(),
            &amount.to_le_bytes(),
        ])
        .to_bytes(),
        sum: amount,
    }
}
pub fn parent(a: Node, b: Node) -> Result<Node, ProgramError> {
    let (l, r) = if (a.hash, a.sum) <= (b.hash, b.sum) {
        (a, b)
    } else {
        (b, a)
    };
    Ok(Node {
        hash: hashv(&[
            b"REBOUND:node:v1",
            &l.hash,
            &l.sum.to_le_bytes(),
            &r.hash,
            &r.sum.to_le_bytes(),
        ])
        .to_bytes(),
        sum: add(l.sum, r.sum)?,
    })
}
fn verify(
    program: &Pubkey,
    config: &Pubkey,
    r: &Round,
    wallet: &Pubkey,
    amount: u64,
    proof: &[Node],
) -> ProgramResult {
    require(amount > 0 && proof.len() <= MAX_PROOF, Error::InvalidProof)?;
    let mut node = leaf(program, config, r.id, wallet, amount);
    for sibling in proof {
        node = parent(node, *sibling)?;
    }
    require(
        node.hash == r.root && node.sum == r.total,
        Error::InvalidProof,
    )
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], ProgramError> {
        let (head, tail) = self.0.split_at_checked(N).ok_or(Error::InvalidData)?;
        self.0 = tail;
        Ok(head.try_into().map_err(|_| Error::InvalidData)?)
    }
    fn byte(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take::<1>()?[0])
    }
    fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    fn i64(&mut self) -> Result<i64, ProgramError> {
        Ok(i64::from_le_bytes(self.take()?))
    }
    fn key(&mut self) -> Result<Pubkey, ProgramError> {
        Ok(Pubkey::new_from_array(self.take()?))
    }
    fn end(&self) -> ProgramResult {
        require(self.0.is_empty(), Error::InvalidData)
    }
}

pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let mut input = Reader(data);
    let tag = input.byte()?;
    let mut it = accounts.iter();
    match tag {
        0 => {
            // admin/payer, config/vault, initialized mint, System Program
            require(accounts.len() == 4, Error::InvalidAccount)?;
            let publisher = input.key()?;
            let guardian = input.key()?;
            let operations = input.key()?;
            input.end()?;
            let admin = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let mint = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(admin)?;
            unique(&[admin, vault, mint, system])?;
            require(
                [publisher, guardian, operations]
                    .iter()
                    .all(|k| *k != Pubkey::default() && k != vault.key && k.is_on_curve()),
                Error::InvalidAccount,
            )?;
            let token = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
            let token2022 = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
            let m = mint.try_borrow_data()?;
            let correct_type = (*mint.owner == token && m.len() == 82)
                || (*mint.owner == token2022 && (m.len() == 82 || (m.len() >= 166 && m[165] == 1)));
            require(
                correct_type && m.get(45) == Some(&1) && m.get(44) == Some(&6),
                Error::InvalidMint,
            )?;
            drop(m);
            let (expected, bump) = config_address(program, admin.key, mint.key);
            require(expected == *vault.key, Error::InvalidAccount)?;
            create_pda(
                program,
                admin,
                vault,
                system,
                &[b"rebound", admin.key.as_ref(), mint.key.as_ref(), &[bump]],
                CONFIG_LEN,
            )?;
            store(
                vault,
                &Config {
                    magic: CONFIG_MAGIC,
                    admin: *admin.key,
                    mint: *mint.key,
                    publisher,
                    guardian,
                    operations,
                    pending_publisher: Pubkey::default(),
                    publisher_at: 0,
                    paused: false,
                    available: 0,
                    reserved: 0,
                    paid: 0,
                    collected: 0,
                    operations_paid: 0,
                    dust: 0,
                    next_round: 1,
                    pending_until: 0,
                    latest_snapshot: 0,
                },
            )
        }
        1 => {
            // depositor, config/vault, operations recipient, System Program
            require(accounts.len() == 4, Error::InvalidAccount)?;
            let amount = input.u64()?;
            input.end()?;
            require(amount > 0, Error::InvalidData)?;
            let depositor = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let operations = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            signer(depositor)?;
            unique(&[depositor, vault, system])?;
            require(
                *system.key == system_program::id()
                    && system.executable
                    && *depositor.owner == system_program::id()
                    && depositor.data_is_empty(),
                Error::InvalidAccount,
            )?;
            let mut c = load_config(program, vault)?;
            backing(&c, vault)?;
            require(*operations.key == c.operations, Error::InvalidAccount)?;
            invoke(
                &system_instruction::transfer(depositor.key, vault.key, amount),
                &[depositor.clone(), vault.clone(), system.clone()],
            )?;
            credit(&mut c, vault, operations, amount)
        }
        2 => {
            // Account for direct SOL transfers exactly once, applying the same 85/15 split.
            require(accounts.len() == 2, Error::InvalidAccount)?;
            input.end()?;
            let vault = next_account_info(&mut it)?;
            let operations = next_account_info(&mut it)?;
            let mut c = load_config(program, vault)?;
            let expected = backing(&c, vault)?;
            let amount = sub(vault.lamports(), expected)?;
            require(amount > 0, Error::InvalidData)?;
            credit(&mut c, vault, operations, amount)
        }
        3 => {
            // publisher/payer, config/vault, new round, System Program
            require(accounts.len() == 4, Error::InvalidAccount)?;
            let id = input.u64()?;
            let root = input.take()?;
            let total = input.u64()?;
            let snapshot_at = input.i64()?;
            let manifest_hash = input.take()?;
            input.end()?;
            let publisher = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let round = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            unique(&[publisher, vault, round, system])?;
            let mut c = load_config(program, vault)?;
            authority(publisher, &c.publisher)?;
            backing(&c, vault)?;
            require(!c.paused, Error::Paused)?;
            let time = now()?;
            require(time >= c.pending_until, Error::PendingRound)?;
            require(
                snapshot_at > c.latest_snapshot && snapshot_at <= time && time - snapshot_at <= 120,
                Error::StaleSnapshot,
            )?;
            require(
                id == c.next_round && total > 0 && root != [0; 32] && manifest_hash != [0; 32],
                Error::InvalidRound,
            )?;
            c.available = sub(c.available, total)?;
            c.reserved = add(c.reserved, total)?;
            c.next_round = add(c.next_round, 1)?;
            c.latest_snapshot = snapshot_at;
            // Open on a UTC hour boundary, with at least ten minutes to review.
            c.pending_until =
                time.checked_add(WAIT + HOUR - 1).ok_or(Error::Arithmetic)? / HOUR * HOUR;
            let (expected, bump) = round_address(program, vault.key, id);
            require(expected == *round.key, Error::InvalidAccount)?;
            create_pda(
                program,
                publisher,
                round,
                system,
                &[b"round", vault.key.as_ref(), &id.to_le_bytes(), &[bump]],
                ROUND_LEN,
            )?;
            store(
                round,
                &Round {
                    magic: ROUND_MAGIC,
                    config: *vault.key,
                    id,
                    root,
                    total,
                    remaining: total,
                    snapshot_at,
                    published_at: time,
                    claimable_at: c.pending_until,
                    cancelled: false,
                    manifest_hash,
                },
            )?;
            store(vault, &c)
        }
        4 => {
            require(accounts.len() == 3, Error::InvalidAccount)?;
            input.end()?;
            let guardian = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let round = next_account_info(&mut it)?;
            unique(&[guardian, vault, round])?;
            let mut c = load_config(program, vault)?;
            authority(guardian, &c.guardian)?;
            backing(&c, vault)?;
            let mut r = load_round(program, round, vault.key)?;
            require(
                !r.cancelled && now()? < r.claimable_at && r.remaining == r.total,
                Error::Closed,
            )?;
            c.reserved = sub(c.reserved, r.remaining)?;
            c.available = add(c.available, r.remaining)?;
            c.pending_until = 0;
            r.cancelled = true;
            r.remaining = 0;
            store(round, &r)?;
            store(vault, &c)
        }
        5 => {
            // payer, config/vault, round, fixed beneficiary, new claim receipt, System Program
            require(accounts.len() == 6, Error::InvalidAccount)?;
            let amount = input.u64()?;
            let depth = usize::from(input.byte()?);
            require(depth <= MAX_PROOF, Error::InvalidProof)?;
            let mut proof = Vec::with_capacity(depth);
            for _ in 0..depth {
                proof.push(Node {
                    hash: input.take()?,
                    sum: input.u64()?,
                });
            }
            input.end()?;
            let payer = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let round = next_account_info(&mut it)?;
            let wallet = next_account_info(&mut it)?;
            let receipt = next_account_info(&mut it)?;
            let system = next_account_info(&mut it)?;
            // The payer may be the beneficiary or any sponsor. The destination is proof-bound.
            signer(payer)?;
            unique(&[vault, round, wallet, receipt, system])?;
            require(
                payer.key != vault.key
                    && payer.key != round.key
                    && payer.key != receipt.key
                    && !wallet.executable,
                Error::InvalidAccount,
            )?;
            let mut c = load_config(program, vault)?;
            backing(&c, vault)?;
            let mut r = load_round(program, round, vault.key)?;
            require(!r.cancelled, Error::Closed)?;
            require(now()? >= r.claimable_at, Error::Waiting)?;
            verify(program, vault.key, &r, wallet.key, amount, &proof)?;
            let (expected, bump) = claim_address(program, round.key, wallet.key);
            require(expected == *receipt.key, Error::InvalidAccount)?;
            require(receipt.owner != program, Error::AlreadyClaimed)?;
            r.remaining = sub(r.remaining, amount)?;
            c.reserved = sub(c.reserved, amount)?;
            c.paid = add(c.paid, amount)?;
            create_pda(
                program,
                payer,
                receipt,
                system,
                &[b"claim", round.key.as_ref(), wallet.key.as_ref(), &[bump]],
                RECEIPT_LEN,
            )?;
            store(
                receipt,
                &Receipt {
                    magic: CLAIM_MAGIC,
                    round: *round.key,
                    wallet: *wallet.key,
                    amount,
                },
            )?;
            pay(vault, wallet, amount)?;
            backing(&c, vault)?;
            store(round, &r)?;
            store(vault, &c)
        }
        6 => {
            require(accounts.len() == 2, Error::InvalidAccount)?;
            let pause = input.byte()?;
            input.end()?;
            require(pause <= 1, Error::InvalidData)?;
            let actor = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let mut c = load_config(program, vault)?;
            signer(actor)?;
            require(
                *actor.key == c.admin || (pause == 1 && *actor.key == c.guardian),
                Error::Unauthorized,
            )?;
            c.paused = pause == 1;
            store(vault, &c)
        }
        7 => {
            require(accounts.len() == 2, Error::InvalidAccount)?;
            let next = input.key()?;
            input.end()?;
            let admin = next_account_info(&mut it)?;
            let vault = next_account_info(&mut it)?;
            let mut c = load_config(program, vault)?;
            authority(admin, &c.admin)?;
            require(
                next != Pubkey::default() && next.is_on_curve() && next != *vault.key,
                Error::InvalidAccount,
            )?;
            c.pending_publisher = next;
            c.publisher_at = now()?.checked_add(ROLE_DELAY).ok_or(Error::Arithmetic)?;
            store(vault, &c)
        }
        8 => {
            require(accounts.len() == 1, Error::InvalidAccount)?;
            input.end()?;
            let vault = next_account_info(&mut it)?;
            let mut c = load_config(program, vault)?;
            require(
                c.pending_publisher != Pubkey::default(),
                Error::NoPendingRole,
            )?;
            require(now()? >= c.publisher_at, Error::Waiting)?;
            c.publisher = c.pending_publisher;
            c.pending_publisher = Pubkey::default();
            c.publisher_at = 0;
            store(vault, &c)
        }
        _ => Err(Error::InvalidData.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_conserves_full_range() {
        for n in (0..=10000).chain([u64::MAX, u64::MAX - 1, 1_000_000_000]) {
            let (h, o, d) = split(n);
            assert_eq!(u128::from(h) + u128::from(o) + u128::from(d), u128::from(n));
            assert!(d <= 1);
        }
        assert_eq!(split(1_000_000_000), (850_000_000, 150_000_000, 0));
    }
    #[test]
    fn merkle_domain_and_sum_binding() {
        let p = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        let w = Pubkey::new_unique();
        let a = leaf(&p, &c, 1, &w, 100);
        let b = leaf(&p, &c, 1, &Pubkey::new_unique(), 200);
        assert_eq!(parent(a, b).unwrap(), parent(b, a).unwrap());
        assert_eq!(parent(a, b).unwrap().sum, 300);
        assert_ne!(a, leaf(&p, &c, 2, &w, 100));
        assert_ne!(a, leaf(&Pubkey::new_unique(), &c, 1, &w, 100));
        assert_ne!(
            parent(a, b).unwrap().hash,
            parent(a, Node { sum: 201, ..b }).unwrap().hash
        );
        assert!(parent(Node { sum: u64::MAX, ..a }, b).is_err());
    }
    #[test]
    fn strict_decoder() {
        assert!(process_instruction(&Pubkey::new_unique(), &[], &[]).is_err());
        assert!(process_instruction(&Pubkey::new_unique(), &[], &[255]).is_err());
        assert!(Reader(&[1]).u64().is_err());
        assert!(Reader(&[1]).end().is_err());
    }
}
