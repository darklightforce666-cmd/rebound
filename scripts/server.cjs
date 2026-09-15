const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {handler}=require('../netlify/functions/chain.cjs');
const root=path.resolve(__dirname,'..','dist');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 let url;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400).end();return;}
 if(url.pathname==='/.netlify/functions/chain'){
  const result=await handler({httpMethod:req.method,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'x-nf-client-connection-ip':req.socket.remoteAddress}});
  res.writeHead(result.statusCode,result.headers).end(result.body);return;
 }
 if(url.pathname==='/preview/REBOUND.html'){res.writeHead(302,{Location:'/'}).end();return;}
 let relative;try{relative=decodeURIComponent(url.pathname).replace(/^\/+/,'')||'index.html';}catch{res.writeHead(400).end();return;}
 const file=path.resolve(root,relative);
 if(!file.startsWith(root+path.sep)||relative.startsWith('.')){res.writeHead(404).end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(data);});
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('REBOUND: http://127.0.0.1:'+server.address().port));
