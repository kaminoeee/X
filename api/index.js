const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const DATA_FILE = path.join(__dirname, 'data.json');

// 初期データ構造
const defaultData = {
  users: {},      // { username: { password, bio, avatarUrl, isVerified, isModerator, isAdmin, dmSetting, banned, ipHistory: [...] } }
  tweets: [],     // [ { id, user, content, mediaUrl, replyToId, repostOfId, likes: [], timestamp } ]
  dms: [],        // [ { id, from, to, message, timestamp } ]
  logs: [],       // [ { timestamp, operator, target, action } ]
  recommendations: [], // [ { from, target, reason, timestamp } ]
  presences: {}   // { username: lastActiveTimestamp }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaultData, ...parsed };
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

// クライアントIP取得ヘルパー
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

// ─── API エンドポイント群 ───

// ユーザー情報・オンライン更新
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const db = loadData();

  if (!db.users[username]) {
    // 新規登録扱い
    const isAdmin = Object.keys(db.users).length === 0; // 初回ユーザーをAdminに
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
      return res.json({ success: false, msg: "このアカウントまたはIPはBANされています。" });
    }
    if (db.users[username].password !== password) {
      return res.json({ success: false, msg: "パスワードが間違っています。" });
    }
    if (!db.users[username].ipHistory.includes(ip)) {
      db.users[username].ipHistory.push(ip);
    }
  }

  // IP BANチェック
  for (let u in db.users) {
    if (db.users[u].banned && db.users[u].ipHistory && db.users[u].ipHistory.includes(ip)) {
      return res.json({ success: false, msg: "お使いのネットワーク（IP）はBANされています。" });
    }
  }

  db.presences[username] = Date.now();
  saveData(db);
  res.json({ success: true, username, isAdmin: db.users[username].isAdmin, isModerator: db.users[username].isModerator });
});

// ユーザー情報取得 & プレゼンス更新
app.get('/api/user/info', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  if (!db.users[username]) return res.json(null);

  db.presences[username] = Date.now();
  saveData(db);

  // オンライン数計算 (過去60秒以内にアクティブだった人)
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

// タイムライン・ツイート取得
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
    let repostData = null;
    if (t.repostOfId) {
      const orig = db.tweets.find(x => x.id === t.repostOfId);
      if (orig) {
        const origAuthor = db.users[orig.user] || {};
        repostData = {
          ...orig,
          isAuthorVerified: !!origAuthor.isVerified
        };
      }
    }
    return {
      ...t,
      avatarUrl: author.avatarUrl || '',
      handle: '@' + t.user,
      isAuthorVerified: !!author.isVerified,
      repostData
    };
  });

  res.json({
    data: enriched,
    hasMore: Number(offset) + Number(limit) < tweets.length
  });
});

// ツイート投稿
app.post('/api/tweets/save', (req, res) => {
  const { username, content, mediaUrl, replyToId, repostOfId } = req.body;
  const db = loadData();
  const newTweet = {
    id: 't_' + Date.now() + Math.random().toString(36.substring(2, 7)),
    user: username,
    content: content || '',
    mediaUrl: mediaUrl || '',
    replyToId: replyToId || null,
    repostOfId: repostOfId || null,
    likes: [],
    timestamp: new Date().toLocaleString()
  };
  db.tweets.push(newTweet);
  saveData(db);
  res.json({ success: true, tweet: newTweet });
});

// いいねトグル
app.post('/api/tweets/like', (req, res) => {
  const { tweetId, username } = req.body;
  const db = loadData();
  const t = db.tweets.find(x => x.id === tweetId);
  if (!t) return res.json({ likes: [] });

  if (!t.likes) t.likes = [];
  const idx = t.likes.indexOf(username);
  if (idx >= 0) {
    t.likes.splice(idx, 1);
  } else {
    t.likes.push(username);
    if (t.user !== username) {
      // 通知追加
      // 簡単のため簡易ログ・通知配列拡張可能
    }
  }
  saveData(db);
  res.json({ likes: t.likes });
});

