/******************************************
 * OBlinks Payments Server (Render-Ready v4)
 ******************************************/

require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ------------------------- CORS & JSON ------------------------------- */
const ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

axios.defaults.timeout = 20000;

/* ------------------------- Email ------------------------------------ */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

/* ------------------------- Env Checks -------------------------------- */
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
must("SILICON_TOKEN_URL");    // https://silicon-pay.com/generate_token
must("SILICON_PAY_URL");      // https://silicon-pay.com/api_withdraw
must("SILICON_COLLECT_URL");  // your collections endpoint
process.env.IPN_URL = process.env.IPN_URL || "https://oblinks-payment-server.onrender.com/ipn";

/* ------------------------- Firebase Admin ---------------------------- */
function resolveServiceAccountPath() {
  if (process.env.FIREBASE_ADMIN_PATH) return process.env.FIREBASE_ADMIN_PATH;
  const dir = "/etc/secrets";
  try {
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".json"));
    if (files.length) return path.join(dir, files[0]);
  } catch (_) {}
  return "/etc/secrets/oblinks-7fdb1-firebase-adminsdk-fbsvc-afd62fb447.json";
}
function loadServiceAccount(p) {
  const full = path.resolve(p);
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw);
  console.log("✅ Loaded Firebase service account from:", full);
  return parsed;
}
admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount(resolveServiceAccountPath())) });
const db = admin.firestore();

/* ------------------------- Helpers ---------------------------------- */
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// PHP openssl_encrypt(txRef, 'aes-256-ecb', secret_key)
function aes256EcbBase64(plainText, secretKeyUtf8) {
  let key = Buffer.from(secretKeyUtf8, "utf8");
  if (key.length !== 32) key = crypto.createHash("sha256").update(key).digest();
  const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(true);
  const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return enc.toString("base64");
}

// keep only digits (remove +, spaces)
const digitsOnly = s => String(s || "").replace(/\D+/g, "");

