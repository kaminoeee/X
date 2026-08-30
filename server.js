const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FOLDER_ID = '1l-oyfOSxBQnyDG6cfaQie_pBjJnbvZZF';

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return google.drive({ version: 'v3', auth });
}

let dbCache = null;

async function loadDB() {
  if (dbCache) return dbCache;
  try {
    const drive = getDriveClient();
    const res = await drive.files.list({
      q: `name = 'database.json' and '${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)'
    });
    
    if (res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      const file = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
      dbCache = file.data;
    } else {
      dbCache = { users: {}, tweets: [], dms: [], notifs: [], adminLogs: [], recommendations: [] };
      await saveDB();
    }
  } catch (e) {
    console.error('DB Load Error:', e);
    if (!dbCache) dbCache = { users: {}, tweets: [], dms: [], notifs: [], adminLogs: [], recommendations: [] };
  }
  return dbCache;
}

async function saveDB() {
  try {
    const drive = getDriveClient();
    const res = await drive.files.list({
      q: `name = 'database.json' and '${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)'
    });
    
    const fileMetadata = { name: 'database.json', parents: [FOLDER_ID] };
    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(dbCache, null, 2)
    };

    if (res.data.files.length > 0) {
      await drive.files.update({ fileId: res.data.files[0].id, requestBody: fileMetadata, media: media });
    } else {
      await drive.files.create({ requestBody: fileMetadata, media: media, fields: 'id' });
    }
  } catch (e) {
    console.error('DB Save Error:', e);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function addLog(db, action, details, user) {
  if (!db.adminLogs) db.adminLogs = [];
  db.adminLogs.unshift({
    timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    user: user,
    action: action,
    details: details
  });
}

// ─── API エンドポイント ───

app.post('/api/register', async (req, res) => {
  const { username, password, adminPassword } = req.body;
  if (!username || !username.trim() || !password || !password.trim()) {
    return res.json({ success: false, msg: "空欄があります" });
  }
  const db = await loadDB();
  if (db.users[username]) return res.json({ success: false, msg: "❌ 既に存在します" });
  
  let isAdmin = false;
  if (adminPassword && adminPassword.trim() !== "") {
    if (adminPassword === "28758141") isAdmin = true;
    else return res.json({ success: false, msg: "管理者キーが違います" });
  }

  db.users[username] = {
    password: hashPassword(password),
    bio: isAdmin ? "🚨公式管理者" : "よろしくお願いします！",
    avatarUrl: "",
    following: [],
    isAdmin: isAdmin,
    isModerator: false,
    isVerified: isAdmin,
    dmSetting: "allow_all",
    lastSeen: Date.now()
  };
  await saveDB();
  res.json({ success: true, msg: "登録成功" });
});

app.post('/api/login', async (req, res) => {
  const { username, password, isHashed } = req.body;
  const db = await loadDB();
  if (!db.users[username]) return res.json({ success: false, msg: "ログイン失敗" });
  
  const targetHash = isHashed ? password : hashPassword(password);
  if (db.users[username].password === targetHash) {
    db.users[username].lastSeen = Date.now();
    await saveDB();
    return res.json({
      success: true,
      isAdmin: db.users[username].isAdmin || false,
      isModerator: db.users[username].isModerator || false,
      token: db.users[username].password
    });
  }
  res.json({ success: false, msg: "ログイン失敗" });
});

app.get('/api/profile/:username', async (req, res) => {
  const { username } = req.params;
  const viewer = req.query.viewer;
  const db = await loadDB();
  if (viewer && db.users[viewer]) {
    db.users[viewer].lastSeen = Date.now();
    await saveDB();
  }
  if (!db.users[username]) return res.json(null);

  let followerCount = 0;
  Object.keys(db.users).forEach(name => {
    if (db.users[name].following && db.users[name].following.includes(username)) followerCount++;
  });

  res.json({
    user: username,
    bio: db.users[username].bio || "",
    avatarUrl: db.users[username].avatarUrl || "",
    followingCount: (db.users[username].following || []).length,
    followerCount: followerCount,
    followingList: db.users[username].following || [],
    isAdmin: db.users[username].isAdmin || false,
    isModerator: db.users[username].isModerator || false,
    isVerified: db.users[username].isVerified || false,
    dmSetting: db.users[username].dmSetting || "allow_all",
    isOnline: (Date.now() - (db.users[username].lastSeen || 0)) < 30000
  });
});

app.post('/api/profile/update', async (req, res) => {
  const { username, bio, avatarUrl, dmSetting } = req.body;
  const db = await loadDB();
  if (!db.users[username]) return res.json({ success: false });
  if (bio !== undefined) db.users[username].bio = bio;
  if (avatarUrl !== undefined) db.users[username].avatarUrl = avatarUrl;
  if (dmSetting !== undefined) db.users[username].dmSetting = dmSetting;
  await saveDB();
  res.json({ success: true });
});

app.post('/api/follow', async (req, res) => {
  const { username, targetUser } = req.body;
  const db = await loadDB();
  if (!db.users[username] || !db.users[targetUser]) return res.json({ success: false });
  if (!db.users[username].following) db.users[username].following = [];
  
  const idx = db.users[username].following.indexOf(targetUser);
  let isFollowing = false;
  if (idx > -1) {
    db.users[username].following.splice(idx, 1);
  } else {
    db.users[username].following.push(targetUser);
    isFollowing = true;
    db.notifs.push({
      id: "notif_" + Date.now(),
      to: targetUser,
      from: username,
      type: "follow",
      content: `${username}さんがあなたをフォローしました`,
      timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    });
  }
  await saveDB();
  res.json({ success: true, isFollowing });
});

app.get('/api/tweets', async (req, res) => {
  const { offset = 0, limit = 20, searchType, searchQuery, currentMe } = req.query;
  const db = await loadDB();
  if (currentMe && db.users[currentMe]) {
    db.users[currentMe].lastSeen = Date.now();
    await saveDB();
  }

  let filtered = db.tweets.filter(t => {
    if (searchType === 'follow') {
      const myFollows = db.users[currentMe] ? (db.users[currentMe].following || []) : [];
      return myFollows.includes(t.user) || t.user === currentMe;
    }
    if (searchType === 'profile') return t.user === searchQuery;
    if (searchType === 'hashtag') return t.content.includes('#' + searchQuery);
    if (searchType === 'keyword') return t.content.toLowerCase().includes(searchQuery.toLowerCase());
    return true;
  });

  const total = filtered.length;
  const sliced = filtered.slice(Number(offset), Number(offset) + Number(limit));

  const mapped = sliced.map(t => {
    const u = db.users[t.user] || {};
    t.avatarUrl = u.avatarUrl || "";
    t.isAuthorVerified = u.isVerified || false;
    
    if (t.replyToId) {
      const parent = db.tweets.find(x => x.id === t.replyToId);
      if (parent) t.replyToUser = parent.user;
    }
    if (t.repostOfId) {
      const orig = db.tweets.find(x => x.id === t.repostOfId);
      if (orig) {
        const ou = db.users[orig.user] || {};
        t.repostData = {
          id: orig.id, user: orig.user, content: orig.content, mediaUrl: orig.mediaUrl,
          timestamp: orig.timestamp, avatarUrl: ou.avatarUrl || "", isAuthorVerified: ou.isVerified || false
        };
      }
    }
    return t;
  });

  res.json({ data: mapped, hasMore: (Number(offset) + Number(limit)) < total });
});

app.post('/api/tweets', async (req, res) => {
  const { username, textContent, mediaUrl, replyToId, repostOfId } = req.body;
  if (!textContent && !mediaUrl && !repostOfId) return res.json({ success: false });

  const db = await loadDB();
  const tweetId = "t_" + Date.now() + "_" + Math.floor(Math.random()*1000);
  
  const newTweet = {
    id: tweetId,
    user: username,
    handle: "@" + username,
    content: textContent || "",
    mediaUrl: mediaUrl || "",
    replyToId: replyToId || null,
    repostOfId: repostOfId || null,
    timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    likes: []
  };

  db.tweets.unshift(newTweet);
  if (replyToId) {
    const parent = db.tweets.find(x => x.id === replyToId);
    if (parent && parent.user !== username) {
      db.notifs.push({
        id: "notif_" + Date.now(), to: parent.user, from: username, type: "reply",
        content: `${username}さんがあなたの投稿に返信しました`, timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      });
    }
  }
  await saveDB();
  res.json({ success: true });
});

app.post('/api/tweets/like', async (req, res) => {
  const { tweetId, username } = req.body;
  const db = await loadDB();
  const tweet = db.tweets.find(t => t.id === tweetId);
  if (!tweet) return res.json({ likes: [] });
  if (!tweet.likes) tweet.likes = [];
  
  const idx = tweet.likes.indexOf(username);
  if (idx > -1) {
    tweet.likes.splice(idx, 1);
  } else {
    tweet.likes.push(username);
    if (tweet.user !== username) {
      db.notifs.push({
        id: "notif_" + Date.now(), to: tweet.user, from: username, type: "like",
        content: `${username}さんがあなたの投稿にいいねしました`, timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      });
    }
  }
  await saveDB();
  res.json({ likes: tweet.likes });
});

app.delete('/api/tweets/:id', async (req, res) => {
  const { id } = req.params;
  const { username } = req.body;
  const db = await loadDB();
  const u = db.users[username] || {};
  
  db.tweets = db.tweets.filter(t => {
    if (t.id === id) {
      if (t.user === username || u.isAdmin || u.isModerator) return false;
    }
    return true;
  });
  await saveDB();
  res.json({ success: true });
});

app.post('/api/dm/send', async (req, res) => {
  const { fromUser, toUser, message } = req.body;
  if (!message || !message.trim()) return res.json({ success: false, msg: "メッセージが空です" });
  const db = await loadDB();
  if (db.users[toUser] && db.users[toUser].dmSetting === "deny_all") {
    return res.json({ success: false, msg: "❌ 相手はDMを受信拒否しています。" });
  }

  db.dms.push({
    id: "dm_" + Date.now(), from: fromUser, to: toUser, message: message,
    timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  });
  db.notifs.push({
    id: "notif_" + Date.now(), to: toUser, from: fromUser, type: "dm",
    content: `${fromUser}さんからDMが届きました`, timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  });
  await saveDB();
  res.json({ success: true });
});

app.get('/api/dm/conversations/:username', async (req, res) => {
  const { username } = req.params;
  const db = await loadDB();
  const contactSet = new Set();
  db.dms.forEach(d => {
    if (d.from === username) contactSet.add(d.to);
    if (d.to === username) contactSet.add(d.from);
  });
  const contacts = Array.from(contactSet).map(name => {
    const uData = db.users[name] || {};
    return {
      username: name,
      avatarUrl: uData.avatarUrl || "",
      isOnline: (Date.now() - (uData.lastSeen || 0)) < 30000
    };
  });
  res.json(contacts);
});

app.get('/api/dm/chat', async (req, res) => {
  const { userA, userB } = req.query;
  const db = await loadDB();
  const logs = db.dms.filter(d => (d.from === userA && d.to === userB) || (d.from === userB && d.to === userA));
  res.json(logs);
});

app.get('/api/notifs/:username', async (req, res) => {
  const { username } = req.params;
  const db = await loadDB();
  const list = db.notifs.filter(n => n.to === username);
  res.json(list);
});

// 管理パネル系
app.get('/api/admin/data', async (req, res) => {
  const db = await loadDB();
  res.json({
    logs: db.adminLogs || [],
    recommendations: db.recommendations || [],
    users: db.users
  });
});

app.post('/api/admin/action', async (req, res) => {
  const { action, targetUser, adminUser, extra } = req.body;
  const db = await loadDB();
  const adm = db.users[adminUser] || {};
  if (!adm.isAdmin && !adm.isModerator) return res.json({ success: false, msg: "権限がありません" });

  if (action === 'warn') {
    db.notifs.push({
      id: "notif_" + Date.now(), to: targetUser, from: adminUser, type: "warning",
      content: `🚨 【警告】管理者からの通達: ${extra}`, timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    });
    addLog(db, '警告送信', `${targetUser}へ: ${extra}`, adminUser);
  } else if (action === 'mod' && adm.isAdmin) {
    db.users[targetUser].isModerator = !db.users[targetUser].isModerator;
    addLog(db, 'モデレーター切替', `${targetUser} -> ${db.users[targetUser].isModerator}`, adminUser);
  } else if (action === 'verify' && adm.isAdmin) {
    db.users[targetUser].isVerified = !db.users[targetUser].isVerified;
    addLog(db, '認証バッジ切替', `${targetUser} -> ${db.users[targetUser].isVerified}`, adminUser);
  } else if (action === 'ban' && adm.isAdmin) {
    delete db.users[targetUser];
    addLog(db, 'アカウント追放(BAN)', targetUser, adminUser);
  }
  await saveDB();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
