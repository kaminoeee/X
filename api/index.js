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

  let onlineCount = 0;
  const now = Date.now();
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

  res.json({
    logs: db.logs || [],
    users: usersList,
    bannedUsers: usersList.filter(u => u.banned)
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
    return res.json({ success: true, msg: `@${target} をBANしました。` });
  }
  res.json({ success: false, msg: "ユーザーがいません" });
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.send("");
  const b64 = Buffer.from(req.file.buffer).toString('base64');
  res.send(`data:${req.file.mimetype};base64,${b64}`);
});

// 本家GAS版のUI/UXレイアウトを完全再現したHTML（Tailwind CSSベース）
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mini X</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            xBlack: '#000000',
            xDarkGray: '#16181c',
            xBorder: '#2f3336',
            xBlue: '#1d9bf0',
            xHover: '#031018'
          }
        }
      }
    }
  </script>
  <style>
    body { background-color: #000000; color: #e7e9ea; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #000; }
    ::-webkit-scrollbar-thumb { background: #2f3336; border-radius: 3px; }
  </style>
</head>
<body class="min-h-screen flex justify-center">

  <!-- ログインモーダル -->
  <div id="authScreen" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
    <div class="bg-xDarkGray border border-xBorder rounded-2xl p-8 w-full max-w-md space-y-6 shadow-2xl">
      <div class="text-center space-y-2">
        <h2 class="text-2xl font-black tracking-wider text-xBlue">◆ Mini X</h2>
        <p class="text-xs text-gray-400">アカウント名とパスワードを入力してログイン</p>
      </div>
      <div class="space-y-4">
        <input type="text" id="authUsername" placeholder="ユーザー名 (例: taro)" class="w-full bg-black border border-xBorder rounded-xl p-3 text-sm focus:outline-none focus:border-xBlue text-white">
        <input type="password" id="authPassword" placeholder="パスワード" class="w-full bg-black border border-xBorder rounded-xl p-3 text-sm focus:outline-none focus:border-xBlue text-white">
        <button onclick="submitAuth()" class="w-full bg-xBlue text-white font-bold py-3 rounded-full hover:opacity-95 transition shadow-lg">ログイン / 新規登録</button>
      </div>
    </div>
  </div>

  <!-- メインレイアウト -->
  <div class="w-full max-w-7xl flex justify-between">
    
    <!-- サイドバー -->
    <header class="w-20 xl:w-64 h-screen sticky top-0 flex flex-col justify-between p-2 xl:p-4 border-r border-xBorder">
      <div class="space-y-4">
        <h1 class="text-xl font-black px-3 hidden xl:block text-xBlue">◆ Mini X</h1>
        <nav class="space-y-1">
          <button onclick="navigateTo('home')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-xDarkGray font-bold transition">
            <span class="text-xl">🏠</span><span class="hidden xl:block text-base">ホーム</span>
          </button>
          <button onclick="navigateTo('dmList')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-xDarkGray font-bold transition">
            <span class="text-xl">📬</span><span class="hidden xl:block text-base">メッセージ</span>
          </button>
          <button id="adminNavBtn" onclick="navigateTo('admin')" class="w-full flex items-center gap-4 p-3 rounded-full hover:bg-xDarkGray font-bold transition hidden">
            <span class="text-xl">🛡️</span><span class="hidden xl:block text-base">管理パネル</span>
          </button>
        </nav>
      </div>
      <div class="p-3 bg-xDarkGray/50 border border-xBorder rounded-2xl flex items-center justify-between">
        <div class="hidden xl:block overflow-hidden">
          <p id="myName" class="font-bold text-sm truncate"></p>
          <p id="myHandle" class="text-xs text-gray-500 truncate"></p>
        </div>
        <button onclick="logout()" class="text-xs text-red-400 hover:underline">ログアウト</button>
      </div>
    </header>

    <!-- タイムラインフィード -->
    <main class="flex-1 max-w-2xl border-r border-xBorder min-h-screen pb-20">
      <div class="sticky top-0 bg-black/80 backdrop-blur-md border-b border-xBorder p-4 z-10 flex justify-between items-center">
        <h2 id="pageTitle" class="font-bold text-lg">ホーム</h2>
        <div class="flex items-center gap-2 text-xs border border-xBorder px-3 py-1 rounded-full bg-xDarkGray">
          <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          <span>オンライン: <strong id="globalOnlineCount">0</strong>人</span>
        </div>
      </div>

      <!-- ツイート投稿エリア -->
      <div id="tweetFormArea" class="border-b border-xBorder p-4 space-y-3">
        <textarea id="tweetInput" placeholder="いまどうしてる？" rows="3" class="w-full bg-transparent text-white placeholder-gray-500 resize-none focus:outline-none text-sm"></textarea>
        <div id="previewContainer" class="hidden relative rounded-xl overflow-hidden max-h-60 border border-xBorder">
          <img id="mediaPreview" class="w-full object-cover">
        </div>
        <div class="flex justify-between items-center pt-2 border-t border-xBorder/50">
          <label class="cursor-pointer text-xBlue hover:opacity-80 flex items-center gap-1 text-sm font-bold">
            <span>📷 画像添付</span>
            <input type="file" id="localFileInput" class="hidden" accept="image/*" onchange="handleFileSelection(event)">
          </label>
          <input type="hidden" id="tweetMediaUrlHidden">
          <button onclick="submitTweet()" class="bg-xBlue text-white font-bold px-5 py-2 rounded-full text-sm hover:opacity-90 transition">ポストする</button>
        </div>
      </div>

      <!-- セクション切替エリア -->
      <div id="homeSection"><div id="timeline" class="divide-y divide-xBorder"></div></div>
      <div id="dmListSection" class="hidden divide-y divide-xBorder"></div>
      
      <!-- DMチャット画面 -->
      <div id="dmSection" class="hidden flex flex-col h-[calc(100vh-65px)]">
        <div id="dmChatBox" class="flex-1 overflow-y-auto p-4 space-y-3 flex flex-col"></div>
        <div class="p-3 border-t border-xBorder flex gap-2 bg-black items-center">
          <input type="text" id="dmInput" placeholder="新しいメッセージを入力..." class="flex-1 bg-xDarkGray border border-xBorder rounded-full px-4 py-2.5 text-sm text-white focus:outline-none focus:border-xBlue">
          <button onclick="executeSendDM()" class="bg-xBlue text-white px-5 py-2.5 rounded-full text-sm font-bold hover:opacity-90 transition">送信</button>
        </div>
      </div>

      <!-- 管理パネル -->
      <div id="adminSection" class="hidden p-4 space-y-6 text-xs">
        <div><h3 class="font-bold text-sm mb-2 text-xBlue">🛡️ 監査ログ</h3><div id="adminLogListArea" class="bg-xDarkGray border border-xBorder p-3 rounded-xl max-h-40 overflow-y-auto space-y-1 text-gray-300"></div></div>
        <div><h3 class="font-bold text-sm mb-2 text-xBlue">👥 ユーザー管理 & IP BAN</h3><div id="adminUserListArea" class="space-y-2"></div></div>
      </div>
    </main>

    <!-- 右側ウィジェット枠 (本家GAS版を踏襲) -->
    <div class="hidden lg:block w-80 p-4 space-y-4 sticky top-0 h-screen overflow-y-auto">
      <div class="bg-xDarkGray border border-xBorder rounded-2xl p-4 space-y-3">
        <h3 class="font-bold text-sm">Mini Xについて</h3>
        <p class="text-xs text-gray-400 leading-relaxed">本家GAS版のUIデザインをそのままVercelへ完全移行した超軽量クローンです。リアルタイムなタイムラインやDM、管理者用IP BAN機能に対応しています。</p>
      </div>
    </div>
  </div>

  <script>
    let currentMe = localStorage.getItem('mini_x_me') || "";
    let amIAdmin = false, amIModerator = false;
    let activeDMTarget = null, dmIntervalTimer = null;

    window.onload = function() {
      if(!currentMe) {
        document.getElementById('authScreen').classList.remove('hidden');
      } else {
        initApp();
      }
    };

    function initApp() {
      fetch('/api/user/info?username=' + encodeURIComponent(currentMe))
        .then(r => r.json())
        .then(info => {
          if(!info) { logout(); return; }
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
      if(!username || !password) return alert('ユーザー名とパスワードを入力してください');
      
      fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username, password})
      }).then(r => r.json()).then(res => {
        if(!res.success) alert(res.msg);
        else {
          currentMe = username;
          localStorage.setItem('mini_x_me', username);
          document.getElementById('authScreen').classList.add('hidden');
          initApp();
        }
      });
    }

    function logout() {
      localStorage.clear();
      location.reload();
    }

    function navigateTo(sec) {
      if(dmIntervalTimer) { clearInterval(dmIntervalTimer); dmIntervalTimer = null; }
      ['homeSection', 'dmListSection', 'dmSection', 'adminSection'].forEach(id => document.getElementById(id).classList.add('hidden'));
      document.getElementById('tweetFormArea').classList.add('hidden');

      if(sec === 'home') {
        document.getElementById('pageTitle').innerText = 'ホーム';
        document.getElementById('tweetFormArea').classList.remove('hidden');
        document.getElementById('homeSection').classList.remove('hidden');
        loadTimeline();
      } else if(sec === 'dmList') {
        document.getElementById('pageTitle').innerText = 'メッセージ';
        document.getElementById('dmListSection').classList.remove('hidden');
        loadDMPartners();
      } else if(sec === 'admin') {
        document.getElementById('pageTitle').innerText = '管理パネル';
        document.getElementById('adminSection').classList.remove('hidden');
        loadAdmin();
      }
    }

    function loadTimeline() {
      fetch('/api/tweets').then(r => r.json()).then(res => {
        const container = document.getElementById('timeline');
        container.innerHTML = '';
        if(res.data.length === 0) {
          container.innerHTML = '<div class="p-8 text-center text-gray-500 text-sm">ポストがまだありません。最初の投稿をしてみましょう！</div>';
          return;
        }
        res.data.forEach(t => {
          const mediaHtml = t.mediaUrl ? \`<div class="mt-3 rounded-xl overflow-hidden border border-xBorder max-h-80"><img src="\${t.mediaUrl}" class="w-full object-cover"></div>\` : '';
          const isLiked = (t.likes || []).includes(currentMe);
          const likeCount = (t.likes || []).length;

          container.insertAdjacentHTML('beforeend', \`
            <div class="p-4 hover:bg-xDarkGray/30 transition cursor-pointer space-y-1">
              <div class="flex items-center justify-between">
                <div class="font-bold text-sm flex items-center gap-1.5">
                  <span>@\${t.user}</span>
                  \${t.isAuthorVerified ? '<span class="text-xBlue">✔</span>' : ''}
                  <span class="text-xs text-gray-500 font-normal">\${t.timestamp}</span>
                </div>
                <button onclick="openDMPacket('\${t.user}')" class="text-xs text-xBlue hover:underline">📬 DMを送る</button>
              </div>
              <p class="text-sm whitespace-pre-wrap leading-relaxed pt-1">\,t.content\</p>
              \${mediaHtml}
              <div class="flex gap-6 pt-2 text-gray-500 text-xs">
                <button onclick="toggleLike('\${t.id}')" class="flex items-center gap-1 hover:text-red-500 transition \${isLiked ? 'text-red-500 font-bold' : ''}">
                  <span>❤️</span> <span>\${likeCount}</span>
                </button>
              </div>
            </div>
          \`);
        });
      });
    }

    function toggleLike(tweetId) {
      fetch('/api/tweets/like', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tweetId, username: currentMe})
      }).then(() => loadTimeline());
    }

    function submitTweet() {
      const content = document.getElementById('tweetInput').value.trim();
      const mediaUrl = document.getElementById('tweetMediaUrlHidden').value;
      if(!content && !mediaUrl) return;

      fetch('/api/tweets/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: currentMe, content, mediaUrl})
      }).then(() => {
        document.getElementById('tweetInput').value = '';
        document.getElementById('tweetMediaUrlHidden').value = '';
        document.getElementById('previewContainer').classList.add('hidden');
        document.getElementById('mediaPreview').src = '';
        loadTimeline();
      });
    }

    function handleFileSelection(e) {
      const file = e.target.files[0];
      if(!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fetch('/api/upload', { method: 'POST', body: fd })
        .then(r => r.text())
        .then(url => {
          document.getElementById('tweetMediaUrlHidden').value = url;
          document.getElementById('mediaPreview').src = url;
          document.getElementById('previewContainer').classList.remove('hidden');
        });
    }

    function loadDMPartners() {
      fetch('/api/dm/list?username=' + encodeURIComponent(currentMe))
        .then(r => r.json())
        .then(list => {
          const area = document.getElementById('dmListSection');
          area.innerHTML = '';
          if(list.length === 0) {
            area.innerHTML = '<div class="p-8 text-center text-gray-500 text-sm">DMの履歴はありません。タイムラインからDMを送ってみましょう。</div>';
            return;
          }
          list.forEach(p => {
            const dot = p.isOnline ? '<span class="w-2 h-2 rounded-full bg-green-500 inline-block"></span>' : '<span class="w-2 h-2 rounded-full bg-gray-600 inline-block"></span>';
            area.insertAdjacentHTML('beforeend', \`
              <div onclick="openDMPacket('\${p.partner}')" class="p-4 hover:bg-xDarkGray cursor-pointer flex justify-between items-center transition">
                <div class="space-y-0.5">
                  <div class="font-bold text-sm flex items-center gap-2">
                    <span>@\${p.partner}</span> \${dot}
                  </div>
                  <p class="text-xs text-gray-400 truncate max-w-xs">\${p.lastMessage}</p>
                </div>
                <span class="text-xs text-gray-500">\${p.timestamp}</span>
              </div>
            \`);
          });
        });
    }

    function openDMPacket(target) {
      navigateTo('none');
      activeDMTarget = target;
      document.getElementById('pageTitle').innerText = '@' + target + ' とのメッセージ';
      document.getElementById('dmSection').classList.remove('hidden');
      loadDMChat();
      dmIntervalTimer = setInterval(loadDMChat, 3000);
    }

    function loadDMChat() {
      fetch('/api/dm/chat?user1=' + encodeURIComponent(currentMe) + '&user2=' + encodeURIComponent(activeDMTarget))
        .then(r => r.json())
        .then(chats => {
          const box = document.getElementById('dmChatBox');
          box.innerHTML = '';
          chats.forEach(l => {
            const isMe = l.from === currentMe;
            box.insertAdjacentHTML('beforeend', \`
              <div class="flex flex-col \${isMe ? 'items-end' : 'items-start'}">
                <div class="\${isMe ? 'bg-xBlue text-white rounded-br-none' : 'bg-xDarkGray text-white rounded-bl-none'} px-4 py-2.5 rounded-2xl text-sm max-w-xs md:max-w-md shadow">
                  \${l.message}
                </div>
                <span class="text-[10px] text-gray-500 mt-1 px-1">\${l.timestamp}</span>
              </div>
            \`);
          });
          box.scrollTop = box.scrollHeight;
        });
    }

    function executeSendDM() {
      const input = document.getElementById('dmInput');
      const message = input.value.trim();
      if(!message) return;
      fetch('/api/dm/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: currentMe, to: activeDMTarget, message})
      }).then(() => {
        input.value = '';
        loadDMChat();
      });
    }

    function loadAdmin() {
      fetch('/api/admin/data?username=' + encodeURIComponent(currentMe))
        .then(r => r.json())
        .then(res => {
          if(!res) return;
          document.getElementById('adminLogListArea').innerHTML = res.logs.map(l => \`<div>[\${l.timestamp}] @\${l.operator} -> @\${l.target}: \${l.action}</div>\`).join('') || 'ログはありません';
          
          const userArea = document.getElementById('adminUserListArea');
          userArea.innerHTML = '';
          res.users.forEach(u => {
            userArea.insertAdjacentHTML('beforeend', \`
              <div class="p-3 bg-xDarkGray border border-xBorder rounded-xl flex items-center justify-between">
                <div>
                  <span class="font-bold text-white">@\${u.username}</span>
                  \${u.banned ? '<span class="text-red-500 ml-2 font-bold">(BAN中)</span>' : ''}
                  <p class="text-[10px] text-gray-400 mt-0.5">IP履歴: \${(u.ipHistory||[]).join(', ')}</p>
                </div>
                <button onclick="adminBan('\${u.username}')" class="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg font-bold text-xs transition">IP BAN</button>
              </div>
            \`);
          });
        });
    }

    function adminBan(target) {
      if(!confirm('@' + target + ' をIPベースでBANしますか？')) return;
      fetch('/api/admin/ban', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({operator: currentMe, target})
      }).then(r => r.json()).then(res => {
        alert(res.msg);
        loadAdmin();
      });
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
