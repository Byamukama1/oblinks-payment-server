// distributor.js
// Works with your current index.js (Render server).
// Moves money ONLY from users.returnsWallet -> users.accountBalance.
// Order: (1) Referral bonus (from referrer)  (2) Equal distribution of the remaining principal to all active-stake users.

const admin = require("firebase-admin");

const STAKES_COL      = "stakes";
const USERS_COL       = "users";
const TRANSFERS_COL   = "transfers";
const REFERRALS_COL   = "referrals"; // index.js writes a log here on first stake { referrerId, refereeId, depositRef, bonus, ... }
const COMPANY_METRICS = ["company", "metrics"]; // collection/doc
const JOBS_COL        = "distributionJobs";

const PAGE_SIZE = 200; // user slice size when distributing

function db() { return admin.firestore(); }
const now = () => admin.firestore.FieldValue.serverTimestamp();

function round0(n){ return Math.round(Number(n)||0); }

/** Public API — optional background listener */
function start(){
  const _db = db();
  _db.collection(STAKES_COL)
    .where("status","==","active")
    .where("distributionProcessed","==", false)
    .onSnapshot(async (snap)=>{
      for (const ch of snap.docChanges()){
        if (ch.type !== "added") continue;
        const s = ch.doc.data() || {};
        const id = ch.doc.id;
        try{
          await handleStake(id, s);
        }catch(e){ console.error("[distributor] listener failed", id, e); }
      }
    }, (err)=> console.error("[distributor] listener error:", err));
  console.log("[distributor] listening for undistributed active stakes…");
}

/** Public API — call right after creating the stake in index.js */
async function runForStake(stakeId){
  const sSnap = await db().collection(STAKES_COL).doc(stakeId).get();
  if (!sSnap.exists) throw new Error("Stake not found: "+stakeId);
  await handleStake(stakeId, sSnap.data()||{});
}

/* ---------------- Core ---------------- */

async function handleStake(stakeId, stakeDoc){
  const _db = db();

  // Idempotency: a job document per stake
  const jobRef = _db.collection(JOBS_COL).doc(stakeId);
  await _db.runTransaction(async(tx)=>{
    const j = await tx.get(jobRef);
    if (j.exists){
      const d = j.data() || {};
      if (d.done) throw new Error("Job already completed");
      if (d.locked) throw new Error("Job already locked");
    }
    tx.set(jobRef, { stakeId, locked:true, done:false, createdAt:now() }, { merge:true });
  }).catch((e)=>{ throw e; });

  try{
    // Basic stake sanity
    const principal = Number(stakeDoc.principal || 0); // index.js wrote netPrincipal here
    if (!(principal > 0)){
      await finishJob(jobRef, stakeId, "invalid-principal", 0, 0);
      return;
    }

    // 1) Try to move referral bonus for this stake if index.js created one
    const { referrerId, bonus } = await getReferralForStake(stakeId);
    const referralMoved = (referrerId && bonus>0)
      ? await moveReferralBonus(referrerId, stakeId, bonus)
      : 0;

    // 2) Distribute remaining principal equally to all active-stake users
    const pool = Math.max(0, principal - referralMoved);
    let distributed = 0;
    let totalUsers  = 0;

    if (pool > 0){
      const userIds = await listAllUsersWithActiveStake();
      totalUsers = userIds.length;
      if (totalUsers > 0){
        const portion = pool / totalUsers;
        for (let i=0; i<userIds.length; i+=PAGE_SIZE){
          const slice = userIds.slice(i, i+PAGE_SIZE);
          const part  = await distributeSlice(slice, portion, stakeId);
          distributed += part;
          await jobRef.set({
            cursor: i + slice.length,
            totalUsers,
            totalDistributed: round0(distributed),
            heartbeat: now(),
          }, { merge:true });
        }
      }
    }

    // 3) Company metrics → add the exact amount that actually moved
    const metricsRef = _db.collection(COMPANY_METRICS[0]).doc(COMPANY_METRICS[1]);
    await metricsRef.set({
      totalCompanyTransfers: admin.firestore.FieldValue.increment(round0(distributed + referralMoved)),
      updatedAt: now(),
    }, { merge:true });

    // 4) Mark stake and job as done
    await Promise.all([
      _db.collection(STAKES_COL).doc(stakeId).set({
        distributionProcessed: true,
        distributionAt: now(),
        distributionAmount: round0(distributed),
        referralMoved: round0(referralMoved),
      }, { merge:true }),
      jobRef.set({ done:true, locked:false, completedAt:now() }, { merge:true })
    ]);

    console.log(`[distributor] stake=${stakeId} principal=${round0(principal)} referral=${round0(referralMoved)} distributed=${round0(distributed)}`);
  }catch(e){
    console.error("[distributor] failed for stake", stakeId, e.message);
    // unlock so it can retry later
    await jobRef.set({ locked:false, error:e.message, updatedAt:now() }, { merge:true });
    throw e;
  }
}

