(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatalogCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FIELDS = Object.freeze(['type', 'name', 'sku', 'image', 'url', 'size', 'japaneseName']);
  const FIELD_LABELS = Object.freeze(['類型', '名稱', '貨號', '圖片', '網址', '尺寸', '日韓名']);
  const sites = Object.freeze({
    chiikawa: Object.freeze({id:'chiikawa', label:'吉伊卡哇', owner:'jiwusales', repo:'jiwusales_chiikawa', branch:'main', roles:Object.freeze(['吉伊','小八','兔兔','小桃','師傅','栗子','獅薩','古本','其他角色'])}),
    nagano: Object.freeze({id:'nagano', label:'自嘲熊', owner:'jiwusales', repo:'jiwusales_nagano', branch:'main', roles:Object.freeze(['白熊','巴哥','可樂餅','綜合角色'])})
  });
  const clone = value => JSON.parse(JSON.stringify(value));
  const owns = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);
  const pathForRole = role => 'data/' + role + '.json';
  const pathEncoded = path => path.split('/').map(encodeURIComponent).join('/');
  function siteDefinition(value) {
    const site = typeof value === 'string' ? sites[value] : value;
    if (!site || !sites[site.id] || sites[site.id].repo !== site.repo) throw new Error('未知的圖鑑。');
    return sites[site.id];
  }
  function parseDocument(value) {
    let raw;
    if (typeof value === 'string') {
      try { raw = JSON.parse(value); }
      catch (_) {
        const start = value.indexOf('{'), end = value.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('圖鑑資料不是有效的 JSON。');
        try { raw = JSON.parse(value.slice(start,end + 1)); }
        catch (_) { throw new Error('圖鑑資料不是有效的 JSON。'); }
      }
    } else raw = clone(value);
    if (!raw || !raw.table || !Array.isArray(raw.table.rows) || !raw.table.rows.length || !raw.table.rows.every(row => row && Array.isArray(row.c))) {
      throw new Error('圖鑑資料格式錯誤：必須保留 GViz 表格與標題列。');
    }
    if (owns(raw,'catalogCategories') && (!Array.isArray(raw.catalogCategories) || raw.catalogCategories.some(type=>typeof type!=='string') || new Set(raw.catalogCategories).size!==raw.catalogCategories.length)) throw new Error('圖鑑分類資料格式錯誤。');
    return {raw, header:raw.table.rows[0], rows:raw.table.rows.slice(1), fields:FIELDS.slice()};
  }
  function getValues(row) {
    const values = {};
    FIELDS.forEach((field,index) => { values[field] = row.c[index] && row.c[index].v != null ? row.c[index].v : ''; });
    return values;
  }
  function groupType(row) { return String(getValues(row).type || '無類型'); }
  function collectionIdentity(row, role) {
    const values = getValues(row);
    return (role == null ? '' : role + '|') + String(values.type || '無類型') + '|' + String(values.name || '');
  }
  function withRows(doc, rows, categories) {
    const raw = clone(doc.raw);
    raw.table.rows = [clone(doc.header)].concat(clone(rows));
    if (categories !== undefined) raw.catalogCategories = categories.slice();
    return parseDocument(raw);
  }
  function serializeDocument(doc) {
    const raw = clone(doc.raw);
    raw.table.rows = [clone(doc.header)].concat(clone(doc.rows));
    return JSON.stringify(raw) + '\n';
  }
  function groupRows(doc) {
    const groups = [], byType = new Map();
    for (const type of doc.raw.catalogCategories || []) {
      const group={type,rows:[]};byType.set(type,group);groups.push(group);
    }
    doc.rows.forEach((row,index) => {
      const type = groupType(row);
      if (!byType.has(type)) { const group = {type,rows:[]}; byType.set(type,group); groups.push(group); }
      byType.get(type).rows.push({index,row,values:getValues(row)});
    });
    return groups;
  }
  function patchRow(row, patch) {
    const result = clone(row);
    FIELDS.forEach((field,index) => {
      if (owns(patch,field) && patch[field] !== undefined) {
        while (result.c.length <= index) result.c.push(null);
        result.c[index] = Object.assign({},result.c[index] || {},{v:patch[field]});
      }
    });
    return result;
  }
  function insertionIndex(rows,type,types=[]) {
    for (let index=rows.length-1;index>=0;index--) if (groupType(rows[index]) === type) return index + 1;
    const position=types.indexOf(type);
    if(position!==-1){for(const nextType of types.slice(position+1)){const index=rows.findIndex(row=>groupType(row)===nextType);if(index!==-1)return index;}}
    return rows.length;
  }
  function categoryName(name) {
    if(typeof name!=='string')throw new Error('請填寫分類名稱。');
    const trimmed=name.trim();
    if(!trimmed)throw new Error('分類名稱不能空白。');
    if(/[<>\"]/.test(trimmed)||Object.getOwnPropertyNames(Object.prototype).includes(trimmed))throw new Error('請使用有效的分類名稱，不可包含 <、> 或雙引號。');
    return trimmed;
  }
  function addCategory(doc,name) {
    const type=categoryName(name),types=groupRows(doc).map(group=>group.type);
    if(types.includes(type))throw new Error('這個分類已經存在。');
    return withRows(doc,doc.rows,types.concat(type));
  }
  function addItem(doc, values) {
    const count = Math.max(FIELDS.length, (doc.raw.table.cols || []).length, doc.header.c.length);
    const row = {c:Array.from({length:count},(_,index) => index < FIELDS.length ? {v:owns(values,FIELDS[index]) ? values[FIELDS[index]] : ''} : null)};
    const rows = doc.rows.slice();
    const types=groupRows(doc).map(group=>group.type),type=groupType(row);
    if(!types.includes(type))types.push(type);
    rows.splice(insertionIndex(rows,type,types),0,row);
    return withRows(doc,rows,owns(doc.raw,'catalogCategories')?types:undefined);
  }
  function validIndex(doc,index) {
    if (!Number.isInteger(index) || index < 0 || index >= doc.rows.length) throw new Error('找不到要修改的商品，請重新選取。');
  }
  function updateItem(doc,index,patch) {
    validIndex(doc,index);
    const before = doc.rows[index], after = patchRow(before,patch), rows = doc.rows.slice();
    const types=groupRows(doc).map(group=>group.type);
    if(!types.includes(groupType(after)))types.push(groupType(after));
    rows[index] = after;
    if (groupType(before) !== groupType(after)) {
      rows.splice(index,1);
      rows.splice(insertionIndex(rows,groupType(after),types),0,after);
    }
    const beforeIdentity = collectionIdentity(before), afterIdentity = collectionIdentity(after);
    return {document:withRows(doc,rows,owns(doc.raw,'catalogCategories')?types:undefined), identityChanged:beforeIdentity !== afterIdentity, beforeIdentity, afterIdentity};
  }
  function reorderItems(doc,type,indices) {
    const positions = [];
    doc.rows.forEach((row,index) => { if (groupType(row) === type) positions.push(index); });
    if (!Array.isArray(indices) || indices.length !== positions.length || new Set(indices).size !== positions.length || indices.some(index => !positions.includes(index))) {
      throw new Error('商品排序必須包含該分類的每一筆資料各一次。');
    }
    const rows = doc.rows.slice();
    positions.forEach((position,index) => { rows[position] = doc.rows[indices[index]]; });
    return withRows(doc,rows);
  }
  function reorderGroups(doc,types) {
    const groups = groupRows(doc), current = groups.map(group => group.type);
    if (!Array.isArray(types) || types.length !== current.length || new Set(types).size !== current.length || types.some(type => !current.includes(type))) {
      throw new Error('分類排序必須包含每一個分類各一次。');
    }
    const byType = new Map(groups.map(group => [group.type,group.rows.map(item => item.row)]));
    return withRows(doc,types.flatMap(type => byType.get(type)),owns(doc.raw,'catalogCategories')?types:undefined);
  }
  function renameGroup(doc,oldType,newType) {
    newType=categoryName(newType);
    const types=groupRows(doc).map(group=>group.type);
    if(newType!==oldType&&types.includes(newType))throw new Error('這個分類已經存在。');
    let identityChanges = 0;
    const rows = doc.rows.map(row => {
      if (groupType(row) !== oldType) return row;
      const changed = patchRow(row,{type:newType});
      if (collectionIdentity(row) !== collectionIdentity(changed)) identityChanges++;
      return changed;
    });
    return {document:withRows(doc,rows,owns(doc.raw,'catalogCategories')?types.map(type=>type===oldType?newType:type):undefined),identityChanges};
  }

  class GitHubError extends Error {
    constructor(message,code,status,details) { super(message); this.name='GitHubError'; this.code=code; this.status=status || 0; this.details=details || {}; }
  }
  function decodeContent(content) {
    const base64 = content.replace(/\s/g,'');
    if (typeof Buffer !== 'undefined') return Buffer.from(base64,'base64').toString('utf8');
    const binary = atob(base64), bytes = Uint8Array.from(binary,char => char.charCodeAt(0));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  class GitHubClient {
    constructor(options) {
      options = options || {};
      this.token = String(options.token || '').trim();
      this.fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.apiBase = 'https://api.github.com';
      if (!this.fetchImpl) throw new Error('此瀏覽器無法連接 GitHub。');
    }
    clearToken() { this.token = ''; }
    async request(path, options) {
      options = options || {};
      const headers = {'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'};
      if (this.token && !options.unauthenticated) headers.Authorization = 'Bearer ' + this.token;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try { response = await this.fetchImpl(this.apiBase + path,{method:options.method || 'GET', headers, cache:'no-store', credentials:'omit', ...(options.body !== undefined ? {body:JSON.stringify(options.body)} : {})}); }
      catch (_) { throw new GitHubError('無法連接 GitHub，請確認網路後重試。','NETWORK'); }
      let data;
      try { data = await response.json(); } catch (_) { data = {}; }
      if (!response.ok) {
        const remaining = response.headers && response.headers.get('x-ratelimit-remaining');
        const retryAfter = response.headers && response.headers.get('retry-after');
        let code='API', message='GitHub 操作失敗，請稍後再試。';
        if (response.status === 401) { code='AUTH'; message='GitHub 權杖無效或已過期，請重新連接。'; }
        else if (response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter))) { code='RATE_LIMIT'; message='GitHub 暫時限制請求次數，請稍後再試。'; }
        else if (response.status === 403) { code='PERMISSION'; message='GitHub 拒絕存取，請確認權杖具有這兩個圖鑑專案的 Contents 讀寫權限。'; }
        else if (response.status === 404) { code='NOT_FOUND'; message='找不到 GitHub 專案或資料檔，請確認權杖的專案存取權限。'; }
        else if (response.status === 409 || response.status === 422) { code='CONFLICT'; message='GitHub 版本已變更或拒絕更新；請保留草稿並重新讀取比較。'; }
        throw new GitHubError(message,code,response.status,{retryAfter:retryAfter || null,resetAt:response.headers && response.headers.get('x-ratelimit-reset')});
      }
      return data;
    }
    base(site) { const def=siteDefinition(site); return '/repos/' + def.owner + '/' + def.repo; }
    async getHead(site) {
      const def=siteDefinition(site), ref=await this.request(this.base(def)+'/git/ref/heads/'+pathEncoded(def.branch));
      if (!ref.object || !ref.object.sha) throw new GitHubError('GitHub 分支資料不完整。','FORMAT');
      return ref.object.sha;
    }
    async getFile(site,path,ref) {
      const file=await this.request(this.base(site)+'/contents/'+pathEncoded(path)+'?ref='+encodeURIComponent(ref));
      if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !file.sha) throw new GitHubError('GitHub 資料檔格式不完整，請重新讀取。','FORMAT');
      return {sha:file.sha,content:decodeContent(file.content)};
    }
    async loadCatalog(site) {
      const def=siteDefinition(site), headSha=await this.getHead(def);
      const paths=def.roles.map(pathForRole).concat('data/updated.json');
      const files=await Promise.all(paths.map(path => this.getFile(def,path,headSha)));
      const documents={}, shas={};
      def.roles.forEach((role,index) => { documents[role]=parseDocument(files[index].content); shas[paths[index]]=files[index].sha; });
      shas['data/updated.json']=files[files.length-1].sha;
      let updated;
      try { updated=JSON.parse(files[files.length-1].content); } catch (_) { throw new GitHubError('更新時間資料格式錯誤。','FORMAT'); }
      return {site:def,headSha,documents,shas,updated};
    }
    async publish(site,changedDocuments,expectedShas,updatedString) {
      const def=siteDefinition(site);
      if (!this.token) throw new GitHubError('請先連接具有 Contents 讀寫權限的 GitHub 權杖。','AUTH');
      const entries=[], seen=new Set();
      Object.keys(changedDocuments || {}).forEach(key => {
        const role=def.roles.includes(key) ? key : def.roles.find(value => pathForRole(value) === key);
        if (!role) throw new GitHubError('發布內容包含不允許修改的檔案。','VALIDATION');
        const path=pathForRole(role);
        if (seen.has(path)) throw new GitHubError('發布內容包含重複的資料檔。','VALIDATION');
        seen.add(path);
        const doc=changedDocuments[key];
        entries.push({path,role,content:serializeDocument(doc && doc.raw ? doc : parseDocument(doc))});
      });
      if (!entries.length) throw new GitHubError('沒有需要發布的變更。','VALIDATION');
      if (typeof updatedString !== 'string' || !updatedString.trim()) throw new GitHubError('缺少更新時間。','VALIDATION');
      const updatedPath='data/updated.json';
      expectedShas=expectedShas || {};
      entries.forEach(entry => { if (!expectedShas[entry.path] && !expectedShas[entry.role]) throw new GitHubError('缺少原始檔案版本，請重新讀取圖鑑。','VERSION'); });
      if (!expectedShas[updatedPath]) throw new GitHubError('缺少更新時間檔案版本，請重新讀取圖鑑。','VERSION');
      const headSha=await this.getHead(def);
      const current=await Promise.all(entries.map(entry=>this.getFile(def,entry.path,headSha)).concat(this.getFile(def,updatedPath,headSha)));
      entries.forEach((entry,index) => {
        if (current[index].sha !== (expectedShas[entry.path] || expectedShas[entry.role])) throw new GitHubError('「'+entry.role+'」已在其他地方修改。草稿已保留，請重新讀取比較後再發布。','CONFLICT',409,{path:entry.path});
      });
      if (current[current.length-1].sha !== expectedShas[updatedPath]) throw new GitHubError('圖鑑已有新的發布版本。草稿已保留，請重新讀取比較後再發布。','CONFLICT',409,{path:updatedPath});
      let updated;
      try { updated=JSON.parse(current[current.length-1].content); } catch (_) { throw new GitHubError('更新時間資料格式錯誤。','FORMAT'); }
      updated.updated=updatedString;
      entries.push({path:updatedPath,content:JSON.stringify(updated)+'\n'});
      const commit=await this.request(this.base(def)+'/git/commits/'+headSha);
      if (!commit.tree || !commit.tree.sha) throw new GitHubError('GitHub 版本資料不完整。','FORMAT');
      const tree=await this.request(this.base(def)+'/git/trees',{method:'POST',body:{base_tree:commit.tree.sha,tree:entries.map(entry=>({path:entry.path,mode:'100644',type:'blob',content:entry.content}))}});
      const created=await this.request(this.base(def)+'/git/commits',{method:'POST',body:{message:'更新圖鑑資料 '+updatedString,tree:tree.sha,parents:[headSha]}});
      let updateUncertain=false;
      try { await this.request(this.base(def)+'/git/refs/heads/'+pathEncoded(def.branch),{method:'PATCH',body:{sha:created.sha,force:false}}); }
      catch (error) {
        if (error.code !== 'NETWORK') throw error;
        const latest=await this.getHead(def);
        if (latest !== created.sha) { error.commitSha=created.sha; throw error; }
        updateUncertain=true;
      }
      let verified;
      try {
        verified=await Promise.all(entries.map(entry=>this.getFile(def,entry.path,created.sha)));
        verified.forEach((file,index) => { if (file.content !== entries[index].content) throw new GitHubError('GitHub 已提交，但讀回內容不一致，請保留草稿並重新讀取。','VERIFY'); });
      } catch (error) {
        error.commitSha=created.sha;
        error.published=true;
        throw error;
      }
      const shas=Object.assign({},expectedShas);
      entries.forEach((entry,index)=>{ shas[entry.path]=verified[index].sha; });
      return {commitSha:created.sha,headSha:created.sha,shas,updated,verified:true,updateUncertain,url:'https://github.com/'+def.owner+'/'+def.repo+'/commit/'+created.sha};
    }
    async getPagesStatus(site,commitSHA) {
      const path=this.base(site)+'/actions/runs?head_sha='+encodeURIComponent(commitSHA)+'&per_page=100';
      let data;
      try { data=await this.request(path); }
      catch (error) {
        // Public deployment status must still work with a Contents-only token.
        if (error.code !== 'PERMISSION' || !this.token) throw error;
        data=await this.request(path,{unauthenticated:true});
      }
      const runs=(data.workflow_runs || []).filter(run=>run.head_sha === commitSHA && (/pages/i.test(String(run.name || '')) || /pages/i.test(String(run.path || ''))));
      if (!runs.length) return {status:'waiting',conclusion:null,runs:[]};
      runs.sort((a,b)=>Number(b.id)-Number(a.id));
      const latest=runs[0];
      return {status:latest.status,conclusion:latest.conclusion || null,url:latest.html_url,runs};
    }
  }
  return {sites,FIELDS,FIELD_LABELS,pathForRole,parseDocument,serializeDocument,getValues,groupRows,collectionIdentity,addCategory,addItem,updateItem,reorderItems,reorderGroups,renameGroup,GitHubClient,GitHubError};
}));
