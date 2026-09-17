"""Real compiled REBOUND SBF execution; synthetic wallets/receipts/market facts.

Receipt attestations here are fixtures, not evidence of Pump collection. The
separate test_pump_lifecycle executes the cloned deployed Pump programs.
"""
import hashlib, json, os, struct, subprocess, base64
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
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import transfer
ROOT=Path(__file__).parents[3]
PROGRAM=Pubkey.from_bytes(hashlib.sha256(b'rebound-v2-test-program-only').digest())
SYSTEM=Pubkey.default(); LOADER=Pubkey.from_string('BPFLoaderUpgradeab1e11111111111111111111111')
TOKEN=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
IXSYS=Pubkey.from_string('Sysvar1nstructions1111111111111111111111111')
ED=Pubkey.from_string('Ed25519SigVerify111111111111111111111111111')
def h(*x):return hashlib.sha256(b''.join(x)).digest()
def u(x):return struct.pack('<Q',x)
def i(x):return struct.pack('<I',x)
def pd(*s,program=PROGRAM):return Pubkey.find_program_address(list(s),program)[0]
def m(k,w=False,s=False):return AccountMeta(k,s,w)
def ix(tag,keys,*data):return Instruction(PROGRAM,bytes([tag])+b''.join(data),keys)
def attestation(kp,msg):
    # Same offsets as web3 Ed25519Program.createInstructionWithPublicKey.
    data=bytes([1,0])+struct.pack('<7H',48,65535,16,65535,112,len(msg),65535)+bytes(kp.pubkey())+bytes(kp.sign_message(msg))+msg
    return Instruction(ED,data,[])
