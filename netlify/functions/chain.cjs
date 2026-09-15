'use strict';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(ALPHABET.indexOf(char));
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  return bytes + (value.match(/^1*/)[0].length) === 32;
}
class Fault extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const badData = () => new Fault(502, 'RPC_DATA', 'The network returned an unreadable response. Try again.');
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw badData();
  return value;
}
function amount(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw badData();
  return value;
}
function decimals(value) { if (!Number.isInteger(value) || value < 0 || value > 255) throw badData(); return value; }
function reply(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(data) };
}

// This is a small read-only API, never a generic RPC or transaction relay.
function makeHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let verifiedEndpoint = null, verifiedUntil = 0, verifying = null;
  const limits = new Map();
  async function rpc(endpoint, method, params = []) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    } catch { throw new Fault(502, 'RPC_UNAVAILABLE', 'The Solana connection is unavailable. Try again shortly.'); }
    if (!response.ok) throw new Fault(502, 'RPC_UNAVAILABLE', 'The Solana connection is unavailable. Try again shortly.');
    // Bound response size before parsing, including untrusted upstream responses.
    let text = '';
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2_000_000) { await reader.cancel(); throw badData(); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const json = JSON.parse(text);
      if (json.error || !Object.hasOwn(json, 'result')) throw badData();
      return json.result;
    } catch { throw badData(); }
  }
  async function verify(endpoint) {
    if (verifiedEndpoint === endpoint && now() < verifiedUntil) return;
    if (!verifying || verifying.endpoint !== endpoint) {
      const promise = rpc(endpoint, 'getGenesisHash').then(hash => {
        if (hash !== MAINNET) throw new Fault(503, 'WRONG_NETWORK', 'The server must connect to Solana mainnet. Contact the site operator.');
        verifiedEndpoint = endpoint; verifiedUntil = now() + 60000;
      });
      verifying = { endpoint, promise };
    }
    const current = verifying;
    try { await current.promise; } finally { if (verifying === current) verifying = null; }
  }
  return async function handler(event) {
    try {
      if (event.httpMethod !== 'GET') return reply(405, { error: 'METHOD', message: 'Only GET requests are supported.' });
      const q = event.queryStringParameters || {};
      if (!['status', 'mint', 'wallet'].includes(q.action) || Object.keys(q).some(k => !['action', 'address'].includes(k))) throw new Fault(400, 'REQUEST', 'Choose a supported request.');
      if (q.action !== 'status' && !isAddress(q.address)) throw new Fault(400, 'ADDRESS', 'Enter a valid Solana address.');
      const ip = event.headers?.['x-nf-client-connection-ip'] || 'local';
      const time = now();
      for (const [key, value] of limits) if (value.until <= time) limits.delete(key);
      if (!limits.has(ip) && limits.size >= 2000) throw new Fault(429, 'RATE_LIMIT', 'Too many requests. Please wait a minute.');
      const budget = limits.get(ip) || { count: 0, until: time + 60000 };
      limits.set(ip, budget);
      if (++budget.count > 30) throw new Fault(429, 'RATE_LIMIT', 'Too many requests. Please wait a minute.');
      let endpoint;
      try { endpoint = new URL(env.SOLANA_RPC_URL); } catch { throw new Fault(503, 'RPC_NOT_CONFIGURED', 'The site operator needs to configure the private Solana connection.'); }
      if (endpoint.protocol !== 'https:' || endpoint.hash) throw new Fault(503, 'RPC_NOT_CONFIGURED', 'The site operator needs to configure an HTTPS Solana connection.');
      await verify(endpoint.href);
      if (q.action === 'status') return reply(200, { cluster: 'mainnet-beta', checkedAt: time });
      if (q.action === 'mint') {
        const result = await rpc(endpoint.href, 'getAccountInfo', [q.address, { encoding: 'jsonParsed', commitment: 'finalized' }]);
        const slot = integer(result?.context?.slot);
        if (result.value === null) return reply(200, { address: q.address, exists: false, slot, checkedAt: time });
        const account = result.value, info = account?.data?.parsed?.info;
        if (account.executable || !PROGRAMS.includes(account.owner) || account.data?.parsed?.type !== 'mint' || info?.isInitialized !== true) throw new Fault(422, 'NOT_MINT', 'This address is not an initialized Solana token mint.');
        const metadata = info.extensions?.find(e => e.extension === 'tokenMetadata')?.state;
        return reply(200, { address: q.address, exists: true, slot, checkedAt: time, program: account.owner, decimals: decimals(info.decimals), supply: amount(info.supply), name: typeof metadata?.name === 'string' ? metadata.name.slice(0,64) : null, symbol: typeof metadata?.symbol === 'string' ? metadata.symbol.slice(0,20) : null });
      }
      const [balance, ...sets] = await Promise.all([
        rpc(endpoint.href, 'getBalance', [q.address, { commitment: 'finalized' }]),
        ...PROGRAMS.map(programId => rpc(endpoint.href, 'getTokenAccountsByOwner', [q.address, { programId }, { encoding: 'jsonParsed', commitment: 'finalized' }]))
      ]);
      const holdings = new Map();
      for (let i = 0; i < sets.length; i++) {
        const set = sets[i];
        integer(set?.context?.slot);
        if (!Array.isArray(set.value) || set.value.length > 10000) throw badData();
        for (const entry of set.value) {
          const account = entry.account, info = account?.data?.parsed?.info;
          if (account?.owner !== PROGRAMS[i] || account.data?.parsed?.type !== 'account' || info?.owner !== q.address || !isAddress(info.mint)) throw badData();
          const raw = BigInt(amount(info.tokenAmount?.amount)), places = decimals(info.tokenAmount?.decimals);
          if (!raw) continue;
          const previous = holdings.get(info.mint);
          if (previous && previous.decimals !== places) throw badData();
          holdings.set(info.mint, { mint: info.mint, decimals: places, amount: (BigInt(previous?.amount || '0') + raw).toString() });
        }
      }
      return reply(200, { address: q.address, lamports: String(integer(balance?.value)), slot: integer(balance?.context?.slot), checkedAt: time, tokens: [...holdings.values()] });
    } catch (error) {
      // Never return provider error bodies, request URLs, or environment values.
      const known = error instanceof Fault;
      return reply(known ? error.status : 502, { error: known ? error.code : 'UNAVAILABLE', message: known ? error.message : 'Live data is unavailable. Please try again.' });
    }
  };
}
exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.isAddress = isAddress;
exports.MAINNET = MAINNET;
