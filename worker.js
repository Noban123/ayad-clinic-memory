const CLINIC_INFO = {
projectName: 'Ayad Clinic AI',
clinicName: 'Ayad Clinic',
doctorName: 'د. محمد عياد',
doctorTitle: 'استشاري الجراحة العامة والأورام',
assistantName: 'Ayad Clinic Assistant',

specialties: [
'الجراحة العامة',
'جراحات الجهاز الهضمي',
'جراحات وأورام الثدي',
'جراحات الغدة الدرقية',
'جراحات الأورام',
'جراحات البواسير والشرخ الشرجي',
'علاج الناسور',
'استئصال الأكياس الدهنية',
'استئصال الزوائد الجلدية',
'خياطة الجروح',
'الغيارات الجراحية',
'متابعة ما بعد العمليات',
'جميع إجراءات الجراحة العامة',
],

prices: {
firstVisit: 350,
followUpVisit: 250,
dressing: 300, // الغيار
currency: 'جنيه',
},

address: 'شارع الجمهورية قبل كوبري البحر',
mapUrl: 'https://maps.app.goo.gl/XSHmRrExWhqe4Hwj6',
};

// أسماء جداول قاعدة البيانات
const TABLES = {
MESSAGES: 'messages',
BOOKINGS: 'bookings',
CONVERSATIONS: 'conversation_state',
};

// حالات الحجز
const BOOKING_STATUS = {
COLLECTING: 'collecting_info', // جاري جمع البيانات
AWAITING_PAYMENT: 'awaiting_payment', // بانتظار التحويل
AWAITING_RECEIPT: 'awaiting_receipt', // بانتظار صورة الإيصال
PENDING_REVIEW: 'pending_review', // بانتظار مراجعة السكرتيرة
CONFIRMED: 'confirmed', // تم التأكيد يدويًا
CANCELLED: 'cancelled',
};

const MAX_HISTORY_MESSAGES = 12; // عدد الرسائل السابقة التي تُرسل للنموذج كسياق

// ============================================================================
// 2) نقطة الدخول الرئيسية (Fetch Handler)
// ============================================================================

export default {
async fetch(request, env, ctx) {
try {
const url = new URL(request.url);
const path = url.pathname;

// تأكد من وجود الجداول قبل أي شيء (لا يوقف الطلب لو فشل - يُسجَّل فقط)  
  ctx.waitUntil(ensureDatabaseSchema(env).catch((err) => {  
    logError('ensureDatabaseSchema (background)', err);  
  }));  

  // ---------------- Facebook Webhook ----------------  
  if (path === '/webhook/facebook' || path === '/webhook') {  
    if (request.method === 'GET') {  
      return handleFacebookVerification(request, env);  
    }  
    if (request.method === 'POST') {  
      return await handleFacebookWebhook(request, env, ctx);  
    }  
  }  

  // ---------------- WhatsApp Webhook ----------------  
  if (path === '/webhook/whatsapp') {  
    if (request.method === 'GET') {  
      return handleWhatsAppVerification(request, env);  
    }  
    if (request.method === 'POST') {  
      return await handleWhatsAppWebhook(request, env, ctx);  
    }  
  }  

  // ---------------- Health Check ----------------  
  if (path === '/health' || path === '/') {  
    return jsonResponse({  
      status: 'ok',  
      project: CLINIC_INFO.projectName,  
      clinic: CLINIC_INFO.clinicName,  
      time: new Date().toISOString(),  
    });  
  }  

  return new Response('Not Found', { status: 404 });  
} catch (err) {  
  // شبكة أمان نهائية: لا يجب أن ينهار الـ Worker مهما حدث  
  logError('Top-level fetch handler', err);  
  return jsonResponse({ status: 'error', message: 'Internal error handled gracefully' }, 200);  
}

},
};

// ============================================================================
// 3) التحقق من Webhooks (Verification Handlers)
// ============================================================================

/**

التحقق من Facebook Webhook (GET request عند إعداد الـ Webhook في Meta Developer)
*/
function handleFacebookVerification(request, env) {
const url = new URL(request.url);
const mode = url.searchParams.get('hub.mode');
const token = url.searchParams.get('hub.verify_token');
const challenge = url.searchParams.get('hub.challenge');


if (mode === 'subscribe' && token === env.FB_VERIFY_TOKEN) {
return new Response(challenge, { status: 200 });
}
return new Response('Verification failed', { status: 403 });
}

/**

التحقق من WhatsApp Webhook (GET request)
*/
function handleWhatsAppVerification(request, env) {
const url = new URL(request.url);
const mode = url.searchParams.get('hub.mode');
const token = url.searchParams.get('hub.verify_token');
const challenge = url.searchParams.get('hub.challenge');


if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
return new Response(challenge, { status: 200 });
}
return new Response('Verification failed', { status: 403 });
}

// ============================================================================
// 4) معالجة Facebook Webhook (Messenger + Comments)
// ============================================================================

async function handleFacebookWebhook(request, env, ctx) {
let body;
try {
body = await request.json();
} catch (err) {
logError('handleFacebookWebhook: JSON parse', err);
return jsonResponse({ status: 'ignored' }, 200);
}

try {
if (body.object !== 'page') {
return jsonResponse({ status: 'ignored' }, 200);
}

const entries = Array.isArray(body.entry) ? body.entry : [];  

for (const entry of entries) {  
  // -------- Messenger Messages --------  
  const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];  
  for (const event of messagingEvents) {  
    ctx.waitUntil(  
      processMessengerEvent(event, env).catch((err) =>  
        logError('processMessengerEvent', err)  
      )  
    );  
  }  

  // -------- Page Feed Changes (Comments) --------  
  const changes = Array.isArray(entry.changes) ? entry.changes : [];  
  for (const change of changes) {  
    if (change.field === 'feed') {  
      ctx.waitUntil(  
        processFacebookCommentEvent(change.value, env).catch((err) =>  
          logError('processFacebookCommentEvent', err)  
        )  
      );  
    }  
  }  
}  

// يجب الرد بسرعة على فيسبوك لتفادي إعادة الإرسال  
return jsonResponse({ status: 'received' }, 200);

} catch (err) {
logError('handleFacebookWebhook', err);
return jsonResponse({ status: 'error_handled' }, 200);
}
}