class Env:
    def __init__(self):
        self.history=[]
        self.svm=LiteSVM();self.svm.add_program_from_file(PROGRAM,Path(__file__).parents[1]/'target/deploy/rebound_rewards_v2.so')
        self.admin,self.publisher,self.verifier,self.guardian,self.ops,self.alice,self.bob=[Keypair() for _ in range(7)]
        for k in [self.admin,self.publisher,self.verifier,self.guardian,self.ops,self.alice,self.bob]:self.svm.airdrop(k.pubkey(),200_000_000_000)
        self.set_clock(1000,1_800_000_000)
        # Upgradeable-loader authority fixture, checked by Initialize.
        program_data=pd(bytes(PROGRAM),program=LOADER)
        self.svm.set_account(PROGRAM,Account(1_000_000,i(2)+bytes(program_data),LOADER,True))
        self.svm.set_account(program_data,Account(10_000_000,i(3)+u(0)+b'\1'+bytes(self.admin.pubkey()),LOADER))
        self.deployment=pd(b'deployment-v2');self.policy=h(b'test-policy-v2')
        self.send(ix(0,[m(self.admin.pubkey(),True,True),m(self.deployment,True),m(PROGRAM),m(program_data),m(SYSTEM)],*[bytes(k.pubkey()) for k in [self.publisher,self.verifier,self.guardian,self.ops]],self.policy))
    def set_clock(self,slot,time=None):
        c=self.svm.get_clock();c.slot=slot
        if time is not None:c.unix_timestamp=time
        self.svm.set_clock(c)
    def send(self,instructions,*signers,ok=True,payer=None):
        self.svm.expire_blockhash();payer=payer or self.admin
        if isinstance(instructions,Instruction):instructions=[instructions]
        message=Message.new_with_blockhash(instructions,payer.pubkey(),self.svm.latest_blockhash())
        keys={str(k.pubkey()):k for k in [payer,*signers]};tx=VersionedTransaction(message,list(keys.values()))
        self.last_signature=bytes(tx.signatures[0])
        assert len(bytes(tx))<=1232, len(bytes(tx))
        def accounts():
            rows=[]
            for key in message.account_keys:
                a=self.svm.get_account(key)
                rows.append(None if a is None else {'address':str(key),'owner':str(a.owner),'lamports':a.lamports,'data':base64.b64encode(a.data).decode() if len(a.data)<4096 else None})
            return rows
        before=accounts()
        result=self.svm.send_transaction(tx)
        assert isinstance(result,TransactionMetadata if ok else FailedTransactionMetadata),str(result)
        if ok:
            def instruction(ci,depth=1):
                return {'programId':str(message.account_keys[ci.program_id_index]),'accounts':[str(message.account_keys[x]) for x in ci.accounts],'data64':base64.b64encode(ci.data).decode(),'stackHeight':depth}
            self.history.append({'signature':str(tx.signatures[0]),'slot':self.svm.get_clock().slot,'time':self.svm.get_clock().unix_timestamp,'packetBytes':len(bytes(tx)),'keys':[str(k) for k in message.account_keys],'instructions':[instruction(ci) for ci in message.instructions],'innerInstructions':[{'index':n,'instructions':[instruction(ci.instruction(),ci.stack_height()) for ci in group]} for n,group in enumerate(result.inner_instructions())],'before':before,'after':accounts(),'logs':result.logs()})
        return result
    def prepare(self,send=True):
        self.mint=Keypair();self.coin=pd(b'coin-v2',bytes(self.mint.pubkey()));self.intake=pd(b'intake-v2',bytes(self.mint.pubkey()))
        instruction=ix(1,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.coin,True),m(self.intake,True),m(self.mint.pubkey(),False,True),m(SYSTEM)])
        if send:self.send(instruction,self.mint)
        return instruction
    def fixture_active(self):
        self.prepare();a=self.svm.get_account(self.coin);d=bytearray(a.data);d[168]=1;self.svm.set_account(self.coin,Account(a.lamports,bytes(d),PROGRAM))
        d=bytearray(82);d[44:46]=b'\6\1';self.svm.set_account(self.mint.pubkey(),Account(2_000_000,bytes(d),TOKEN))
        self.send(transfer({'from_pubkey':self.admin.pubkey(),'to_pubkey':self.intake,'lamports':10_001_000_000}))
    def credit(self,n=10_000_000_000,identity=b'fixture-receipt',ok=True,source_signature=None,instruction_path=None):
        sig=source_signature or h(identity)*2;path=instruction_path or h(b'0/1');slot=self.svm.get_clock().slot
        msg=b'RBD2RCPT'+bytes(PROGRAM)+bytes(self.deployment)+bytes(self.mint.pubkey())+b'\0'+sig+path+u(n)+u(slot)+u(slot)+u(slot+20)
        event=h(b'REBOUND:receipt:v2',sig,path,bytes(self.mint.pubkey()));self.receipt=pd(b'receipt-v2',bytes(self.coin),event)
        self.send([attestation(self.verifier,msg),ix(5,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.coin,True),m(self.intake,True),m(self.receipt,True),m(SYSTEM),m(IXSYS)],msg)],ok=ok)
    def fund(self,amount=2_000_000_000,wallet=None):
        self.wallet=wallet or self.alice.pubkey();self.amount=amount;self.index=0;self.rid=self.svm.get_clock().unix_timestamp//1800
        self.round=pd(b'round-v2',bytes(self.coin),u(self.rid));self.position=pd(b'position-v2',bytes(self.coin),bytes(self.wallet));self.award=pd(b'award-v2',bytes(self.round),i(0))
        leaf=h(b'REBOUND:leaf:v2',bytes(PROGRAM),bytes(self.deployment),bytes(self.mint.pubkey()),b'\0',self.policy,u(self.rid),i(0),bytes(self.wallet),u(amount))
        self.send(ix(6,[m(self.admin.pubkey(),True,True),m(self.publisher.pubkey(),False,True),m(self.verifier.pubkey(),False,True),m(self.deployment),m(self.coin,True),m(self.round,True),m(SYSTEM)],u(self.rid),leaf,u(amount),u(self.svm.get_clock().slot),u(self.svm.get_clock().unix_timestamp),h(b'manifest')),self.publisher,self.verifier)
        self.register_ix=ix(7,[m(self.admin.pubkey(),True,True),m(self.deployment),m(self.coin,True),m(self.round,True),m(self.position,True),m(self.award,True),m(self.wallet),m(SYSTEM)],i(0),u(amount),i(0))
        self.send(self.register_ix)
        self.token=Pubkey.new_unique();d=bytearray(165);d[:32]=bytes(self.mint.pubkey());d[32:64]=bytes(self.wallet);d[64:72]=u(1_000_000);d[108]=1
        self.svm.set_account(self.token,Account(2_100_000,bytes(d),TOKEN))
    def payment(self,payable=None,outcome=0,cost=10_000_000_000,value=7_000_000_000,version=1,through=None,expires=None,recipient=None,verifier=None,epoch=1):
        slot=self.svm.get_clock().slot;payable=self.amount if payable is None else payable;through=slot if through is None else through;expires=slot+20 if expires is None else expires
        recipient=recipient or self.wallet
        msg=b'RBD2PAY0'+bytes(PROGRAM)+bytes(self.deployment)+bytes(self.mint.pubkey())+b'\0'+u(self.rid)+i(self.index)+bytes(recipient)+b''.join(u(n) for n in [self.amount,payable,cost,value,1_000_000,through,slot,expires,version,epoch])+bytes([outcome])+h(b'fresh-evidence')
        return[attestation(verifier or self.verifier,msg),ix(8,[m(self.deployment),m(self.coin,True),m(self.round,True),m(self.position,True),m(self.award,True),m(recipient,True),m(IXSYS),m(self.token)],msg)]
    def balances(self):
        d=self.svm.get_account(self.coin).data;return struct.unpack_from('<6Q',d,169)

