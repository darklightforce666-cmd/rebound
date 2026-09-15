"""Execute the compiled program in a Solana VM, including real System Program CPIs."""
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path
import pytest
from solders.account import Account
from solders.instruction import Instruction, AccountMeta
from solders.keypair import Keypair
from solders.litesvm import LiteSVM
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import transfer
from solders.transaction import VersionedTransaction
from solders.transaction_metadata import TransactionMetadata, FailedTransactionMetadata
sys.path.insert(0,str(Path(__file__).parents[1]/'client'))
import rebound as R
import hourly_payouts as worker

TIME=1_800_000_000
TOKEN=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
PROGRAM=Pubkey.from_bytes(bytes(range(32)))
def h(*parts): return hashlib.sha256(b''.join(parts)).digest()
def leaf(vault,rid,wallet,n): return (h(b'REBOUND:leaf:v1',bytes(PROGRAM),bytes(vault),R.u64(rid),bytes(wallet),R.u64(n)),n)
def parent(a,b):
    a,b=sorted([a,b]);return h(b'REBOUND:node:v1',a[0],R.u64(a[1]),b[0],R.u64(b[1])),a[1]+b[1]
class Env:
    def __init__(self,prefund=False):
        self.svm=LiteSVM();self.svm.add_program_from_file(PROGRAM,Path(__file__).parents[1]/'target/deploy/rebound_rewards.so')
        self.admin=Keypair();self.guardian=Keypair();self.ops=Keypair();self.alice=Keypair();self.bob=Keypair();self.other=Keypair()
        for kp in [self.admin,self.guardian,self.ops,self.alice,self.bob,self.other]: self.svm.airdrop(kp.pubkey(),10_000_000_000)
        self.mint=Pubkey.new_unique();data=bytearray(82);data[44]=6;data[45]=1
        self.svm.set_account(self.mint,Account(1_500_000,bytes(data),TOKEN))
        self.vault=R.vault_address(PROGRAM,self.admin.pubkey(),self.mint);self.set_time(TIME)
        if prefund:self.send(transfer({'from_pubkey':self.admin.pubkey(),'to_pubkey':self.vault,'lamports':1}))
        self.send(R.initialize(PROGRAM,self.admin.pubkey(),self.mint,self.admin.pubkey(),self.guardian.pubkey(),self.ops.pubkey()))
    def set_time(self,time):
        clock=self.svm.get_clock();clock.unix_timestamp=time;self.svm.set_clock(clock)
    def send(self,ix,*signers,ok=True):
        self.svm.expire_blockhash()
        message=Message.new_with_blockhash([ix],self.admin.pubkey(),self.svm.latest_blockhash())
        keys={str(k.pubkey()):k for k in [self.admin,*signers]}
        tx=VersionedTransaction(message,list(keys.values()));assert len(bytes(tx))<=1232
        result=self.svm.send_transaction(tx)
        if ok: assert isinstance(result,TransactionMetadata),str(result)
        else: assert isinstance(result,FailedTransactionMetadata),str(result)
        return result
    def state(self): return R.read_config(self.svm.get_account(self.vault).data)
    def deposit(self,n=1_000_000_000): self.send(R.deposit(PROGRAM,self.admin.pubkey(),self.vault,self.ops.pubkey(),n))
    def bundle(self,amounts=(400_000_000,450_000_000),rid=1,snapshot=TIME):
        a=leaf(self.vault,rid,self.alice.pubkey(),amounts[0]);b=leaf(self.vault,rid,self.bob.pubkey(),amounts[1]);root=parent(a,b)
        self.awards=[{'wallet':str(self.alice.pubkey()),'amount':str(a[1]),'proof':[{'hash':b[0].hex(),'sum':str(b[1])}]},{'wallet':str(self.bob.pubkey()),'amount':str(b[1]),'proof':[{'hash':a[0].hex(),'sum':str(a[1])}]}]
        return {'programId':str(PROGRAM),'config':str(self.vault),'roundId':str(rid),'root':root[0].hex(),'total':str(root[1]),'snapshotAt':snapshot,'manifestHash':h(b'fixture').hex()}
    def publish(self,**kwargs):
        bundle=self.bundle(**kwargs);self.send(R.publish(PROGRAM,self.admin.pubkey(),self.vault,bundle));return bundle
    def claim(self,index=0,rid=1,award=None,ok=True):
        return self.send(R.claim(PROGRAM,self.admin.pubkey(),self.vault,rid,award or self.awards[index]),ok=ok)

@pytest.fixture
def env():return Env()

def test_initialize_prefunded_pda_and_no_reinitialize():
    e=Env(prefund=True);assert e.state()['nextRound']==1
    e.send(R.initialize(PROGRAM,e.admin.pubkey(),e.mint,e.other.pubkey(),e.guardian.pubkey(),e.ops.pubkey()),ok=False)
    assert e.state()['publisher']==str(e.admin.pubkey())

