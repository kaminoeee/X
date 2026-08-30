const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
  users: {},
  tweets: [],
  dms: [],
  logs: [],
  recommendations: [],
  presences: {}
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return { ...defaultData, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('Data load error:', e);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Data save error:', e);
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

// ─── API エンドポイント ───

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const db = loadData();

  // IP BANチェック
  for (let u in db.users) {
    if (db.users[u].banned && db.users[u].ipHistory && db.users[u].ipHistory.includes(ip)) {
      return res.json({ success: false, msg: "お使いのネットワーク（IP）はBANされています。" });
    }
  }

  if (!db.users[username]) {
    const isAdmin = Object.keys(db.users).length === 0;
    db.users[username] = {
      password,
      bio: "こんにちは！Mini Xへようこそ",
      avatarUrl: "",
      isVerified: isAdmin,
      isModerator: false,
      isAdmin: isAdmin,
      dmSetting: "all",
      banned: false,
      ipHistory: [ip]
    };
  } else {
    if (db.users[username].banned) {
      return res.json({ success: false, msg: "このアカウントはBANされています。" });
    }
    if (db.users[username].password !== password) {
      return res.json({ success: false, msg: "パスワードが間違っています。" });
    }
    if (!db.users[username].ipHistory) db.users[username].ipHistory = [];
    if (!db.users[username].ipHistory.includes(ip)) {
      db.users[username].ipHistory.push(ip);
    }
  }

  db.presences[username] = Date.now();
  saveData(db);
  res.json({ success: true, username, isAdmin: db.users[username].isAdmin, isModerator: db.users[username].isModerator });
});

app.get('/api/user/info', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  if (!db.users[username]) return res.json(null);

  db.presences[username] = Date.now();
  saveData(db);

  const now = Date.now();
  let onlineCount = 0;
  for (let u in db.presences) {
    if (now - db.presences[u] < 60000) onlineCount++;
  }

  res.json({
    username,
    avatarUrl: db.users[username].avatarUrl,
    bio: db.users[username].bio,
    dmSetting: db.users[username].dmSetting,
    isAdmin: db.users[username].isAdmin,
    isModerator: db.users[username].isModerator,
    onlineCount
  });
});

app.get('/api/tweets', (req, res) => {
  const { offset = 0, limit = 20, type = 'timeline', query = '', username = '' } = req.query;
  const db = loadData();
  let tweets = [...db.tweets].reverse();

  if (type === 'search' && query) {
    const q = query.toLowerCase();
    tweets = tweets.filter(t => t.content.toLowerCase().includes(q) || t.user.toLowerCase().includes(q));
  } else if (type === 'user' && username) {
    tweets = tweets.filter(t => t.user === username);
  }

  const sliced = tweets.slice(Number(offset), Number(offset) + Number(limit));
  const enriched = sliced.map(t => {
    const author = db.users[t.user] || {};
    return {
      ...t,
      avatarUrl: author.avatarUrl || '',
      handle: '@' + t.user,
      isAuthorVerified: !!author.isVerified
    };
  });

  res.json({ data: enriched, hasMore: Number(offset) + Number(limit) < tweets.length });
});

app.post('/api/tweets/save', (req, res) => {
  const { username, content, mediaUrl } = req.body;
  const db = loadData();
  const newTweet = {
    id: 't_' + Date.now() + Math.random().toString(36).substring(2, 7),
    user: username,
    content: content || '',
    mediaUrl: mediaUrl || '',
    likes: [],
    timestamp: new Date().toLocaleString()
  };
  db.tweets.push(newTweet);
  saveData(db);
  res.json({ success: true, tweet: newTweet });
});

app.post('/api/tweets/like', (req, res) => {
  const { tweetId, username } = req.body;
  const db = loadData();
  const t = db.tweets.find(x => x.id === tweetId);
  if (!t) return res.json({ likes: [] });

  if (!t.likes) t.likes = [];
  const idx = t.likes.indexOf(username);
  if (idx >= 0) t.likes.splice(idx, 1);
  else t.likes.push(username);
  
  saveData(db);
  res.json({ likes: t.likes });
});