@pytest.fixture
def env():
    e=Env();e.fixture_active();e.credit();e.fund();return e

def test_happy_sol_payment_and_operations(env):
    e=env;a=e.svm.get_balance(e.wallet);e.send(e.payment());assert e.svm.get_balance(e.wallet)-a==2_000_000_000
    assert e.balances()==(10_000_000_000,6_500_000_000,0,2_000_000_000,1_500_000_000,0)
    before=e.svm.get_balance(e.ops.pubkey());e.send(ix(9,[m(e.deployment),m(e.coin,True),m(e.ops.pubkey(),True)]));assert e.svm.get_balance(e.ops.pubkey())-before==1_500_000_000
    e.send(e.payment(),ok=False);e.send(e.register_ix,ok=False);e.credit(ok=False)

def test_sale_cancel_and_replay(env):
    e=env;before=e.svm.get_balance(e.wallet);old=e.payment();e.send(e.payment(0,outcome=1));assert e.svm.get_balance(e.wallet)==before
    assert e.balances()==(10_000_000_000,8_500_000_000,0,0,1_500_000_000,0);e.send(old,ok=False)
    assert e.svm.get_account(e.position).data[96]==1

def test_price_recovery_reduces_and_releases_once(env):
    e=env;old=e.payment();e.send(e.payment(500_000_000,outcome=2,value=9_500_000_000));assert e.balances()==(10_000_000_000,8_000_000_000,0,500_000_000,1_500_000_000,0)
    assert e.svm.get_account(e.position).data[96]==0;e.send(old,ok=False)

@pytest.mark.parametrize('kwargs',[{'version':0},{'through':903},{'expires':1021},{'recipient':Pubkey.new_unique()}])
def test_stale_or_substituted_authorization(env,kwargs):
    before=env.balances();env.send(env.payment(**kwargs),ok=False);assert env.balances()==before

def test_missing_verifier_holds_reservation_and_expiry(env):
    before=env.balances();env.send(env.payment()[1],ok=False);env.send(env.payment(verifier=env.publisher),ok=False)
    old=env.payment();env.set_clock(1021);env.send(old,ok=False);assert env.balances()==before

def test_outgoing_holdings_detected_at_execution(env):
    d=bytearray(env.svm.get_account(env.token).data);d[64:72]=u(1);env.svm.set_account(env.token,Account(2_100_000,bytes(d),TOKEN));env.send(env.payment(),ok=False)

def test_unauthorized_ops_and_pause(env):
    e=env;e.send(ix(9,[m(e.deployment),m(e.coin,True),m(e.bob.pubkey(),True)]),ok=False)
    e.send(ix(11,[m(e.guardian.pubkey(),False,True),m(e.deployment,True)]),e.guardian);e.send(e.payment(),ok=False)
    e.send(e.payment(0,outcome=1));assert e.balances()[1]==8_500_000_000

def test_residual_finalized_gap_is_not_claimed_as_instantaneous(env):
    # Replaced token holdings and an unreported sell can pass the direct balance
    # check. This test explicitly records the offchain completeness trust limit.
    env.send(env.payment());assert env.balances()[3]==2_000_000_000

def test_three_coins_have_isolated_fee_accounts():
    e=Env();accounts=[]
    for receipt,holders,ops in [(10_000_000_000,8_500_000_000,1_500_000_000),(800_000_000,680_000_000,120_000_000),(6_300_000_000,5_355_000_000,945_000_000)]:
        e.fixture_active();e.credit(receipt,identity=bytes(e.mint.pubkey()));assert e.balances()==(receipt,holders,0,0,ops,0);accounts.append((e.coin,e.balances()))
    assert len(set(a[0] for a in accounts))==3
    for account,expected in accounts:assert struct.unpack_from('<6Q',e.svm.get_account(account).data,169)==expected

def test_repeated_tiny_collections_preserve_fractional_split():
    e=Env();e.fixture_active()
    for n in range(100):e.credit(1,identity=u(n))
    assert e.balances()==(100,85,0,0,15,0)

def test_recorded_exit_invalidates_already_issued_payment(env):
    e=env;old=e.payment();slot=e.svm.get_clock().slot
    msg=b'RBD2EXIT'+bytes(PROGRAM)+bytes(e.deployment)+bytes(e.mint.pubkey())+b'\0'+u(0)+i(0)+bytes(e.wallet)+b''.join(u(n) for n in [0,0,0,0,0,slot,slot,slot+20,1,0])+b'\1'+h(b'confirmed-exit')
    e.send([attestation(e.verifier,msg),ix(10,[m(e.admin.pubkey(),True,True),m(e.deployment),m(e.coin),m(e.position,True),m(SYSTEM),m(IXSYS)],msg)])
    e.send(old,ok=False);assert e.balances()[2]==e.amount
    e.send(e.payment(0,outcome=1,version=2));assert e.balances()[2]==0

