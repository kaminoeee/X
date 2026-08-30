const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Vercel等のサーバーレス環境でも絶対にデータが消えないように大域変数に保持
if (!global._xUltraDb) {
  global._xUltraDb = {
    users: {},
    tweets: [],
    dms: [],
    notifs: [],
    bans: [],
    logs: []
  };
}
let db = global._xUltraDb;
const DATA_FILE = path.join('/tmp', 'x_ultra_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed && parsed.users) {
        global._xUltraDb = parsed;
        db = global._xUltraDb;
      }
    }
  } catch (e) {
    console.error("Data load error ignored, using memory DB.");
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    // Vercelの読み取り専用領域などでエラーが出てもサーバーがクラッシュしないようにする
    console.error("Data save warning:", e.message);
  }
}

loadData();

// 定期的にオンライン状態を自動更新
setInterval(() => {
  const now = Date.now();
  Object.keys(db.users || {}).forEach(u => {
    if (db.users[u].isOnline && (now - (db.users[u].lastSeen || 0) > 30000)) {
      db.users[u].isOnline = false;
    }
  });
}, 5000);

// BANチェック用ミドルウェア
function checkBan(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (!db.bans) db.bans = [];
  const activeBan = db.bans.find(b => b.ip === ip);
  if (activeBan) {
    if (activeBan.bannedUntil === 'permanent' || activeBan.bannedUntil > now) {
      return res.status(403).json({
        banned: true,
        reason: activeBan.reason,
        executedBy: activeBan.executedBy,
        bannedUntil: activeBan.bannedUntil === 'permanent' ? '永久' : new Date(activeBan.bannedUntil).toLocaleString()
      });
    } else {
      db.bans = db.bans.filter(b => b.ip !== ip);
    }
  }
  next();
}

app.use(checkBan);

// ユーザー登録
app.post('/api/register', (req, res) => {
  const { username, password, adminPassword } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!username || !password) return res.json({ success: false, msg: '入力値が不正です' });
  if (!db.users) db.users = {};
  if (db.users[username]) return res.json({ success: false, msg: '既に存在するユーザーIDです' });

  let isAdmin = false;
  let isModerator = false;

  if (adminPassword) {
    if (adminPassword === (process.env.ADMIN_SECRET_KEY || 'SECRET_ADMIN_999')) {
      isAdmin = true;
      isModerator = true;
    } else {
      return res.json({ success: false, msg: '管理者シークレットキーが違います' });
    }
  }

  db.users[username] = {
    password,
    isAdmin,
    isModerator,
    isVerified: isAdmin,
    bio: 'X Ultraへようこそ！',
    avatarUrl: '',
    dmSetting: 'allow_all',
    following: [],
    followers: [],
    ipAddress: ip,
    isOnline: true,
    lastSeen: Date.now()
  };

  if (!db.logs) db.logs = [];
  db.logs.push({ timestamp: new Date().toLocaleString(), user: username, action: 'REGISTER', details: `IP: ${ip}` });
  saveData();
  res.json({ success: true, msg: 'アカウント作成成功！' });
});

// ログイン
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const user = db.users && db.users[username];

  if (!user || user.password !== password) {
    return res.json({ success: false, msg: 'ユーザー名またはパスワードが違います' });
  }

  user.isOnline = true;
  user.lastSeen = Date.now();
  user.ipAddress = ip;
  saveData();

  res.json({ success: true, token: password, isAdmin: user.isAdmin, isModerator: user.isModerator });
});

// オンラインユーザー一覧
app.get('/api/online-users', (req, res) => {
  if (!db.users) db.users = {};
  const onlineList = Object.keys(db.users)
    .filter(u => db.users[u].isOnline)
    .map(u => ({ username: u, isAdmin: db.users[u].isAdmin, avatarUrl: db.users[u].avatarUrl }));
  res.json({ count: onlineList.length, users: onlineList });
});

