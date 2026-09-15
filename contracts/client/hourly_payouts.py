"""SOL payout worker. Plans by default; only --send reads a local sponsor key.

Run every minute to retry unpaid awards. The program only opens new reward rounds
on hourly UTC boundaries. This worker cannot publish a root or withdraw the vault.
"""
import argparse
import base64
import hashlib
import json
import os
import struct
import time
from pathlib import Path
from urllib.request import Request, urlopen
from solders.keypair import Keypair
from solders.message import Message
from solders.transaction import VersionedTransaction
from solders.hash import Hash
import rebound as R

def digest(*parts): return hashlib.sha256(b''.join(parts)).digest()
def checked_amount(value):
    if not isinstance(value,str) or not value.isascii() or not value.isdigit() or (len(value)>1 and value[0]=='0'): raise ValueError('Invalid integer amount')
    n=int(value)
    if n<0 or n>=2**64: raise ValueError('Amount outside u64')
    return n
def validate_bundle(bundle):
    fields=['version','policy','programId','config','roundId','snapshotAt','sourceSlot','commitment','referencePriceQ','inputHash','root','total','awards']
    canonical={f:bundle[f] for f in fields}
    encoded=json.dumps(canonical,separators=(',',':'),ensure_ascii=False).encode()
    if digest(encoded).hex()!=bundle['manifestHash']: raise ValueError('Manifest hash mismatch')
    if bundle['version']!=1 or bundle['policy']!='holder-recovery/v2' or bundle['commitment']!='finalized': raise ValueError('Unsupported policy or unfinalized snapshot')
    program=R.key(bundle['programId']);vault=R.key(bundle['config']);rid=checked_amount(bundle['roundId']);total=checked_amount(bundle['total'])
    claims=bundle['claims'];seen=set();summed=0
    if not 1<=len(claims)<=65536: raise ValueError('Invalid award count')
    if bundle['awards']!=[{'wallet':c['wallet'],'amount':c['amount']} for c in claims]: raise ValueError('Award list mismatch')
    for c in claims:
        wallet=R.key(c['wallet']);n=checked_amount(c['amount'])
        if c['wallet'] in seen or n==0 or len(c['proof'])>16: raise ValueError('Duplicate wallet, zero award, or oversized proof')
        seen.add(c['wallet']);summed+=n
        node=(digest(b'REBOUND:leaf:v1',bytes(program),bytes(vault),R.u64(rid),bytes(wallet),R.u64(n)),n)
        for p in c['proof']:
            ph=bytes.fromhex(p['hash']);ps=checked_amount(p['sum'])
            if len(ph)!=32: raise ValueError('Invalid proof hash')
            left,right=sorted([node,(ph,ps)]);s=left[1]+right[1]
            if s>=2**64: raise ValueError('Proof sum overflow')
            node=(digest(b'REBOUND:node:v1',left[0],R.u64(left[1]),right[0],R.u64(right[1])),s)
        if node[0].hex()!=bundle['root'] or node[1]!=total: raise ValueError('Invalid award proof')
    if summed!=total: raise ValueError('Awards do not cover the committed total')

def read_round(data):
    if len(data)!=153 or data[:8]!=b'RBDRND01': raise ValueError('Invalid round account')
    return {'config':str(R.Pubkey.from_bytes(data[8:40])),'id':struct.unpack_from('<Q',data,40)[0],'root':data[48:80].hex(),'total':struct.unpack_from('<Q',data,80)[0],'remaining':struct.unpack_from('<Q',data,88)[0],'claimableAt':struct.unpack_from('<q',data,112)[0],'cancelled':bool(data[120]),'manifestHash':data[121:153].hex()}

class Rpc:
    def __init__(self,url):self.url=url
    def call(self,method,params):
        body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
        try:
            with urlopen(Request(self.url,body,{'Content-Type':'application/json'}),timeout=30) as response: reply=json.load(response)
        except Exception: raise RuntimeError('RPC request failed; no transfer was confirmed') from None
        if 'error' in reply: raise RuntimeError('RPC rejected '+method)
        return reply['result']
    def account(self,address):
        a=self.call('getAccountInfo',[str(address),{'encoding':'base64','commitment':'finalized'}])['value']
        return None if a is None else {'owner':a['owner'],'data':base64.b64decode(a['data'][0]),'lamports':a['lamports']}