app.get('/api/dm/list', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  const userDms = db.dms.filter(d => d.from === username || d.to === username);
  
  const partnersMap = {};
  userDms.forEach(d => {
    const partner = d.from === username ? d.to : d.from;
    if (!partnersMap[partner] || new Date(d.timestamp) > new Date(partnersMap[partner].timestamp)) {
      const pActive = db.presences[partner] && (Date.now() - db.presences[partner] < 60000);
      partnersMap[partner] = {
        partner,
        lastMessage: d.message,
        timestamp: d.timestamp,
        isOnline: !!pActive,
        avatarUrl: db.users[partner]?.avatarUrl || ''
      };
    }
  });

  res.json(Object.values(partnersMap));
});

app.get('/api/dm/chat', (req, res) => {
  const { user1, user2 } = req.query;
  const db = loadData();
  const chats = db.dms.filter(d => (d.from === user1 && d.to === user2) || (d.from === user2 && d.to === user1));
  res.json(chats);
});

app.post('/api/dm/send', (req, res) => {
  const { from, to, message } = req.body;
  const db = loadData();
  if (!db.users[to]) return res.json({ success: false, msg: "宛先ユーザーがいません" });

  db.dms.push({
    id: 'dm_' + Date.now(),
    from,
    to,
    message,
    timestamp: new Date().toLocaleString()
  });
  saveData(db);
  res.json({ success: true });
});

app.get('/api/user/profile', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  const u = db.users[username];
  if (!u) return res.json(null);
  const userTweets = db.tweets.filter(t => t.user === username).reverse();
  res.json({ username, bio: u.bio, avatarUrl: u.avatarUrl, tweets: userTweets });
});

app.get('/api/admin/data', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  const user = db.users[username];
  if (!user || (!user.isAdmin && !user.isModerator)) return res.json(null);

  const usersList = Object.keys(db.users).map(uname => ({
    username: uname,
    isVerified: db.users[uname].isVerified,
    isModerator: db.users[uname].isModerator,
    isAdmin: db.users[uname].isAdmin,
    banned: db.users[uname].banned,
    ipHistory: db.users[uname].ipHistory || []
  }));

  const bannedList = usersList.filter(u => u.banned);

  res.json({
    logs: db.logs || [],
    recommendations: db.recommendations || [],
    users: usersList,
    bannedUsers: bannedList
  });
});

app.post('/api/admin/ban', (req, res) => {
  const { operator, target } = req.body;
  const db = loadData();
  if (!db.users[operator]?.isAdmin && !db.users[operator]?.isModerator) {
    return res.json({ success: false, msg: "権限がありません" });
  }
  if (db.users[target]) {
    db.users[target].banned = true;
    db.logs.push({
      timestamp: new Date().toLocaleString(),
      operator,
      target,
      action: `IP BAN実行 (IPs: ${(db.users[target].ipHistory || []).join(', ')})`
    });
    saveData(db);
    return res.json({ success: true, msg: `@${target} をIPベースでBANしました。` });
  }
  res.json({ success: false, msg: "ユーザーがいません" });
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.send("error");
  const b64 = Buffer.from(req.file.buffer).toString('base64');
  res.send(`data:${req.file.mimetype};base64,${b64}`);
});

