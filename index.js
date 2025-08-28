/******************************************
 * OBlinks + MoneyGamez Server (Render v4)
 *  - OBlinks: withdrawals, collections, business IPN
 *  - MoneyGamez: deposits via Silicon Pay, stakes, referrals, cron daily returns
 ******************************************/
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cron = require("node-cron");
const { DateTime } = require("luxon");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

const app = express();

/* ─────────────── Express / CORS ─────────────── */
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));

axios.defaults.timeout = 20000;

/* ─────────────── Email (Gmail) ─────────────── */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

/* ─────────────── Env & constants ─────────────── */
function must(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`❌ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}
must("ENCRYPTION_KEY");
must("SECRET_KEY");
must("SILICON_TOKEN_URL");   // e.g. https://silicon-pay.com/generate_token
must("SILICON_PAY_URL");     // e.g. https://silicon-pay.com/api_withdraw
// For collections we will default to the documented endpoint below if env is missing
const SILICON_COLLECT_URL =
  process.env.SILICON_COLLECT_URL?.trim() ||
  "https://silicon-pay.com/process_payments";

const MODE = (process.env.MODE || "both").toLowerCase(); // web | worker | both
const TZ = process.env.TZ || "UTC";
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/g, "");
process.env.IPN_URL =
  process.env.IPN_URL || (PUBLIC_URL ? `${PUBLIC_URL}/ipn` : "");

// MoneyGamez product constants
const DAILY_RATE = 0.10; // 10% per day
const DURATION_DAYS = 20;
const REFERRAL_BONUS_RATE = 0.20;

/* ─────────────── Firebase Admin ─────────────── */
function resolveServiceAccountPath() {
  if (process.env.FIREBASE_ADMIN_PATH) return process.env.FIREBASE_ADMIN_PATH;
  const dir = "/etc/secrets";
  try {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
    if (files.length) return path.join(dir, files[0]);
  } catch (_) {}
  return "/etc/secrets/firebase-admin.json";
}
function loadServiceAccount(p) {
  const full = path.resolve(p);
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw);
  console.log("✅ Loaded Firebase service account from:", full);
  return parsed;
}
admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount(resolveServiceAccountPath())),
});
const db = admin.firestore();

/* ─────────────── Utils ─────────────── */
const asyncRoute =
  (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const normalizeUgPhone = (input) => {
  const digits = String(input || "").replace(/\D/g, "");
  if (/^256\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return "256" + digits.slice(1);
  return null;
};

const digitsOnly = (s) => String(s || "").replace(/\D+/g, "");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const todayKeyUTC = () => new Date().toISOString().slice(0, 10);
const isSuccess = (s) =>
  ["successful", "success", "completed", "approved", "paid", "successful"].includes(
    String(s || "").toLowerCase()
  );

// PHP openssl_encrypt(txRef, 'aes-256-ecb', secret_key)
function aes256EcbBase64(plainText, secretKeyUtf8) {
  let key = Buffer.from(secretKeyUtf8, "utf8");
  if (key.length !== 32) key = crypto.createHash("sha256").update(key).digest();
  const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(true);
  const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return enc.toString("base64");
}

/* ─────────────── Silicon Pay helpers ─────────────── */
async function siliconToken() {
  const secrete_hash = crypto.createHash("sha512").update(process.env.SECRET_KEY).digest("hex");
  const headers = {
    encryption_key: process.env.ENCRYPTION_KEY,
    secrete_hash,
    "Content-Type": "application/json",
  };
  const { data } = await axios.get(process.env.SILICON_TOKEN_URL, { headers });
  if (!data?.token) throw new Error("Token missing in SiliconPay response");
  console.log("✅ Generated SiliconPay token");
  return data.token;
}

/* ── Withdraw (payout) ── */
async function sendPayout(withdrawalId, withdrawal, token) {
  const encryptionKey = String(process.env.ENCRYPTION_KEY || "");
  const secretKey = String(process.env.SECRET_KEY || "");

  const phone = digitsOnly(withdrawal.account || withdrawal.phone);
  const amountInt = Math.max(0, parseInt(String(withdrawal.amount), 10));

  if (!phone || !amountInt) {
    console.error("❌ Invalid withdrawal payload:", { phone, amount: withdrawal.amount });
    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "failed",
      errorMessage: "Invalid phone or amount",
    });
    return;
  }

  // signature = HMAC_SHA256( SHA256(encryption_key)+phone , secret_key )
  const msg = crypto.createHash("sha256").update(encryptionKey).digest("hex") + phone;
  const signature = crypto.createHmac("sha256", secretKey).update(msg).digest("hex");

  const payload = {
    req: "mm",
    currency: "UGX",
    txRef: `TX-${Date.now()}`,
    encryption_key: encryptionKey,
    amount: String(amountInt),
    emailAddress: withdrawal.emailAddress || "noreply@oblinks.app",
    call_back: process.env.IPN_URL,
    phone,
    reason: withdrawal.reason || "User Withdrawal",
    debit_wallet: process.env.DEBIT_WALLET || "UGX",
  };

  const secrete_hash = crypto.createHash("sha512").update(secretKey).digest("hex");
  const headers = {
    Authorization: `Bearer ${token}`,
    signature,
    encryption_key: encryptionKey,
    secrete_hash,
    "Content-Type": "application/json",
  };

  try {
    console.log("➡️ SiliconPay Withdraw Request:", {
      txRef: payload.txRef,
      phone: payload.phone,
      amount: payload.amount,
      debit_wallet: payload.debit_wallet,
    });

    const { data, status } = await axios.post(process.env.SILICON_PAY_URL, payload, { headers });
    console.log("✅ SiliconPay Withdraw Response:", status, data);

    if (isSuccess(data?.status)) {
      await db.collection("withdrawals").doc(withdrawalId).update({
        status: "approved",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        providerRef: data?.txRef || null,
      });

      if (withdrawal.emailAddress) {
        transporter.sendMail(
          {
            from: process.env.GMAIL_USER,
            to: withdrawal.emailAddress,
            subject: "OBlinks Withdrawal Processed",
            text: `Hello!\n\n✅ Your withdrawal of ${amountInt} UGX has been processed and sent to ${phone}.\n\n— OBlinks Team`,
          },
          (error, info) =>
            error
              ? console.error("❌ Withdrawal email error:", error.message)
              : console.log("✅ Email sent:", info.response)
        );
      }
    } else {
      await db.collection("withdrawals").doc(withdrawalId).update({
        status: "failed",
        errorMessage: data?.message || "Transfer rejected",
      });
      console.log(`⚠️ Withdrawal ${withdrawalId} failed:`, data?.message);
    }
  } catch (err) {
    console.error("❌ Withdraw error:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "failed",
      errorMessage: err.response?.data?.message || err.message,
    });
  }
}

/* ─────────────── MoneyGamez deposit helpers ─────────────── */
const payCache = new Map(); // txRef -> { amount, contact, userId, narrative, createdAt }

async function createStakeAndCredit(txRef, amount, userId, phone, rawEvent) {
  const depRef = db.collection("deposits").doc(txRef);
  const depSnap = await depRef.get();
  if (depSnap.exists && depSnap.data()?.credited) return;

  await depRef.set(
    {
      userId,
      amount,
      phone: phone || null,
      gateway: "SiliconPay",
      status: "successful",
      raw: rawEvent || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const stakeRef = db.collection("stakes").doc(txRef);

  await db.runTransaction(async (tx) => {
    const userRef = db.collection("users").doc(userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("User not found for deposit");
    const u = userSnap.data() || {};

    const stakeSnap = await tx.get(stakeRef);

    // referrer (reads only)
    let refRef = null;
    let refData = null;
    if (u.referrerCode) {
      const refQuery = db.collection("users").where("referralCode", "==", u.referrerCode).limit(1);
      const refQSnap = await tx.get(refQuery);
      if (!refQSnap.empty) {
        refRef = refQSnap.docs[0].ref;
        refData = refQSnap.docs[0].data() || {};
      }
    }

    // writes (no more reads after this point)
    if (!stakeSnap.exists) {
      tx.set(stakeRef, {
        stakeId: txRef,
        userId,
        principal: round2(amount),
        dailyRate: DAILY_RATE,
        totalDays: DURATION_DAYS,
        remainingDays: DURATION_DAYS,
        earnedSoFar: 0,
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastProcessedAt: null,
        lastProcessedDate: null,
        depositRef: txRef,
      });
    }

    tx.update(userRef, {
      totalDeposited: round2(Number(u.totalDeposited || 0) + amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (refRef) {
      const paid = Array.isArray(refData.paidRefereesIds) ? refData.paidRefereesIds : [];
      if (!paid.includes(userId)) {
        const bonus = round2(amount * REFERRAL_BONUS_RATE);
        tx.update(refRef, {
          returnsWallet: admin.firestore.FieldValue.increment(bonus),
          paidRefereesIds: admin.firestore.FieldValue.arrayUnion(userId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const refLog = db.collection("referrals").doc();
        tx.set(refLog, {
          referrerId: refRef.id,
          refereeId: userId,
          depositRef: txRef,
          bonus,
          rate: REFERRAL_BONUS_RATE,
          amount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    tx.update(depRef, {
      credited: true,
      creditedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  console.log(`💰 Deposit processed: ${txRef} +${amount} UGX → stake created & totals updated`);
}

/* ─────────────── Daily returns ─────────────── */
async function runDailyReturns() {
  const started = DateTime.now().setZone(TZ).toISO();
  console.log(`[CRON] Daily returns start @ ${started} (${TZ})`);
  const today = todayKeyUTC();
  const pageSize = 500;

  let processed = 0;
  let paidTotal = 0;
  let cursor = null;

  while (true) {
    let q = db
      .collection("stakes")
      .where("status", "==", "active")
      .where("remainingDays", ">", 0)
      .orderBy("remainingDays")
      .orderBy("stakeId")
      .limit(pageSize);

    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const stake = doc.data() || {};
      const stakeId = doc.id;
      const userId = stake.userId;
      const remaining = Number(stake.remainingDays || 0);
      const lastDate = stake.lastProcessedDate || null;
      if (!userId || remaining <= 0) continue;
      if (lastDate === today) continue;

      const principal = Number(stake.principal || 0);
      const rate = Number(stake.dailyRate || DAILY_RATE);
      const daily = round2(principal * rate);
      const newRemaining = remaining - 1;

      try {
        await db.runTransaction(async (tx) => {
          const userRef = db.collection("users").doc(userId);
          const stakeRef = db.collection("stakes").doc(stakeId);

          const sSnap = await tx.get(stakeRef);
          const s = sSnap.data() || {};
          if (s.lastProcessedDate === today) return;
          if (Number(s.remainingDays || 0) <= 0) return;

          tx.update(userRef, {
            returnsWallet: admin.firestore.FieldValue.increment(daily),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          const updates = {
            earnedSoFar: admin.firestore.FieldValue.increment(daily),
            remainingDays: newRemaining,
            lastProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastProcessedDate: today,
          };
          if (newRemaining <= 0) {
            updates.status = "completed";
            updates.completedAt = admin.firestore.FieldValue.serverTimestamp();
          }
          tx.update(stakeRef, updates);
        });

        processed += 1;
        paidTotal += daily;
      } catch (e) {
        console.error(`Stake ${stakeId} daily process failed:`, e.message);
      }
    }

    cursor = snap.docs[snap.docs.length - 1];
    if (!cursor || snap.size < pageSize) break;
  }

  console.log(
    `[CRON] Daily returns done: processed=${processed}, paidTotal=${round2(
      paidTotal
    )} @ ${DateTime.now().setZone(TZ).toISO()}`
  );

  return { ok: true, date: today, processed, paidTotal: round2(paidTotal), rate: DAILY_RATE };
}

/* ─────────────── Basic routes ─────────────── */
app.get("/", (_req, res) =>
  res
    .status(200)
    .send(
      `OBlinks server ✅ • MODE=${MODE} • TZ=${TZ} • ${DateTime.now()
        .setZone(TZ)
        .toISO()}`
    )
);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ─────────────── OBlinks: Withdrawals ─────────────── */
app.get(
  "/process-withdrawals",
  asyncRoute(async (_req, res) => {
    console.log("✅ Checking pending withdrawals…");
    const snap = await db.collection("withdrawals").where("status", "==", "pending").get();
    if (snap.empty) return res.send("No pending withdrawals found.");
    const token = await siliconToken();
    for (const doc of snap.docs) {
      console.log(`➡️ Processing Withdrawal ${doc.id}`, doc.data());
      await sendPayout(doc.id, doc.data(), token);
    }
    res.send("All withdrawals processed.");
  })
);

app.post(
  "/process-single-withdrawal",
  asyncRoute(async (req, res) => {
    const { withdrawalId } = req.body || {};
    if (!withdrawalId) return res.status(400).json({ success: false, error: "Missing withdrawalId" });

    const ref = db.collection("withdrawals").doc(withdrawalId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Withdrawal not found" });

    const data = snap.data();
    if (data.status !== "pending")
      return res.status(400).json({ success: false, error: `Already processed (status: ${data.status})` });

    const token = await siliconToken();
    console.log(`⚡ Processing single withdrawal: ${withdrawalId}`);
    await sendPayout(withdrawalId, data, token);

    const updated = await ref.get();
    const finalStatus = updated.data()?.status;
    if (finalStatus === "approved")
      return res.json({ success: true, message: "Withdrawal approved", data: updated.data() });

    return res.status(500).json({ success: false, error: `Processing failed (status: ${finalStatus})` });
  })
);

/* ─────────────── OBlinks: Collections (business) ─────────────── */
app.post(
  "/start-payment",
  asyncRoute(async (req, res) => {
    const { phone, amount, email, package: pack } = req.body || {};
    if (!phone || !amount || !email || !pack) return res.status(400).json({ error: "Missing required fields" });

    const txRef = `TX-${Date.now()}`;
    const payload = {
      req: "mobile_money",
      currency: "UGX",
      phone: digitsOnly(phone),
      encryption_key: process.env.ENCRYPTION_KEY,
      amount: String(Math.max(0, parseInt(String(amount), 10))),
      emailAddress: email,
      call_back: process.env.IPN_URL,
      txRef,
      metadata: { kind: "oblinks" },
    };

    console.log("➡️ SiliconPay Collection Request (OBlinks):", { txRef, phone: payload.phone, amount: payload.amount });
    const { data } = await axios.post(SILICON_COLLECT_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log("✅ SiliconPay Collection Response:", data);

    await db.collection("payments").doc(txRef).set({
      txRef,
      phone: payload.phone,
      amount: payload.amount,
      email,
      package: pack,
      status: "pending",
      siliconResponse: data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Payment push sent; awaiting confirmation.", txRef, siliconResponse: data });
  })
);

/* ─────────────── MoneyGamez: Deposit (Silicon Collect) ─────────────── */
// Body: { amount, phone, userId, narrative?, email? }
app.post(
  "/api/pay",
  asyncRoute(async (req, res) => {
    const amount = Number(req.body?.amount);
    const phone = normalizeUgPhone(req.body?.phone);
    const userId = (req.body?.userId && String(req.body.userId)) || "";
    const email = String(req.body?.email || "noreply@oblinks.app");
    const narrative = (req.body?.narrative || "Wallet deposit").toString().slice(0, 100);

    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ success: false, messages: ["Invalid amount"], data: [] });
    if (!phone) return res.status(400).json({ success: false, messages: ["Invalid phone"], data: [] });
    if (!userId) return res.status(400).json({ success: false, messages: ["Missing userId"], data: [] });
    if (!process.env.IPN_URL) return res.status(500).json({ success: false, messages: ["Server missing PUBLIC_URL/IPN_URL"], data: [] });

    const txRef = `PP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    payCache.set(txRef, { amount, contact: phone, narrative, userId, status: "initiated", createdAt: Date.now() });

    // Seed minimal deposit doc
    await db.collection("deposits").doc(txRef).set(
      {
        userId,
        amount,
        phone,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const payload = {
      req: "mobile_money",
      currency: "UGX",
      phone,
      encryption_key: process.env.ENCRYPTION_KEY,
      amount: String(Math.max(0, Math.trunc(amount))),
      emailAddress: email,              // always include, per docs
      call_back: process.env.IPN_URL,
      txRef,
      metadata: { kind: "moneygamez", userId },
    };

    console.log("➡️ SiliconPay Collection Request (MG):", { txRef, phone, amount: payload.amount });
    const { data, status } = await axios.post(SILICON_COLLECT_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });

    if (!(status >= 200 && status < 300)) payCache.get(txRef).status = "failed_to_start";
    return res.status(status).json({ ...(data || {}), transaction_ref: txRef });
  })
);