/**

معالجة حدث رسالة Messenger واحدة (خاصة)
*/
async function processMessengerEvent(event, env) {
try {
const senderId = event?.sender?.id;
if (!senderId) return;

// تجاهل رسائل تأكيد التسليم/القراءة أو echoes
if (event.delivery || event.read || event.message?.is_echo) return;

const messageObj = event.message;
const postbackObj = event.postback;

let userText = '';
let imageUrl = null;

if (messageObj) {
if (messageObj.text) {
userText = messageObj.text.trim();
}
if (Array.isArray(messageObj.attachments)) {
const imageAttachment = messageObj.attachments.find(
(att) => att.type === 'image'
);
if (imageAttachment?.payload?.url) {
imageUrl = imageAttachment.payload.url;
}
}
} else if (postbackObj) {
userText = postbackObj.title || postbackObj.payload || 'بدء المحادثة';
}

if (!userText && !imageUrl) return;

await handleIncomingUserMessage({
env,
channel: 'messenger',
externalUserId: senderId,
text: userText,
imageUrl,
sendReply: async (replyText) => {
await sendFacebookMessage(senderId, replyText, env);
},
});
} catch (err) {
logError('processMessengerEvent (inner)', err);
}
}


/**

معالجة تعليق عام على منشور فيسبوك

القاعدة: لا يطلب رقم هاتف ولا بيانات شخصية، فقط يدعو للتواصل عبر الرسائل الخاصة
*/
async function processFacebookCommentEvent(value, env) {
try {
if (!value || value.item !== 'comment') return;
// تجاهل التعليقات التي كتبتها الصفحة نفسها (لتفادي حلقة لا نهائية)
if (value.verb !== 'add') return;
if (!value.comment_id || !value.from?.id) return;
if (env.FB_PAGE_ID && value.from.id === env.FB_PAGE_ID) return;

const commentText = value.message || '';

// نتحقق أولًا: هل التعليق موجّه فعلًا لطلب حجز/استفسار طبي أم مجرد تفاعل عام؟
// في الحالتين، الرد نفسه: أسلوب راقٍ، بدون طلب بيانات، دعوة للرسائل الخاصة.
const replyText = await generateCommentReply(commentText, env);

await replyToFacebookComment(value.comment_id, replyText, env);

// حفظ في قاعدة البيانات كسجل تفاعل (بدون بيانات شخصية حساسة)
await saveMessageSafe(env, {
channel: 'facebook_comment',
externalUserId: value.from.id,
direction: 'inbound',
content: commentText,
});
await saveMessageSafe(env, {
channel: 'facebook_comment',
externalUserId: value.from.id,
direction: 'outbound',
content: replyText,
});
} catch (err) {
logError('processFacebookCommentEvent (inner)', err);
}
}


/**

توليد رد راقٍ على تعليق عام في فيسبوك (بدون طلب أي بيانات شخصية)
*/
async function generateCommentReply(commentText, env) {
const fallback = شكرًا لتواصلكم مع ${CLINIC_INFO.clinicName} 🌿\nيسعدنا تواصلكم معنا عبر الرسائل الخاصة (Messenger) لمساعدتكم بكل التفاصيل التي تحتاجونها.;


const systemPrompt = buildCommentSystemPrompt();

const aiReply = await callOpenAI({
env,
systemPrompt,
messages: [{ role: 'user', content: commentText || 'تعليق عام على المنشور' }],
maxTokens: 200,
});

return aiReply || fallback;
}

// ============================================================================
// 5) معالجة WhatsApp Webhook
// ============================================================================

async function handleWhatsAppWebhook(request, env, ctx) {
let body;
try {
body = await request.json();
} catch (err) {
logError('handleWhatsAppWebhook: JSON parse', err);
return jsonResponse({ status: 'ignored' }, 200);
}

try {
const entries = Array.isArray(body.entry) ? body.entry : [];

for (const entry of entries) {  
  const changes = Array.isArray(entry.changes) ? entry.changes : [];  
  for (const change of changes) {  
    const value = change.value;  
    if (!value) continue;  

    const messages = Array.isArray(value.messages) ? value.messages : [];  
    for (const message of messages) {  
      ctx.waitUntil(  
        processWhatsAppMessage(message, value, env).catch((err) =>  
          logError('processWhatsAppMessage', err)  
        )  
      );  
    }  
    // نتجاهل statuses (delivered/read) عمدًا  
  }  
}  

return jsonResponse({ status: 'received' }, 200);

} catch (err) {
logError('handleWhatsAppWebhook', err);
return jsonResponse({ status: 'error_handled' }, 200);
}
}

/**

معالجة رسالة واتساب واحدة
*/
async function processWhatsAppMessage(message, value, env) {
try {
const from = message.from; // رقم الهاتف كمعرّف
if (!from) return;

let userText = '';
let imageUrl = null;

if (message.type === 'text' && message.text?.body) {
userText = message.text.body.trim();
} else if (message.type === 'image' && message.image?.id) {
// نحتاج جلب رابط الصورة من WhatsApp Media API
imageUrl = await fetchWhatsAppMediaUrl(message.image.id, env);
userText = message.image.caption || '';
} else if (message.type === 'button' && message.button?.text) {
userText = message.button.text;
} else if (message.type === 'interactive') {
userText =
message.interactive?.button_reply?.title ||
message.interactive?.list_reply?.title ||
'';
}

if (!userText && !imageUrl) return;

await handleIncomingUserMessage({
env,
channel: 'whatsapp',
externalUserId: from,
text: userText,
imageUrl,
sendReply: async (replyText) => {
await sendWhatsAppMessage(from, replyText, env);
},
});
} catch (err) {
logError('processWhatsAppMessage (inner)', err);
}
}