// 投稿取得
app.get('/api/tweets', (req, res) => {
  const { searchType, searchQuery, currentMe } = req.query;
  let results = [...(db.tweets || [])].reverse();

  if (searchType === 'follow' && currentMe && db.users && db.users[currentMe]) {
    const following = db.users[currentMe].following || [];
    results = results.filter(t => t.user === currentMe || following.includes(t.user));
  } else if (searchType === 'profile' && searchQuery) {
    results = results.filter(t => t.user === searchQuery);
  } else if (searchType === 'keyword' && searchQuery) {
    results = results.filter(t => t.content && t.content.includes(searchQuery));
  } else if (searchType === 'hashtag' && searchQuery) {
    results = results.filter(t => t.content && t.content.includes('#' + searchQuery));
  }

  results = results.map(t => {
    if (t.repostOfId) {
      const original = (db.tweets || []).find(orig => orig.id === t.repostOfId);
      if (original) t.repostData = original;
    }
    return t;
  });

  res.json({ data: results, hasMore: false });
});

// 投稿作成
app.post('/api/tweets', (req, res) => {
  const { username, textContent, mediaUrl, replyToId, repostOfId } = req.body;
  if (!db.users) db.users = {};
  const userObj = db.users[username];
  if (!userObj) return res.status(400).json({ success: false, msg: 'ユーザーが見つかりません' });

  userObj.isOnline = true;
  userObj.lastSeen = Date.now();

  let replyToUser = null;
  if (replyToId) {
    const parent = (db.tweets || []).find(t => t.id === replyToId);
    if (parent) replyToUser = parent.user;
  }

  const newTweet = {
    id: '_' + Math.random().toString(36).substr(2, 9),
    user: username,
    avatarUrl: userObj.avatarUrl || '',
    content: textContent || '',
    mediaUrl: mediaUrl || '',
    replyToId: replyToId || null,
    replyToUser: replyToUser,
    repostOfId: repostOfId || null,
    likes: [],
    timestamp: new Date().toLocaleString()
  };

  if (!db.tweets) db.tweets = [];
  db.tweets.push(newTweet);
  saveData();
  res.json({ success: true, tweet: newTweet });
});

// いいね
app.post('/api/tweets/like', (req, res) => {
  const { tweetId, username } = req.body;
  const tweet = (db.tweets || []).find(t => t.id === tweetId);
  if (!tweet) return res.status(404).json({});

  if (!tweet.likes) tweet.likes = [];
  const idx = tweet.likes.indexOf(username);
  if (idx > -1) {
    tweet.likes.splice(idx, 1);
  } else {
    tweet.likes.push(username);
  }
  saveData();
  res.json({ likes: tweet.likes });
});

// 投稿削除
app.delete('/api/tweets/:id', (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  const tweet = (db.tweets || []).find(t => t.id === tweetId);
  if (!tweet) return res.status(404).json({});

  const user = db.users && db.users[username];
  if (tweet.user === username || (user && (user.isAdmin || user.isModerator))) {
    db.tweets = db.tweets.filter(t => t.id !== tweetId);
    saveData();
    return res.json({ success: true });
  }
  res.status(403).json({ success: false });
});

// プロフィール情報取得
app.get('/api/profile/:username', (req, res) => {
  const target = req.params.username;
  const viewer = req.query.viewer;
  if (!db.users) db.users = {};
  const user = db.users[target];
  if (!user) return res.status(404).json({});

  res.json({
    user: target,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    dmSetting: user.dmSetting,
    isOnline: user.isOnline,
    followingCount: (user.following || []).length,
    followerCount: (user.followers || []).length,
    isFollowing: viewer && (user.followers || []).includes(viewer)
  });
});

// プロフィール更新
app.post('/api/profile/update', (req, res) => {
  const { username, bio, avatarUrl, dmSetting } = req.body;
  if (!db.users) db.users = {};
  const user = db.users[username];
  if (!user) return res.status(404).json({});

  if (bio !== undefined) user.bio = bio;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (dmSetting !== undefined) user.dmSetting = dmSetting;
  saveData();
  res.json({ success: true });
});

