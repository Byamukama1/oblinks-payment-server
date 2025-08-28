/******************************************
 * OBlinks Payments Server (Render-ready)
 * - Uses Firebase Admin via Secret File mount
 * - Withdrawals Automation
 * - Collections (Customer Payments)
 * - Business Listing Automation
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

/* ------------------------- Server Middleware ------------------------- */
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ------------------------- Axios Defaults ---------------------------- */
axios.defaults.timeout = 20000; // 20s network timeout

/* ------------------------- Email Transport --------------------------- */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
});

/* ------------------------- Firebase Admin Init ----------------------- */
/**
 * On Render, Secret Files are mounted at:
 *   /etc/secrets/<filename>
 * You uploaded: oblinks-7fdb1-firebase-adminsdk-fbsvc-afd62fb447.json
 */
const SECRET_FILE_DEFAULT =
  "/etc/secrets/oblinks-7fdb1-firebase-adminsdk-fbsvc-afd62fb447.json";

// Allow overriding via env if you ever change the filename.
const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_ADMIN_PATH || SECRET_FILE_DEFAULT;

function loadServiceAccount(jsonPath) {
  try {
    const full = path.resolve(jsonPath);
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    console.log("✅ Loaded Firebase service account from:", full);
    return parsed;
  } catch (err) {
    console.error("❌ Failed to read service account file:", jsonPath, err.message);
    throw err;
  }
}

const serviceAccount = loadServiceAccount(SERVICE_ACCOUNT_PATH);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ------------------------- Helpers ---------------------------------- */
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------- 1) SiliconPay Token ----------------------- */
async function generateToken() {
  const secretHash = crypto
    .createHash("sha512")
    .update(process.env.SECRET_KEY || "")
    .digest("hex");

  const headers = {
    encryption_key: process.env.ENCRYPTION_KEY,
    secrete_hash: secretHash,
    "Content-Type": "application/json",
  };

  const url = process.env.SILICON_TOKEN_URL;
  if (!url) throw new Error("SILICON_TOKEN_URL not set");

  const { data } = await axios.get(url, { headers });
  if (!data?.token) throw new Error("Token missing in SiliconPay response");
  console.log("✅ Generated SiliconPay Token");
  return data.token;
}