/**

جلب رابط الوسائط (الصورة) من WhatsApp Cloud API باستخدام media_id
*/
async function fetchWhatsAppMediaUrl(mediaId, env) {
try {
if (!env.WHATSAPP_TOKEN) return null;

const metaRes = await fetch(https://graph.facebook.com/v19.0/${mediaId}, {
headers: { Authorization: Bearer ${env.WHATSAPP_TOKEN} },
});

if (!metaRes.ok) {
logError('fetchWhatsAppMediaUrl: metadata request failed', new Error(await safeText(metaRes)));
return null;
}

const metaData = await metaRes.json();
return metaData?.url || null;
} catch (err) {
logError('fetchWhatsAppMediaUrl', err);
return null;
}
}


// ============================================================================
// 6) المنطق المركزي: معالجة رسالة واردة من أي قناة (Messenger / WhatsApp)
// ============================================================================

/**

دالة موحّدة تستقبل رسالة من أي قناة (Messenger خاص أو WhatsApp)

وتدير: الحفظ، حالة المحادثة، منطق الحجز، والرد عبر OpenAI.
*/
async function handleIncomingUserMessage({ env, channel, externalUserId, text, imageUrl, sendReply }) {
try {
// 1) حفظ الرسالة الواردة
await saveMessageSafe(env, {
channel,
externalUserId,
direction: 'inbound',
content: text || (imageUrl ? '[صورة مرسلة]' : ''),
imageUrl,
});

// 2) جلب حالة المحادثة الحالية (إن وجدت)
const conversation = await getConversationStateSafe(env, channel, externalUserId);

// 3) إذا وصلت صورة أثناء انتظار إيصال التحويل -> معالجة خاصة
if (imageUrl && conversation && conversation.status === BOOKING_STATUS.AWAITING_RECEIPT) {
const confirmationText =
'شكرًا لحضرتكم، تم استلام صورة إيصال التحويل، وسيتم مراجعتها من قبل فريق الاستقبال، وسيتم التواصل معكم لتأكيد الحجز في أقرب وقت.';

await updateBookingStatusSafe(env, conversation.booking_id, BOOKING_STATUS.PENDING_REVIEW, {
receiptImageUrl: imageUrl,
});

await updateConversationStateSafe(env, channel, externalUserId, {
status: BOOKING_STATUS.PENDING_REVIEW,
bookingId: conversation.booking_id,
collectedData: conversation.collected_data,
});

await sendReply(confirmationText);

await saveMessageSafe(env, {
channel,
externalUserId,
direction: 'outbound',
content: confirmationText,
});
return;
}

// 4) جلب سياق المحادثة (آخر رسائل) لإرساله للنموذج
const history = await getRecentMessagesSafe(env, channel, externalUserId, MAX_HISTORY_MESSAGES);

// 5) بناء الـ System Prompt المتكامل (شخصية + تعليمات طبية + نظام حجز)
const systemPrompt = buildMainSystemPrompt(conversation);

// 6) تجهيز رسائل المحادثة لإرسالها إلى OpenAI
const chatMessages = buildChatMessagesFromHistory(history, text, imageUrl);

// 7) استدعاء OpenAI مع أدوات (Function Calling) لاستخراج بيانات الحجز إن وُجدت
const aiResult = await callOpenAIWithBookingTools({
env,
systemPrompt,
messages: chatMessages,
});

let replyText = aiResult.replyText;
const extractedBooking = aiResult.bookingData; // قد تكون null

// 8) إذا استخرج النموذج بيانات حجز (كاملة أو جزئية) -> نحدّث حالة المحادثة/الحجز
if (extractedBooking) {
await handleBookingProgress({
env,
channel,
externalUserId,
conversation,
extractedBooking,
});
}

// 9) في حال عدم وجود رد نصي من النموذج (فشل استدعاء)، استخدم رسالة احتياطية راقية
if (!replyText || !replyText.trim()) {
replyText =
'نعتذر عن أي تأخير، نحن هنا لخدمتكم. هل يمكن توضيح طلب حضرتكم أكثر حتى نساعدكم بأفضل شكل؟';
}

// 10) إرسال الرد للمستخدم
await sendReply(replyText);

// 11) حفظ الرد الصادر
await saveMessageSafe(env, {
channel,
externalUserId,
direction: 'outbound',
content: replyText,
});
} catch (err) {
logError('handleIncomingUserMessage', err);
// شبكة أمان: نحاول إرسال رد احتياطي راقٍ حتى لو حدث خطأ غير متوقع
try {
await sendReply(
'نعتذر عن هذا الإزعاج، نواجه ضغطًا مؤقتًا في الاستجابة. سيتم التواصل معكم من فريق الاستقبال في أقرب وقت ممكن. شكرًا لتفهمكم 🌿'
);
} catch (innerErr) {
logError('handleIncomingUserMessage: fallback reply failed', innerErr);
}
}
}