def test_paid_allocation_cannot_also_release(env):
    e=env;cancel=e.payment(0,outcome=1);e.send(e.payment());before=e.balances();e.send(cancel,ok=False);assert e.balances()==before

def test_altered_merkle_amount_and_cross_coin_accounts_fail(env):
    e=env
    bad=ix(7,[m(e.admin.pubkey(),True,True),m(e.deployment),m(e.coin,True),m(e.round,True),m(e.position,True),m(pd(b'award-v2',bytes(e.round),i(1)),True),m(e.wallet),m(SYSTEM)],i(1),u(e.amount+1),i(0))
    e.send(bad,ok=False)
    instructions=e.payment();a=list(instructions[1].accounts);a[1]=m(Pubkey.new_unique(),True);instructions[1]=Instruction(PROGRAM,instructions[1].data,a);e.send(instructions,ok=False)

def test_independent_funding_signer_and_budget_are_enforced():
    e=Env();e.fixture_active();e.credit();rid=e.svm.get_clock().unix_timestamp//1800;round_address=pd(b'round-v2',bytes(e.coin),u(rid))
    def proposal(verifier,amount):return ix(6,[m(e.admin.pubkey(),True,True),m(e.publisher.pubkey(),False,True),m(verifier.pubkey(),False,True),m(e.deployment),m(e.coin,True),m(round_address,True),m(SYSTEM)],u(rid),h(b'root'),u(amount),u(1000),u(e.svm.get_clock().unix_timestamp),h(b'manifest'))
    before=e.balances();e.send(proposal(e.bob,1),e.publisher,e.bob,ok=False);e.send(proposal(e.verifier,8_500_000_001),e.publisher,e.verifier,ok=False);assert e.balances()==before

def test_partial_delivery_and_later_exclusion_carry_release_to_next_round():
    e=Env();e.fixture_active();e.credit();e.rid=e.svm.get_clock().unix_timestamp//1800;e.round=pd(b'round-v2',bytes(e.coin),u(e.rid))
    wallets=[e.alice.pubkey(),e.bob.pubkey()];amounts=[1_000_000_000,2_000_000_000]
    leaves=[h(b'REBOUND:leaf:v2',bytes(PROGRAM),bytes(e.deployment),bytes(e.mint.pubkey()),b'\0',e.policy,u(e.rid),i(n),bytes(wallets[n]),u(amounts[n])) for n in range(2)]
    # The wire client and program canonically sort (hash, sum) pairs. Random
    # fixture wallets must not make the manifest root depend on leaf order.
    nodes=sorted(zip(leaves,amounts),key=lambda node:(node[0],node[1]))
    root=h(b'REBOUND:node:v2',nodes[0][0],u(nodes[0][1]),nodes[1][0],u(nodes[1][1]))
    e.send(ix(6,[m(e.admin.pubkey(),True,True),m(e.publisher.pubkey(),False,True),m(e.verifier.pubkey(),False,True),m(e.deployment),m(e.coin,True),m(e.round,True),m(SYSTEM)],u(e.rid),root,u(sum(amounts)),u(1000),u(e.svm.get_clock().unix_timestamp),h(b'two-conditional-awards')),e.publisher,e.verifier)
    positions=[]
    for n in range(2):
        position=pd(b'position-v2',bytes(e.coin),bytes(wallets[n]));award=pd(b'award-v2',bytes(e.round),i(n));token=Pubkey.new_unique();data=bytearray(165);data[:32]=bytes(e.mint.pubkey());data[32:64]=bytes(wallets[n]);data[64:72]=u(1_000_000);data[108]=1;e.svm.set_account(token,Account(2_100_000,bytes(data),TOKEN))
        e.send(ix(7,[m(e.admin.pubkey(),True,True),m(e.deployment),m(e.coin,True),m(e.round,True),m(position,True),m(award,True),m(wallets[n]),m(SYSTEM)],i(n),u(amounts[n]),i(1),leaves[1-n],u(amounts[1-n])))
        positions.append((position,award,token))
    for n in range(2):
        e.position,e.award,e.token=positions[n];e.wallet=wallets[n];e.amount=amounts[n];e.index=n
        e.send(e.payment() if n==0 else e.payment(0,outcome=1))
    assert e.balances()==(10_000_000_000,7_500_000_000,0,1_000_000_000,1_500_000_000,0)
    e.set_clock(2000,e.svm.get_clock().unix_timestamp+1800);e.fund(1_000_000_000,wallet=wallets[0]);e.send(e.payment(version=3,epoch=2))
    assert e.balances()==(10_000_000_000,6_500_000_000,0,2_000_000_000,1_500_000_000,0)