async function finishJob(jobRef, stakeId, reason, referral=0, distributed=0){
  await Promise.all([
    jobRef.set({ done:true, locked:false, reason, completedAt:now() }, { merge:true }),
    db().collection(STAKES_COL).doc(stakeId).set({
      distributionProcessed: true,
      distributionAt: now(),
      distributionAmount: round0(distributed),
      referralMoved: round0(referral),
      reason
    }, { merge:true })
  ]);
}

/* --------------- Referral helpers --------------- */

// Read the exact referral record your index.js created for this deposit/stake.
async function getReferralForStake(stakeId){
  const snap = await db()
    .collection(REFERRALS_COL)
    .where("depositRef","==", stakeId)
    .limit(1)
    .get();

  if (snap.empty) return { referrerId:null, bonus:0 };
  const d = snap.docs[0].data() || {};
  const referrerId = d.referrerId || null;
  const bonus = Number(d.bonus || 0);
  return { referrerId, bonus: Math.max(0, bonus) };
}

// Move up to 'bonus' from referrer's returnsWallet -> accountBalance
// Write a single deterministic transfer: REF-<stakeId>-<referrerId>
async function moveReferralBonus(referrerId, stakeId, bonus){
  const _db = db();
  const uRef = _db.collection(USERS_COL).doc(referrerId);
  const tRef = _db.collection(TRANSFERS_COL).doc(`REF-${stakeId}-${referrerId}`);

  let moved = 0;

  await _db.runTransaction(async (tx)=>{
    const [uSnap, tSnap] = await Promise.all([ tx.get(uRef), tx.get(tRef) ]);
    if (tSnap.exists){ moved = Number(tSnap.data()?.amount || 0); return; } // idempotent
    if (!uSnap.exists) return;

    const u = uSnap.data() || {};
    const available = Number(u.returnsWallet || 0);
    const take = Math.min(available, Number(bonus)||0);
    if (take <= 0) return;

    tx.update(uRef, {
      accountBalance: Number(u.accountBalance || 0) + take,
      returnsWallet: available - take,
      updatedAt: now(),
    });
    tx.set(tRef, {
      amount: round0(take),
      userId: referrerId,
      phone: u.phone || "",
      type: "transfer",
      reason: `Referral bonus for stake ${stakeId}`,
      source: "auto-distributor",
      createdAt: now(),
    });
    moved = take;
  });

  return moved;
}

/* --------------- Distribution helpers --------------- */

// All unique userIds having at least one active stake
async function listAllUsersWithActiveStake(){
  const _db = db();
  const ids = new Set();
  const base = _db.collection(STAKES_COL).where("status","==","active");
  let last = null;

  while(true){
    let q = base.orderBy("stakeId").limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach(d => { const uid = d.data()?.userId; if (uid) ids.add(uid); });
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }
  return Array.from(ids);
}

// For a slice of users, move min(portion, returnsWallet) into accountBalance and log one transfer each.
async function distributeSlice(userIds, portion, stakeId){
  const _db = db();
  let distributed = 0;

  if (!userIds.length) return 0;

  const refs = userIds.map(id => _db.collection(USERS_COL).doc(id));
  const snaps = await _db.getAll(...refs);

  const batch = _db.batch();
  for (const snap of snaps){
    if (!snap.exists) continue;
    const u = snap.data() || {};
    const uid = snap.id;

    const avail = Number(u.returnsWallet || 0);
    const take  = Math.min(avail, portion);
    if (take <= 0) continue;

    distributed += take;

    batch.update(snap.ref, {
      accountBalance: Number(u.accountBalance || 0) + take,
      returnsWallet: avail - take,
      updatedAt: now(),
    });

    const txId  = `DIST-${stakeId}-${uid}`;
    const txRef = _db.collection(TRANSFERS_COL).doc(txId);
    batch.set(txRef, {
      amount: round0(take),
      userId: uid,
      phone: u.phone || "",
      type: "transfer",
      reason: `Auto distribution from stake ${stakeId}`,
      source: "auto-distributor",
      createdAt: now(),
    }, { merge:true });
  }
  await batch.commit();
  return distributed;
}

module.exports = { start, runForStake };