const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Googleドライブ設定（環境変数またはService Account等を利用）
// ※Vercel環境変数に GOOGLE_SERVICE_ACCOUNT_JSON の中身をそのまま設定してください
const FOLDER_ID = '1l-oyfOSxBQnyDG6cfaQie_pBjJnbvZZF';

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return google.drive({ version: 'v3', auth });
}

// 簡易DBキャッシュ（GoogleドライブAPIのレートリミット対策＋メモリ保持）
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
      // 初期データ作成
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
      await drive.files.update({
        fileId: res.data.files[0].id,
        requestBody: fileMetadata,
        media: media
      });
    } else {
      await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id'
      });
    }
  } catch (e) {
    console.error('DB Save Error:', e);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// ─── APIエンドポイント群 ───

// ユーザー登録
app.post('/api/register', async (req, res) => {
  const { username, password, adminPassword } = req.body;
  if (!username || !username.trim() || !password || !password.trim()) {
    return res.json({ success: false, msg: "空欄があります" });
  }
  const db = await loadDB();
  if (db.users[username]) {
    return res.json({ success: false, msg: "❌ このユーザー名は既に使用されています。" });
  }
  
  let isAdmin = false;
  if (adminPassword && adminPassword.trim() !== "") {
    if (adminPassword === "28758141") {
      isAdmin = true;
    } else {
      return { success: false, msg: "管理者キーが不正です" };
    }
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
  res.json({ success: true, msg: isAdmin ? "👑管理者として登録完了" : "👤一般登録完了" });
});

// ログイン
app.post('/api/login', async (req, res) => {
  const { username, password, isHashed } = req.body;
  const db = await loadDB();
  if (!db.users[username]) return res.json({ success: false, msg: "ユーザーIDまたはパスワードが違います" });
  
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
  res.json({ success: false, msg: "ユーザーIDまたはパスワードが違います" });
});

// ユーザープロフィール取得＆オンライン状態更新
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
    // 30秒以内をオンラインとみなす
    isOnline: (Date.now() - (db.users[username].lastSeen || 0)) < 30000
  });
});

// ツイート取得
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
      return myFollows.includes(t.user);
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
    
    if (t.repostOfId) {
      const orig = db.tweets.find(x => x.id === t.repostOfId);
      if (orig) {
        const ou = db.users[orig.user] || {};
        t.repostData = {
          id: orig.id,
          user: orig.user,
          content: orig.content,
          mediaUrl: orig.mediaUrl,
          timestamp: orig.timestamp,
          avatarUrl: ou.avatarUrl || "",
          isAuthorVerified: ou.isVerified || false
        };
      }
    }
    return t;
  });

  res.json({ data: mapped, hasMore: (Number(offset) + Number(limit)) < total });
});

// ツイート投稿
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
  await saveDB();
  res.json({ success: true });
});

// いいね切替
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
  }
  await saveDB();
  res.json({ likes: tweet.likes });
});

// ツイート削除
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

// DM送信
app.post('/api/dm/send', async (req, res) => {
  const { fromUser, toUser, message } = req.body;
  if (!message || !message.trim()) return res.json({ success: false, msg: "メッセージが空です" });
  
  const db = await loadDB();
  if (db.users[toUser] && db.users[toUser].dmSetting === "deny_all") {
    return { success: false, msg: "❌ 相手はDMを受信拒否しています。" };
  }

  db.dms.push({
    id: "dm_" + Date.now(),
    from: fromUser,
    to: toUser,
    message: message,
    timestamp: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  });
  await saveDB();
  res.json({ success: true });
});

// DMスレッド相手一覧 ＆ オンライン状況取得
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
    const isOnline = (Date.now() - (uData.lastSeen || 0)) < 30000;
    return {
      username: name,
      avatarUrl: uData.avatarUrl || "",
      isOnline: isOnline
    };
  });

  res.json(contacts);
});

// 特定ユーザー間のDMチャットログ
app.get('/api/dm/chat', async (req, res) => {
  const { userA, userB } = req.query;
  const db = await loadDB();
  const logs = db.dms.filter(d => (d.from === userA && d.to === userB) || (d.from === userB && d.to === userA));
  res.json(logs);
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
