const { kv } = require('@vercel/kv');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // without @, e.g. MyEarningBot
// CHANNEL_IDS: comma separated. Public channel: @channelusername
// Private channel: numeric chat id like -1001234567890 (bot must be admin there)
const CHANNELS = (process.env.CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WORK_REWARD = parseFloat(process.env.WORK_REWARD || '0.5');
const WORK_COOLDOWN_SECONDS = parseInt(process.env.WORK_COOLDOWN_SECONDS || '3600', 10);
const REFERRAL_BONUS = parseFloat(process.env.REFERRAL_BONUS || '5');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function getUser(id) {
  const user = await kv.get(`user:${id}`);
  if (user) return user;
  const fresh = {
    id,
    balance: 0,
    referrals: 0,
    verified: false,
    referredBy: null,
    lastWork: 0,
  };
  await kv.set(`user:${id}`, fresh);
  return fresh;
}

async function saveUser(user) {
  await kv.set(`user:${user.id}`, user);
}

function joinKeyboard() {
  const rows = CHANNELS.map((ch, i) => {
    const handle = ch.startsWith('@') ? ch.slice(1) : ch;
    const url = ch.startsWith('-') ? undefined : `https://t.me/${handle}`;
    return [{ text: `📢 Channel ${i + 1} Join Korun`, url: url || `https://t.me/${handle}` }];
  });
  rows.push([{ text: '✅ Verify Korun', callback_data: 'verify' }]);
  return { inline_keyboard: rows };
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💰 Balance', callback_data: 'balance' },
        { text: '👥 Refer & Earn', callback_data: 'refer' },
      ],
      [{ text: '💼 Work Kore Income', callback_data: 'work' }],
    ],
  };
}

async function checkJoinedAll(userId) {
  for (const ch of CHANNELS) {
    try {
      const r = await tg('getChatMember', { chat_id: ch, user_id: userId });
      const status = r && r.result && r.result.status;
      if (!['member', 'administrator', 'creator'].includes(status)) {
        return false;
      }
    } catch (e) {
      return false;
    }
  }
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot webhook is alive.');
  }

  const update = req.body;

  try {
    // ---- normal text message ----
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = msg.text || '';

      if (text.startsWith('/start')) {
        const user = await getUser(userId);

        // capture referral payload: /start <referrerId>
        const parts = text.split(' ');
        if (parts.length > 1 && !user.referredBy && parts[1] !== String(userId)) {
          user.referredBy = parts[1];
          await saveUser(user);
        }

        if (user.verified) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'স্বাগতম! নিচের মেনু থেকে বেছে নিন 👇',
            reply_markup: mainKeyboard(),
          });
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text:
              '👋 স্বাগতম!\n\nবট ব্যবহার করার আগে নিচের চ্যানেলগুলোতে জয়েন করুন, ' +
              'তারপর নিচের "Verify Korun" বাটনে ক্লিক করুন।',
            reply_markup: joinKeyboard(),
          });
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ---- button press ----
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const userId = cq.from.id;
      const data = cq.data;
      const user = await getUser(userId);

      if (data === 'verify') {
        const joined = await checkJoinedAll(userId);
        if (joined) {
          if (!user.verified) {
            user.verified = true;
            if (user.referredBy) {
              const refUser = await getUser(user.referredBy);
              refUser.balance += REFERRAL_BONUS;
              refUser.referrals += 1;
              await saveUser(refUser);
            }
            await saveUser(user);
          }
          await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Verified!' });
          await tg('sendMessage', {
            chat_id: chatId,
            text: '✅ ভেরিফিকেশন সফল হয়েছে!\nমেনু থেকে বেছে নিন 👇',
            reply_markup: mainKeyboard(),
          });
        } else {
          await tg('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: '❌ আপনি এখনো সব চ্যানেলে জয়েন করেননি!',
            show_alert: true,
          });
        }
      } else if (data === 'balance') {
        await tg('answerCallbackQuery', { callback_query_id: cq.id });
        await tg('sendMessage', {
          chat_id: chatId,
          text: `💰 আপনার ব্যালেন্স: ${user.balance.toFixed(2)} টাকা\n👥 রেফার করেছেন: ${user.referrals} জন`,
        });
      } else if (data === 'refer') {
        await tg('answerCallbackQuery', { callback_query_id: cq.id });
        const link = `https://t.me/${BOT_USERNAME}?start=${userId}`;
        await tg('sendMessage', {
          chat_id: chatId,
          text: `👥 আপনার রেফার লিংক:\n${link}\n\nনতুন ইউজার এই লিংক দিয়ে জয়েন করে ভেরিফাই করলেই আপনি পাবেন ${REFERRAL_BONUS} টাকা।`,
        });
      } else if (data === 'work') {
        await tg('answerCallbackQuery', { callback_query_id: cq.id });
        const now = Math.floor(Date.now() / 1000);
        const remaining = user.lastWork + WORK_COOLDOWN_SECONDS - now;
        if (remaining > 0) {
          const mins = Math.ceil(remaining / 60);
          await tg('sendMessage', {
            chat_id: chatId,
            text: `⏳ আবার কাজ করতে আরও প্রায় ${mins} মিনিট অপেক্ষা করুন।`,
          });
        } else {
          user.balance += WORK_REWARD;
          user.lastWork = now;
          await saveUser(user);
          await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ কাজ সম্পন্ন হয়েছে! আপনি পেয়েছেন ${WORK_REWARD} টাকা।\nনতুন ব্যালেন্স: ${user.balance.toFixed(2)} টাকা`,
          });
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ ok: true });
  }
};