/**

إدارة تقدّم عملية الحجز بناءً على البيانات المستخرجة من رسالة المستخدم
*/
async function handleBookingProgress({ env, channel, externalUserId, conversation, extractedBooking }) {
try {
// دمج البيانات المستخرجة الجديدة مع أي بيانات سابقة محفوظة
const previousData = conversation?.collected_data
? safeJsonParse(conversation.collected_data, {})
: {};

const mergedData = {
fullName: extractedBooking.fullName || previousData.fullName || null,
phoneNumber: extractedBooking.phoneNumber || previousData.phoneNumber || null,
visitReason: extractedBooking.visitReason || previousData.visitReason || null,
preferredTime: extractedBooking.preferredTime || previousData.preferredTime || null,
};

const isComplete =
mergedData.fullName && mergedData.phoneNumber && mergedData.visitReason && mergedData.preferredTime;

let bookingId = conversation?.booking_id || null;

if (!bookingId) {
bookingId = await createBookingSafe(env, {
channel,
externalUserId,
fullName: mergedData.fullName,
phoneNumber: mergedData.phoneNumber,
visitReason: mergedData.visitReason,
preferredTime: mergedData.preferredTime,
status: isComplete ? BOOKING_STATUS.AWAITING_PAYMENT : BOOKING_STATUS.COLLECTING,
});
} else {
await updateBookingDataSafe(env, bookingId, {
...mergedData,
status: isComplete ? BOOKING_STATUS.AWAITING_PAYMENT : BOOKING_STATUS.COLLECTING,
});
}

await updateConversationStateSafe(env, channel, externalUserId, {
status: isComplete ? BOOKING_STATUS.AWAITING_PAYMENT : BOOKING_STATUS.COLLECTING,
bookingId,
collectedData: JSON.stringify(mergedData),
});
} catch (err) {
logError('handleBookingProgress', err);
}
}


// ============================================================================
// 7) بناء الـ System Prompts (شخصية المساعد + السياسات)
// ============================================================================

function buildMainSystemPrompt(conversation) {
const specialtiesList = CLINIC_INFO.specialties.map((s) => - ${s}).join('\n');

const bookingStatusNote = conversation?.status
? \n\nملاحظة داخلية (لا تُذكر للمريض حرفيًا): حالة الحجز الحالية للمحادثة هي "${conversation.status}". استخدم هذا لفهم أين توقفت المحادثة ولا تكرر أسئلة تمت الإجابة عليها بالفعل.
: '';

return `أنت "${CLINIC_INFO.assistantName}"، المساعد الرقمي لقسم الاستقبال وخدمة العملاء في "${CLINIC_INFO.clinicName}"، عيادة ${CLINIC_INFO.doctorName} - ${CLINIC_INFO.doctorTitle}.

شخصيتك وأسلوبك

تتحدث بأسلوب راقٍ جدًا واحترافي، كأنك موظف استقبال متمرس في مركز طبي خاص فاخر.

لا تستخدم أبدًا أسلوب الروبوتات أو الردود الجاهزة والمكررة الجافة.

ترحّب بالمريض بطريقة دافئة واحترافية في بداية التواصل.

تهتم براحة المريض ومشاعره، وتُظهر تفهمًا وأدبًا راقيًا في كل رد.

ردودك مختصرة، واضحة، ومباشرة - بدون إطالة غير ضرورية، لكن دون أن تبدو جافة أو مقتضبة بشكل غير لائق.

تستخدم اللغة العربية الفصحى الميسّرة (أو تجاري لهجة المريض إن كتب بالعامية، لكن بأسلوب راقٍ دائمًا).


معلومات العيادة

اسم العيادة: ${CLINIC_INFO.clinicName}
الطبيب: ${CLINIC_INFO.doctorName} - ${CLINIC_INFO.doctorTitle}

التخصصات:

${specialtiesList}

الأسعار:

الكشف لأول مرة: ${CLINIC_INFO.prices.firstVisit} ${CLINIC_INFO.prices.currency}

إعادة الكشف: ${CLINIC_INFO.prices.followUpVisit} ${CLINIC_INFO.prices.currency}

الغيار: ${CLINIC_INFO.prices.dressing} ${CLINIC_INFO.prices.currency}


عنوان العيادة:

${CLINIC_INFO.address}
رابط الموقع على الخريطة: ${CLINIC_INFO.mapUrl}

قواعد طبية صارمة (يُمنع مخالفتها إطلاقًا)

لا تشخّص أي حالة مرضية مهما بدت واضحة أو بسيطة.

لا تصف أي دواء أو علاج تحت أي ظرف.

لا تحدد أي جرعة دوائية إطلاقًا.

إذا سأل المريض عن أعراض أو طلب تقييمًا طبيًا أو استشارة، وجّهه بلطف لحجز موعد مع ${CLINIC_INFO.doctorName} حتى يتم تقييمه بشكل صحيح ومباشر، ووضّح أن هذا للحفاظ على سلامته وحصوله على تقييم دقيق.


نظام الحجز

عندما يطلب المريض حجز موعد، اجمع منه بأسلوب راقٍ وطبيعي (سؤال أو سؤالين في كل رد، وليس استجوابًا دفعة واحدة) البيانات التالية:

1. الاسم بالكامل.


2. رقم الهاتف.


3. سبب الزيارة.


4. الموعد المناسب له.



بعد اكتمال هذه البيانات الأربعة، اطلب من المريض تحويل قيمة الكشف (${CLINIC_INFO.prices.firstVisit} ${CLINIC_INFO.prices.currency}) بأسلوب لبق ومحترم، ثم اطلب منه إرسال صورة إيصال التحويل لإتمام الحجز.

بعد استلام صورة الإيصال، سيتم إرسال رسالة تأكيد استلام تلقائيًا من النظام (لا تكتبها أنت بنفسك في ردودك النصية العادية، فالنظام يتولى ذلك).

قواعد مهمة جدًا حول الحجز:

لا تؤكد الحجز نهائيًا بنفسك أبدًا تحت أي ظرف. التأكيد النهائي مسؤولية فريق الاستقبال فقط بعد المراجعة.

لا تعتبر صورة التحويل دليلًا نهائيًا كافيًا لتأكيد الحجز.

دائمًا وضّح للمريض (بأسلوب لطيف) أن الحجز سيُراجَع من فريق الاستقبال وسيتم التواصل معه للتأكيد النهائي.


ملاحظة حول استخراج بيانات الحجز

عندما يزوّدك المريض بأي من بيانات الحجز (الاسم، رقم الهاتف، سبب الزيارة، الموعد المفضل) ضمن رسالته، يجب عليك استدعاء الأداة (function) المخصصة لتسجيل بيانات الحجز بالبيانات التي حصلت عليها فقط (حتى لو كانت جزئية)، بالإضافة إلى كتابة ردك النصي الطبيعي للمريض كالمعتاد.${bookingStatusNote}

تذكّر دائمًا: أنت واجهة العيادة الأولى للمريض، فكن انعكاسًا للرقي والاحترافية والاهتمام الحقيقي في كل كلمة.`;
}

