const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!global._xUltraDb) {
  global._xUltraDb = {
    users: {},
    tweets: [],
    dms: [],
    notifs: [],
    bans: [],
    logs: [],
    ipLogs: {}
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
    console.error("Data load error:", e);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    console.error("Data save error:", e);
  }
}

loadData();

// 定期的なファイル同期とオンライン判定の調整（オンライン猶予を3分に延長して消えにくくする）
setInterval(() => {
  const now = Date.now();
  if (!db.users) return;
  Object.keys(db.users).forEach(u => {
    if (db.users[u].isOnline && (now - (db.users[u].lastSeen || 0) > 180000)) {
      db.users[u].isOnline = false;
    }
  });
  saveData();
}, 10000);

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

// アクティビティ更新ヘルパー（アクションごとにオンラインを維持）
function touchUser(username, ip) {
  if (!db.users || !db.users[username]) return;
  db.users[username].isOnline = true;
  db.users[username].lastSeen = Date.now();
  if (ip && ip !== 'unknown') {
    db.users[username].ipAddress = ip;
    if (!db.ipLogs) db.ipLogs = {};
    db.ipLogs[username] = ip;
  }
}

app.post('/api/register', (req, res) => {
  loadData();
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

  if (!db.ipLogs) db.ipLogs = {};
  db.ipLogs[username] = ip;

  if (!db.logs) db.logs = [];
  db.logs.push({ timestamp: new Date().toLocaleString(), user: username, action: 'REGISTER', details: `IP: ${ip}` });
  saveData();
  res.json({ success: true, msg: 'アカウント作成成功！' });
});

app.post('/api/login', (req, res) => {
  loadData();
  const { username, password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!db.users) db.users = {};
  const user = db.users[username];

  if (!user || user.password !== password) {
    return res.json({ success: false, msg: 'ユーザー名またはパスワードが違います' });
  }

  touchUser(username, ip);
  saveData();

  res.json({ success: true, token: password, isAdmin: user.isAdmin, isModerator: user.isModerator });
});

app.get('/api/online-users', (req, res) => {
  loadData();
  if (!db.users) db.users = {};
  const onlineList = Object.keys(db.users)
    .filter(u => db.users[u] && db.users[u].isOnline)
    .map(u => ({ username: u, isAdmin: db.users[u].isAdmin, avatarUrl: db.users[u].avatarUrl }));
  res.json({ count: onlineList.length, users: onlineList });
});

app.get('/api/tweets', (req, res) => {
  loadData();
  const { searchType, searchQuery, currentMe } = req.query;
  if (currentMe) touchUser(currentMe);

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

app.post('/api/tweets', (req, res) => {
  loadData();
  const { username, textContent, mediaUrl, replyToId, repostOfId } = req.body;
  if (!db.users) db.users = {};
  const userObj = db.users[username];
  if (!userObj) return res.status(400).json({ success: false, msg: 'ユーザーが見つかりません' });

  touchUser(username);

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

app.post('/api/tweets/like', (req, res) => {
  loadData();
  const { tweetId, username } = req.body;
  touchUser(username);
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

app.delete('/api/tweets/:id', (req, res) => {
  loadData();
  const { username } = req.body;
  touchUser(username);
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

app.get('/api/profile/:username', (req, res) => {
  loadData();
  const target = req.params.username;
  const viewer = req.query.viewer;
  if (viewer) touchUser(viewer);

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

app.post('/api/profile/update', (req, res) => {
  loadData();
  const { username, bio, avatarUrl, dmSetting } = req.body;
  touchUser(username);
  if (!db.users) db.users = {};
  const user = db.users[username];
  if (!user) return res.status(404).json({});

  if (bio !== undefined) user.bio = bio;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (dmSetting !== undefined) user.dmSetting = dmSetting;
  saveData();
  res.json({ success: true });
});

app.post('/api/follow', (req, res) => {
  loadData();
  const { username, targetUser } = req.body;
  touchUser(username);
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

app.get('/api/dm/conversations/:username', (req, res) => {
  loadData();
  const username = req.params.username;
  touchUser(username);
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
  loadData();
  const { userA, userB } = req.query;
  if (userA) touchUser(userA);
  const logs = (db.dms || []).filter(d => (d.from === userA && d.to === userB) || (d.from === userB && d.to === userA));
  res.json(logs);
});

app.post('/api/dm/send', (req, res) => {
  loadData();
  const { fromUser, toUser, message } = req.body;
  touchUser(fromUser);
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
  loadData();
  const username = req.params.username;
  touchUser(username);
  res.json((db.notifs || []).filter(n => n.to === username));
});

app.get('/api/admin/data', (req, res) => {
  loadData();
  res.json({ 
    users: db.users || {}, 
    logs: db.logs || [], 
    allDms: db.dms || [], 
    bans: db.bans || [],
    ipLogs: db.ipLogs || {}
  });
});

app.post('/api/admin/action', (req, res) => {
  loadData();
  const { action, targetUser, adminUser, extra, banDurationHours, banReason } = req.body;
  if (!db.users) db.users = {};
  const target = db.users[targetUser];
  if (!target) return res.json({ success: false, msg: 'ユーザーが存在しません' });

  if (action === 'ban') {
    const ip = (db.ipLogs && db.ipLogs[targetUser]) || target.ipAddress || 'unknown';
    let bannedUntil = 'permanent';
    if (banDurationHours && banDurationHours !== 'permanent') {
      bannedUntil = Date.now() + (Number(banDurationHours) * 3600 * 1000);
    }
    if (!db.bans) db.bans = [];
    db.bans.push({
      ip: ip,
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
