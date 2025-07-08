/*******************************************
 * OBlinks Payments Server
 * Supports:
 *  - Withdrawals Automation
 *  - Collections (Customer Payments)
 *******************************************/

require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors'); // ADDED: CORS middleware

const app = express();

// ADDED: Enable CORS for frontend domain
// Enable CORS for all origins (for development)
app.use(cors());
app.use(bodyParser.json());

// Load Firebase Admin SDK
const serviceAccount = require(`./${process.env.FIREBASE_KEY_FILE}`);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/*******************************************
 * 1️⃣ SiliconPay Token Generation
 *******************************************/
async function generateToken() {
  const secreteHash = crypto.createHash('sha512')
    .update(process.env.SECRET_KEY)
    .digest('hex');

  const headers = {
    'encryption_key': process.env.ENCRYPTION_KEY,
    'secrete_hash': secreteHash,
    'Content-Type': 'application/json'
  };

  const response = await axios.get(process.env.SILICON_TOKEN_URL, { headers });
  console.log('✅ Generated SiliconPay Token:', response.data.token);
  return response.data.token;
}

/*******************************************
 * 2️⃣ Withdrawals Automation
 *******************************************/
async function sendPayout(withdrawalId, withdrawal, token) {
  try {
    const msg = crypto.createHash('sha256')
      .update(process.env.ENCRYPTION_KEY)
      .digest('hex') + withdrawal.account;

    const signature = crypto.createHmac('sha256', process.env.SECRET_KEY)
      .update(msg)
      .digest('hex');

    const payload = {
      req: 'mm',
      currency: 'UGX',
      txRef: `TX-${Date.now()}`,
      encryption_key: process.env.ENCRYPTION_KEY,
      amount: withdrawal.amount,
      emailAddress: 'byamukamambabazimentor@gmail.com',
      // FIXED: Updated callback URL
      call_back: 'https://oblinks-payout-automation.byamukamambabaz.repl.co/ipn',
      phone: withdrawal.account,
      reason: 'User Withdrawal',
      debit_wallet: 'UGX WALLET'
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      signature,
      'Content-Type': 'application/json'
    };

    const response = await axios.post(process.env.SILICON_PAY_URL, payload, { headers });
    console.log('✅ SiliconPay Withdraw Response:', response.data);

    if (response.data.status === 'successful') {
      await db.collection('withdrawals').doc(withdrawalId).update({
        status: 'approved',
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Withdrawal ${withdrawalId} marked approved`);
    } else {
      await db.collection('withdrawals').doc(withdrawalId).update({
        status: 'failed',
        errorMessage: response.data.message
      });
      console.log(`⚠️ Withdrawal ${withdrawalId} marked failed`);
    }

  } catch (error) {
    console.error('❌ Error sending payout:', error.response?.data || error.message);
  }
}

// Withdrawals Processing Endpoint
app.get('/process-withdrawals', async (req, res) => {
  try {
    console.log('✅ Checking pending withdrawals...');
    const snapshot = await db.collection('withdrawals').where('status', '==', 'pending').get();

    if (snapshot.empty) {
      console.log('ℹ️ No pending withdrawals found.');
      return res.send('No pending withdrawals found.');
    }

    const token = await generateToken();

    for (const doc of snapshot.docs) {
      console.log(`Processing Withdrawal ID: ${doc.id} =>`, doc.data());
      await sendPayout(doc.id, doc.data(), token);
    }

    console.log('✅ All withdrawals processed.');
    res.send('All withdrawals processed.');

  } catch (error) {
    console.error('❌ Error processing withdrawals:', error.message);
    res.status(500).send('Error processing withdrawals');
  }
});

/*******************************************
 * 3️⃣ Collections API - Customer Payments
 *******************************************/

// ADDED: Wakeup endpoint to prevent server sleeping
app.get('/wakeup', (req, res) => {
  console.log('✅ Received wakeup call');
  res.send('Server is awake');
});

/**
 * /start-payment
 * Triggers STK Push to Customer Phone
 */
app.post('/start-payment', async (req, res) => {
  try {
    const { phone, amount, email, package } = req.body;

    if (!phone || !amount || !email || !package) {
      return res.status(400).send({ error: 'Missing required fields' });
    }

    const txRef = `TX-${Date.now()}`;
    const payload = {
      req: 'mobile_money',
      currency: 'UGX',
      phone,
      encryption_key: process.env.ENCRYPTION_KEY,
      amount,
      emailAddress: email,
      // FIXED: Updated callback URL
      call_back: 'https://oblinks-payout-automation.byamukamambabaz.repl.co/ipn',
      txRef
    };

    console.log('✅ Sending payment collection request to SiliconPay:', payload);

    // Call SiliconPay
    const response = await axios.post(process.env.SILICON_COLLECT_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('✅ SiliconPay Collection Response:', response.data);

    // Save payment as pending
    await db.collection('payments').doc(txRef).set({
      txRef,
      phone,
      amount,
      email,
      package,
      status: 'pending',
      siliconResponse: response.data,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.send({
      message: 'Payment push sent to customer phone. Awaiting confirmation.',
      txRef,
      siliconResponse: response.data
    });

  } catch (error) {
    console.error('❌ Error in /start-payment:', error.response?.data || error.message);
    res.status(500).send('Error initiating payment');
  }
});

/**
 * /ipn
 * SiliconPay Callback Endpoint
 */
app.post('/ipn', async (req, res) => {
  try {
    console.log('✅ IPN Received from SiliconPay:', req.body);

    const { txRef, status, network_ref, msisdn, secure_hash } = req.body;

    if (!txRef) {
      return res.status(400).send('Missing txRef');
    }

    await db.collection('payments').doc(txRef).update({
      status: status === 'successful' ? 'approved' : 'failed',
      network_ref: network_ref || null,
      msisdn: msisdn || null,
      secure_hash: secure_hash || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Payment ${txRef} updated to status: ${status}`);
    res.send('OK');

  } catch (error) {
    console.error('❌ Error processing IPN:', error.message);
    res.status(500).send('Error processing IPN');
  }
});

/*******************************************
 * Start Express Server
 *******************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ OBlinks Payment Server running on port ${PORT}`);
});