function buildCommentSystemPrompt() {
return `أنت "${CLINIC_INFO.assistantName}"، المساعد الرقمي لصفحة "${CLINIC_INFO.clinicName}" على فيسبوك، عيادة ${CLINIC_INFO.doctorName} - ${CLINIC_INFO.doctorTitle}.

مهمتك الآن: الرد على تعليق عام كتبه شخص أسفل منشور على صفحة العيادة.

قواعد صارمة لهذا السياق تحديدًا

هذا تعليق عام يراه الجميع، وليس رسالة خاصة.

لا تطلب إطلاقًا رقم الهاتف أو أي بيانات شخصية (اسم كامل، عنوان، تفاصيل حالة صحية).

لا تجمع أي بيانات حجز هنا نهائيًا.

لا تشخّص أي حالة ولا تقدّم أي معلومة طبية تفصيلية في الرد العام.

ردّك يجب أن يكون راقيًا، مختصرًا، ودافئًا، ويدعو صاحب التعليق للتواصل معنا عبر الرسائل الخاصة (Messenger) لمتابعة استفساره أو طلب الحجز بخصوصية وراحة أكبر.

لا أسلوب روبوتي، ولا صيغ مكررة جامدة.


اكتب ردًا واحدًا فقط بأسلوب موظف استقبال محترف في مركز طبي فاخر.`;
}

// ============================================================================
// 8) تكامل OpenAI (Chat Completions + Function Calling)
// ============================================================================

/**

استدعاء بسيط لـ OpenAI بدون أدوات (تُستخدم للردود على التعليقات العامة مثلاً)

لا تُلقي استثناءً أبدًا - تُعيد null عند الفشل ليتم استخدام رد احتياطي.
*/
async function callOpenAI({ env, systemPrompt, messages, maxTokens = 400 }) {
try {
if (!env.OPENAI_API_KEY) {
logError('callOpenAI', new Error('OPENAI_API_KEY is not configured'));
return null;
}

const payload = {
model: env.OPENAI_MODEL || 'gpt-4o-mini',
messages: [{ role: 'system', content: systemPrompt }, ...messages],
max_tokens: maxTokens,
temperature: 0.6,
};

const response = await fetchWithTimeout(
'https://api.openai.com/v1/chat/completions',
{
method: 'POST',
headers: {
'Content-Type': 'application/json',
Authorization: Bearer ${env.OPENAI_API_KEY},
},
body: JSON.stringify(payload),
},
20000
);

if (!response.ok) {
const errText = await safeText(response);
logError('callOpenAI: non-OK response', new Error(Status ${response.status}: ${errText}));
return null;
}

const data = await response.json();
const content = data?.choices?.[0]?.message?.content;
return content ? content.trim() : null;
} catch (err) {
logError('callOpenAI', err);
return null;
}
}


/**

استدعاء OpenAI مع Function Calling لاستخراج بيانات الحجز تلقائيًا من رسالة المريض،

مع الحصول على الرد النصي الطبيعي في نفس الوقت.

لا تُلقي استثناءً أبدًا - تُعيد كائنًا بقيم افتراضية آمنة عند الفشل.
*/
async function callOpenAIWithBookingTools({ env, systemPrompt, messages }) {
const safeDefault = { replyText: null, bookingData: null };


try {
if (!env.OPENAI_API_KEY) {
logError('callOpenAIWithBookingTools', new Error('OPENAI_API_KEY is not configured'));
return safeDefault;
}

const tools = [  
  {  
    type: 'function',  
    function: {  
      name: 'record_booking_info',  
      description:  
        'تسجيل أي بيانات حجز يقدمها المريض ضمن رسالته (الاسم، رقم الهاتف، سبب الزيارة، الموعد المفضل). استدعِ هذه الدالة فقط إذا ذكر المريض فعليًا واحدة أو أكثر من هذه البيانات في رسالته الحالية.',  
      parameters: {  
        type: 'object',  
        properties: {  
          fullName: { type: 'string', description: 'اسم المريض بالكامل، إن ذُكر' },  
          phoneNumber: { type: 'string', description: 'رقم هاتف المريض، إن ذُكر' },  
          visitReason: { type: 'string', description: 'سبب الزيارة أو الحالة التي يريد مراجعتها، إن ذُكر' },  
          preferredTime: { type: 'string', description: 'الموعد أو اليوم/الوقت المفضل للمريض، إن ذُكر' },  
        },  
        required: [],  
      },  
    },  
  },  
];  

const payload = {  
  model: env.OPENAI_MODEL || 'gpt-4o-mini',  
  messages: [{ role: 'system', content: systemPrompt }, ...messages],  
  tools,  
  tool_choice: 'auto',  
  max_tokens: 500,  
  temperature: 0.6,  
};  

const response = await fetchWithTimeout(  
  'https://api.openai.com/v1/chat/completions',  
  {  
    method: 'POST',  
    headers: {  
      'Content-Type': 'application/json',  
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,  
    },  
    body: JSON.stringify(payload),  
  },  
  25000  
);  

if (!response.ok) {  
  const errText = await safeText(response);  
  logError('callOpenAIWithBookingTools: non-OK response', new Error(`Status ${response.status}: ${errText}`));  
  return safeDefault;  
}  

const data = await response.json();  
const choice = data?.choices?.[0];  
const messageObj = choice?.message;  

let bookingData = null;  
const toolCalls = messageObj?.tool_calls;  

if (Array.isArray(toolCalls) && toolCalls.length > 0) {  
  const bookingCall = toolCalls.find((tc) => tc.function?.name === 'record_booking_info');  
  if (bookingCall) {  
    try {  
      const args = JSON.parse(bookingCall.function.arguments || '{}');  
      bookingData = sanitizeExtractedBookingData(args);  
    } catch (parseErr) {  
      logError('callOpenAIWithBookingTools: tool_calls JSON parse', parseErr);  
    }  
  }  
}  

let replyText = messageObj?.content ? messageObj.content.trim() : null;  

// في حال استدعى النموذج الأداة فقط بدون نص رد (سلوك نادر)، نطلب رد نصي متابع بسيط  
if (!replyText && bookingData) {  
  replyText = await callOpenAI({  
    env,  
    systemPrompt,  
    messages: [  
      ...messages,  
      {  
        role: 'assistant',  
        content: 'تم تسجيل البيانات المذكورة داخليًا.',  
      },  
      {  
        role: 'user',  
        content: 'تابع الرد الطبيعي للمريض بأسلوبك المعتاد بناءً على ما ذكرته.',  
      },  
    ],  
    maxTokens: 300,  
  });  
}  

return { replyText, bookingData };

} catch (err) {
logError('callOpenAIWithBookingTools', err);
return safeDefault;
}
}