def test_fee_split_direct_transfer_sync_and_dust(env):
    e=env;before=e.svm.get_balance(e.ops.pubkey());e.deposit(1_000_000_001)
    c=e.state();assert (c['available'],c['operationsPaid'],c['dust'])==(850_000_000,150_000_000,1)
    assert e.svm.get_balance(e.ops.pubkey())-before==150_000_000
    e.send(transfer({'from_pubkey':e.admin.pubkey(),'to_pubkey':e.vault,'lamports':1_000_000_000}))
    e.send(R.sync(PROGRAM,e.vault,e.ops.pubkey()));assert e.state()['collected']==2_000_000_001
    e.send(R.sync(PROGRAM,e.vault,e.ops.pubkey()),ok=False)

def test_hourly_wait_and_sponsored_payouts(env):
    e=env;e.deposit();e.publish();assert e.state()['pendingUntil']==TIME+3600
    e.set_time(TIME+3599);e.claim(ok=False)
    e.set_time(TIME+3600);a=e.svm.get_balance(e.alice.pubkey());b=e.svm.get_balance(e.bob.pubkey())
    e.claim(0);e.claim(1);assert e.svm.get_balance(e.alice.pubkey())-a==400_000_000;assert e.svm.get_balance(e.bob.pubkey())-b==450_000_000
    c=e.state();assert c['reserved']==0 and c['paid']==850_000_000
    assert e.svm.get_balance(e.vault)==e.svm.minimum_balance_for_rent_exemption(281)
    e.claim(ok=False)

def test_late_publication_preserves_ten_minute_review(env):
    e=env;e.deposit();e.set_time(TIME+3001);e.publish(snapshot=TIME+3001)
    assert e.state()['pendingUntil']==TIME+7200

def test_no_overlapping_rounds_and_no_over_reserving(env):
    e=env;e.deposit();e.publish();e.deposit();e.set_time(TIME+1)
    e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,e.bundle(rid=2,snapshot=TIME+1)),ok=False)
    e.set_time(TIME+3600)
    e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,e.bundle(amounts=(900_000_000,1),rid=2,snapshot=TIME+3600)),ok=False)
    e.publish(rid=2,snapshot=TIME+3600);assert e.state()['reserved']==1_700_000_000

def test_unauthorized_publisher_and_operations_substitution(env):
    e=env;e.deposit();e.send(R.publish(PROGRAM,e.other.pubkey(),e.vault,e.bundle()),e.other,ok=False)
    before=e.state();e.send(R.deposit(PROGRAM,e.admin.pubkey(),e.vault,e.other.pubkey(),1000),ok=False);assert e.state()==before

def test_cancellation_before_hour_releases_funds_and_burns_round_id(env):
    e=env;e.deposit();e.publish();e.send(R.cancel(PROGRAM,e.other.pubkey(),e.vault,1),e.other,ok=False)
    e.send(R.cancel(PROGRAM,e.guardian.pubkey(),e.vault,1),e.guardian)
    assert e.state()['reserved']==0 and e.state()['available']==850_000_000
    e.set_time(TIME+3600);e.claim(ok=False)
    e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,e.bundle(rid=1,snapshot=TIME+3600)),ok=False)

def test_cancellation_closed_when_hour_opens(env):
    e=env;e.deposit();e.publish();e.set_time(TIME+3600);e.send(R.cancel(PROGRAM,e.guardian.pubkey(),e.vault,1),e.guardian,ok=False);e.claim()

def test_pause_blocks_publication_but_never_funded_payouts(env):
    e=env;e.deposit();e.publish();e.send(R.pause(PROGRAM,e.guardian.pubkey(),e.vault),e.guardian)
    e.set_time(TIME+3600);e.claim();e.deposit();e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,e.bundle(rid=2,snapshot=TIME+3600)),ok=False)
    e.send(R.pause(PROGRAM,e.guardian.pubkey(),e.vault,False),e.guardian,ok=False)
    e.send(R.pause(PROGRAM,e.admin.pubkey(),e.vault,False));e.publish(rid=2,snapshot=TIME+3600)

def test_merkle_tampering_and_recipient_substitution(env):
    e=env;e.deposit();e.publish();e.set_time(TIME+3600);original=json.loads(json.dumps(e.awards[0]));before=e.state()
    e.claim(award={**original,'amount':'400000001'},ok=False)
    e.claim(award={**original,'wallet':str(e.other.pubkey())},ok=False)
    bad=json.loads(json.dumps(original));bad['proof'][0]['sum']='450000001';e.claim(award=bad,ok=False)
    assert e.state()==before;e.claim()