// ツイート削除
app.post('/api/tweets/delete', (req, res) => {
  const { username, tweetId } = req.body;
  const db = loadData();
  const idx = db.tweets.findIndex(x => x.id === tweetId);
  if (idx >= 0) {
    const t = db.tweets[idx];
    if (t.user === username || db.users[username]?.isAdmin || db.users[username]?.isModerator) {
      db.tweets.splice(idx, 1);
      saveData(db);
      return res.json({ success: true });
    }
  }
  res.json({ success: false });
});

// DM一覧・チャット取得
app.get('/api/dm/list', (req, res) => {
  const { username } = req.query;
  const db = loadData();
  const userDms = db.dms.filter(d => d.from === username || d.to === username);
  
  // 相手ごとの最新メッセージとオンライン状況を抽出
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
  if (!db.users[to]) return res.json({ success: false, msg: "宛先ユーザーが存在しません" });
  
  const targetSetting = db.users[to].dmSetting || 'all';
  if (targetSetting === 'none') return res.json({ success: false, msg: "このユーザーはDMを受け付けていません" });

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

// プロフィール情報取得
app.get('/api/user/profile', (req, res) => {
  const { username, currentMe } = req.query;
  const db = loadData();
  const u = db.users[username];
  if (!u) return res.json(null);

  const userTweets = db.tweets.filter(t => t.user === username).reverse();
  res.json({
    username,
    bio: u.bio,
    avatarUrl: u.avatarUrl,
    tweets: userTweets,
    followingCount: 0,
    followersCount: 0,
    isFollowing: false
  });
});

app.post('/api/user/profile/update', (req, res) => {
  const { username, bio, avatarUrl } = req.body;
  const db = loadData();
  if (db.users[username]) {
    db.users[username].bio = bio;
    db.users[username].avatarUrl = avatarUrl;
    saveData(db);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

// 管理パネル用データ (IP履歴付き)
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
    recommendations: db.recommendations || [],
    users: usersList
  });
});

// BAN処理（IP紐付け対応）
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
      action: `IP BAN実行 (IPs: ${db.users[target].ipHistory.join(', ')})`
    });
    saveData(db);
    return res.json({ success: true, msg: `@${target} をIPベースでBANしました。` });
  }
  res.json({ success: false, msg: "ユーザーが見つかりません" });
});

// モデレーター推薦
app.post('/api/admin/recommend', (req, res) => {
  const { from, target, reason } = req.body;
  const db = loadData();
  db.recommendations.push({ from, target, reason, timestamp: new Date().toLocaleString() });
  db.logs.push({ timestamp: new Date().toLocaleString(), operator: from, target, action: `管理者へ昇格推薦: ${reason}` });
  saveData(db);
  res.json({ success: true, msg: "推薦を送信しました。" });
});

// その他管理操作（警告、バッジ、MOD任命）
app.post('/api/admin/verify', (req, res) => {
  const { operator, target } = req.body;
  const db = loadData();
  if (db.users[target]) {
    db.users[target].isVerified = !db.users[target].isVerified;
    saveData(db);
    res.json({ success: true });
  }
});

app.post('/api/admin/mod', (req, res) => {
  const { operator, target } = req.body;
  const db = loadData();
  if (db.users[operator]?.isAdmin && db.users[target]) {
    db.users[target].isModerator = !db.users[target].isModerator;
    saveData(db);
    return res.json({ success: true, msg: "MOD権限を切り替えました" });
  }
  res.json({ success: false, msg: "権限がありません" });
});

// ダミーファイルアップロード (Vercel用)
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.send("error: no file");
  // 本番ではGoogleドライブAPIやCloudinary等へ転送可能。ここではBase64データURLとして即座に返す実装
  const b64 = Buffer.from(req.file.buffer).toString('base64');
  const mime = req.file.mimetype;
  res.send(`data:${mime};base64,${b64}`);
});

// Vercelローカル起動用
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mini X server running on port ${PORT}`);
});
