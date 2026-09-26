"""Compiled REBOUND V3 SBF program in LiteSVM (real SPL Token program; synthetic wallets/mints).

Covers spec §19 "Launch, buyback and program": holder-only primary deposits are not split,
third-party credits split once 85/15, immutable rounds with timing enforced on-chain, exact
recipients, replay-proof receipts, snapshot-locked awards (no fresh holding check), pause,
authority rotation, cross-coin isolation, buyback targets that cannot be retargeted, burn only
after purchase with real supply reduction, and conservation after every step.
Third-party activation and the Pump swap CPI need the cloned Pump programs (M4 lifecycle test);
here those two facts are fixture-set and labelled as such.
"""
import hashlib, struct
from pathlib import Path
import pytest
from solders.account import Account
from solders.instruction import Instruction, AccountMeta
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.message import Message
from solders.transaction import VersionedTransaction
from solders.transaction_metadata import TransactionMetadata, FailedTransactionMetadata
from solders.litesvm import LiteSVM

PROGRAM=Pubkey.from_bytes(hashlib.sha256(b'rebound-v3-test-program-only').digest())
SYSTEM=Pubkey.default();LOADER=Pubkey.from_string('BPFLoaderUpgradeab1e11111111111111111111111')
TOKEN=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');ATA=Pubkey.from_string('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
IXSYS=Pubkey.from_string('Sysvar1nstructions1111111111111111111111111');ED=Pubkey.from_string('Ed25519SigVerify111111111111111111111111111')
SO=Path(__file__).parents[1]/'target/deploy/rebound_rewards_v3.so'
T0=1_800_000_000
def h(*x):return hashlib.sha256(b''.join(x)).digest()
def u(x):return struct.pack('<Q',x)
def i64(x):return struct.pack('<q',x)
def u32(x):return struct.pack('<I',x)
def u16(x):return struct.pack('<H',x)
def pd(*s,program=PROGRAM):return Pubkey.find_program_address(list(s),program)[0]
def m(k,w=False,s=False):return AccountMeta(k,s,w)
def ix(tag,keys,*data):return Instruction(PROGRAM,bytes([tag])+b''.join(data),keys)
def err(result,code):return isinstance(result,FailedTransactionMetadata) and f'Custom({code})' in str(result.err())
E={n:300+k for k,n in enumerate('Unauthorized Account Data Arithmetic Funds Paused Round Proof Settled Stale Kind Inactive TooSoon TooLate Routing Buyback Burn'.split())}
def attestation(kp,msg):
    data=bytes([1,0])+struct.pack('<7H',48,65535,16,65535,112,len(msg),65535)+bytes(kp.pubkey())+bytes(kp.sign_message(msg))+msg
    return Instruction(ED,data,[])
def leaf(coin_mint,deployment,policy,cycle,index,wallet,n):
    return (h(b'REBOUND:leaf:v3',bytes(PROGRAM),bytes(deployment),bytes(coin_mint),policy,u(cycle),u32(index),bytes(wallet),u(n)),n)
def parent(a,b):
    l,r=(a,b) if (a[0],a[1])<=(b[0],b[1]) else (b,a)
    return (h(b'REBOUND:node:v3',l[0],u(l[1]),r[0],u(r[1])),l[1]+r[1])
def tree(leaves):
    levels=[leaves]
    while len(levels[-1])>1:
        l=levels[-1];levels.append([parent(l[k],l[k+1]) if k+1<len(l) else l[k] for k in range(0,len(l),2)])
    proofs=[]
    for idx in range(len(leaves)):
        p=[];j=idx
        for lv in levels[:-1]:
            if j^1<len(lv):p.append(lv[j^1])
            j//=2
        proofs.append(p)
    return levels[-1][0],proofs
def nodes(p):return u32(len(p))+b''.join(x[0]+u(x[1]) for x in p)
COIN=struct.Struct('<8s32sB32s32s?qqq32s32sQQQQQQQQBQQ')
FIELDS='magic mint kind deployment policy active anchor cycle_seconds cutoff_lead funding_wallet launcher receipts deposits holder_unallocated holder_reserved holder_paid buyback_available buyback_reserved buyback_spent split_carry last_cycle next_job'.split()
JOB=struct.Struct('<8s32sQQ32s32sQQBQQQHHQQ')
JOBF='magic coin id cycle target_mint target_token_program config_version budget state spent acquired burned max_slippage_bps max_impact_bps purchase_slot burn_slot'.split()

