/* Jiwu browser transport. Both origins must forward to the SAME Mac API/database.
 * Load JIWU_FAILOVER_CONFIG first. No credentials, orders or request bodies are persisted/logged.
 */
(() => {
 'use strict';
 const root=window;
 if(root.JIWUTransport||typeof root.fetch!=='function')return;
 const raw=root.JIWU_FAILOVER_CONFIG||{};
 function origin(value,backup=false){
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return null;
   if(backup&&!/\.(?:proxy\.netbird\.io|netbird\.services)$/.test(u.hostname))return null;
   return u.origin;
  }catch{return null;}
 }
 const primary=origin(raw.primaryOrigin),backup=origin(raw.backupOrigin,true);
 if(primary!=='https://jiwu-mac-relay.jiwusales.workers.dev'||!backup||primary===backup)return;
 const preferred=raw.preferredRoute==='backup'?'backup':'primary',preferredOrigin=preferred==='backup'?backup:primary;
 const otherOrigin=value=>value===primary?backup:primary;
 const bounded=(value,fallback,maximum)=>Number.isFinite(value)&&value>0?Math.min(value,maximum):fallback;
 const stickyMs=bounded(raw.stickyMs,180000,3600000),readTimeout=bounded(raw.readTimeoutMs,4000,60000),
  probeTimeout=bounded(raw.probeTimeoutMs,4000,30000),mutationTimeout=bounded(raw.mutationTimeoutMs,0,120000),
  backupTimeout=bounded(raw.backupTimeoutMs,15000,120000),wsTimeout=bounded(raw.webSocketTimeoutMs,6000,30000);
 const nativeFetch=root.fetch.bind(root),NativeWS=root.WebSocket;
 const functions=new Set(['jiwu-admin-test','jiwu-line-orders','jiwu-public','jiwu-launch-register','jiwu-inventory-auto','jiwu-short-links','jiwu-free-shipping','jiwu-calendar-sync']);
 const adminReads=new Set(('authWarmup authLogin authCheck ping backendSync inventory online onlineCustomer onlineCargo group storeSales storeProduct storeCart storeActiveSalesperson ship purchaseChannels purchaseOrders purchaseMatch customerLineChatData lineChatCustomers getCustomerLineChat launchList launchGet launchAuxSheet launchURLs launchImageProxy launchProductInfo launchAnnouncementPreview launchPriceHistory manualOrderSuggestions inventoryPriceHistory helperSnapshot helperLoadPlan profitDashboard profitAuthCheck').split(' '));
 // Explicitly reviewed actions committed through jiwu_requests/jiwu_edge_commit_delta or an atomic p_request RPC.
 const adminWrites=new Set(('saveLineChatContact bindCustomerLineChat saveCustomerLineChat saveOnlinePayment setOnlineFaceToFace setOnlineStar setOnlineReconciled setOnlineOpened setOnlineItemBadge purchaseRestock addOnlineOrder appendOnlineOrder editOnlineOrder deleteOnlineOrder renameOnlineCustomer renameOnlineOrderCustomer bindOnlineOrderCustomer deleteStoreSale updateStoreSaleNote updateStoreSalePayment addStoreSale purchaseSave purchaseSync purchaseImage purchaseCheck purchaseEdit purchaseDelete purchaseSplit purchaseBatchSave purchaseBatchDelete setInventoryPrice updateInventoryProduct deleteInventoryProduct setInventoryStock setInventoryStore setInventoryImage reorderInventory addInventoryProduct checkInventoryAvailability storeScan storeCartSet storeCartClear storeCheckout createShip setShip setShipPacked deleteShipOrder mergeShipOrders launchImportInventory launchGroupWork launchGroupWorkAdd launchGroupWorkReorder launchGroupWorkBatchSave launchSetProductHidden launchSetInventoryAvailability launchCheckAvailability launchFillFromInventory launchSave launchMove launchDelete launchReorder launchTransferProducts helperSavePlan helperDeletePlan').split(' '));
 const fastAdminReads=new Set('authWarmup authLogin authCheck ping backendSync storeCart storeActiveSalesperson'.split(' '));
 const storageKey='jiwu-transport-v1:'+primary+'|'+backup+'|'+preferred;
 let state={route:preferred,retryAt:0,reason:''};const probes=new Map();
 const now=()=>Date.now();
 function restore(){try{const s=JSON.parse(root.localStorage?.getItem(storageKey)||'null');if(s&&['primary','backup'].includes(s.route)&&s.route!==preferred&&Number.isFinite(s.retryAt)&&s.retryAt>0&&s.retryAt<=now()+3600000)state={route:s.route,retryAt:s.retryAt,reason:'shared-failure'};}catch{}}
 function notify(){try{root.dispatchEvent(new CustomEvent('jiwu-transport-change',{detail:{...state}}));}catch{}}
 function fail(reason,failedOrigin){
  const next=failedOrigin===backup?'primary':'backup';
  if(state.route===next&&state.retryAt>now())return;
  state={route:next,retryAt:now()+stickyMs,reason};
  try{root.localStorage?.setItem(storageKey,JSON.stringify({route:next,retryAt:state.retryAt}));}catch{}
  notify();
 }
 function recover(){state={route:preferred,retryAt:0,reason:''};try{root.localStorage?.removeItem(storageKey);}catch{}notify();}
 restore();
 function route(input,websocket=false){
  let u;try{u=new URL(typeof input==='string'||input instanceof URL?input:input.url,root.location?.href);}catch{return null;}
  const expected=websocket?primary.replace(/^https:/,'wss:'):primary;
  if(u.origin!==expected||u.username||u.password)return null;
  if(websocket)return u.pathname==='/realtime/v1/websocket'&&!u.hash?{url:u}:null;
  if([...u.searchParams.keys()].some(key=>/^__store_(?:queue|discord)(?:$|_)/.test(key)))return null;
  const m=u.pathname.match(/^\/functions\/v1\/([a-z0-9-]+)(\/assets\/[a-f0-9-]{36})?\/?$/i);
  if(!m||!functions.has(m[1])||m[2]&&m[1]!=='jiwu-admin-test')return null;
  return {url:u,slug:m[1],asset:!!m[2]};
 }
 function replaceOrigin(url,target){return target+url.pathname+url.search;}
 function abortReason(signal){return signal?.reason||new DOMException('The operation was aborted.','AbortError');}
 function bufferedResponse(response,bytes,signal){
  const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
  let abort;
  const stream=new ReadableStream({
   start(controller){abort=()=>controller.error(abortReason(signal));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});},
   pull(controller){signal.removeEventListener('abort',abort);if(signal.aborted){controller.error(abortReason(signal));return;}controller.enqueue(bytes);controller.close();},
   cancel(){signal.removeEventListener('abort',abort);}
  },{highWaterMark:0});
  const copy=new Response(stream,{status:response.status,statusText:response.statusText,headers});
  for(const key of ['url','redirected','type'])try{Object.defineProperty(copy,key,{value:response[key]});}catch{}
  return copy;
 }
 async function withTimeout(request,ms,bufferMode=false){
  if(request.signal.aborted)throw abortReason(request.signal);
  const controller=new AbortController(),onAbort=()=>controller.abort(abortReason(request.signal));
  const combined=typeof AbortSignal.any==='function'?AbortSignal.any([request.signal,controller.signal]):controller.signal;
  if(combined===controller.signal)request.signal.addEventListener('abort',onAbort,{once:true});
  const timer=ms?setTimeout(()=>controller.abort(new DOMException('Jiwu transport timeout','TimeoutError')),ms):null;
  let reader,abortListener;
  const cancelled=new Promise((_,reject)=>{abortListener=()=>reject(abortReason(combined));combined.addEventListener('abort',abortListener,{once:true});});
  try{
   return await Promise.race([(async()=>{
    const response=await nativeFetch(new Request(request,{...requestOptions(request),signal:combined}));
    if(!bufferMode||!response.ok||[204,205].includes(response.status))return response;
    reader=response.body?.getReader();const chunks=[];let length=0;
    if(reader)for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>9*1024*1024)throw Error('Jiwu response exceeds transport limit');chunks.push(part.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(bufferMode==='gviz'){
     const match=text.match(/^\s*(?:\/\*O_o\*\/\s*)?google\.visualization\.Query\.setResponse\(([\s\S]*)\);\s*$/);
     if(!match)throw Error('Incomplete Jiwu catalog response');JSON.parse(match[1]);
    }else JSON.parse(text);
    return bufferedResponse(response,bytes,request.signal);
   })(),cancelled]);
  }catch(error){reader?.cancel().catch(()=>{});request.signal.removeEventListener('abort',onAbort);throw error;}
  finally{if(timer!==null)clearTimeout(timer);combined.removeEventListener('abort',abortListener);}
 }
 async function prepareBody(request){
  if(request.body===null)return {body:undefined,text:null,length:0};
  const bytes=await request.clone().arrayBuffer();
  // Do not pass a ReadableStream as RequestInit.body: Safari does not support request streaming.
  // A lossless UTF-8 JSON string preserves serialization/whitespace; other bodies retain their raw bytes.
  if(/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')){
   try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return {body:text,text,length:bytes.byteLength};}catch{}
  }
  return {body:bytes,text:null,length:bytes.byteLength};
 }
 function requestOptions(original){
  const init={method:original.method,headers:new Headers(original.headers),signal:original.signal,
   mode:original.mode,cache:original.cache,credentials:original.credentials,redirect:original.redirect,
   referrer:original.referrer,referrerPolicy:original.referrerPolicy,integrity:original.integrity,keepalive:original.keepalive};
  if(typeof original.priority==='string')init.priority=original.priority;
  return init;
 }
 function requestAt(url,original,prepared){
  const init=requestOptions(original);if(prepared.body!==undefined)init.body=prepared.body;
  return new Request(url,init);
 }
 function classify(request,entry,prepared){
  if(['GET','HEAD'].includes(request.method))return {retry:entry.asset||['jiwu-public','jiwu-short-links'].includes(entry.slug),read:true};
  if(request.method!=='POST'||entry.asset||!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))return {retry:false,read:false};
  let data;
  try{if(prepared.text===null||prepared.length>12*1024*1024)return {retry:false,read:false};data=JSON.parse(prepared.text.replace(/^\uFEFF/,''));}catch{return {retry:false,read:false};}
  if(!data||Array.isArray(data)||typeof data!=='object')return {retry:false,read:false};
  const action=data.action;
  if(entry.slug==='jiwu-admin-test')return {read:adminReads.has(action),longRead:adminReads.has(action)&&!fastAdminReads.has(action)?(action==='launchAnnouncementPreview'?120000:90000):0,retry:adminReads.has(action)||adminWrites.has(action)&&typeof data.requestId==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(data.requestId)};
  if(entry.slug==='jiwu-public')return {read:['cartQuote','publicGroupWork'].includes(action),retry:['cartQuote','publicGroupWork'].includes(action)||action==='webOrder'&&typeof data.requestId==='string'&&/^[a-zA-Z0-9_-]{16,96}$/.test(data.requestId)};
  if(entry.slug==='jiwu-launch-register')return {read:['authLogin','jiwuHelperGroups'].includes(action),retry:['authLogin','jiwuHelperGroups'].includes(action)};
  return {retry:false,read:false};
 }
 async function quota403(response){
  if(response.status!==403)return false;
  let reader,timer;
  try{
   reader=response.clone().body?.getReader();if(!reader)return false;
   const text=await Promise.race([(async()=>{const parts=[];let size=0;while(size<16384){const item=await reader.read();if(item.done)break;parts.push(item.value.subarray(0,16384-size));size+=parts.at(-1).length;}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return new TextDecoder().decode(bytes);})(),new Promise(resolve=>{timer=setTimeout(()=>resolve(''),500);})]);
   return /error code:\s*1027\b|Exceeded allowed (?:requests|rows (?:read|written)) in Durable Objects free tier|Durable Objects[^\n]{0,160}(?:daily request limit|request quota) (?:exceeded|reached)/i.test(text);
  }catch{return false;}finally{if(timer)clearTimeout(timer);reader?.cancel().catch(()=>{});}
 }
 async function failedResponse(response){return response.status===429||response.status>=500||await quota403(response);}
 async function probeOrigin(destination){
  if(probes.has(destination))return probes.get(destination);
  const work=(async()=>{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),probeTimeout);
   try{
    const request=new Request(destination+'/functions/v1/jiwu-admin-test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"authWarmup"}',cache:'no-store',signal:controller.signal});
    const response=await withTimeout(request,0,'json'),data=response.ok?await response.json():null;
    if(response.ok&&data?.ok===true&&data.configured===true){if(destination===preferredOrigin)recover();return true;}
   }catch{}finally{clearTimeout(timer);}
   if(destination===preferredOrigin&&state.route!==preferred){state.retryAt=now()+stickyMs;try{root.localStorage?.setItem(storageKey,JSON.stringify({route:state.route,retryAt:state.retryAt}));}catch{}}
   return false;
  })().finally(()=>{probes.delete(destination);});
  probes.set(destination,work);return work;
 }
 function probePrimary(){return probeOrigin(primary);}
 function probePreferred(){return probeOrigin(preferredOrigin);}
 function selected(){if(state.route!==preferred&&now()>=state.retryAt)void probePreferred();return state.route==='backup'?backup:primary;}
 function resolveURL(input){const ws=/^wss:/i.test(String(input)),entry=route(input,ws);if(!entry)return String(input);const target=selected();return replaceOrigin(entry.url,ws?target.replace(/^https:/,'wss:'):target);}
 root.fetch=async function(input,init){
  const entry=route(input);if(!entry)return nativeFetch(input,init);
  const original=new Request(input,init);
  if(original.signal.aborted)throw abortReason(original.signal);
  const prepared=await prepareBody(original),policy=classify(original,entry,prepared);
  if(original.signal.aborted)throw abortReason(original.signal);
  const target=selected();
  const bufferMode=policy.retry&&original.method!=='HEAD'&&!entry.asset?(entry.slug==='jiwu-public'&&entry.url.searchParams.get('format')==='gviz'?'gviz':'json'):false;
  const attempt=(destination,timeout)=>withTimeout(requestAt(replaceOrigin(entry.url,destination),original,prepared),timeout,bufferMode);
  try{
   const response=await attempt(target,policy.retry?(policy.read?(policy.longRead||(target===primary?readTimeout:backupTimeout)):mutationTimeout):0);
   if(!await failedResponse(response))return response;
   fail('http-'+response.status,target);
   if(!policy.retry||original.signal.aborted)return response;
   void response.body?.cancel().catch(()=>{});
  }catch(error){
   if(original.signal.aborted)throw abortReason(original.signal);
   fail('network',target);if(!policy.retry)throw error;
  }
  if(original.signal.aborted)throw abortReason(original.signal);
  const alternative=otherOrigin(target);
  return attempt(alternative,policy.read?(policy.longRead||(alternative===primary?readTimeout:backupTimeout)):mutationTimeout);
 };
 root.addEventListener?.('storage',event=>{if(event.key!==storageKey)return;if(event.newValue===null){state={route:preferred,retryAt:0,reason:''};notify();}else{restore();notify();}});
 if(typeof NativeWS==='function'&&typeof EventTarget==='function'){
  class JiwuWebSocket extends EventTarget{
   constructor(input,protocols){
    super();const entry=route(String(input),true);
    if(!entry)return protocols===undefined?new NativeWS(input):new NativeWS(input,protocols);
    this._entry=entry;this._protocols=protocols;this._state=0;this._binaryType='blob';this._epoch=0;this._opened=false;this._userClosed=false;this._triedOther=false;
    this.onopen=this.onmessage=this.onerror=this.onclose=null;
    this._connect(selected());
   }
   _emit(type,event){
    let copy;
    if(type==='message')copy=new MessageEvent(type,{data:event.data,origin:event.origin||'',lastEventId:event.lastEventId||''});
    else if(type==='close'&&typeof CloseEvent==='function')copy=new CloseEvent(type,{code:event.code,reason:event.reason||'',wasClean:!!event.wasClean});
    else{copy=new Event(type);if(type==='close')for(const key of ['code','reason','wasClean'])Object.defineProperty(copy,key,{value:event[key]});}
    this.dispatchEvent(copy);if(typeof this['on'+type]==='function')this['on'+type].call(this,copy);
   }
   _connect(target){
    const epoch=++this._epoch,url=replaceOrigin(this._entry.url,target.replace(/^https:/,'wss:'));
    const socket=this._protocols===undefined?new NativeWS(url):new NativeWS(url,this._protocols);
    this._socket=socket;socket.binaryType=this._binaryType;
    let timer;
    const clear=()=>{if(timer!==undefined)clearTimeout(timer);};this._clearTimer=clear;
    const current=()=>epoch===this._epoch;
    const beforeOpenFallback=()=>{
     if(!current()||this._opened||this._userClosed||this._triedOther)return false;
     clear();fail('websocket',target);this._triedOther=true;this._epoch++;try{socket.close();}catch{}this._connect(otherOrigin(target));return true;
    };
    timer=setTimeout(()=>{if(beforeOpenFallback())return;if(current()&&!this._opened&&!this._userClosed){this._state=3;this._emit('error',{});this._emit('close',{code:1006,reason:'Connection timed out',wasClean:false});this._epoch++;try{socket.close();}catch{}}},wsTimeout);
    socket.addEventListener('open',event=>{if(!current())return;clear();if(this._userClosed)return;this._opened=true;this._state=1;this._emit('open',event);});
    socket.addEventListener('message',event=>{if(current()&&!this._userClosed)this._emit('message',event);});
    socket.addEventListener('error',event=>{if(!current()||beforeOpenFallback())return;clear();if(!this._userClosed)fail('websocket',target);this._emit('error',event);});
    socket.addEventListener('close',event=>{if(!current()||beforeOpenFallback())return;clear();if(!this._userClosed&&(event.code!==1000||!event.wasClean))fail('websocket',target);this._state=3;this._emit('close',event);});
   }
   get readyState(){return this._state;}
   get url(){return this._socket.url;}
   get protocol(){return this._socket.protocol||'';}
   get extensions(){return this._socket.extensions||'';}
   get bufferedAmount(){return this._socket.bufferedAmount||0;}
   get binaryType(){return this._binaryType;}
   set binaryType(value){if(!['blob','arraybuffer'].includes(value))return;this._binaryType=value;if(this._socket)this._socket.binaryType=value;}
   send(data){if(this._state===0)throw new DOMException('WebSocket is not open','InvalidStateError');return this._socket.send(data);}
   close(code,reason){const previous=this._userClosed;this._userClosed=true;try{const result=this._socket.close(code,reason);this._clearTimer?.();this._state=this._state===3?3:2;return result;}catch(error){this._userClosed=previous;throw error;}}
  }
  for(const [name,value]of Object.entries({CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3})){Object.defineProperty(JiwuWebSocket,name,{value});Object.defineProperty(JiwuWebSocket.prototype,name,{value});}
  Object.defineProperty(JiwuWebSocket,Symbol.hasInstance,{value:value=>JiwuWebSocket.prototype.isPrototypeOf(value)||NativeWS.prototype.isPrototypeOf(value)});
  root.WebSocket=JiwuWebSocket;
 }
 root.JIWUTransport=Object.freeze({version:'20261107-v2',getState:()=>({...state,preferredRoute:preferred}),resolveURL,probePrimary,probePreferred});
})();
