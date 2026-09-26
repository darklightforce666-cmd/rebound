"""JS wire builders (server/rewards/wire-v3.cjs) executed against the compiled V3 program."""
import json, subprocess, base64
from pathlib import Path
from solders.instruction import Instruction, AccountMeta
from solders.pubkey import Pubkey
from solders.transaction_metadata import TransactionMetadata
from test_svm import Env, PROGRAM, T0, E, err, ok
NODE=Path(__file__).with_name('wire-vectors.cjs')
def js(op,args):
    r=subprocess.run(['node',str(NODE)],input=json.dumps({'op':op,'program':str(PROGRAM),'args':args}),capture_output=True,text=True,timeout=60,cwd=str(Path(__file__).parents[3]))
    assert r.returncode==0,r.stderr;return json.loads(r.stdout)
def build(op,args):
    o=js(op,args);return Instruction(PROGRAM,base64.b64decode(o['data64']),[AccountMeta(Pubkey.from_string(k['pubkey']),k['isSigner'],k['isWritable']) for k in o['keys']])

def test_js_built_primary_lifecycle_executes_on_compiled_program():
    e=Env();e.pmint=e.mint(10**15)
    ok(e.send(build('registerPrimary',{'admin':str(e.admin.pubkey()),'mint':str(e.pmint),'fundingWallet':str(e.dev.pubkey())})))
    ok(e.send(build('startPrimary',{'admin':str(e.admin.pubkey()),'mint':str(e.pmint)})))
    e.pcoin=Pubkey.find_program_address([b'coin-v3',bytes(e.pmint)],PROGRAM)[0]
    ok(e.send(build('depositHolders',{'fundingWallet':str(e.dev.pubkey()),'mint':str(e.pmint),'amount':'850000000'}),payer=e.dev))
    e.clock(time=T0+1800-60)
    wallets=[str(e.alice.pubkey()),str(e.bob.pubkey()),str(Pubkey.new_unique())];amounts=['500000000','250000000','100000000']
    ctx={'program':str(PROGRAM),'deployment':str(e.deployment),'mint':str(e.pmint),'policy':e.policy.hex(),'cycle':'1'}
    t=js('tree',{'context':ctx,'awards':[{'wallet':w,'amount':a} for w,a in zip(wallets,amounts)]})
    ok(e.send(build('fund',{'payer':str(e.admin.pubkey()),'publisher':str(e.publisher.pubkey()),'verifier':str(e.verifier.pubkey()),'mint':str(e.pmint),'cycle':'1','root':t['root'],'count':3,'cutoffSlot':str(e.svm.get_clock().slot),'snapshot':'11'*32,'manifest':'22'*32}),e.publisher,e.verifier))
    e.clock(time=T0+1800)
    for idx,(w,a) in enumerate(zip(wallets,amounts)):
        before=e.svm.get_balance(Pubkey.from_string(w)) or 0
        ok(e.send(build('pay',{'payer':str(e.cranker.pubkey()),'mint':str(e.pmint),'cycle':'1','index':idx,'wallet':w,'amount':a,'proof':t['proofs'][idx]}),payer=e.cranker))
        assert e.svm.get_balance(Pubkey.from_string(w))-before==int(a)
    coin=js('decode',{'kind':'coin','data64':base64.b64encode(e.svm.get_account(e.pcoin).data).decode()})
    assert (coin['kind'],coin['deposits'],coin['holderPaid'],coin['holderReserved'],coin['holderUnallocated'],coin['lastCycle'])==('primary','850000000','850000000','0','0','1')
    rnd=Pubkey.find_program_address([b'round-v3',bytes(e.pcoin),(1).to_bytes(8,'little')],PROGRAM)[0]
    r=js('decode',{'kind':'round','data64':base64.b64encode(e.svm.get_account(rnd).data).decode()})
    assert (r['total'],r['remaining'],r['count'],r['paidCount'],r['dueTime'],r['root'])==('850000000','0',3,3,str(T0+1800),t['root']['hash'])