class Env:
    def __init__(self,test_mode=False):
        self.svm=LiteSVM();self.svm.add_program_from_file(PROGRAM,SO)
        self.admin,self.publisher,self.verifier,self.guardian,self.dev,self.alice,self.bob,self.cranker=[Keypair() for _ in range(8)]
        for k in [self.admin,self.publisher,self.verifier,self.guardian,self.dev,self.alice,self.bob,self.cranker]:self.svm.airdrop(k.pubkey(),500_000_000_000)
        self.clock(1000,T0)
        program_data=pd(bytes(PROGRAM),program=LOADER)
        self.svm.set_account(PROGRAM,Account(1_000_000,u32(2)+bytes(program_data),LOADER,True))
        self.svm.set_account(program_data,Account(10_000_000,u32(3)+u(0)+b'\1'+bytes(self.admin.pubkey()),LOADER))
        self.deployment=pd(b'deployment-v3');self.policy=h(b'rebound-v3.0' if not test_mode else b'rebound-v3.0-test')
        r=self.send(ix(0,[m(self.admin.pubkey(),True,True),m(self.deployment,True),m(PROGRAM),m(program_data),m(SYSTEM)],*[bytes(k.pubkey()) for k in [self.publisher,self.verifier,self.guardian]],self.policy,bytes([1 if test_mode else 0])))
        assert isinstance(r,TransactionMetadata),r
    def clock(self,slot=None,time=None):
        c=self.svm.get_clock()
        if slot is not None:c.slot=slot
        if time is not None:c.unix_timestamp=time
        self.svm.set_clock(c)
    def now(self):return self.svm.get_clock().unix_timestamp
    def send(self,instructions,*signers,payer=None):
        self.svm.expire_blockhash();payer=payer or self.admin
        if isinstance(instructions,Instruction):instructions=[instructions]
        msg=Message.new_with_blockhash(instructions,payer.pubkey(),self.svm.latest_blockhash())
        keys={str(k.pubkey()):k for k in [payer,*signers]};tx=VersionedTransaction(msg,list(keys.values()))
        assert len(bytes(tx))<=1232,len(bytes(tx))
        return self.svm.send_transaction(tx)
    def mint(self,supply=0,decimals=6):
        k=Pubkey.new_unique();d=bytearray(82);d[36:44]=u(supply);d[44]=decimals;d[45]=1
        self.svm.set_account(k,Account(1_461_600,bytes(d),TOKEN));return k
    def coin_state(self,coin):return dict(zip(FIELDS,COIN.unpack_from(self.svm.get_account(coin).data,0)))
    def put_coin(self,coin,**changes):
        a=self.svm.get_account(coin);s=self.coin_state(coin);s.update(changes);d=bytearray(a.data);COIN.pack_into(d,0,*[s[f] for f in FIELDS])
        self.svm.set_account(coin,Account(a.lamports,bytes(d),PROGRAM))
    def conserved(self,coin):
        s=self.coin_state(coin);holders=s['holder_unallocated']+s['holder_reserved']+s['holder_paid'];buy=s['buyback_available']+s['buyback_reserved']+s['buyback_spent']
        rent=self.svm.minimum_balance_for_rent_exemption(384)
        assert self.svm.get_account(coin).lamports>=rent+s['holder_unallocated']+s['holder_reserved']+s['buyback_available']
        assert (s['deposits']==holders and s['receipts']==0 and buy==0) if s['kind']==0 else (s['receipts']==holders+buy and s['deposits']==0)
        return s
    # ---- primary ----
    def primary(self,start=True):
        self.pmint=self.mint(10**15);self.pcoin=pd(b'coin-v3',bytes(self.pmint))
        assert isinstance(self.send(ix(1,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.pcoin,True),m(self.pmint),m(SYSTEM)],bytes(self.dev.pubkey()))),TransactionMetadata)
        if start:assert isinstance(self.send(ix(2,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.pcoin,True)])),TransactionMetadata)
        return self.pcoin
    def deposit(self,amount,signer=None,coin=None):
        s=signer or self.dev;return self.send(ix(4,[m(s.pubkey(),True,True),m(self.deployment),m(coin or self.pcoin,True),m(SYSTEM)],u(amount)),payer=s)
    def fund(self,coin,mint,cycle,awards,signers=None,cutoff_slot=None):
        leaves=[leaf(mint,self.deployment,self.policy,cycle,k,w,n) for k,(w,n) in enumerate(awards)];root,proofs=tree(leaves)
        rnd=pd(b'round-v3',bytes(coin),u(cycle));signers=signers or [self.publisher,self.verifier]
        r=self.send(ix(10,[m(self.admin.pubkey(),True,True),m(signers[0].pubkey(),False,True),m(signers[1].pubkey(),False,True),m(self.deployment),m(coin,True),m(rnd,True),m(SYSTEM)],
            u(cycle),root[0],u(root[1]),u32(len(awards)),u(cutoff_slot if cutoff_slot is not None else self.svm.get_clock().slot),h(b'snapshot',u(cycle)),h(b'manifest',u(cycle))),*signers)
        return r,rnd,proofs
    def pay(self,coin,rnd,cycle,index,wallet,amount,proof):
        # Permissionless: no signer; the cranker only pays the transaction fee. Paid flags are bits in the round.
        return self.send(ix(11,[m(self.deployment),m(coin,True),m(rnd,True),m(wallet,True)],u(cycle),u32(index),u(amount),nodes(proof)),payer=self.cranker)
    def close_round(self,coin,rnd,cycle,rent_to):
        return self.send(ix(21,[m(self.deployment),m(coin),m(rnd,True),m(rent_to,True)],u(cycle)),payer=self.cranker)
    # ---- third party (activation fixture-set; see module docstring) ----
    def third_party(self,fund_intake=0):
        mk=Keypair();self.tmint=mk.pubkey();self.tcoin=pd(b'coin-v3',bytes(self.tmint));self.intake=pd(b'intake-v3',bytes(self.tmint))
        r=self.send(ix(5,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.tcoin,True),m(self.intake,True),m(self.tmint,False,True),m(SYSTEM)]),mk);assert isinstance(r,TransactionMetadata),r
        d=bytearray(82);d[44]=6;d[45]=1;self.svm.set_account(self.tmint,Account(1_461_600,bytes(d),TOKEN))
        self.put_coin(self.tcoin,active=True)          # FIXTURE: normally set by LockSharing/Activate against Pump
        if fund_intake:self.svm.set_account(self.intake,Account(fund_intake,b'',SYSTEM))
        return self.tcoin
    def credit(self,amount,identity=b'receipt',verifier=None):
        slot=self.svm.get_clock().slot;sig=h(identity)*2;path=h(b'0/1')
        msg=b'RBD3RCPT'+bytes(PROGRAM)+bytes(self.deployment)+bytes(self.tmint)+b'\0'+sig+path+u(amount)+u(slot)+u(slot)+u(slot+20)
        event=h(b'REBOUND:receipt:v3',sig,path,bytes(self.tmint));rcpt=pd(b'receipt-v3',bytes(self.tcoin),event)
        return self.send([attestation(verifier or self.verifier,msg),ix(9,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.tcoin,True),m(self.intake,True),m(rcpt,True),m(SYSTEM),m(IXSYS)],msg)])