/* ------------------------- 2) Withdrawals ---------------------------- */
async function sendPayout(withdrawalId, withdrawal, token) {
  const msg =
    crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY || "").digest("hex") +
    withdrawal.account;

  const signature = crypto
    .createHmac("sha256", process.env.SECRET_KEY || "")
    .update(msg)
    .digest("hex");

  const payload = {
    req: "mm",
    currency: "UGX",
    txRef: `TX-${Date.now()}`,
    encryption_key: process.env.ENCRYPTION_KEY,
    amount: withdrawal.amount,
    emailAddress: "byamukamambabazimentor@gmail.com",
    call_back: "https://oblinks-payment-server.onrender.com/ipn",
    phone: withdrawal.account,
    reason: "User Withdrawal",
    debit_wallet: "UGX WALLET",
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    signature,
    "Content-Type": "application/json",
  };

  const url = process.env.SILICON_PAY_URL;
  if (!url) throw new Error("SILICON_PAY_URL not set");

  try {
    const { data } = await axios.post(url, payload, { headers });
    console.log("✅ SiliconPay Withdraw Response:", data);

    if (data.status === "successful") {
      await db.collection("withdrawals").doc(withdrawalId).update({
        status: "approved",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Withdrawal ${withdrawalId} approved`);

      // Optional email
      if (withdrawal.emailAddress) {
        transporter.sendMail(
          {
            from: process.env.GMAIL_USER,
            to: withdrawal.emailAddress,
            subject: "OBlinks Withdrawal Processed",
            text: `Hello!\n\n✅ Your withdrawal of ${withdrawal.amount} UGX has been processed and sent to ${withdrawal.account}.\n\n— OBlinks Team`,
          },
          (error, info) => {
            if (error) console.error("❌ Withdrawal email error:", error.message);
            else console.log("✅ Withdrawal email sent:", info.response);
          }
        );
      }
    } else {
      await db.collection("withdrawals").doc(withdrawalId).update({
        status: "failed",
        errorMessage: data.message || "Unknown error",
      });
      console.log(`⚠️ Withdrawal ${withdrawalId} failed`);
    }
  } catch (err) {
    console.error("❌ Error sending payout:", err.response?.data || err.message);
    await db.collection("withdrawals").doc(withdrawalId).update({
      status: "failed",
      errorMessage: err.response?.data?.message || err.message,
    });
  }
}

app.get(
  "/process-withdrawals",
  asyncRoute(async (req, res) => {
    console.log("✅ Checking pending withdrawals...");
    const snap = await db.collection("withdrawals").where("status", "==", "pending").get();

    if (snap.empty) {
      console.log("ℹ️ No pending withdrawals found.");
      return res.send("No pending withdrawals found.");
    }

    const token = await generateToken();

    for (const doc of snap.docs) {
      console.log(`➡️ Processing Withdrawal ${doc.id}`, doc.data());
      await sendPayout(doc.id, doc.data(), token);
    }

    res.send("All withdrawals processed.");
  })
);

/* ------------------------- 3) Collections (Customer Payments) -------- */
app.get("/wakeup", (req, res) => {
  console.log("✅ Wakeup ping");
  res.send("Server is awake");
});

app.post(
  "/start-payment",
  asyncRoute(async (req, res) => {
    const { phone, amount, email, package } = req.body || {};
    if (!phone || !amount || !email || !package) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const txRef = `TX-${Date.now()}`;
    const payload = {
      req: "mobile_money",
      currency: "UGX",
      phone,
      encryption_key: process.env.ENCRYPTION_KEY,
      amount,
      emailAddress: email,
      call_back: "https://oblinks-payment-server.onrender.com/ipn",
      txRef,
    };

    console.log("➡️ SiliconPay Collection Request:", payload);

    const url = process.env.SILICON_COLLECT_URL;
    if (!url) throw new Error("SILICON_COLLECT_URL not set");

    const { data } = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
    });

    console.log("✅ SiliconPay Collection Response:", data);

    await db.collection("payments").doc(txRef).set({
      txRef,
      phone,
      amount,
      email,
      package,
      status: "pending",
      siliconResponse: data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      message: "Payment push sent; awaiting confirmation.",
      txRef,
      siliconResponse: data,
    });
  })
);

/* ------------------------- SiliconPay IPN ---------------------------- */
app.post(
  "/ipn",
  asyncRoute(async (req, res) => {
    console.log("✅ IPN Received:", req.body);
    const { txRef, status, network_ref, msisdn, secure_hash } = req.body || {};

    if (!txRef) return res.status(400).send("Missing txRef");

    const paymentRef = db.collection("payments").doc(txRef);
    await paymentRef.update({
      status: status === "successful" ? "approved" : "failed",
      network_ref: network_ref || null,
      msisdn: msisdn || null,
      secure_hash: secure_hash || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Payment ${txRef} -> ${status}`);

    if (status === "successful") {
      try {
        const paySnap = await paymentRef.get();
        const payData = paySnap.data();
        if (!payData) throw new Error("Payment data not found");

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

            // Notify business owner
            transporter.sendMail(
              {
                from: process.env.GMAIL_USER,
                to: payData.email,
                subject: "Your Business is Live on OBlinks!",
                text: `Hello!\n\n✅ Your payment has been confirmed.\n✅ Your business "${businessData.title}" is now live on OBlinks.\n\n— OBlinks Team`,
              },
              (error, info) => {
                if (error) console.error("❌ Email send error:", error.message);
                else console.log("✅ Email sent:", info.response);
              }
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

/* ------------------------- Single Withdrawal ------------------------- */
app.post(
  "/process-single-withdrawal",
  asyncRoute(async (req, res) => {
    const { withdrawalId } = req.body || {};
    if (!withdrawalId) {
      return res.status(400).json({ success: false, error: "Missing withdrawalId" });
    }

    const ref = db.collection("withdrawals").doc(withdrawalId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Withdrawal not found" });
    }

    const data = snap.data();
    if (data.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, error: `Already processed (status: ${data.status})` });
    }

    const token = await generateToken();
    console.log(`⚡ Processing single withdrawal: ${withdrawalId}`);
    await sendPayout(withdrawalId, data, token);

    const updated = await ref.get();
    const finalStatus = updated.data()?.status;
    if (finalStatus === "approved") {
      return res.json({ success: true, message: "Withdrawal approved", data: updated.data() });
    }
    return res
      .status(500)
      .json({ success: false, error: `Processing failed (status: ${finalStatus})` });
  })
);

/* ------------------------- Health/Root ------------------------------- */
app.get("/", (_req, res) => res.send("OBlinks Payment Server ✅"));

/* ------------------------- Error Handler ----------------------------- */
app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error", details: err.message });
});

/* ------------------------- Start Server ------------------------------ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OBlinks server running on :${PORT}`));