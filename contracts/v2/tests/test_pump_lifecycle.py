"""Execute cloned mainnet Pump binaries with synthetic local wallets/trades.

No mainnet transaction is sent. This verifies program compatibility, not live
rewards activation, production price history, or wallet identity inference.
"""
import base64, json, subprocess
from pathlib import Path
from solders.account import Account
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.compute_budget import set_compute_unit_limit
from solders.system_program import transfer
from test_svm import Env, PROGRAM, pd, h

BASE=Path(__file__).parents[1]; FIXTURES=BASE/'fixtures/mainnet'
PUMP=Pubkey.from_string('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
FEES=Pubkey.from_string('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
GLOBAL=Pubkey.from_string('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf')

def test_actual_pump_creation_sharing_and_collection(tmp_path):
    manifest=json.loads((FIXTURES/'manifest.json').read_text());e=Env()
    for program in manifest['programs']:
        binary=(FIXTURES/program['file']).read_bytes();assert h(binary).hex()==program['sha256']
        e.svm.add_program_from_file(Pubkey.from_string(program['id']),FIXTURES/program['file'])
    for a in manifest['accounts']:
        if not a.get('missing'):e.svm.set_account(Pubkey.from_string(a['id']),Account(int(a['lamports']),base64.b64decode(a['data']),Pubkey.from_string(a['owner']),a['executable']))
    e.set_clock(manifest['programs'][0]['slot']+100,1_800_000_000);e.prepare()
    e.send(transfer({'from_pubkey':e.admin.pubkey(),'to_pubkey':e.intake,'lamports':50_000_000}))
    curve=pd(b'bonding-curve',bytes(e.mint.pubkey()),program=PUMP);sharing=pd(b'sharing-config',bytes(e.mint.pubkey()),program=FEES)
    def vector(action,**extra):
        data={'program':str(PROGRAM),'mint':str(e.mint.pubkey()),'user':str(e.admin.pubkey()),'action':action,'global':base64.b64encode(e.svm.get_account(GLOBAL).data).decode(),**extra}
        if e.svm.get_account(curve):data['curve']=base64.b64encode(e.svm.get_account(curve).data).decode()
        if e.svm.get_account(sharing):data['sharing']=base64.b64encode(e.svm.get_account(sharing).data).decode()
        source=tmp_path/'public-input.json';source.write_text(json.dumps(data))
        result=subprocess.run(['node',str(BASE/'tests/pump-vector.cjs'),str(source)],capture_output=True,text=True)
        assert result.returncode==0,result.stderr
        vectors=json.loads(result.stdout)
        # Protocol fee recipients already exist on mainnet. Supply their local
        # System-account rent balances; these are NOT fabricated trade proceeds.
        for v in vectors:
            for recipient in v.get('testExistingFeeRecipients',[]):
                key=Pubkey.from_string(recipient)
                if e.svm.get_account(key) is None:e.svm.set_account(key,Account(10_000_000,b'',Pubkey.default()))
        return [Instruction(Pubkey.from_string(v['program']),base64.b64decode(v['data']),[AccountMeta(Pubkey.from_string(k['key']),k['signer'],k['writable']) for k in v['keys']]) for v in vectors]
    budget=set_compute_unit_limit(1_400_000)
    e.send([budget,*vector('create')],e.mint)
    # First trade happens deliberately BEFORE sharing setup: creator was intake.
    bc=e.svm.get_account(curve).data;assert bc[49:81]==bytes(e.intake)
    e.send([budget,*vector('buy')])
    initial_creator_vault=pd(b'creator-vault',bytes(e.intake),program=PUMP)
    assert e.svm.get_balance(initial_creator_vault)>e.svm.minimum_balance_for_rent_exemption(0)
    e.send([budget,*vector('sharing')]);e.send([budget,*vector('lock')])
    sc=e.svm.get_account(sharing).data;assert sc[75]==1 and sc[80:112]==bytes(e.intake)
    assert e.svm.get_account(curve).data[49:81]==bytes(sharing)
    assert e.svm.get_account(e.coin).data[168]==1
    initial=e.svm.get_balance(e.intake);e.send([budget,*vector('collectInitial')]);assert e.svm.get_balance(e.intake)>initial
    # A subsequent trade routes into the mint-scoped sharing vault.
    e.send([budget,*vector('buy')]);before=e.svm.get_balance(e.intake)
    e.send([budget,*vector('collect')]);assert e.svm.get_balance(e.intake)>before