def ok(r):assert isinstance(r,TransactionMetadata),str(r)

@pytest.fixture
def env():return Env()

def test_primary_holder_only_deposit_is_never_split(env):
    e=env;coin=e.primary();ok(e.deposit(850_000_000))
    s=e.conserved(coin);assert (s['deposits'],s['holder_unallocated'],s['buyback_available'],s['receipts'],s['split_carry'])==(850_000_000,850_000_000,0,0,0)
    assert err(e.deposit(1,signer=e.alice),E['Unauthorized'])        # only the registered dev funding wallet
    assert s['anchor']==T0 and s['cycle_seconds']==1800 and s['cutoff_lead']==60

def test_third_party_credit_splits_once_85_15_and_receipts_cannot_replay(env):
    e=env;coin=e.third_party(fund_intake=2_000_000_000);ok(e.credit(1_000_000_000))
    s=e.conserved(coin);assert (s['receipts'],s['holder_unallocated'],s['buyback_available'])==(1_000_000_000,850_000_000,150_000_000)
    assert err(e.credit(1_000_000_000),E['Settled'])                  # same source event
    assert err(e.credit(1,identity=b'other',verifier=e.publisher),E['Unauthorized'])
    assert err(e.deposit(1,coin=coin),E['Kind'])                      # holder-only deposits are primary-only

