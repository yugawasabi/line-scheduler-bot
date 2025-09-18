const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { format, parse, isValid, addDays, startOfMonth, endOfMonth } = require('date-fns');
const ja = require('date-fns/locale/ja');

// ===== Firebase 初期化 =====
const serviceAccount = require('/opt/render/project/src/serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ===== LINE API 設定 =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);
const app = express();

// ===== Webhook受信 =====
app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

// ===== メッセージ処理 =====
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 今日の予定
  if (text.includes('今日')) {
    await replySchedules(event.replyToken, userId, new Date(), new Date());
    return;
  }

  // 明日の予定
  if (text.includes('明日')) {
    const tomorrow = addDays(new Date(), 1);
    await replySchedules(event.replyToken, userId, tomorrow, tomorrow);
    return;
  }

  // 「10月の予定」など月指定
  const monthMatch = text.match(/(\d{1,2})月/);
  if (monthMatch) {
    const month = parseInt(monthMatch[1], 10) - 1;
    const year = new Date().getFullYear();
    const start = startOfMonth(new Date(year, month, 1));
    const end = endOfMonth(new Date(year, month, 1));
    await replySchedules(event.replyToken, userId, start, end);
    return;
  }

  // 「①を削除」
  const delMatch = text.match(/^(\d+)を削除$/);
  if (delMatch) {
    const index = parseInt(delMatch[1], 10);
    await deleteSchedule(event.replyToken, userId, index);
    return;
  }

  // 日付+内容の予定追加
  const dateMatch = text.match(/(\d{1,2})[\/月](\d{1,2})\s*(\d{1,2}:\d{2})?\s*(.+)/);
  if (dateMatch) {
    const [, m, d, t, content] = dateMatch;
    const year = new Date().getFullYear();
    const date = new Date(year, m - 1, d);
    if (!isValid(date)) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '日付が不正です' });
      return;
    }
    const dateStr = format(date, 'yyyy-MM-dd');
    const timeStr = t || null;

    await db.collection('schedules').add({
      userId,
      date: dateStr,
      time: timeStr,
      content,
      createdAt: new Date().toISOString()
    });

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `予定を登録しました！\n📅 ${dateStr}${timeStr ? ' ' + timeStr : ''}\n📝 ${content}`
    });
    return;
  }

  // それ以外は無反応
  return;
}

// ===== 予定リスト返信 =====
async function replySchedules(replyToken, userId, startDate, endDate) {
  const start = format(startDate, 'yyyy-MM-dd');
  const end = format(endDate, 'yyyy-MM-dd');

  const snapshot = await db.collection('schedules')
    .where('userId', '==', userId)
    .where('date', '>=', start)
    .where('date', '<=', end)
    .get();

  if (snapshot.empty) {
    await client.replyMessage(replyToken, { type: 'text', text: '予定はありません。' });
    return;
  }

  let message = '📅 予定リスト\n';
  let i = 1;
  snapshot.forEach(doc => {
    const s = doc.data();
    message += `${i}. ${s.date}${s.time ? ' ' + s.time : ''} ${s.content}\n`;
    i++;
  });

  await client.replyMessage(replyToken, { type: 'text', text: message });
}

// ===== 削除 =====
async function deleteSchedule(replyToken, userId, index) {
  const snapshot = await db.collection('schedules')
    .where('userId', '==', userId)
    .orderBy('date')
    .get();

  if (snapshot.empty || index < 1 || index > snapshot.size) {
    await client.replyMessage(replyToken, { type: 'text', text: '指定番号の予定が見つかりません。' });
    return;
  }

  const doc = snapshot.docs[index - 1];
  const data = doc.data();
  await doc.ref.delete();

  await client.replyMessage(replyToken, {
    type: 'text',
    text: `削除しました ✅\n📅 ${data.date}${data.time ? ' ' + data.time : ''}\n📝 ${data.content}`
  });
}

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