app.get("/api/pay/:ref", (req, res) => {
  const ref = String(req.params.ref || "");
  const rec = payCache.get(ref);
  if (!rec) return res.status(404).json({ success: false, messages: ["Not found"], data: [] });
  res.json({ success: true, data: [{ transaction_reference: ref, ...rec }] });
});

/* ─────────────── Unified IPN (OBlinks + MoneyGamez) ─────────────── */
app.post(
  "/ipn",
  asyncRoute(async (req, res) => {
    console.log("✅ IPN Received:", req.body);
    const { txRef, status, msisdn, secure_hash } = req.body || {};
    if (!txRef) return res.status(400).send("Missing txRef");

    // Silicon docs show 'nework_ref' (typo) sometimes; also handle 'network_ref'
    const networkRef = req.body?.nework_ref || req.body?.network_ref || null;

    // Validate signature if present
    const generated = aes256EcbBase64(txRef, process.env.SECRET_KEY);
    if (secure_hash && generated !== secure_hash) {
      console.error("❌ IPN signature mismatch", { txRef, secure_hash, generated });
      return res.status(403).send("Invalid signature");
    }

    // Persist/merge payment record (OBlinks flow)
    const paymentRef = db.collection("payments").doc(txRef);
    await paymentRef.set(
      {
        status: isSuccess(status) ? "approved" : "failed",
        network_ref: networkRef,
        msisdn: msisdn || null,
        secure_hash: secure_hash || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`✅ Payment ${txRef} -> ${status}`);

    // MoneyGamez credit + stake creation on success (idempotent)
    if (isSuccess(status)) {
      // Discover amount & userId
      const rec = payCache.get(txRef) || {};
      let amount =
        Number(rec.amount) ||
        Number(req.body?.amount) ||
        Number(req.body?.transaction_amount) ||
        0;
      let userId = rec.userId || "";
      if (!userId) {
        const depSnap = await db.collection("deposits").doc(txRef).get();
        if (depSnap.exists) userId = depSnap.data()?.userId || "";
      }
      if (userId && amount > 0) {
        await createStakeAndCredit(txRef, amount, userId, rec.contact || msisdn || null, req.body);
      } else {
        if (!userId) console.warn("No userId available for tx", txRef);
        if (!(amount > 0)) console.warn("No amount found for tx", txRef);
      }
    }

    // OBlinks business automation (only when an OBlinks payment doc carries email/package)
    try {
      const paySnap = await paymentRef.get();
      const payData = paySnap.data() || {};
      if (isSuccess(status) && payData.email && payData.package) {
        const q = db
          .collection("pendingBusinesses")
          .where("paymentPhone", "==", payData.phone)
          .where("package", "==", payData.package);
        const snap = await q.get();
        if (!snap.empty) {
          for (const doc of snap.docs) {
            const businessData = doc.data();
            const businessId = doc.id;

            await db.collection("businesses").doc(businessId).set({
              ...businessData,
              status: "approved",
              paymentStatus: "paid",
              approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            await db.collection("pendingBusinesses").doc(businessId).delete();
            console.log(`✅ Business ${businessId} approved & moved`);

            transporter.sendMail(
              {
                from: process.env.GMAIL_USER,
                to: payData.email,
                subject: "Your Business is Live on OBlinks!",
                text: `Hello!\n\n✅ Your payment has been confirmed.\n✅ Your business "${businessData.title}" is now live on OBlinks.\n\n— OBlinks Team`,
              },
              (error, info) =>
                error
                  ? console.error("❌ Email send error:", error.message)
                  : console.log("✅ Email sent:", info.response)
            );
          }
        }
      }
    } catch (err) {
      console.error("❌ Business automation error:", err.message);
    }

    res.send("OK");
  })
);

/* ─────────────── Transfer Status helper ─────────────── */
app.post(
  "/transfer-status",
  asyncRoute(async (req, res) => {
    const { txRef } = req.body || {};
    if (!txRef) return res.status(400).json({ error: "txRef required" });
    // Silicon docs: /transaction_status/{reference}
    const url = `https://silicon-pay.com/transaction_status/${encodeURIComponent(txRef)}`;
    const payload = { encryption_key: process.env.ENCRYPTION_KEY };
    const { data } = await axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
    res.json(data);
  })
);

/* ─────────────── Error & Start ─────────────── */
app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error", details: err.message });
});

app.listen(PORT, () =>
  console.log(`✅ Server running on :${PORT} • MODE=${MODE} • TZ=${TZ}`)
);

/* ─────────────── Scheduler (daily returns) ─────────────── */
if (MODE === "worker" || MODE === "both") {
  console.log(`[SCHEDULER] Enabled. Timezone=${TZ}`);
  cron.schedule(
    "10 0 * * *",
    async () => {
      try {
        await runDailyReturns();
      } catch (e) {
        console.error("Scheduled run failed:", e);
      }
    },
    { timezone: TZ }
  );
} else {
  console.log("[SCHEDULER] Disabled (MODE=web).");
}