def test_round_timing_is_enforced_on_chain(env):
    e=env;coin=e.primary();ok(e.deposit(1_000_000_000));cutoff1=T0+1800-60
    e.clock(time=cutoff1-1);r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),10)]);assert err(r,E['TooSoon'])
    e.clock(time=cutoff1+1800);r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),10)]);assert err(r,E['TooLate'])   # window closed at cutoff(2)
    e.clock(time=cutoff1+10);r,rnd,proofs=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),10)]);ok(r)
    assert err(e.pay(coin,rnd,1,0,e.alice.pubkey(),10,proofs[0]),E['TooSoon'])         # before scheduled_end(1)
    e.clock(time=T0+1800);ok(e.pay(coin,rnd,1,0,e.alice.pubkey(),10,proofs[0]))
    r,_,_=e.fund(coin,e.pmint,1,[(e.bob.pubkey(),1)]);assert not isinstance(r,TransactionMetadata)  # cycle already funded

def test_awards_pay_exact_recipients_once_and_survive_later_sales(env):
    e=env;coin=e.primary();ok(e.deposit(1_000_000_000));e.clock(time=T0+1800-60)
    awards=[(e.alice.pubkey(),500_000_000),(e.bob.pubkey(),250_000_000),(Pubkey.new_unique(),100_000_000)]
    r,rnd,proofs=e.fund(coin,e.pmint,1,awards);ok(r)
    s=e.conserved(coin);assert (s['holder_unallocated'],s['holder_reserved'])==(150_000_000,850_000_000)
    e.clock(time=T0+1800)
    # Alice holds no tokens at all now (sold after the cutoff): the frozen award is still paid.
    before=e.svm.get_balance(e.alice.pubkey());ok(e.pay(coin,rnd,1,0,e.alice.pubkey(),500_000_000,proofs[0]))
    assert e.svm.get_balance(e.alice.pubkey())-before==500_000_000
    assert err(e.pay(coin,rnd,1,0,e.alice.pubkey(),500_000_000,proofs[0]),E['Settled'])   # replay
    assert err(e.pay(coin,rnd,1,1,e.alice.pubkey(),250_000_000,proofs[1]),E['Proof'])     # wrong recipient
    assert err(e.pay(coin,rnd,1,1,e.bob.pubkey(),250_000_001,proofs[1]),E['Proof'])       # wrong amount
    ok(e.pay(coin,rnd,1,1,e.bob.pubkey(),250_000_000,proofs[1]))
    assert err(e.close_round(coin,rnd,1,e.admin.pubkey()),E['Round'])                      # not everything paid yet
    ok(e.pay(coin,rnd,1,2,awards[2][0],100_000_000,proofs[2]))                          # brand-new account, above rent minimum
    s=e.conserved(coin);assert (s['holder_reserved'],s['holder_paid'])==(0,850_000_000)
    # Round account = 320-byte header + 1 bit per award (3 awards -> 1 byte); no account per recipient.
    assert len(e.svm.get_account(rnd).data)==321
    assert err(e.close_round(coin,rnd,1,e.bob.pubkey()),E['Account'])                     # rent goes back only to its payer
    rent=e.svm.get_balance(rnd);before=e.svm.get_balance(e.admin.pubkey())
    ok(e.close_round(coin,rnd,1,e.admin.pubkey()))
    assert e.svm.get_balance(e.admin.pubkey())-before==rent and e.svm.get_balance(rnd) in (0,None)
    assert err(e.pay(coin,rnd,1,0,e.alice.pubkey(),500_000_000,proofs[0]),E['Account'])   # closed round cannot pay again

def test_funding_cannot_exceed_holder_reserve_or_skip_signers(env):
    e=env;coin=e.primary();ok(e.deposit(100));e.clock(time=T0+1800-60)
    r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),101)]);assert err(r,E['Funds'])
    r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),50)],signers=[e.publisher,e.alice]);assert err(r,E['Unauthorized'])
    r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),50)],signers=[e.alice,e.verifier]);assert err(r,E['Unauthorized'])
    e.clock(slot=1000);r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),50)],cutoff_slot=5000);assert err(r,E['Round'])   # cutoff slot in the future