def test_prefunded_receipt_and_payer_is_beneficiary(env):
    e=env;e.deposit();e.publish();e.set_time(TIME+3600)
    receipt=R.receipt_address(PROGRAM,R.round_address(PROGRAM,e.vault,1),e.alice.pubkey())
    e.send(transfer({'from_pubkey':e.admin.pubkey(),'to_pubkey':receipt,'lamports':1}))
    e.send(R.claim(PROGRAM,e.alice.pubkey(),e.vault,1,e.awards[0]),e.alice)
    assert e.svm.get_account(receipt).data[:8]==b'RBDCLM01'

def test_publisher_change_requires_admin_and_24_hours(env):
    e=env;e.send(R.propose_publisher(PROGRAM,e.other.pubkey(),e.vault,e.other.pubkey()),e.other,ok=False)
    e.send(R.propose_publisher(PROGRAM,e.admin.pubkey(),e.vault,e.other.pubkey()))
    e.send(R.activate_publisher(PROGRAM,e.vault),ok=False);e.set_time(TIME+86400)
    e.send(R.activate_publisher(PROGRAM,e.vault));assert e.state()['publisher']==str(e.other.pubkey())
    e.deposit();bundle=e.bundle(snapshot=TIME+86400)
    e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,bundle),ok=False)
    e.send(R.publish(PROGRAM,e.other.pubkey(),e.vault,bundle),e.other)

@pytest.mark.parametrize('offset',[-121,1])
def test_stale_and_future_snapshots(env,offset):
    e=env;e.deposit();e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,e.bundle(snapshot=TIME+offset)),ok=False)

def test_strict_decoding_readonly_vault_and_wrong_mint(env):
    e=env;ix=R.deposit(PROGRAM,e.admin.pubkey(),e.vault,e.ops.pubkey(),1_000)
    e.send(Instruction(PROGRAM,ix.data+b'\0',ix.accounts),ok=False)
    metas=list(ix.accounts);metas[1]=AccountMeta(e.vault,False,False);e.send(Instruction(PROGRAM,ix.data,metas),ok=False)
    fake=Pubkey.new_unique();e.svm.set_account(fake,Account(2_000_000,b'\0'*82,R.SYSTEM))
    e.send(R.initialize(PROGRAM,e.admin.pubkey(),fake,e.admin.pubkey(),e.guardian.pubkey(),e.ops.pubkey()),ok=False)

def test_javascript_builder_proof_claims_in_vm(env,tmp_path):
    e=env;e.deposit()
    input={'programId':str(PROGRAM),'config':str(e.vault),'roundId':'1','snapshotAt':TIME,'sourceSlot':1,'commitment':'finalized','availableLamports':'850000000','positions':[{'wallet':str(e.alice.pubkey()),'funded':'0','hasOutgoing':False,'lots':[{'id':'trade-1','quantity':'1000000','cost':'2000000000','at':(TIME-900)*1000}]}],'reference':{'confirmed':True,'historyComplete':True,'spotQ':'1000000000000000','samples':[{'at':(TIME-900)*1000,'priceQ':'1000000000000000'},{'at':TIME*1000,'priceQ':'1000000000000000'}]}}
    source=tmp_path/'snapshot.json';out=tmp_path/'round.json';source.write_text(json.dumps(input))
    subprocess.run(['node',str(Path(__file__).parents[1]/'client/build-round.cjs'),str(source),str(out)],check=True)
    bundle=json.loads(out.read_text());e.send(R.publish(PROGRAM,e.admin.pubkey(),e.vault,bundle))
    class VmRpc:
        def account(self,address):
            if str(address)=='SysvarC1ock11111111111111111111111111111111':
                return {'data':bytes(32)+struct.pack('<q',e.svm.get_clock().unix_timestamp)}
            a=e.svm.get_account(R.key(address))
            return None if a is None else {'owner':str(a.owner),'data':a.data,'lamports':a.lamports}
    settings={'programId':str(PROGRAM),'admin':str(e.admin.pubkey()),'mint':str(e.mint)}
    rpc=VmRpc();worker.validate_bundle(bundle)
    assert worker.plan(rpc,settings,bundle,e.admin.pubkey())==[]
    e.set_time(TIME+3600);pending=worker.plan(rpc,settings,bundle,e.admin.pubkey());assert len(pending)==1
    e.send(pending[0][1]);assert e.state()['paid']==850_000_000
    assert worker.plan(rpc,settings,bundle,e.admin.pubkey())==[]
    corrupt=json.loads(json.dumps(bundle));corrupt['claims'][0]['amount']='850000001'
    with pytest.raises(ValueError):worker.plan(rpc,settings,corrupt,e.admin.pubkey())