/**

تنظيف والتحقق من صحة البيانات المستخرجة من OpenAI قبل استخدامها
*/
function sanitizeExtractedBookingData(rawArgs) {
if (!rawArgs || typeof rawArgs !== 'object') return null;


const fullName = typeof rawArgs.fullName === 'string' ? rawArgs.fullName.trim() : null;
const phoneNumberRaw = typeof rawArgs.phoneNumber === 'string' ? rawArgs.phoneNumber.trim() : null;
const visitReason = typeof rawArgs.visitReason === 'string' ? rawArgs.visitReason.trim() : null;
const preferredTime = typeof rawArgs.preferredTime === 'string' ? rawArgs.preferredTime.trim() : null;

const phoneNumber = phoneNumberRaw ? normalizePhoneNumber(phoneNumberRaw) : null;

const hasAnyValue = fullName || phoneNumber || visitReason || preferredTime;
if (!hasAnyValue) return null;

return {
fullName: fullName || null,
phoneNumber: phoneNumber || null,
visitReason: visitReason || null,
preferredTime: preferredTime || null,
};
}

/**

تنظيف بسيط لرقم الهاتف (إزالة مسافات وأحرف غير رقمية عدا + في البداية)
*/
function normalizePhoneNumber(phone) {
const trimmed = phone.trim();
const hasPlus = trimmed.startsWith('+');
const digitsOnly = trimmed.replace(/[^\d]/g, '');
if (!digitsOnly) return null;
return hasPlus ? +${digitsOnly} : digitsOnly;
}


/**

بناء مصفوفة الرسائل (history + الرسالة الحالية) بالصيغة التي يتوقعها OpenAI
*/
function buildChatMessagesFromHistory(history, currentText, imageUrl) {
const messages = [];


if (Array.isArray(history)) {
// history تأتي مرتّبة تنازليًا (الأحدث أولًا) من قاعدة البيانات، لذا نعكسها
const chronological = [...history].reverse();
for (const row of chronological) {
const role = row.direction === 'outbound' ? 'assistant' : 'user';
if (row.content) {
messages.push({ role, content: row.content });
}
}
}

let currentContent = currentText || '';
if (imageUrl) {
currentContent = currentContent
? ${currentContent}\n[أرفق المريض صورة]
: '[أرسل المريض صورة]';
}

if (currentContent) {
messages.push({ role: 'user', content: currentContent });
}

return messages;
}

// ============================================================================
// 9) إرسال الرسائل عبر Facebook Graph API
// ============================================================================

async function sendFacebookMessage(recipientId, text, env) {
try {
if (!env.FB_PAGE_ACCESS_TOKEN) {
logError('sendFacebookMessage', new Error('FB_PAGE_ACCESS_TOKEN is not configured'));
return;
}

const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(  
  env.FB_PAGE_ACCESS_TOKEN  
)}`;  

const payload = {  
  recipient: { id: recipientId },  
  message: { text: truncateText(text, 2000) },  
  messaging_type: 'RESPONSE',  
};  

const response = await fetchWithTimeout(  
  url,  
  {  
    method: 'POST',  
    headers: { 'Content-Type': 'application/json' },  
    body: JSON.stringify(payload),  
  },  
  15000  
);  

if (!response.ok) {  
  const errText = await safeText(response);  
  logError('sendFacebookMessage: non-OK response', new Error(`Status ${response.status}: ${errText}`));  
}

} catch (err) {
logError('sendFacebookMessage', err);
}
}

async function replyToFacebookComment(commentId, message, env) {
try {
if (!env.FB_PAGE_ACCESS_TOKEN) {
logError('replyToFacebookComment', new Error('FB_PAGE_ACCESS_TOKEN is not configured'));
return;
}

const url = `https://graph.facebook.com/v19.0/${commentId}/comments?access_token=${encodeURIComponent(  
  env.FB_PAGE_ACCESS_TOKEN  
)}`;  

const response = await fetchWithTimeout(  
  url,  
  {  
    method: 'POST',  
    headers: { 'Content-Type': 'application/json' },  
    body: JSON.stringify({ message: truncateText(message, 800) }),  
  },  
  15000  
);  

if (!response.ok) {  
  const errText = await safeText(response);  
  logError('replyToFacebookComment: non-OK response', new Error(`Status ${response.status}: ${errText}`));  
}

} catch (err) {
logError('replyToFacebookComment', err);
}
}

// ============================================================================
// 10) إرسال الرسائل عبر WhatsApp Business Cloud API
// ============================================================================

async function sendWhatsAppMessage(toPhoneNumber, text, env) {
try {
if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
logError(
'sendWhatsAppMessage',
new Error('WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured')
);
return;
}

const url = `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;  