// フォロー / アンフォロー
app.post('/api/follow', (req, res) => {
  const { username, targetUser } = req.body;
  if (!db.users) db.users = {};
  const me = db.users[username];
  const target = db.users[targetUser];
  if (!me || !target) return res.status(400).json({});

  if (!me.following) me.following = [];
  if (!target.followers) target.followers = [];

  const idx = me.following.indexOf(targetUser);
  if (idx > -1) {
    me.following.splice(idx, 1);
    target.followers = target.followers.filter(u => u !== username);
  } else {
    me.following.push(targetUser);
    target.followers.push(username);
    if (!db.notifs) db.notifs = [];
    db.notifs.push({
      to: targetUser,
      content: `@${username} があなたをフォローしました`,
      timestamp: new Date().toLocaleString()
    });
  }
  saveData();
  res.json({ success: true });
});

// DM一覧・履歴
app.get('/api/dm/conversations/:username', (req, res) => {
  const username = req.params.username;
  const contacts = new Set();
  (db.dms || []).forEach(d => {
    if (d.from === username) contacts.add(d.to);
    if (d.to === username) contacts.add(d.from);
  });

  const list = Array.from(contacts).map(c => ({
    username: c,
    isOnline: db.users && db.users[c] ? db.users[c].isOnline : false
  }));
  res.json(list);
});

app.get('/api/dm/chat', (req, res) => {
  const { userA, userB } = req.query;
  const logs = (db.dms || []).filter(d => (d.from === userA && d.to === userB) || (d.from === userB && d.to === userA));
  res.json(logs);
});

app.post('/api/dm/send', (req, res) => {
  const { fromUser, toUser, message } = req.body;
  if (!db.users) db.users = {};
  const target = db.users[toUser];
  if (!target) return res.status(404).json({});

  if (target.dmSetting === 'deny_all') {
    return res.json({ success: false, msg: 'このユーザーはDMを受け付けていません' });
  }

  const dm = { from: fromUser, to: toUser, message, timestamp: new Date().toLocaleString() };
  if (!db.dms) db.dms = [];
  db.dms.push(dm);
  if (!db.notifs) db.notifs = [];
  db.notifs.push({ to: toUser, content: `@${fromUser} からDMが届きました`, timestamp: new Date().toLocaleString() });
  saveData();
  res.json({ success: true });
});

app.get('/api/notifs/:username', (req, res) => {
  const username = req.params.username;
  res.json((db.notifs || []).filter(n => n.to === username));
});

// 管理パネル
app.get('/api/admin/data', (req, res) => {
  res.json({ users: db.users || {}, logs: db.logs || [], allDms: db.dms || [], bans: db.bans || [] });
});

app.post('/api/admin/action', (req, res) => {
  const { action, targetUser, adminUser, extra, banDurationHours, banReason } = req.body;
  if (!db.users) db.users = {};
  const target = db.users[targetUser];
  if (!target) return res.json({ success: false, msg: 'ユーザーが存在しません' });

  if (action === 'ban') {
    const ip = target.ipAddress;
    let bannedUntil = 'permanent';
    if (banDurationHours && banDurationHours !== 'permanent') {
      bannedUntil = Date.now() + (Number(banDurationHours) * 3600 * 1000);
    }
    if (!db.bans) db.bans = [];
    db.bans.push({
      ip: ip || 'unknown',
      bannedUntil,
      reason: banReason || '規約違反',
      executedBy: adminUser
    });
    if (!db.logs) db.logs = [];
    db.logs.push({ timestamp: new Date().toLocaleString(), user: adminUser, action: 'BAN', details: `@${targetUser} (IP: ${ip})` });
    saveData();
    return res.json({ success: true });
  }

  if (action === 'mod') {
    target.isModerator = !target.isModerator;
  } else if (action === 'verify') {
    target.isVerified = !target.isVerified;
  } else if (action === 'warn') {
    if (!db.notifs) db.notifs = [];
    db.notifs.push({ to: targetUser, content: `【警告】${extra || 'マナーを守ってください'}`, timestamp: new Date().toLocaleString() });
  }

  if (!db.logs) db.logs = [];
  db.logs.push({ timestamp: new Date().toLocaleString(), user: adminUser, action: action.toUpperCase(), details: targetUser });
  saveData();
  res.json({ success: true });
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
