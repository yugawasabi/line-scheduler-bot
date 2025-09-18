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

  // ユーザーの状態取得
  const stateDoc = await db.collection('user_states').doc(userId).get();
  let state = stateDoc.exists ? stateDoc.data() : {};

  // --------------------------
  // (1) 対話中の編集・削除処理
  // --------------------------
  if (state.step === "waitingForNumber") {
    // リスト番号を受け取る
    const index = parseInt(text, 10);
    if (isNaN(index) || index < 1) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '正しい番号を送ってください' });
      return;
    }

    // 該当予定を取得
    const snapshot = await db.collection('schedules')
      .where('userId', '==', userId)
      .orderBy('date')
      .get();

    if (index > snapshot.size) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '指定番号の予定が見つかりません。' });
      return;
    }

    const doc = snapshot.docs[index - 1];
    await db.collection('user_states').doc(userId).set({
      targetScheduleId: doc.id,
      step: "selectAction"
    }, { merge: true });

    await client.replyMessage(event.replyToken, { type: 'text', text: `予定「${doc.data().date} ${doc.data().time || ""} ${doc.data().content}」\n編集しますか？削除しますか？` });
    return;
  }

  if (state.step === "selectAction") {
    const scheduleRef = db.collection('schedules').doc(state.targetScheduleId);
    const scheduleDoc = await scheduleRef.get();
    const data = scheduleDoc.data();

    if (text === "編集") {
      await db.collection('user_states').doc(userId).set({ currentAction: "editing", step: "waitingForField" }, { merge: true });
      await client.replyMessage(event.replyToken, { type: 'text', text: '何を編集しますか？ 日付 / 時間 / 内容 を送ってください' });
      return;
    } else if (text === "削除") {
      await scheduleRef.delete();
      await db.collection('user_states').doc(userId).set({ currentAction: null, step: null, targetScheduleId: null }, { merge: true });
      await client.replyMessage(event.replyToken, { type: 'text', text: `削除しました ✅\n📅 ${data.date}${data.time ? ' ' + data.time : ''}\n📝 ${data.content}` });
      return;
    } else {
      await client.replyMessage(event.replyToken, { type: 'text', text: '「編集」か「削除」を送ってください' });
      return;
    }
  }

  if (state.step === "waitingForField" && state.currentAction === "editing") {
    const scheduleRef = db.collection('schedules').doc(state.targetScheduleId);
    const scheduleDoc = await scheduleRef.get();
    const data = scheduleDoc.data();
    let updateData = {};

    // 日付変更
    if (/^\d{1,2}[\/-]\d{1,2}$/.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      updateData.date = text;
    }
    // 時間変更
    else if (/^\d{1,2}:\d{2}$/.test(text)) {
      updateData.time = text;
    }
    // 内容変更
    else {
      updateData.content = text;
    }

    await scheduleRef.update(updateData);
    await db.collection('user_states').doc(userId).set({ currentAction: null, step: null, targetScheduleId: null }, { merge: true });

    await client.replyMessage(event.replyToken, { type: 'text', text: `変更を保存しました ✅\n📅 ${updateData.date || data.date}${updateData.time || data.time ? ' ' + (updateData.time || data.time) : ''}\n📝 ${updateData.content || data.content}` });
    return;
  }

  // --------------------------
  // (2) 予定の追加
  // --------------------------
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

    await client.replyMessage(event.replyToken, { type: 'text', text: `予定を登録しました！\n📅 ${dateStr}${timeStr ? ' ' + timeStr : ''}\n📝 ${content}` });
    return;
  }

  // --------------------------
  // (3) 今日・明日・月の予定リスト
  // --------------------------
  let startDate, endDate;

  if (text.includes('今日')) startDate = endDate = new Date();
  else if (text.includes('明日')) { startDate = endDate = addDays(new Date(), 1); }
  else {
    const monthMatch = text.match(/(\d{1,2})月/);
    if (monthMatch) {
      const month = parseInt(monthMatch[1], 10) - 1;
      const year = new Date().getFullYear();
      startDate = startOfMonth(new Date(year, month, 1));
      endDate = endOfMonth(new Date(year, month, 1));
    }
  }

  if (startDate && endDate) {
    await replySchedules(event.replyToken, userId, startDate, endDate);
    return;
  }

  // --------------------------
  // それ以外は無反応
  // --------------------------
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
    .orderBy('date')
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

  message += '\n番号を送って編集・削除したい予定を選択してください';

  await client.replyMessage(replyToken, { type: 'text', text: message });

  // ユーザー状態を更新
  await db.collection('user_states').doc(userId).set({
    step: "waitingForNumber",
    targetScheduleId: null,
    currentAction: null
  }, { merge: true });
}

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