const payload = {  
  messaging_product: 'whatsapp',  
  to: toPhoneNumber,  
  type: 'text',  
  text: { body: truncateText(text, 4000) },  
};  

const response = await fetchWithTimeout(  
  url,  
  {  
    method: 'POST',  
    headers: {  
      'Content-Type': 'application/json',  
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,  
    },  
    body: JSON.stringify(payload),  
  },  
  15000  
);  

if (!response.ok) {  
  const errText = await safeText(response);  
  logError('sendWhatsAppMessage: non-OK response', new Error(`Status ${response.status}: ${errText}`));  
}

} catch (err) {
logError('sendWhatsAppMessage', err);
}
}

// ============================================================================
// 11) طبقة قاعدة البيانات D1 (Schema + CRUD) — كل الدوال آمنة ولا تُلقي استثناءً للخارج
// ============================================================================

let schemaEnsured = false; // لتفادي تنفيذ CREATE TABLE في كل طلب داخل نفس الـ isolate

/**

إنشاء الجداول المطلوبة تلقائيًا إذا لم تكن موجودة
*/
async function ensureDatabaseSchema(env) {
if (schemaEnsured) return;
if (!env.DB) {
logError('ensureDatabaseSchema', new Error('env.DB is not configured'));
return;
}


try {
await env.DB.batch([
env.DB.prepare(  CREATE TABLE IF NOT EXISTS ${TABLES.MESSAGES} (   id INTEGER PRIMARY KEY AUTOINCREMENT,   channel TEXT NOT NULL,   external_user_id TEXT NOT NULL,   direction TEXT NOT NULL,   content TEXT,   image_url TEXT,   created_at TEXT NOT NULL DEFAULT (datetime('now'))   )  ),
env.DB.prepare(  CREATE TABLE IF NOT EXISTS ${TABLES.BOOKINGS} (   id INTEGER PRIMARY KEY AUTOINCREMENT,   channel TEXT NOT NULL,   external_user_id TEXT NOT NULL,   full_name TEXT,   phone_number TEXT,   visit_reason TEXT,   preferred_time TEXT,   status TEXT NOT NULL DEFAULT '${BOOKING_STATUS.COLLECTING}',   receipt_image_url TEXT,   created_at TEXT NOT NULL DEFAULT (datetime('now')),   updated_at TEXT NOT NULL DEFAULT (datetime('now'))   )  ),
env.DB.prepare(  CREATE TABLE IF NOT EXISTS ${TABLES.CONVERSATIONS} (   channel TEXT NOT NULL,   external_user_id TEXT NOT NULL,   status TEXT,   booking_id INTEGER,   collected_data TEXT,   updated_at TEXT NOT NULL DEFAULT (datetime('now')),   PRIMARY KEY (channel, external_user_id)   )  ),
env.DB.prepare(
CREATE INDEX IF NOT EXISTS idx_messages_user ON ${TABLES.MESSAGES} (channel, external_user_id, created_at)
),
env.DB.prepare(
CREATE INDEX IF NOT EXISTS idx_bookings_user ON ${TABLES.BOOKINGS} (channel, external_user_id)
),
env.DB.prepare(
CREATE INDEX IF NOT EXISTS idx_bookings_status ON ${TABLES.BOOKINGS} (status)
),
]);

schemaEnsured = true;

} catch (err) {
logError('ensureDatabaseSchema', err);
// لا نرمي الخطأ للخارج - النظام يجب أن يستمر حتى لو فشل إنشاء الجداول (قد تكون موجودة أصلًا)
}
}

/**

حفظ رسالة في قاعدة البيانات (لا تُلقي استثناءً)
*/
async function saveMessageSafe(env, { channel, externalUserId, direction, content, imageUrl }) {
try {
if (!env.DB) {
logError('saveMessageSafe', new Error('env.DB is not configured'));
return;
}
await env.DB.prepare(
INSERT INTO ${TABLES.MESSAGES} (channel, external_user_id, direction, content, image_url) VALUES (?, ?, ?, ?, ?)
)
.bind(channel, externalUserId, direction, content || null, imageUrl || null)
.run();
} catch (err) {
logError('saveMessageSafe', err);
}
}


/**

جلب آخر N رسالة لمستخدم معيّن (الأحدث أولًا) — تُعيد مصفوفة فارغة عند الفشل
*/
async function getRecentMessagesSafe(env, channel, externalUserId, limit = MAX_HISTORY_MESSAGES) {
try {
if (!env.DB) {
logError('getRecentMessagesSafe', new Error('env.DB is not configured'));
return [];
}
const result = await env.DB.prepare(
SELECT direction, content, created_at FROM ${TABLES.MESSAGES}   WHERE channel = ? AND external_user_id = ?   ORDER BY id DESC   LIMIT ?
)
.bind(channel, externalUserId, limit)
.all();

return result?.results || [];
} catch (err) {
logError('getRecentMessagesSafe', err);
return [];
}
}