def plan(rpc,settings,bundle,payer):
    validate_bundle(bundle)
    program=R.key(settings['programId']);vault=R.vault_address(program,settings['admin'],settings['mint'])
    if bundle['programId']!=str(program) or bundle['config']!=str(vault): raise ValueError('Wrong program or vault')
    cfg=rpc.account(vault)
    if not cfg or cfg['owner']!=str(program): raise ValueError('Missing configured vault')
    state=R.read_config(cfg['data'])
    if state['admin']!=settings['admin'] or state['mint']!=settings['mint']: raise ValueError('Vault identity mismatch')
    round_account=R.round_address(program,vault,bundle['roundId']);raw=rpc.account(round_account)
    if not raw or raw['owner']!=str(program): raise ValueError('Round has not been published')
    row=read_round(raw['data'])
    if any([row['config']!=str(vault),row['id']!=int(bundle['roundId']),row['root']!=bundle['root'],row['total']!=int(bundle['total']),row['manifestHash']!=bundle['manifestHash']]): raise ValueError('Bundle differs from the published round')
    if row['cancelled']: return []
    clock=rpc.account('SysvarC1ock11111111111111111111111111111111')
    if not clock or len(clock['data'])!=40: raise ValueError('Clock unavailable')
    timestamp=struct.unpack_from('<q',clock['data'],32)[0]
    if timestamp<row['claimableAt']:return []
    pending=[]
    for award in bundle['claims']:
        receipt=R.receipt_address(program,round_account,award['wallet']);paid=rpc.account(receipt)
        if paid and paid['owner']==str(program):
            expected=b'RBDCLM01'+bytes(round_account)+bytes(R.key(award['wallet']))+R.u64(award['amount'])
            if paid['data']!=expected:raise ValueError('Unexpected claim receipt')
            continue
        pending.append((award,R.claim(program,payer,vault,bundle['roundId'],award)))
    return pending

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('settings');parser.add_argument('round_directory');parser.add_argument('--payer-public-key',required=True)
    parser.add_argument('--send',action='store_true');parser.add_argument('--keypair-file');parser.add_argument('--allow-mainnet',action='store_true')
    args=parser.parse_args();settings=json.loads(Path(args.settings).read_text());cluster=settings.get('cluster','devnet')
    if cluster not in ['devnet','mainnet-beta']:parser.error('Unsupported cluster')
    if args.send and cluster=='mainnet-beta' and not args.allow_mainnet:parser.error('Mainnet submission requires --allow-mainnet')
    rpc=Rpc(os.environ.get('SOLANA_RPC_URL','https://api.'+cluster+'.solana.com'))
    expected={'devnet':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1','mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'}[cluster]
    if rpc.call('getGenesisHash',[])!=expected:raise ValueError('RPC is connected to the wrong cluster')
    payer=R.key(args.payer_public_key);signer=None
    if args.send:
        if not args.keypair_file:parser.error('--send requires a local --keypair-file')
        signer=Keypair.from_json(Path(args.keypair_file).read_text())
        if signer.pubkey()!=payer:parser.error('Sponsor key does not match its expected public address')
    failures=0
    for file in sorted(Path(args.round_directory).glob('*.json')):
        try: pending=plan(rpc,settings,json.loads(file.read_text()),payer)
        except Exception as error:
            failures+=1;print(json.dumps({'file':file.name,'status':'blocked','reason':str(error)}));continue
        for award,ix in pending:
            result={'wallet':award['wallet'],'amount':award['amount'],'status':'planned'}
            if signer is None: result['instruction']=R.instruction_json(ix)
            else:
                try:
                    block=rpc.call('getLatestBlockhash',[{'commitment':'finalized'}])['value']['blockhash']
                    tx=VersionedTransaction(Message.new_with_blockhash([ix],payer,Hash.from_string(block)),[signer])
                    if len(bytes(tx))>1232:raise ValueError('Transaction exceeds packet limit')
                    signature=rpc.call('sendTransaction',[base64.b64encode(bytes(tx)).decode(),{'encoding':'base64','skipPreflight':False,'preflightCommitment':'finalized','maxRetries':3}])
                    result.update(status='submitted_pending',signature=signature)
                    for _ in range(15):
                        status=rpc.call('getSignatureStatuses',[[signature],{'searchTransactionHistory':True}])['value'][0]
                        if status and status.get('err') is not None:raise RuntimeError('Transaction failed; award remains owed')
                        if status and status.get('confirmationStatus')=='finalized':result['status']='finalized';break
                        time.sleep(1)
                    if result['status']!='finalized':failures+=1
                except Exception as error:failures+=1;result.update(status='retry_required',reason=str(error))
            print(json.dumps(result))
    return 1 if failures else 0
if __name__=='__main__':raise SystemExit(main())
