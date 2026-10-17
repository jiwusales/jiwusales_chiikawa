(function () {
  'use strict';
  const $=id=>document.getElementById(id);
  const encoder=new TextEncoder();
  const filename='jiwu-catalog-setup.encrypted.json';
  const cloudflareClientId='54d11594-84e4-41aa-b438-e81b8fa78ee7';
  const cloudflareScopes=['account:read','user:read','workers_scripts:write','offline_access'];
  let config=null,publicKey=null,downloadUrl=null,busy=false,expiryTimer=null;
  const base64url=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  function expiry(value) {
    if(typeof value==='number')return value<1e12?value*1000:value;
    if(typeof value==='string'&&/^\d+$/.test(value))return expiry(Number(value));
    return typeof value==='string'?Date.parse(value):NaN;
  }
  function clearInputs() { for(const id of ['callbackUrl','githubToken','password','confirmPassword'])$(id).value=''; }
  function error(message) { $('formError').textContent=message; }
  function isExpired() { return !config||Date.now()>=config.expiresAt; }
  function markExpired() {
    $('encryptBtn').disabled=true;$('oauthLink').removeAttribute('href');$('oauthLink').setAttribute('aria-disabled','true');$('oauthLink').classList.add('is-disabled');
    $('configStatus').textContent='這個設定連結已到期，請回原對話取得新的設定連結。';$('configStatus').classList.add('is-error');
  }
  function checkExpiry() {
    if(isExpired()){markExpired();return;}
    clearTimeout(expiryTimer);expiryTimer=setTimeout(checkExpiry,Math.min(config.expiresAt-Date.now()+10,2147483647));
  }
  function callback(value) {
    let url;
    if(value.length>16384)throw new Error('授權網址過長，請重新複製瀏覽器的完整網址。');
    if(value.startsWith('localhost:8976/oauth/callback?'))value='http://'+value;
    try {url=new URL(value);}catch(_){throw new Error('請貼上 Cloudflare 授權後的完整網址。');}
    if(url.hostname==='dash.cloudflare.com')throw new Error('你貼到的是開始授權的連結。請在 Cloudflare 按「Allow／允許」，等網址變成 http://localhost:8976/oauth/callback?code= 開頭，再點 Safari 網址列 → 全選 → 複製，回本頁貼上。手機顯示 localhost 無法連線是正常的。');
    if(url.origin!=='http://localhost:8976'||url.pathname!=='/oauth/callback'||url.username||url.password||url.hash||url.searchParams.getAll('code').length!==1||!/^[A-Za-z0-9._~+\/=\-]{1,4096}$/.test(url.searchParams.get('code')||'')||url.searchParams.getAll('state').length!==1||Array.from(url.searchParams.keys()).some(key=>!['code','state','scope'].includes(key)))throw new Error('請貼上授權完成後，含有 code 與 state 的 localhost:8976/oauth/callback 完整網址。');
    if(url.searchParams.get('state')!==config.oauthState)throw new Error('這個授權網址不屬於目前設定，請使用本頁的 Cloudflare 授權按鈕重新授權。');
    if(url.searchParams.has('scope')){const scopes=(url.searchParams.get('scope')||'').trim().split(/\s+/).filter(Boolean),expected=['account:read','user:read','workers_scripts:write','offline_access'];if(url.searchParams.getAll('scope').length!==1||scopes.length!==expected.length||new Set(scopes).size!==expected.length||expected.some(scope=>!scopes.includes(scope)))throw new Error('授權範圍與本次設定不同，請使用本頁的 Cloudflare 授權按鈕重新授權。');}
    if(url.searchParams.has('error'))throw new Error('這個網址顯示授權未完成，請重新開啟 Cloudflare 授權。');
    return url.href;
  }
  function credentials() {
    const githubToken=$('githubToken').value.trim(),password=$('password').value,confirmation=$('confirmPassword').value;
    if(!/^(?:github_pat_[A-Za-z0-9_]{40,244}|ghp_[A-Za-z0-9]{36,196})$/.test(githubToken))throw new Error('請貼上完整以 github_pat_ 或 ghp_ 開頭的 GitHub 圖鑑權杖。');
    if(password.length<12||password.length>512||encoder.encode(password).length>1024)throw new Error('管理密碼至少需要 12 個字元，最多 512 個字元與 1024 位元組。');
    if(password!==confirmation)throw new Error('兩次管理密碼不同，請重新確認。');
    return {githubToken,password};
  }
  async function passwordHash(password) {
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const bytes=encoder.encode(password);
    try {
      const key=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveBits']);
      const hash=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:100000},key,256);
      return 'pbkdf2-sha256$100000$'+base64url(salt)+'$'+base64url(hash);
    } finally {bytes.fill(0);}
  }
  async function encrypt(payload) {
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const rawKey=new Uint8Array(await crypto.subtle.exportKey('raw',key));
    const plain=encoder.encode(JSON.stringify(payload));
    try {
      const encryptedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,rawKey);
      const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(config.taskId),tagLength:128},key,plain);
      return {version:1,taskId:config.taskId,encryptedKey:base64url(encryptedKey),iv:base64url(iv),ciphertext:base64url(ciphertext)};
    } finally {rawKey.fill(0);plain.fill(0);}
  }
  async function generate(event) {
    event.preventDefault();if(busy)return;
    error('');
    if(isExpired()){markExpired();error('設定連結已到期，請取得新的設定連結。');return;}
    let callbackUrl,githubToken,password;
    try {
      ({githubToken,password}=credentials());callbackUrl=callback($('callbackUrl').value.trim());
    } catch(problem){error(problem.message);return;}
    busy=true;$('encryptBtn').disabled=true;$('encryptBtn').textContent='正在本機加密…';$('result').hidden=true;
    try {
      const hash=await passwordHash(password);password='';$('password').value='';$('confirmPassword').value='';
      if(isExpired())throw new Error('設定連結剛剛到期，請取得新的設定連結後重試。');
      const envelope=await encrypt({taskId:config.taskId,callbackUrl,githubToken,passwordHash:hash});
      clearInputs();callbackUrl='';githubToken='';
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);
      downloadUrl=URL.createObjectURL(new Blob([JSON.stringify(envelope,null,2)+'\n'],{type:'application/json'}));
      $('downloadAgain').href=downloadUrl;$('downloadAgain').download=filename;
      $('result').hidden=false;$('downloadAgain').click();
      $('configStatus').textContent='加密完成，輸入內容已清空。請將下載的加密檔傳回原對話。';
      $('result').scrollIntoView({block:'nearest'});
    } catch(problem){clearInputs();error(problem.message||'加密未完成，請重新輸入後再試。');}
    finally {password='';callbackUrl='';githubToken='';busy=false;$('encryptBtn').textContent='加密並下載設定檔';$('encryptBtn').disabled=isExpired();}
  }
  async function initialize() {
    try {
      if(window.top!==window.self){$('setupForm').hidden=true;throw new Error('請直接開啟原對話中的設定頁，不要在其他頁面的內嵌視窗操作。');}
      if(!window.isSecureContext||!crypto.subtle)throw new Error('請使用 HTTPS 安全連結開啟這個設定頁。');
      const response=await fetch('./config.json',{method:'GET',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
      if(!response.ok)throw new Error('設定尚未啟用，請從原對話中的設定連結開啟本頁。');
      const data=await response.json();
      const expiresAt=expiry(data.expiresAt);
      if(data.version!==1||typeof data.taskId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(data.taskId)||!Number.isFinite(expiresAt)||data.publicJwk?.kty!=='RSA')throw new Error('設定資料不完整，請回原對話取得新的設定連結。');
      if(expiresAt>Date.now()+31*60*1000)throw new Error('設定使用期限不正確，請回原對話取得新的設定連結。');
      const oauth=new URL(data.oauthUrl);
      if(oauth.protocol!=='https:'||oauth.hostname!=='dash.cloudflare.com'||oauth.port||oauth.username||oauth.password||oauth.pathname!=='/oauth2/auth'||oauth.hash||!/^[A-Za-z0-9._~-]{16,256}$/.test(oauth.searchParams.get('state')||'')||oauth.searchParams.get('redirect_uri')!=='http://localhost:8976/oauth/callback'||oauth.searchParams.get('response_type')!=='code'||oauth.searchParams.get('client_id')!==cloudflareClientId||oauth.searchParams.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(oauth.searchParams.get('code_challenge')||''))throw new Error('Cloudflare 授權連結不正確，請回原對話取得新的設定連結。');
      for(const key of ['state','redirect_uri','response_type','client_id','code_challenge','code_challenge_method','scope'])if(oauth.searchParams.getAll(key).length!==1)throw new Error('Cloudflare 授權連結不正確，請回原對話取得新的設定連結。');
      const scopes=(oauth.searchParams.get('scope')||'').trim().split(/\s+/).filter(Boolean);
      if(scopes.length!==cloudflareScopes.length||new Set(scopes).size!==cloudflareScopes.length||scopes.some(scope=>!cloudflareScopes.includes(scope)))throw new Error('Cloudflare 授權範圍不正確，請回原對話取得新的設定連結。');
      publicKey=await crypto.subtle.importKey('jwk',data.publicJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
      if(publicKey.algorithm.modulusLength!==3072)throw new Error('加密設定無效，請回原對話取得新的設定連結。');
      config={taskId:data.taskId,expiresAt,oauthState:oauth.searchParams.get('state')};
      if(isExpired()){markExpired();return;}
      $('oauthLink').href=oauth.href;$('oauthLink').removeAttribute('aria-disabled');$('oauthLink').classList.remove('is-disabled');$('encryptBtn').disabled=false;
      $('configStatus').textContent='安全設定已就緒，有效期限：'+new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(expiresAt));
      checkExpiry();
    } catch(problem){$('configStatus').textContent=problem.message||'無法準備加密設定，請稍後再試。';$('configStatus').classList.add('is-error');$('encryptBtn').disabled=true;}
  }
  $('setupForm').addEventListener('submit',generate);
  $('oauthLink').addEventListener('click',event=>{
    error('');
    try {if(isExpired()){markExpired();throw new Error('設定連結已到期，請取得新的設定連結。');}credentials();}
    catch(problem){event.preventDefault();error(problem.message);$('formError').scrollIntoView({block:'nearest'});}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&config)checkExpiry();});
  window.addEventListener('pagehide',()=>{clearInputs();if(downloadUrl)URL.revokeObjectURL(downloadUrl);});
  initialize();
}());