/**

جلب حالة المحادثة الحالية لمستخدم — تُعيد null عند عدم الوجود أو الفشل
*/
async function getConversationStateSafe(env, channel, externalUserId) {
try {
if (!env.DB) {
logError('getConversationStateSafe', new Error('env.DB is not configured'));
return null;
}
const result = await env.DB.prepare(
SELECT * FROM ${TABLES.CONVERSATIONS} WHERE channel = ? AND external_user_id = ?
)
.bind(channel, externalUserId)
.first();

return result || null;
} catch (err) {
logError('getConversationStateSafe', err);
return null;
}
}


/**

تحديث (أو إنشاء) حالة المحادثة لمستخدم معيّن
*/
async function updateConversationStateSafe(env, channel, externalUserId, { status, bookingId, collectedData }) {
try {
if (!env.DB) {
logError('updateConversationStateSafe', new Error('env.DB is not configured'));
return;
}
await env.DB.prepare(
INSERT INTO ${TABLES.CONVERSATIONS} (channel, external_user_id, status, booking_id, collected_data, updated_at)   VALUES (?, ?, ?, ?, ?, datetime('now'))   ON CONFLICT (channel, external_user_id)   DO UPDATE SET status = excluded.status, booking_id = excluded.booking_id,   collected_data = excluded.collected_data, updated_at = datetime('now')
)
.bind(channel, externalUserId, status || null, bookingId || null, collectedData || null)
.run();
} catch (err) {
logError('updateConversationStateSafe', err);
}
}


/**

إنشاء سجل حجز جديد — تُعيد id السجل الجديد أو null عند الفشل
*/
async function createBookingSafe(env, { channel, externalUserId, fullName, phoneNumber, visitReason, preferredTime, status }) {
try {
if (!env.DB) {
logError('createBookingSafe', new Error('env.DB is not configured'));
return null;
}
const result = await env.DB.prepare(
INSERT INTO ${TABLES.BOOKINGS}   (channel, external_user_id, full_name, phone_number, visit_reason, preferred_time, status, created_at, updated_at)   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
)
.bind(
channel,
externalUserId,
fullName || null,
phoneNumber || null,
visitReason || null,
preferredTime || null,
status || BOOKING_STATUS.COLLECTING
)
.run();

return result?.meta?.last_row_id || null;
} catch (err) {
logError('createBookingSafe', err);
return null;
}
}


/**

تحديث بيانات حجز موجود
*/
async function updateBookingDataSafe(env, bookingId, { fullName, phoneNumber, visitReason, preferredTime, status }) {
try {
if (!env.DB || !bookingId) {
if (!env.DB) logError('updateBookingDataSafe', new Error('env.DB is not configured'));
return;
}
await env.DB.prepare(
UPDATE ${TABLES.BOOKINGS}   SET full_name = ?, phone_number = ?, visit_reason = ?, preferred_time = ?, status = ?, updated_at = datetime('now')   WHERE id = ?
)
.bind(
fullName || null,
phoneNumber || null,
visitReason || null,
preferredTime || null,
status || BOOKING_STATUS.COLLECTING,
bookingId
)
.run();
} catch (err) {
logError('updateBookingDataSafe', err);
}
}


/**

تحديث حالة الحجز فقط (مع إمكانية إرفاق رابط صورة الإيصال)
*/
async function updateBookingStatusSafe(env, bookingId, status, { receiptImageUrl } = {}) {
try {
if (!env.DB || !bookingId) {
if (!env.DB) logError('updateBookingStatusSafe', new Error('env.DB is not configured'));
return;
}

if (receiptImageUrl) {
await env.DB.prepare(
UPDATE ${TABLES.BOOKINGS} SET status = ?, receipt_image_url = ?, updated_at = datetime('now') WHERE id = ?
)
.bind(status, receiptImageUrl, bookingId)
.run();
} else {
await env.DB.prepare(
UPDATE ${TABLES.BOOKINGS} SET status = ?, updated_at = datetime('now') WHERE id = ?
)
.bind(status, bookingId)
.run();
}
} catch (err) {
logError('updateBookingStatusSafe', err);
}
}


// ============================================================================
// 12) دوال مساعدة عامة (Utilities)
// ============================================================================

/**

استدعاء fetch مع timeout لتفادي تعليق الطلب إلى ما لا نهاية
*/
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
try {
const response = await fetch(url, { ...options, signal: controller.signal });
return response;
} finally {
clearTimeout(timeoutId);
}
}


/**

قراءة نص الاستجابة بأمان (بدون رمي استثناء لو فشلت القراءة)
*/
async function safeText(response) {
try {
return await response.text();
} catch (err) {
return '[unable to read response body]';
}
}


/**

تحويل كائن JS إلى Response بصيغة JSON
*/
function jsonResponse(obj, status = 200) {
return new Response(JSON.stringify(obj), {
status,
headers: { 'Content-Type': 'application/json' },
});
}


/**

قص النص إلى حد أقصى معيّن لتفادي رفض المنصات للرسائل الطويلة جدًا
*/
function truncateText(text, maxLength) {
if (!text) return '';
if (text.length <= maxLength) return text;
return ${text.slice(0, maxLength - 3)}...;
}


/**

محاولة تحليل JSON بأمان مع قيمة افتراضية عند الفشل
*/
function safeJsonParse(jsonString, fallback = null) {
try {
return JSON.parse(jsonString);
} catch (err) {
return fallback;
}
}


/**

تسجيل الأخطاء بشكل موحّد (يمكن لاحقًا ربطها بخدمة مراقبة خارجية)
*/
function logError(context, error) {
const message = error?.message || String(error);
const stack = error?.stack || '';
console.error([Ayad Clinic AI] Error in ${context}: ${message}${stack ? \n${stack} : ''});
}
