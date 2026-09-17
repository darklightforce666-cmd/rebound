'use strict';
const {makeService,ChartError}=require('../../server/charts.cjs');
function makeHandler({service=makeService()}={}){
 return async event=>{
  const reply=(statusCode,value)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':statusCode===200?'public,max-age=15,s-maxage=30':'no-store','X-Content-Type-Options':'nosniff',...(statusCode===429?{'Retry-After':'60'}:{})},body:JSON.stringify(value)});
  if(event.httpMethod!=='GET')return reply(405,{message:'Method not allowed'});
  const query=event.queryStringParameters||{};
  if(Object.keys(query).some(k=>!['mint','interval','currency'].includes(k)))return reply(400,{message:'Unsupported chart parameter'});
  try{return reply(200,await service(query));}
  catch(e){return reply(e instanceof ChartError?e.status:502,{message:e instanceof ChartError?e.message:'Chart data is temporarily unavailable. Please retry shortly.'});}
 };
}
exports.makeHandler=makeHandler;exports.handler=makeHandler();