def test_pause_blocks_funding_and_payment_and_resume_is_delayed(env):
    e=env;coin=e.primary();ok(e.deposit(1000));e.clock(time=T0+1800-60);r,rnd,proofs=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),1000)]);ok(r)
    ok(e.send(ix(12,[m(e.guardian.pubkey(),False,True),m(e.deployment,True)]),e.guardian))
    e.clock(time=T0+1800);assert err(e.pay(coin,rnd,1,0,e.alice.pubkey(),1000,proofs[0]),E['Paused']);assert err(e.deposit(1),E['Paused'])
    assert err(e.send(ix(14,[m(e.admin.pubkey(),True,True),m(e.deployment,True)])),E['TooSoon'])
    ok(e.send(ix(13,[m(e.admin.pubkey(),True,True),m(e.deployment,True)])));e.clock(time=T0+1800+86400)
    ok(e.send(ix(14,[m(e.admin.pubkey(),True,True),m(e.deployment,True)])));ok(e.pay(coin,rnd,1,0,e.alice.pubkey(),1000,proofs[0]))
    assert err(e.send(ix(12,[m(e.alice.pubkey(),True,True),m(e.deployment,True)]),payer=e.alice),E['Unauthorized'])

def test_authority_rotation_requires_admin_and_pause(env):
    e=env;new=[Keypair() for _ in range(3)];args=b''.join(bytes(k.pubkey()) for k in new)
    assert err(e.send(ix(15,[m(e.admin.pubkey(),True,True),m(e.deployment,True)],args)),E['Paused'])
    ok(e.send(ix(12,[m(e.admin.pubkey(),True,True),m(e.deployment,True)])))
    assert err(e.send(ix(15,[m(e.alice.pubkey(),True,True),m(e.deployment,True)],args),payer=e.alice),E['Unauthorized'])
    ok(e.send(ix(15,[m(e.admin.pubkey(),True,True),m(e.deployment,True)],args)))

def test_coins_cannot_cross_fund_or_pay_each_other(env):
    e=env;a=e.primary();ok(e.deposit(1000));b=e.third_party(fund_intake=10_000_000);ok(e.credit(1000))
    e.clock(time=T0+1800-60);r,rnd,proofs=e.fund(a,e.pmint,1,[(e.alice.pubkey(),1000)]);ok(r);e.clock(time=T0+1800)
    assert not isinstance(e.pay(b,rnd,1,0,e.alice.pubkey(),1000,proofs[0]),TransactionMetadata)   # other coin's treasury
    sb=e.conserved(b);assert sb['holder_unallocated']==850 and sb['holder_paid']==0
    ok(e.pay(a,rnd,1,0,e.alice.pubkey(),1000,proofs[0]));e.conserved(a);e.conserved(b)

def test_test_mode_deployment_uses_isolated_120_30_schedule():
    e=Env(test_mode=True);coin=e.primary();s=e.coin_state(coin);assert (s['cycle_seconds'],s['cutoff_lead'])==(120,30)
    ok(e.deposit(10));e.clock(time=T0+120-31);r,_,_=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),10)]);assert err(r,E['TooSoon'])
    e.clock(time=T0+90);r,rnd,proofs=e.fund(coin,e.pmint,1,[(e.alice.pubkey(),10)]);ok(r)

def reserve(e,amount,cycle=1):
    s=e.coin_state(e.tcoin);job=pd(b'buyback-v3',bytes(e.tcoin),u(s['next_job']));buyer=pd(b'buyer-v3',bytes(job))
    r=e.send(ix(17,[m(e.admin.pubkey(),True,True),m(e.publisher.pubkey(),False,True),m(e.deployment),m(e.tcoin,True),m(job,True),m(buyer,True),m(SYSTEM)],u(cycle),u(amount),u16(100),u16(200)),e.publisher)
    return r,job,buyer
def set_target(e,mint):return e.send(ix(16,[m(e.admin.pubkey(),True,True),m(e.deployment,True),m(mint)],bytes(mint)))

