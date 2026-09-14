(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine.cjs'));else root.ReboundFixtures=factory(root.ReboundEngine);})(typeof globalThis!=='undefined'?globalThis:this,function(E){
  'use strict';
  const assets={SOL:{decimals:9,symbol:'SOL',mint:null},USDC:{decimals:6,symbol:'USDC',mint:null}};
  function reference(token,now){return E.checkedReference({samples:[{at:now-900000,priceQ:token.priceQ},{at:now,priceQ:token.priceQ}],spotQ:token.priceQ,at:now,confirmed:true,historyComplete:true});}
  function token(input,now,index=0){
    E.invariant(input.currency==='SOL','Trading and rewards must use SOL');
    const decimals=assets[input.currency].decimals, unit=10n**BigInt(decimals), id=input.id;
    const t={...input,decimals,tokenDecimals:6,createdAt:now-4*3600000,taxBps:input.taxBps||500,
      mode:E.POLICY.id,mint:null,treasuryAddress:null,website:input.website||'',description:input.description||'A community token with fee-funded recovery.',
      priceQ:unit*E.PRICE_SCALE/10000n/1000000n,treasury:E.treasury(id,now-4*3600000),positions:[],trades:[],simulated:true};
    if(input.blank){t.createdAt=now;t.treasury=E.treasury(id,now);return t;}
    const a=E.newPosition('demo-holder'),b=E.newPosition('demo-holder-b');
    E.purchase(a,{id:id+'-entry-a',quantity:30000n*1000000n,officialCost:5n*unit,at:now-3*3600000});
    E.purchase(b,{id:id+'-entry-b',quantity:20000n*1000000n,officialCost:3n*unit,at:now-3*3600000});
    t.positions=[a,b];
    E.collect(t.treasury,id+'-fees-1',unit*375n/1000n,now-2*3600000);
    const r=E.fund(t.treasury,t.positions,reference(t,now-90*60000),now-90*60000);
    E.claim(t.treasury,t.positions,r.id,a.wallet,now-75*60000);E.claim(t.treasury,t.positions,r.id,b.wallet,now-75*60000);
    E.collect(t.treasury,id+'-fees-2',unit*(150n+BigInt(index)*25n)/100n,now-3600000);
    t.trades=[{id:id+'-fixture-buy',side:'buy',wallet:'demo-holder',amount:5n*unit,quantity:30000n*1000000n,at:now-3*3600000,simulated:true}];
    return t;
  }
  function create(now=Date.now()){
    const inputs=[
      {id:'demo-rbd',name:'Rebound',symbol:'RBD',currency:'SOL',tone:'emerald',art:'rebound',tag:'Platform token',change:18.42,marketCap:1284000,volume:328400},
      {id:'demo-orbit',name:'Orbital',symbol:'ORBIT',currency:'SOL',tone:'emerald',art:'orbit',tag:'Community',change:32.81,marketCap:386200,volume:98600},
      {id:'demo-wind',name:'Second Wind',symbol:'WIND',currency:'SOL',tone:'emerald',art:'wind',tag:'Fresh energy',change:7.36,marketCap:248700,volume:74200},
      {id:'demo-cat',name:'Orbit Cat',symbol:'OCAT',currency:'SOL',tone:'emerald',art:'cat',tag:'Culture',change:-4.27,marketCap:162900,volume:41600,taxBps:300},
      {id:'demo-drift',name:'Drift Club',symbol:'DRIFT',currency:'SOL',tone:'emerald',art:'drift',tag:'Community',change:12.68,marketCap:98600,volume:24800},
      {id:'demo-nim',name:'Nimble',symbol:'NIM',currency:'SOL',tone:'emerald',art:'nimble',tag:'New launch',change:24.54,marketCap:62400,volume:18600,taxBps:200},
      {id:'demo-mellow',name:'Mellow',symbol:'MEL',currency:'SOL',tone:'emerald',art:'mellow',tag:'Culture',change:-2.64,marketCap:42100,volume:11300,taxBps:400},
      {id:'demo-encore',name:'Encore',symbol:'ENCR',currency:'SOL',tone:'emerald',art:'encore',tag:'Community',change:9.18,marketCap:27300,volume:7400}
    ];
    return {version:4,now,createdAt:now,tokens:inputs.map((t,i)=>token(t,now,i)),demoBalances:{SOL:20n*1000000000n}};
  }
  return {assets,reference,token,create};
});