/* ------------------------- SiliconPay: Token ------------------------- */
async function generateToken() {
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

/* ------------------------- Withdrawals (Payout) ---------------------- */
async function sendPayout(withdrawalId, withdrawal, token) {
  const encryptionKey = String(process.env.ENCRYPTION_KEY || "");
  const secretKey = String(process.env.SECRET_KEY || "");

  const phone = digitsOnly(withdrawal.account);
  const intAmount = Math.max(0, parseInt(String(withdrawal.amount), 10));
  if (!phone || !intAmount) {
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

  // Debit wallet per support: "UGX" (configurable)
  const DEBIT_WALLET = process.env.DEBIT_WALLET || "UGX";

  const payload = {
    req: "mm",
    currency: "UGX",
    txRef: `TX-${Date.now()}`,
    encryption_key: encryptionKey,
    amount: String(intAmount), // plain integer string
    emailAddress: withdrawal.emailAddress || "byamukamambabazimentor@gmail.com",
    call_back: process.env.IPN_URL,
    phone,
    reason: withdrawal.reason || "User Withdrawal",
    debit_wallet: DEBIT_WALLET, // <- "UGX"
  };

  // Include token-style headers too
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
      txRef: payload.txRef, phone: payload.phone, amount: payload.amount, debit_wallet: payload.debit_wallet
    });

    const { data, status } = await axios.post(process.env.SILICON_PAY_URL, payload, { headers });
    console.log("✅ SiliconPay Withdraw Response:", status, data);

    if (data?.status === "successful") {
      await db.collection("withdrawals").doc(withdrawalId).update({
        status: "approved",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        providerRef: data?.txRef || null,
      });
      console.log(`✅ Withdrawal ${withdrawalId} approved`);

      if (withdrawal.emailAddress) {
        transporter.sendMail(
          {
            from: process.env.GMAIL_USER,
            to: withdrawal.emailAddress,
            subject: "OBlinks Withdrawal Processed",
            text: `Hello!\n\n✅ Your withdrawal of ${intAmount} UGX has been processed and sent to ${phone}.\n\n— OBlinks Team`,
          },
          (error, info) =>
            error ? console.error("❌ Withdrawal email error:", error.message) : console.log("✅ Email sent:", info.response)
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

/* ------------------------- Routes ----------------------------------- */
app.get("/", (_req, res) => res.send("OBlinks Payment Server ✅"));
app.get("/wakeup", (_req, res) => res.send("awake"));

app.get(
  "/process-withdrawals",
  asyncRoute(async (_req, res) => {
    console.log("✅ Checking pending withdrawals…");
    const snap = await db.collection("withdrawals").where("status", "==", "pending").get();
    if (snap.empty) return res.send("No pending withdrawals found.");
    const token = await generateToken();
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

    const token = await generateToken();
    console.log(`⚡ Processing single withdrawal: ${withdrawalId}`);
    await sendPayout(withdrawalId, data, token);

    const updated = await ref.get();
    const finalStatus = updated.data()?.status;
    if (finalStatus === "approved")
      return res.json({ success: true, message: "Withdrawal approved", data: updated.data() });

    return res.status(500).json({ success: false, error: `Processing failed (status: ${finalStatus})` });
  })
);

/* ---------- Collections (Customer Payments) -------------------------- */
app.post(
  "/start-payment",
  asyncRoute(async (req, res) => {
    const { phone, amount, email, package } = req.body || {};
    if (!phone || !amount || !email || !package)
      return res.status(400).json({ error: "Missing required fields" });

    const txRef = `TX-${Date.now()}`;
    const payload = {
      req: "mobile_money",
      currency: "UGX",
      phone: digitsOnly(phone),
      encryption_key: process.env.ENCRYPTION_KEY,
      amount: String(Math.max(0, parseInt(String(amount), 10))), // integer string
      emailAddress: email,
      call_back: process.env.IPN_URL,
      txRef,
    };

    console.log("➡️ SiliconPay Collection Request:", { txRef, phone: payload.phone, amount: payload.amount });

    const { data } = await axios.post(process.env.SILICON_COLLECT_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });

    console.log("✅ SiliconPay Collection Response:", data);

    await db.collection("payments").doc(txRef).set({
      txRef,
      phone: payload.phone,
      amount: payload.amount,
      email,
      package,
      status: "pending",
      siliconResponse: data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Payment push sent; awaiting confirmation.", txRef, siliconResponse: data });
  })
);

/* ------------------------- IPN (with signature) ---------------------- */
app.post(
  "/ipn",
  asyncRoute(async (req, res) => {
    console.log("✅ IPN Received:", req.body);
    const { txRef, status, network_ref, msisdn, secure_hash } = req.body || {};
    if (!txRef) return res.status(400).send("Missing txRef");

    const generated = aes256EcbBase64(txRef, process.env.SECRET_KEY);
    if (secure_hash && generated !== secure_hash) {
      console.error("❌ IPN signature mismatch", { txRef, secure_hash, generated });
      return res.status(403).send("Invalid signature");
    }

    const paymentRef = db.collection("payments").doc(txRef);
    await paymentRef.set(
      {
        status: status === "successful" ? "approved" : "failed",
        network_ref: network_ref || null,
        msisdn: msisdn || null,
        secure_hash: secure_hash || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`✅ Payment ${txRef} -> ${status}`);

    if (status === "successful") {
      try {
        const paySnap = await paymentRef.get();
        const payData = paySnap.data();
        const q = db
          .collection("pendingBusinesses")
          .where("paymentPhone", "==", payData.phone)
          .where("package", "==", payData.package);

        const snap = await q.get();
        if (snap.empty) {
          console.log(`⚠️ No pending business found for ${txRef}`);
        } else {
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
                error ? console.error("❌ Email send error:", error.message) : console.log("✅ Email sent:", info.response)
            );
          }
        }
      } catch (err) {
        console.error("❌ Business automation error:", err.message);
      }
    }

    res.send("OK");
  })
);

/* ------------------------- Transfer Status --------------------------- */
app.post(
  "/transfer-status",
  asyncRoute(async (req, res) => {
    const { txRef } = req.body || {};
    if (!txRef) return res.status(400).json({ error: "txRef required" });

    const url = `https://silicon-pay.com/tranfer_status/${encodeURIComponent(txRef)}`;
    const payload = { encryption_key: process.env.ENCRYPTION_KEY };

    const { data } = await axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
    res.json(data);
  })
);

/* ------------------------- Error & Start ----------------------------- */
app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error", details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OBlinks server running on :${PORT}`));