def test_buyback_reserves_only_the_15_percent_and_jobs_keep_their_target(env):
    e=env;e.primary(start=False);e.third_party(fund_intake=2_000_000_000);ok(e.credit(1_000_000_000))
    r,_,_=reserve(e,1);assert err(r,E['Buyback'])                            # no target configured yet
    ok(set_target(e,e.pmint));r,job,buyer=reserve(e,150_000_001);assert err(r,E['Funds'])   # more than the buyback reserve
    r,job,buyer=reserve(e,150_000_000);ok(r)
    s=e.conserved(e.tcoin);assert (s['buyback_available'],s['buyback_reserved'],s['holder_unallocated'])==(0,150_000_000,850_000_000)
    assert e.svm.get_balance(buyer)==150_000_000+e.svm.minimum_balance_for_rent_exemption(0)
    j=dict(zip(JOBF,JOB.unpack_from(e.svm.get_account(job).data,0)));assert (j['target_mint'],j['budget'],j['config_version'])==(bytes(e.pmint),150_000_000,1)
    other=e.mint(1);ok(set_target(e,other))                                   # prospective change
    j2=dict(zip(JOBF,JOB.unpack_from(e.svm.get_account(job).data,0)));assert j2['target_mint']==bytes(e.pmint)
    assert err(e.send(ix(19,[m(e.deployment),m(e.tcoin),m(job,True),m(buyer),m(Pubkey.new_unique(),True),m(e.pmint,True),m(TOKEN)])),E['Burn'])   # nothing purchased: cannot burn

def test_burn_is_a_real_supply_reduction_and_only_the_burn_retries(env):
    e=env;e.primary(start=False);e.third_party(fund_intake=2_000_000_000);ok(e.credit(1_000_000_000));ok(set_target(e,e.pmint))
    r,job,buyer=reserve(e,150_000_000);ok(r)
    # FIXTURE for the Pump swap CPI (exercised against cloned Pump programs in M4): 140_000_000 lamports
    # spent, 1_000_000 target tokens acquired into the buyer's ATA.
    acc=e.svm.get_account(job);j=dict(zip(JOBF,JOB.unpack_from(acc.data,0)));j.update(state=1,spent=140_000_000,acquired=1_000_000,purchase_slot=1000)
    d=bytearray(acc.data);JOB.pack_into(d,0,*[j[f] for f in JOBF]);e.svm.set_account(job,Account(acc.lamports,bytes(d),PROGRAM))
    e.svm.set_account(buyer,Account(e.svm.get_balance(buyer)-140_000_000,b'',SYSTEM))
    holding=Pubkey.find_program_address([bytes(buyer),bytes(TOKEN),bytes(e.pmint)],ATA)[0]
    t=bytearray(165);t[:32]=bytes(e.pmint);t[32:64]=bytes(buyer);t[64:72]=u(1_000_000);t[108]=1;e.svm.set_account(holding,Account(2_039_280,bytes(t),TOKEN))
    supply=struct.unpack_from('<Q',e.svm.get_account(e.pmint).data,36)[0]
    burn=ix(19,[m(e.deployment),m(e.tcoin),m(job,True),m(buyer),m(holding,True),m(e.pmint,True),m(TOKEN)])
    assert err(e.send(ix(18,[m(e.publisher.pubkey(),False,True),m(e.deployment),m(e.tcoin),m(job,True),m(buyer,True)]+[m(Pubkey.new_unique()) for _ in range(16)],u(1)),e.publisher),E['Buyback'])  # purchased job never buys again
    ok(e.send(burn))
    assert struct.unpack_from('<Q',e.svm.get_account(e.pmint).data,36)[0]==supply-1_000_000
    assert struct.unpack_from('<Q',e.svm.get_account(holding).data,64)[0]==0
    assert err(e.send(burn),E['Burn'])                                         # burn is final
    close=ix(20,[m(e.cranker.pubkey(),True,True),m(e.deployment),m(e.tcoin,True),m(job,True),m(buyer,True),m(SYSTEM)])
    ok(e.send(close,payer=e.cranker))
    s=e.conserved(e.tcoin);assert (s['buyback_available'],s['buyback_reserved'],s['buyback_spent'])==(10_000_000,0,140_000_000)
    assert e.svm.get_balance(buyer) in (None,0)                                # buyer PDA fully drained (account removed)
    assert not isinstance(e.send(close,payer=e.cranker),TransactionMetadata)
