(function () {
  'use strict';
  const C = window.CatalogCore;
  const $ = id => document.getElementById(id);
  const pageSize = 60;
  const inputIds = {type:'editType',name:'editName',sku:'editSku',image:'editImage',url:'editUrl',size:'editSize',japaneseName:'editJapaneseName'};
  const initial = new URL(location.href);
  const initialSite = Object.prototype.hasOwnProperty.call(C.sites,initial.searchParams.get('site')) ? initial.searchParams.get('site') : (location.pathname.includes('nagano') ? 'nagano' : 'chiikawa');
  const state = {site:initialSite,role:null,category:null,query:'',page:1,catalogs:{},client:new C.GitHubClient(),authenticated:false,busy:false,loading:false,loadId:0,editor:null,drag:null,confirm:null,pollers:new Map()};
  const draftKey = site => 'jiwu_catalog_admin_draft_v1_' + site;
  const catalog = () => state.catalogs[state.site];
  const doc = () => catalog()?.documents[state.role];
  const clone = value => JSON.parse(JSON.stringify(value));
  function el(tag,className,text) { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; }
  function button(text,handler,className) { const node=el('button',className==='secondary'?'button button-secondary':className,text);node.type='button';node.addEventListener('click',handler);return node; }
  function status(message,error) { $('status').textContent=message;$('status').classList.toggle('is-error',!!error); }
  function fail(error) {
    if(error?.code==='AUTH'){state.client.clearToken();state.authenticated=false;}
    status(error?.message || '操作未完成，請再試一次。',true);renderSummary();
  }
  function dirtyRoles(cat=catalog()) { return cat ? C.sites[cat.site.id].roles.filter(role=>C.serializeDocument(cat.documents[role])!==cat.baselines[role]) : []; }
  function isBlocked() { return state.busy || state.loading || !catalog() || !!catalog().conflictedDraft; }
  function syncUrl() { const url=new URL(location.href);url.searchParams.set('site',state.site);url.searchParams.set('role',state.role);history.replaceState(null,'',url); }
  function effectiveType(row) { return String(C.getValues(row).type || '無類型'); }
  function groups() { return doc() ? C.groupRows(doc()) : []; }
  function currentGroup() { return groups().find(group=>group.type===state.category); }
  function ensureCategory() { const all=groups();if(!all.some(group=>group.type===state.category))state.category=all[0]?.type || null; }
  function confirmAction(title,message,options={}) {
    if(state.confirm)state.confirm.resolve(false);
    $('confirmTitle').textContent=title;$('confirmMessage').textContent=message;
    $('confirmAccept').textContent=options.accept || '確定';
    $('confirmDialog').querySelector('.position-prompt')?.remove();
    let input;
    if(options.position){const label=el('label','position-prompt','移到第幾個');input=el('input');input.type='number';input.min='1';input.max=String(options.position.max);input.value=String(options.position.value);label.append(input);$('confirmMessage').after(label);}
    $('confirmDialog').showModal();if(input)input.focus();
    return new Promise(resolve=>{state.confirm={resolve,input,max:options.position?.max};});
  }
  function resolveConfirm(accepted) {
    const pending=state.confirm;if(!pending)return;
    if(accepted&&pending.input){const n=Number(pending.input.value);if(!Number.isInteger(n)||n<1||n>pending.max){pending.input.setCustomValidity('請輸入 1 到 '+pending.max+'。');pending.input.reportValidity();return;}accepted=n;}
    state.confirm=null;$('confirmDialog').close();pending.resolve(accepted);
  }
  function persistDraft(cat=catalog()) {
    if(!cat || cat.conflictedDraft)return;
    const roles=dirtyRoles(cat);
    try {
      if(!roles.length){localStorage.removeItem(draftKey(cat.site.id));cat.draftSaved=true;return;}
      const bundle={format:'jiwu-catalog-draft-v1',site:cat.site.id,savedAt:new Date().toISOString(),baseShas:cat.shas,documents:Object.fromEntries(roles.map(role=>[role,cat.documents[role].raw]))};
      localStorage.setItem(draftKey(cat.site.id),JSON.stringify(bundle));cat.draftSaved=true;
    }catch(_){cat.draftSaved=false;status('瀏覽器無法暫存草稿，請先下載草稿備份。',true);}
  }
  function restoreDraft(cat) {
    let bundle;
    try { bundle=JSON.parse(localStorage.getItem(draftKey(cat.site.id))||'null'); }catch(_){return;}
    if(!bundle)return;
    const roles=Object.keys(bundle.documents||{});
    if(bundle.format!=='jiwu-catalog-draft-v1'||bundle.site!==cat.site.id||!roles.length||roles.some(role=>!cat.site.roles.includes(role))){cat.conflictedDraft=bundle;return;}
    if(roles.some(role=>bundle.baseShas?.[C.pathForRole(role)]!==cat.shas[C.pathForRole(role)])||bundle.baseShas?.['data/updated.json']!==cat.shas['data/updated.json']){cat.conflictedDraft=bundle;return;}
    try { for(const role of roles)cat.documents[role]=C.parseDocument(bundle.documents[role]);cat.restored=true; }
    catch(_){cat.conflictedDraft=bundle;}
  }
  function recordChange(next,role=state.role) {
    const cat=catalog(),before=cat.documents[role];
    if(C.serializeDocument(before)===C.serializeDocument(next))return false;
    cat.history.push({role,raw:clone(before.raw)});if(cat.history.length>20)cat.history.shift();
    cat.documents[role]=next;persistDraft(cat);ensureCategory();render();
    status(cat.draftSaved?'已暫存草稿，按「發布」才會更新公開圖鑑。':'已修改，請先下載草稿備份。');return true;
  }
  async function loadSite(siteId,force=false) {
    const request=++state.loadId;state.site=siteId;
    if(!force&&catalog()){state.role=state.role&&C.sites[siteId].roles.includes(state.role)?state.role:C.sites[siteId].roles[0];state.category=null;ensureCategory();state.page=1;render();syncUrl();return;}
    state.loading=true;renderSummary();$('itemGrid').replaceChildren(el('p','empty-state','正在讀取圖鑑…'));status('正在讀取 '+C.sites[siteId].label+' 圖鑑…');
    try {
      const result=await state.client.loadCatalog(siteId);if(request!==state.loadId)return;
      const cat={...result,baselines:Object.fromEntries(result.site.roles.map(role=>[role,C.serializeDocument(result.documents[role])])),history:[],draftSaved:true};
      restoreDraft(cat);state.catalogs[siteId]=cat;
      const wanted=initial.searchParams.get('role');state.role=result.site.roles.includes(state.role)?state.role:(result.site.roles.includes(wanted)?wanted:result.site.roles[0]);
      state.category=null;state.page=1;ensureCategory();status(cat.conflictedDraft?'線上資料已有變更，請先下載或放棄本機草稿。':cat.restored?'已還原尚未發布的草稿。':'已讀取圖鑑，可新增、編輯與排序。',!!cat.conflictedDraft);syncUrl();
    }catch(error){if(request===state.loadId)fail(error);}
    finally{if(request===state.loadId){state.loading=false;render();}}
  }
  function renderSummary() {
    const cat=catalog(),dirty=dirtyRoles(),blocked=isBlocked();
    $('siteSelect').value=state.site;$('siteSelect').disabled=state.loading||state.busy;
    $('authBtn').textContent=state.authenticated?'GitHub 已連接':'連接 GitHub';$('authBtn').disabled=state.busy;
    $('disconnectBtn').hidden=!state.authenticated;
    for(const id of ['addItem','addCategory','undoBtn','reloadBtn','discardBtn','exportBtn','publishBtn'])$(id).disabled=blocked;
    $('reloadBtn').disabled=state.busy||state.loading;
    $('discardBtn').disabled=state.busy||state.loading||(!dirty.length&&!cat?.conflictedDraft);
    $('exportBtn').disabled=state.busy||state.loading||(!dirty.length&&!cat?.conflictedDraft);
    $('undoBtn').disabled=blocked||!cat?.history.length;
    $('publishBtn').disabled=blocked||!dirty.length;
    $('publishBtn').textContent=state.busy?'處理中…':'發布'+C.sites[state.site].label;
    $('searchInput').disabled=!cat||state.loading||state.busy;
    $('catalogTitle').textContent=C.sites[state.site].label+'圖鑑';
    $('dirtySummary').textContent=dirty.length?`${dirty.length} 個角色有未發布變更${cat?.draftSaved?' · 草稿已暫存':''}`:'目前沒有未發布變更';
    $('lastPublished').textContent=cat?.deploymentMessage || (cat?.updated?.updated?'最後更新：'+cat.updated.updated:'');
    $('publicLink').href=`https://jiwusales.github.io/${C.sites[state.site].repo}/`;
    $('notice').replaceChildren();$('notice').hidden=!cat?.conflictedDraft;
    if(cat?.conflictedDraft){$('notice').append(el('p','','本機草稿的版本與線上不同。請下載保留，或放棄本機草稿後重新編輯。'),button('下載本機草稿',exportDraft,'secondary'),button('放棄本機草稿',discardDraft,'secondary'));}
  }
  function renderRoles() {
    $('roleTabs').replaceChildren();
    for(const role of C.sites[state.site].roles){const b=button(role+ (dirtyRoles().includes(role)?' •':''),()=>{state.role=role;state.category=null;state.page=1;ensureCategory();render();syncUrl();},'role-tab'+(state.role===role?' is-active':''));b.disabled=state.loading||state.busy;b.setAttribute('aria-current',state.role===role?'true':'false');b.dataset.role=role;$('roleTabs').append(b);}
  }
  function categoryMove(type,delta) {
    if(isBlocked())return;const order=groups().map(group=>group.type),from=order.indexOf(type),to=from+delta;if(to<0||to>=order.length)return;
    [order[from],order[to]]=[order[to],order[from]];recordChange(C.reorderGroups(doc(),order));
  }
  function dragHandle(kind,label,sourceKey,onDrop,onKeyboard,disabled) {
    const handle=button('≡',()=>{},'drag-handle');handle.disabled=disabled;handle.draggable=false;
    handle.setAttribute('aria-label',label+'，拖曳或使用方向鍵調整順序');
    handle.addEventListener('keydown',event=>{
      const steps={ArrowLeft:-1,ArrowRight:1,ArrowUp:kind==='category'?-3:-4,ArrowDown:kind==='category'?3:4};
      if(disabled||!(event.key in steps))return;event.preventDefault();onKeyboard(steps[event.key]);
    });
    handle.addEventListener('pointerdown',event=>{
      if(disabled||isBlocked()||event.button!==0||event.isPrimary===false||state.drag)return;
      event.preventDefault();
      const selector=kind==='category'?'.category-item':'.item-card',source=handle.closest(selector),container=source.parentElement,documentBefore=doc();
      const start={x:event.clientX,y:event.clientY},pointerId=event.pointerId;let active=false,target=null;
      state.drag={kind,sourceKey,pointerId};
      const targetAt=e=>{const candidate=document.elementFromPoint(e.clientX,e.clientY)?.closest(selector);return candidate?.parentElement===container?candidate:null;};
      const cleanup=()=>{
        window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',cancel,true);window.removeEventListener('blur',cancelAll);document.removeEventListener('visibilitychange',visibility);handle.removeEventListener('lostpointercapture',cancelAll);
        source.classList.remove('is-dragging');target?.classList.remove('drag-over');state.drag=null;
        try{if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);}catch(_){}
      };
      const move=e=>{
        if(e.pointerId!==pointerId)return;
        if(isBlocked()||doc()!==documentBefore){cleanup();return;}
        e.preventDefault();if(!active&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<6)return;
        active=true;source.classList.add('is-dragging');
        const next=targetAt(e);if(next!==target){target?.classList.remove('drag-over');target=next;if(target!==source)target?.classList.add('drag-over');}
        if(e.clientY<60)window.scrollBy(0,-18);else if(e.clientY>innerHeight-60)window.scrollBy(0,18);
      };
      const end=e=>{
        if(e.pointerId!==pointerId)return;e.preventDefault();const destination=targetAt(e),shouldDrop=active&&destination&&destination!==source&&!isBlocked()&&doc()===documentBefore;
        cleanup();if(shouldDrop)onDrop(kind==='category'?destination.dataset.type:Number(destination.dataset.index));
      };
      const cancel=e=>{if(e.pointerId===pointerId)cleanup();};const cancelAll=()=>cleanup();const visibility=()=>{if(document.hidden)cleanup();};
      window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',cancel,true);window.addEventListener('blur',cancelAll);document.addEventListener('visibilitychange',visibility);handle.addEventListener('lostpointercapture',cancelAll);
      try{handle.setPointerCapture(pointerId);}catch(_){}
    });
    return handle;
  }
  function renderCategories() {
    const list=$('categoryList');list.replaceChildren();const all=groups();
    all.forEach(group=>{
      const wrap=el('div','category-item'+(group.type===state.category?' is-active':''));wrap.dataset.type=group.type;
      const choose=button(group.type,()=>{state.category=group.type;state.page=1;renderCategories();renderItems();},'category-select');choose.append(el('span','category-count',String(group.rows.length)));choose.disabled=isBlocked();
      const handle=dragHandle('category','拖曳分類「'+group.type+'」',group.type,target=>{const order=groups().map(g=>g.type),from=order.indexOf(group.type),to=order.indexOf(target);if(from<0||to<0||from===to)return;order.splice(to,0,order.splice(from,1)[0]);recordChange(C.reorderGroups(doc(),order));},delta=>{categoryMove(group.type,delta);Array.from(list.children).find(node=>node.dataset.type===group.type)?.querySelector('.drag-handle')?.focus();},isBlocked());
      wrap.append(handle,choose);list.append(wrap);
    });
    if(!all.length)list.append(el('p','empty-state','按右上方「＋」新增分類。'));
  }
  function imageUrl(value) {
    const first=String(value||'').trim().split(/\s+/)[0];if(!first)return '';
    try{const u=new URL(first);if(!['https:','http:'].includes(u.protocol))return '';return u.href.replace(/^https:\/\/([^.]+)\.github\.io\/([^/]+)\/(.+)$/,'https://cdn.jsdelivr.net/gh/$1/$2@main/$3').replace(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,'https://cdn.jsdelivr.net/gh/$1/$2@$3/$4');}catch(_){return '';}
  }
  function moveItem(index,to) {
    if(isBlocked())return;const group=currentGroup();if(!group)return;const indices=group.rows.map(item=>item.index),from=indices.indexOf(index);if(from<0||to<0||to>=indices.length||from===to)return;
    indices.splice(to,0,indices.splice(from,1)[0]);const scroll=window.scrollY;recordChange(C.reorderItems(doc(),group.type,indices));window.scrollTo(0,scroll);
  }
  async function moveItemPrompt(index) {
    const group=currentGroup(),position=group.rows.findIndex(item=>item.index===index);
    const to=await confirmAction('調整商品位置','依目前分類的完整順序移動商品。',{accept:'移動',position:{max:group.rows.length,value:position+1}});
    if(to!==false)moveItem(index,to-1);
  }
  function renderItems() {
    const grid=$('itemGrid'),pages=$('pagination');grid.setAttribute('aria-busy',String(state.loading));grid.replaceChildren();pages.replaceChildren();
    if(!doc()){grid.append(el('p','empty-state',state.loading?'正在讀取圖鑑…':state.authenticated?'尚未讀取資料，請按「重新載入」。':'請先登入圖鑑管理，登入後會還原這台瀏覽器的草稿。'));$('countSummary').textContent='';return;}
    const group=currentGroup(),query=state.query.toLocaleLowerCase(),all=group?.rows||[],filtered=all.filter(item=>!query||Object.values(item.values).some(value=>String(value).toLocaleLowerCase().includes(query)));
    const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));state.page=Math.min(state.page,totalPages);
    const displayed=filtered.slice((state.page-1)*pageSize,state.page*pageSize),sortDisabled=isBlocked()||!!state.query;
    $('countSummary').textContent=`${state.role}共 ${doc().rows.length} 筆 · ${state.category||'尚無分類'} ${all.length} 筆`+(query?` · 搜尋結果 ${filtered.length} 筆`:'');
    $('sortHint').textContent=query?'清除搜尋後可調整商品順序。':'拖曳「≡」調整順序，或按「移到」指定位置。';
    for(const item of displayed){
      const position=all.findIndex(value=>value.index===item.index),card=el('article','item-card');card.dataset.index=String(item.index);
      const picture=el('div','item-image'),src=imageUrl(item.values.image);
      if(src){const image=el('img');image.src=src;image.alt=String(item.values.name||'未命名商品');image.loading='lazy';image.decoding='async';image.addEventListener('error',()=>{image.remove();picture.append(el('span','image-placeholder','圖片無法載入'));},{once:true});picture.append(image);}else picture.append(el('span','image-placeholder','尚無圖片'));
      picture.append(el('span','item-position',String(position+1)));
      const info=el('div','item-info');info.append(el('h3','item-name',String(item.values.name||'（未填名稱）')),el('p','item-size',String(item.values.size||'未填尺寸')),el('p','item-sku',String(item.values.sku||'')));
      const controls=el('div','item-actions'),edit=button('編輯',()=>openEditor(item.index),'secondary');edit.disabled=isBlocked();
      const move=button('移到',()=>moveItemPrompt(item.index),'secondary');move.disabled=sortDisabled;controls.append(edit,move);
      const handle=dragHandle('item','拖曳商品第 '+(position+1)+' 個',item.index,target=>{const to=currentGroup()?.rows.findIndex(value=>value.index===target);if(to>=0)moveItem(item.index,to);},delta=>{const to=position+delta;if(to<0||to>=all.length)return;state.page=Math.floor(to/pageSize)+1;moveItem(item.index,to);const next=currentGroup()?.rows[to];if(next)grid.querySelector('[data-index="'+next.index+'"] .drag-handle')?.focus();},sortDisabled);
      for(const image of picture.querySelectorAll('img'))image.draggable=false;
      card.append(handle,picture,info,controls);grid.append(card);
    }
    if(!displayed.length)grid.append(el('div','empty-state',query?'找不到符合的商品。':'這裡還沒有商品，按「新增商品」開始。'));
    if(totalPages>1){const prev=button('上一頁',()=>{state.page--;renderItems();},'page-btn');prev.disabled=state.page===1;const next=button('下一頁',()=>{state.page++;renderItems();},'page-btn');next.disabled=state.page===totalPages;pages.append(prev,el('span','page-label',`${state.page} / ${totalPages}`),next);}
  }
  function render() { renderSummary();renderRoles();renderCategories();renderItems(); }
  function grabForm() { return Object.fromEntries(C.FIELDS.map(field=>[field,$(inputIds[field]).value])); }
  function updatePreview() { const src=imageUrl($('editImage').value);$('imagePreview').hidden=!src;$('imagePreviewEmpty').hidden=!!src;if(src)$('imagePreview').src=src; }
  function updateIdentityWarning() {
    const edit=state.editor;if(!edit||edit.index===null){$('identityWarning').hidden=true;return;}
    const changed=$('editName').value!==edit.inputs.name || $('editType').value!==edit.inputs.type;
    $('identityWarning').hidden=!changed;$('identityWarning').textContent='修改既有商品的名稱或分類，會讓使用者原本的勾選無法對應。只改圖片、尺寸或排序則不影響。';
  }
  function openEditor(index=null,presetType) {
    if(isBlocked())return;const document=doc(),values=index===null?{type:presetType??state.category??'',name:'',sku:'',image:'',url:'',size:'',japaneseName:''}:C.getValues(document.rows[index]);
    $('editorTitle').textContent=index===null?'新增商品':'編輯商品';$('editorForm').reset();$('formError').textContent='';$('identityWarning').hidden=true;
    for(const field of C.FIELDS)$(inputIds[field]).value=String(field==='type'?(values.type||'無類型'):(values[field]??''));
    if(index===null&&!presetType&&!state.category)$('editType').value='';
    $('editName').required=index===null||!!values.name;
    const group=C.groupRows(document).find(g=>g.type===$('editType').value),position=index===null?(group?.rows.length||0)+1:(group?.rows.findIndex(item=>item.index===index)??0)+1;
    $('editPosition').value=String(position);$('editPosition').max=String((group?.rows.length||0)+(index===null?1:0));
    $('typeOptions').replaceChildren(...groups().map(g=>{const option=el('option');option.value=g.type;return option;}));
    state.editor={site:state.site,role:state.role,index,document,inputs:grabForm(),position};updatePreview();$('editorDialog').showModal();$('editName').focus();
  }
  function validateChanged(values,fields) {
    if(fields.includes('type')&&Object.getOwnPropertyNames(Object.prototype).includes(String(values.type)))throw new Error('請使用其他分類名稱，這個名稱無法在公開圖鑑顯示。');
    for(const field of fields){const value=String(values[field]??'');if(['name','type','size'].includes(field)&&/[<>\"]/.test(value))throw new Error(C.FIELD_LABELS[C.FIELDS.indexOf(field)]+'不可包含 <、> 或雙引號。');if(['image','url'].includes(field)&&value){let url;try{url=new URL(value);}catch(_){throw new Error(field==='image'?'請填入完整的圖片網址。':'請填入完整的商品網址。');}if(!['https:','http:'].includes(url.protocol)||/[\s<>\"']/.test(value))throw new Error('網址請使用完整的 http 或 https 連結，不可包含空白或引號。');}}
  }
  async function saveEditor(event) {
    event.preventDefault();const edit=state.editor;if(!edit)return;
    try {
      if(edit.site!==state.site||edit.role!==state.role||edit.document!==doc())throw new Error('資料已更新，請關閉表單後重新選取商品。');
      const values=grabForm(),isNew=edit.index===null,fields=C.FIELDS.filter(field=>isNew||values[field]!==edit.inputs[field]);
      if((isNew||fields.includes('name'))&&!values.name.trim())throw new Error('請填寫商品名稱。');if(!values.type.trim())throw new Error('請填寫分類。');validateChanged(values,fields);
      const oldType=isNew?null:effectiveType(doc().rows[edit.index]);
      const patch=Object.fromEntries(fields.map(field=>[field,values[field]]));
      const identityChanged=!isNew&&C.updateItem(doc(),edit.index,patch).identityChanged;
      const proposedType=isNew||fields.includes('type')?values.type:oldType;
      const proposedName=isNew||fields.includes('name')?values.name:C.getValues(doc().rows[edit.index]).name;
      const duplicate=(isNew||identityChanged)&&doc().rows.some((row,index)=>index!==edit.index&&effectiveType(row)===proposedType&&String(C.getValues(row).name||'')===String(proposedName||''));
      const warnings=[];
      if(identityChanged)warnings.push('修改名稱或分類會改變收藏對照，使用者舊勾選可能不再顯示。');
      if(duplicate)warnings.push('同分類已有同名商品，公開圖鑑會共用勾選狀態。');
      if(warnings.length&&!await confirmAction('確認商品對照',warnings.join(' '),{accept:isNew?'仍要新增':'確定修改'}))return;
      let next=isNew?C.addItem(doc(),values):C.updateItem(doc(),edit.index,patch).document;
      const type=isNew||fields.includes('type')?values.type:oldType,group=C.groupRows(next).find(g=>g.type===type);
      const position=Number($('editPosition').value);
      if(!Number.isInteger(position)||position<1||position>(group?.rows.length||0))throw new Error('排序位置請填 1 到 '+(group?.rows.length||1)+'。');
      let index;
      if(isNew||oldType!==type)index=group.rows.at(-1).index;else index=edit.index;
      const order=group.rows.map(item=>item.index),from=order.indexOf(index);if(from!==position-1){order.splice(position-1,0,order.splice(from,1)[0]);next=C.reorderItems(next,type,order);}
      state.category=type;state.page=Math.floor((position-1)/pageSize)+1;recordChange(next);$('editorDialog').close();state.editor=null;
    }catch(error){$('formError').textContent=error.message;}
  }
  function exportDraft() {
    const cat=catalog();if(!cat)return;const roles=dirtyRoles(cat);
    const bundle=cat.conflictedDraft||{format:'jiwu-catalog-draft-v1',site:state.site,baseShas:cat.shas,documents:Object.fromEntries(roles.map(role=>[role,cat.documents[role].raw]))};
    const blob=new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='圖鑑草稿-'+state.site+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function discardDraft() {
    if(state.busy||state.loading)return;if(!await confirmAction('放棄本圖鑑草稿','尚未發布的新增、編輯及排序會被放棄，公開圖鑑不會改動。',{accept:'放棄草稿'}))return;
    try{localStorage.removeItem(draftKey(state.site));}catch(_){}delete state.catalogs[state.site];await loadSite(state.site,true);
  }
  function updateTime() { const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${v.year}/${v.month}/${v.day} ${v.hour}:${v.minute}`; }
  async function pollPublication(site,commit,cat) {
    let attempts=0;
    async function poll(){
      if(cat.deploymentCommit!==commit||state.catalogs[site]!==cat)return;
      attempts++;
      try{
        const result=await state.client.getPagesStatus(site,commit);
        if(cat.deploymentCommit!==commit||state.catalogs[site]!==cat)return;
        if(result.status==='completed'){cat.deploymentMessage=result.conclusion==='success'?'已發布到公開圖鑑 · '+cat.updated.updated:'資料已儲存，網站發布未完成，請檢查 GitHub Pages。';if(state.site===site){renderSummary();status(cat.deploymentMessage,result.conclusion!=='success');}state.pollers.delete(site);return;}
      }catch(_){/* The commit remains safely stored even if workflow status cannot be read. */}
      if(cat.deploymentCommit!==commit||state.catalogs[site]!==cat)return;
      cat.deploymentMessage='已儲存到 GitHub，等待網站發布…';if(state.site===site)renderSummary();
      if(attempts<16)state.pollers.set(site,setTimeout(poll,15000));else{cat.deploymentMessage='已儲存到 GitHub，請開啟公開圖鑑確認發布結果。';if(state.site===site)renderSummary();state.pollers.delete(site);}
    }
    clearTimeout(state.pollers.get(site));await poll();
  }
  async function publish() {
    if(isBlocked()||!dirtyRoles().length)return;
    if(!state.authenticated){$('authError').textContent='請先連接 GitHub，再發布草稿。';$('authDialog').showModal();return;}
    const roles=dirtyRoles(),site=state.site,cat=catalog();
    if(!await confirmAction('發布'+C.sites[site].label+'圖鑑','將發布 '+roles.join('、')+' 的變更。公開圖鑑會在 GitHub Pages 完成發布後更新。',{accept:'確認發布'}))return;
    state.busy=true;renderSummary();renderRoles();renderCategories();renderItems();status('正在儲存到 GitHub，請稍候…');
    try {
      const result=await state.client.publish(site,Object.fromEntries(roles.map(role=>[role,cat.documents[role]])),cat.shas,updateTime());
      cat.shas=result.shas;cat.headSha=result.commitSha;cat.updated=result.updated;for(const role of roles)cat.baselines[role]=C.serializeDocument(cat.documents[role]);cat.history=[];persistDraft(cat);
      cat.deploymentCommit=result.commitSha;cat.deploymentMessage='已儲存到 GitHub，等待網站發布…';status(cat.deploymentMessage);pollPublication(site,result.commitSha,cat);
    }catch(error){
      if(error.published)status('GitHub 已收到變更，但讀回確認未完成。草稿已保留，請重新讀取確認後再操作。',true);else fail(error);
      persistDraft(cat);
    }finally{state.busy=false;render();}
  }
  async function connect(event) {
    event.preventDefault();const token=$('tokenInput').value.trim();$('tokenInput').value='';
    if(!token){$('authError').textContent='請輸入 GitHub 權杖。';return;}
    $('authSubmit').disabled=true;$('authError').textContent='正在確認 GitHub 存取權限…';
    const candidate=new C.GitHubClient({token});
    try {
      await candidate.getFile(state.site,'data/updated.json',C.sites[state.site].branch);
      state.client.clearToken();state.client=candidate;state.authenticated=true;$('authError').textContent='';$('authDialog').close();status('已連接 GitHub，可發布本圖鑑草稿。');renderSummary();if(!catalog())await loadSite(state.site,true);
    }catch(error){candidate.clearToken();$('authError').textContent=error.message;}
    finally{$('authSubmit').disabled=false;}
  }
  $('siteSelect').addEventListener('change',()=>{state.role=null;state.category=null;state.page=1;loadSite($('siteSelect').value);});
  let searchTimer;$('searchInput').addEventListener('input',()=>{state.query=$('searchInput').value;state.page=1;clearTimeout(searchTimer);searchTimer=setTimeout(renderItems,120);});
  $('addItem').addEventListener('click',()=>openEditor());
  $('addCategory').addEventListener('click',()=>{if(isBlocked())return;$('categoryName').value='';$('categoryError').textContent='';$('categoryDialog').showModal();$('categoryName').focus();});
  $('categoryCancel').addEventListener('click',()=>$('categoryDialog').close());
  $('categoryForm').addEventListener('submit',event=>{event.preventDefault();if(isBlocked())return;try{const name=$('categoryName').value.trim();if(name.length>160)throw new Error('分類名稱最多 160 字。');const next=C.addCategory(doc(),name);state.category=name;state.query='';$('searchInput').value='';state.page=1;recordChange(next);$('categoryDialog').close();status('已新增分類「'+name+'」。');}catch(error){$('categoryError').textContent=error.message;$('categoryName').focus();}});
  $('undoBtn').addEventListener('click',()=>{if(isBlocked())return;const cat=catalog(),previous=cat.history.pop();if(!previous)return;cat.documents[previous.role]=C.parseDocument(previous.raw);state.role=previous.role;persistDraft(cat);ensureCategory();render();status('已復原上一步，尚未發布。');});
  $('reloadBtn').addEventListener('click',()=>{persistDraft();loadSite(state.site,true);});
  $('discardBtn').addEventListener('click',discardDraft);$('exportBtn').addEventListener('click',exportDraft);$('publishBtn').addEventListener('click',publish);
  $('authBtn').addEventListener('click',()=>{$('authError').textContent='';$('tokenInput').value='';$('authDialog').showModal();$('tokenInput').focus();});
  $('authForm').addEventListener('submit',connect);$('authClose').addEventListener('click',()=>{$('tokenInput').value='';$('authDialog').close();});$('authDialog').addEventListener('cancel',()=>{$('tokenInput').value='';});
  $('disconnectBtn').addEventListener('click',()=>{state.client.clearToken();state.client=new C.GitHubClient();state.authenticated=false;$('tokenInput').value='';$('authDialog').close();renderSummary();status('已中斷 GitHub 連接，草稿仍保留。');});
  $('editorForm').addEventListener('submit',saveEditor);$('cancelEdit').addEventListener('click',()=>{$('editorDialog').close();state.editor=null;});$('editorDialog').addEventListener('cancel',()=>{state.editor=null;});
  $('editImage').addEventListener('input',updatePreview);$('imagePreview').addEventListener('error',()=>{$('imagePreview').hidden=true;$('imagePreviewEmpty').hidden=false;$('imagePreviewEmpty').textContent='圖片暫時無法載入，請確認網址。';});
  for(const id of ['editName','editType'])$(id).addEventListener('input',updateIdentityWarning);
  $('editType').addEventListener('change',()=>{const group=groups().find(g=>g.type===$('editType').value),edit=state.editor;if(!edit)return;const same=edit.index!==null&&effectiveType(doc().rows[edit.index])===$('editType').value;const n=(group?.rows.length||0)+(same?0:1);$('editPosition').max=String(n);$('editPosition').value=String(same?edit.position:n);});
  $('confirmCancel').addEventListener('click',()=>resolveConfirm(false));$('confirmAccept').addEventListener('click',()=>resolveConfirm(true));$('confirmDialog').addEventListener('cancel',event=>{event.preventDefault();resolveConfirm(false);});
  window.addEventListener('beforeunload',event=>{if(state.busy||Object.values(state.catalogs).some(cat=>dirtyRoles(cat).length)||(state.editor&&C.FIELDS.some(field=>$(inputIds[field]).value!==state.editor.inputs[field]))){event.preventDefault();event.returnValue='';}});
  loadSite(initialSite);
}());