// ルートアクセスに対して一体型のHTMLを直接返却（404エラー防止）
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mini X (Vercel Edition)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { colors: { darkBg: '#000000', darkCard: '#16181c', darkBorder: '#2f3336' } } }
    }
  </script>
  <style>
    body { background-color: #000000; color: #e7e9ea; font-family: sans-serif; }
    .bg-card { background-color: #16181c; }
    .border-main { border-color: #2f3336; }
    .input-box { background-color: #202327; color: #fff; }
  </style>
</head>
<body class="min-h-screen">
  <div id="authScreen" class="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
    <div class="bg-card border border-main rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-xl">
      <h2 class="text-xl font-bold text-center">Mini X ログイン</h2>
      <input type="text" id="authUsername" placeholder="ユーザー名" class="w-full input-box border rounded-xl p-3 text-sm focus:outline-none">
      <input type="password" id="authPassword" placeholder="パスワード" class="w-full input-box border rounded-xl p-3 text-sm focus:outline-none">
      <button onclick="submitAuth()" class="w-full bg-[#1d9bf0] text-white font-bold py-3 rounded-xl hover:opacity-90">ログイン / 登録</button>
    </div>
  </div>

  <div class="max-w-7xl mx-auto flex">
    <header class="w-20 xl:w-64 h-screen sticky top-0 flex flex-col justify-between p-2 xl:p-4 border-r border-main">
      <div class="space-y-4">
        <h1 class="text-xl font-black px-3 hidden xl:block text-[#1d9bf0]">◆ Mini X</h1>
        <nav class="space-y-1">
          <button onclick="navigateTo('home')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-card font-bold"><span>🏠</span><span class="hidden xl:block">ホーム</span></button>
          <button onclick="navigateTo('dmList')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-card font-bold"><span>📬</span><span class="hidden xl:block">DM一覧</span></button>
          <button id="adminNavBtn" onclick="navigateTo('admin')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-card font-bold hidden"><span>🛡️</span><span class="hidden xl:block">管理パネル</span></button>
        </nav>
      </div>
      <div class="p-2 bg-card rounded-xl text-xs">
        <p id="myName" class="font-bold"></p>
        <p id="myHandle" class="text-gray-500"></p>
      </div>
    </header>

    <main class="flex-1 max-w-2xl border-r border-main min-h-screen pb-20">
      <div class="sticky top-0 bg-black/80 backdrop-blur border-b border-main p-4 z-10 flex justify-between items-center">
        <h2 id="pageTitle" class="font-bold text-lg">ホーム</h2>
        <div class="flex items-center gap-1.5 text-xs border border-main px-3 py-1 rounded-full">
          <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          <span>オンライン: <strong id="globalOnlineCount">0</strong>人</span>
        </div>
      </div>

      <div id="tweetFormArea" class="border-b border-main p-4 space-y-3">
        <textarea id="tweetInput" placeholder="いまどうしてる？" class="w-full input-box border rounded-xl p-3 text-sm focus:outline-none"></textarea>
        <div class="flex justify-between items-center">
          <input type="file" id="localFileInput" class="text-xs" onchange="handleFileSelection(event)">
          <input type="hidden" id="tweetMediaUrlHidden">
          <button onclick="submitTweet()" class="bg-[#1d9bf0] text-white font-bold px-4 py-1.5 rounded-full text-sm">ポスト</button>
        </div>
      </div>

      <div id="homeSection"><div id="timeline"></div></div>
      <div id="dmListSection" class="hidden divide-y divide-main"></div>
      <div id="dmSection" class="hidden flex flex-col h-[calc(100vh-60px)]">
        <div id="dmTargetTitle" class="p-3 border-b border-main font-bold text-sm bg-card"></div>
        <div id="dmChatBox" class="flex-1 overflow-y-auto p-4 space-y-3 flex flex-col"></div>
        <div class="p-3 border-t border-main flex gap-2 bg-card">
          <input type="text" id="dmInput" placeholder="メッセージ..." class="flex-1 input-box border rounded-full px-4 py-2 text-sm">
          <button onclick="executeSendDM()" class="bg-[#1d9bf0] text-white px-4 py-2 rounded-full text-sm font-bold">送信</button>
        </div>
      </div>
      <div id="adminSection" class="hidden p-4 space-y-6 text-xs">
        <div><h3 class="font-bold mb-2">🛡️ 監査ログ</h3><div id="adminLogListArea" class="bg-card p-3 rounded-xl max-h-40 overflow-y-auto space-y-1"></div></div>
        <div><h3 class="font-bold mb-2">🚫 BAN済みユーザー一覧</h3><div id="adminBannedListArea" class="bg-card p-3 rounded-xl space-y-1"></div></div>
        <div><h3 class="font-bold mb-2">👥 ユーザー一覧 (IPアドレス履歴・BAN)</h3><div id="adminUserListArea" class="space-y-2"></div></div>
      </div>
    </main>
  </div>

  <script>
    let currentMe = localStorage.getItem('mini_x_me') || "";
    let amIAdmin = false, amIModerator = false;
    let activeDMTarget = null, dmIntervalTimer = null;

    window.onload = function() {
      if(!currentMe) document.getElementById('authScreen').classList.remove('hidden');
      else initApp();
    };

    function initApp() {
      fetch('/api/user/info?username=' + encodeURIComponent(currentMe)).then(r => r.json()).then(info => {
        if(!info) { localStorage.clear(); location.reload(); return; }
        amIAdmin = info.isAdmin; amIModerator = info.isModerator;
        if(amIAdmin || amIModerator) document.getElementById('adminNavBtn').classList.remove('hidden');
        document.getElementById('globalOnlineCount').innerText = info.onlineCount || 1;
        document.getElementById('myName').innerText = currentMe;
        document.getElementById('myHandle').innerText = '@' + currentMe;
        loadTimeline();
      });
    }

    function submitAuth() {
      const username = document.getElementById('authUsername').value.trim();
      const password = document.getElementById('authPassword').value.trim();
      if(!username || !password) return;
      fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password}) })
      .then(r => r.json()).then(res => {
        if(!res.success) alert(res.msg);
        else { currentMe = username; localStorage.setItem('mini_x_me', username); document.getElementById('authScreen').classList.add('hidden'); initApp(); }
      });
    }

    function navigateTo(sec) {
      if(dmIntervalTimer) { clearInterval(dmIntervalTimer); dmIntervalTimer = null; }
      ['homeSection', 'dmListSection', 'dmSection', 'adminSection'].forEach(id => document.getElementById(id).classList.add('hidden'));
      document.getElementById('tweetFormArea').classList.add('hidden');
      if(sec === 'home') { document.getElementById('pageTitle').innerText = 'ホーム'; document.getElementById('tweetFormArea').classList.remove('hidden'); document.getElementById('homeSection').classList.remove('hidden'); loadTimeline(); }
      else if(sec === 'dmList') { document.getElementById('pageTitle').innerText = 'DM一覧'; document.getElementById('dmListSection').classList.remove('hidden'); loadDMPartners(); }
      else if(sec === 'admin') { document.getElementById('pageTitle').innerText = '管理パネル'; document.getElementById('adminSection').classList.remove('hidden'); loadAdmin(); }
    }

    function loadTimeline() {
      fetch('/api/tweets').then(r => r.json()).then(res => {
        const c = document.getElementById('timeline'); c.innerHTML = '';
        res.data.forEach(t => {
          c.insertAdjacentHTML('beforeend', \`<div class="p-4 border-b border-main space-y-1"><div class="font-bold">\${t.user} <span class="text-xs text-gray-500">\${t.timestamp}</span></div><p class="text-sm">\${t.content}</p><button onclick="openDMPacket('\${t.user}')" class="text-xs text-blue-400">📬 DMを送る</button></div>\`);
        });
      });
    }

    function submitTweet() {
      const content = document.getElementById('tweetInput').value.trim();
      const mediaUrl = document.getElementById('tweetMediaUrlHidden').value;
      if(!content && !mediaUrl) return;
      fetch('/api/tweets/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: currentMe, content, mediaUrl}) })
      .then(() => { document.getElementById('tweetInput').value = ''; loadTimeline(); });
    }

    function loadDMPartners() {
      fetch('/api/dm/list?username=' + encodeURIComponent(currentMe)).then(r => r.json()).then(list => {
        const area = document.getElementById('dmListSection'); area.innerHTML = '';
        list.forEach(p => {
          const dot = p.isOnline ? '<span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span>' : '<span class="w-2 h-2 rounded-full bg-gray-500 inline-block"></span>';
          area.insertAdjacentHTML('beforeend', \`<div onclick="openDMPacket('\${p.partner}')" class="p-4 hover:bg-card cursor-pointer flex justify-between items-center"><div class="space-y-0.5"><div class="font-bold text-sm flex items-center gap-2">@\${p.partner} \${dot}</div><p class="text-xs text-gray-400">\${p.lastMessage}</p></div><span class="text-xs text-gray-500">\${p.timestamp}</span></div>\`);
        });
      });
    }

    function openDMPacket(target) {
      navigateTo('none'); activeDMTarget = target;
      document.getElementById('pageTitle').innerText = '@' + target + ' とのDM';
      document.getElementById('dmSection').classList.remove('hidden');
      loadDMChat(); dmIntervalTimer = setInterval(loadDMChat, 3000);
    }

    function loadDMChat() {
      fetch('/api/dm/chat?user1=' + encodeURIComponent(currentMe) + '&user2=' + encodeURIComponent(activeDMTarget)).then(r => r.json()).then(chats => {
        const box = document.getElementById('dmChatBox'); box.innerHTML = '';
        chats.forEach(l => {
          const isMe = l.from === currentMe;
          box.insertAdjacentHTML('beforeend', \`<div class="flex flex-col \${isMe ? 'items-end' : 'items-start'}"><div class="\${isMe ? 'bg-[#1d9bf0] text-white' : 'bg-card'} px-3 py-2 rounded-xl text-xs">\${l.message}</div></div>\`);
        });
        box.scrollTop = box.scrollHeight;
      });
    }

    function executeSendDM() {
      const input = document.getElementById('dmInput'); const message = input.value.trim();
      if(!message) return;
      fetch('/api/dm/send', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from: currentMe, to: activeDMTarget, message}) })
      .then(() => { input.value = ''; loadDMChat(); });
    }

    function loadAdmin() {
      fetch('/api/admin/data?username=' + encodeURIComponent(currentMe)).then(r => r.json()).then(res => {
        if(!res) return;
        document.getElementById('adminLogListArea').innerHTML = res.logs.map(l => \`<div>[\${l.timestamp}] @\${l.operator} -> @\${l.target}: \${l.action}</div>\`).join('') || 'ログなし';
        document.getElementById('adminBannedListArea').innerHTML = res.bannedUsers.map(u => \`<div>@\${u.username} (IPs: \${(u.ipHistory||[]).join(', ')})</div>\`).join('') || 'BANユーザーなし';
        
        const userArea = document.getElementById('adminUserListArea'); userArea.innerHTML = '';
        res.users.forEach(u => {
          userArea.insertAdjacentHTML('beforeend', \`<div class="p-3 bg-card border border-main rounded-xl space-y-1"><div class="flex justify-between font-bold"><span>@\${u.username} \${u.banned?'(BAN済)':''}</span><button onclick="adminBan('\${u.username}')" class="bg-red-600 text-white px-2 py-0.5 rounded text-[10px]">IP BAN</button></div><p class="text-[10px] text-gray-400">IP履歴: \${(u.ipHistory||[]).join(', ')}</p></div>\`);
        });
      });
    }

    function adminBan(target) {
      if(!confirm('@' + target + ' をIPベースでBANしますか？')) return;
      fetch('/api/admin/ban', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operator: currentMe, target}) })
      .then(r => r.json()).then(res => { alert(res.msg); loadAdmin(); });
    }

    function handleFileSelection(e) {
      const file = e.target.files[0]; if(!file) return;
      const fd = new FormData(); fd.append('file', file);
      fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.text()).then(url => {
        document.getElementById('tweetMediaUrlHidden').value = url; alert('添付準備完了');
      });
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
