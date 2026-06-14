// server.js — Backend Stripe TubeToPost
// Endpoints (alignés sur config.js de l'extension) :
//   POST /api/checkout              -> crée une session Stripe Checkout (abo 15€/mois)
//   POST /api/webhook               -> reçoit les événements Stripe (raw body, signature vérifiée)
//   GET  /api/subscription-status   -> { active: bool } pour un email
//   POST /api/portal                -> session du portail client Stripe (gestion/résiliation)
//   POST /api/cancel                -> résiliation en 1 clic (cancel_at_period_end)
// Pages ouvertes par l'extension :
//   GET  /upgrade                   -> mini page email -> Checkout
//   GET  /account                   -> page gestion (statut + résilier en 1 clic)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import * as store from './store.js';

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  PORT = 4242
} = process.env;

// URL publique : explicite, sinon celle injectée par Render, sinon local.
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

if (!STRIPE_SECRET_KEY) {
  console.error('FATAL: STRIPE_SECRET_KEY manquant. Copier .env.example en .env.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// CORS : l'extension appelle depuis une origine chrome-extension://
app.use(cors({ origin: true }));

// ---------------------------------------------------------------------------
// WEBHOOK — DOIT recevoir le corps brut (raw) AVANT express.json().
// ---------------------------------------------------------------------------
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Toujours répondre 200 vite ; traiter l'event ensuite.
  handleEvent(event).catch((e) => console.error('handleEvent:', e));
  res.json({ received: true });
});

async function handleEvent(event) {
  switch (event.type) {
    // Abonnement souscrit avec succès.
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') break;
      const email = (session.customer_details?.email || session.metadata?.email || '').toLowerCase();
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      let currentPeriodEnd = null;
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        currentPeriodEnd = sub.current_period_end;
      }
      if (email) {
        store.upsert(email, {
          customerId, subscriptionId,
          status: 'active', currentPeriodEnd, cancelAtPeriodEnd: false
        });
        console.log(`✓ Abonnement actif: ${email}`);
      }
      break;
    }

    // Changement d'état (renouvellement, annulation programmée, paiement échoué…).
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const active = ['active', 'trialing', 'past_due'].includes(sub.status);
      store.updateByCustomerId(sub.customer, {
        status: active ? 'active' : 'inactive',
        subscriptionId: sub.id,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end
      });
      break;
    }

    // Abonnement réellement terminé.
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      store.updateByCustomerId(sub.customer, { status: 'inactive', cancelAtPeriodEnd: false });
      console.log(`✗ Abonnement terminé: client ${sub.customer}`);
      break;
    }

    default:
      break;
  }
}

// JSON pour toutes les AUTRES routes (après le webhook raw).
app.use(express.json());

// ---------------------------------------------------------------------------
// CHECKOUT — crée la session d'abonnement.
// ---------------------------------------------------------------------------
app.post('/api/checkout', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Email invalide.' });
    }
    if (!STRIPE_PRICE_ID) return res.status(500).json({ error: 'STRIPE_PRICE_ID non configuré.' });

    // Réutilise le client Stripe existant si déjà connu.
    const existing = store.getByEmail(email);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      ...(existing?.customerId
        ? { customer: existing.customerId }
        : { customer_email: email }),
      client_reference_id: email,
      metadata: { email },
      subscription_data: { metadata: { email } },
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/account?status=success&email=${encodeURIComponent(email)}`,
      cancel_url: `${PUBLIC_URL}/upgrade?status=cancel`
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('checkout:', e.message);
    // Détail Stripe exposé pour le debug (type/code/message). À retirer ensuite.
    res.status(500).json({
      error: 'Création de session impossible.',
      detail: e.message,
      type: e.type,
      code: e.code,
      param: e.param
    });
  }
});

// ---------------------------------------------------------------------------
// STATUS — l'extension interroge cet endpoint (REFRESH_SUBSCRIPTION).
// ---------------------------------------------------------------------------
app.get('/api/subscription-status', (req, res) => {
  const email = String(req.query?.email || '').trim().toLowerCase();
  const rec = email ? store.getByEmail(email) : null;
  const active = rec?.status === 'active';
  res.json({
    active,
    cancelAtPeriodEnd: rec?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: rec?.currentPeriodEnd ?? null
  });
});

// ---------------------------------------------------------------------------
// PORTAL — portail client Stripe (gérer carte, factures, résilier).
// ---------------------------------------------------------------------------
app.post('/api/portal', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const rec = store.getByEmail(email);
    if (!rec?.customerId) return res.status(404).json({ error: 'Client introuvable.' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: rec.customerId,
      return_url: `${PUBLIC_URL}/account?email=${encodeURIComponent(email)}`
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error('portal:', e.message);
    res.status(500).json({ error: 'Portail indisponible.' });
  }
});

// ---------------------------------------------------------------------------
// CANCEL — résiliation en 1 clic. Éthique : on garde l'accès jusqu'à la fin
// de la période déjà payée (cancel_at_period_end), aucun débit supplémentaire.
// ---------------------------------------------------------------------------
app.post('/api/cancel', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const immediate = req.body?.immediate === true;
    const rec = store.getByEmail(email);
    if (!rec?.subscriptionId) return res.status(404).json({ error: 'Abonnement introuvable.' });

    let sub;
    if (immediate) {
      sub = await stripe.subscriptions.cancel(rec.subscriptionId);
    } else {
      sub = await stripe.subscriptions.update(rec.subscriptionId, { cancel_at_period_end: true });
    }

    store.upsert(email, {
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      status: sub.status === 'canceled' ? 'inactive' : rec.status,
      currentPeriodEnd: sub.current_period_end
    });

    res.json({
      ok: true,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      accessUntil: sub.current_period_end,
      message: immediate
        ? 'Abonnement résilié immédiatement.'
        : "Résiliation enregistrée. Accès maintenu jusqu'à la fin de la période payée, sans nouveau prélèvement."
    });
  } catch (e) {
    console.error('cancel:', e.message);
    res.status(500).json({ error: 'Résiliation impossible.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Pages ouvertes par l'extension (chrome.tabs.create).
// ---------------------------------------------------------------------------
app.get('/upgrade', (_req, res) => res.type('html').send(UPGRADE_PAGE));
app.get('/account', (_req, res) => res.type('html').send(ACCOUNT_PAGE));

app.listen(PORT, () => console.log(`TubeToPost backend → ${PUBLIC_URL} (port ${PORT})`));

// ---------------------------------------------------------------------------
// Pages HTML minimalistes (mêmes couleurs que l'extension).
// ---------------------------------------------------------------------------
const STYLE = `
  :root{--p:#6d5efc;--pf:#5b4ce0;--fg:#0f1115;--mut:#6b7280;--bd:#e8eaee;--soft:#efeefe}
  *{box-sizing:border-box;margin:0;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif}
  body{min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:var(--fg);padding:24px}
  .card{background:#fff;border:1px solid var(--bd);border-radius:16px;padding:34px;max-width:420px;width:100%;
    box-shadow:0 8px 30px rgba(16,18,24,.06)}
  h1{font-size:21px;letter-spacing:-.02em}.price{font-size:34px;font-weight:800;margin:6px 0}
  .price small{font-size:15px;color:var(--mut);font-weight:600}
  p{color:var(--mut);font-size:14px;line-height:1.55;margin:8px 0}
  ul{list-style:none;margin:16px 0;display:flex;flex-direction:column;gap:7px}
  li{font-size:13.5px;color:var(--mut);padding-left:22px;position:relative}
  li::before{content:"✓";position:absolute;left:0;color:#16a34a;font-weight:700}
  input{width:100%;padding:12px 14px;border:1px solid #d7dae0;border-radius:10px;font-size:14px;margin:12px 0;outline:none}
  input:focus{border-color:var(--p);box-shadow:0 0 0 3px var(--soft)}
  button{width:100%;padding:13px;border:0;border-radius:10px;background:var(--p);color:#fff;font-size:14.5px;
    font-weight:600;cursor:pointer}button:hover{background:var(--pf)}button:disabled{opacity:.6}
  .ghost{background:#fff;color:var(--fg);border:1px solid #d7dae0;margin-top:10px}.ghost:hover{background:#f8f9fb}
  .msg{font-size:13px;margin-top:12px;text-align:center}.ok{color:#16a34a}.err{color:#dc2626}
  .logo{width:46px;height:46px;border-radius:12px;background:var(--soft);color:var(--p);display:grid;
    place-items:center;font-size:22px;margin-bottom:16px}
`;

const UPGRADE_PAGE = `<!doctype html><html lang=fr><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>TubeToPost Pro</title>
<style>${STYLE}</style><div class=card>
  <div class=logo>▶</div>
  <h1>TubeToPost Pro</h1>
  <div class=price>15€<small>/mois</small></div>
  <p>Tarif transparent, sans frais cachés. Désabonnement en un clic, à tout moment.</p>
  <ul><li>Posts illimités via OpenAI / Claude</li><li>Filtrage éthique inclus</li>
    <li>Résiliation en 1 clic</li></ul>
  <input id=email type=email placeholder="votre@email.com" autocomplete=email>
  <button id=go>S'abonner</button>
  <div id=msg class=msg></div>
</div>
<script>
  const q=new URLSearchParams(location.search);
  if(q.get('status')==='cancel'){msg.textContent='Paiement annulé.';msg.className='msg err';}
  go.onclick=async()=>{
    const email=document.getElementById('email').value.trim();
    if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){msg.textContent='Email invalide.';msg.className='msg err';return;}
    go.disabled=true;go.textContent='Redirection…';
    try{
      const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email})});
      const d=await r.json();
      if(d.url)location.href=d.url;else{msg.textContent=d.error||'Erreur.';msg.className='msg err';go.disabled=false;go.textContent="S'abonner";}
    }catch(e){msg.textContent='Erreur réseau.';msg.className='msg err';go.disabled=false;go.textContent="S'abonner";}
  };
</script></html>`;

const ACCOUNT_PAGE = `<!doctype html><html lang=fr><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Mon compte TubeToPost</title>
<style>${STYLE}</style><div class=card>
  <div class=logo>▶</div>
  <h1>Mon abonnement</h1>
  <div id=state><p>Chargement…</p></div>
  <input id=email type=email placeholder="votre@email.com" autocomplete=email>
  <button id=check class=ghost>Vérifier mon statut</button>
  <div id=actions style=display:none>
    <button id=cancel>Résilier en 1 clic</button>
    <button id=portal class=ghost>Gérer (carte, factures)</button>
  </div>
  <div id=msg class=msg></div>
</div>
<script>
  const q=new URLSearchParams(location.search);
  const emailEl=document.getElementById('email');
  if(q.get('email'))emailEl.value=q.get('email');
  if(q.get('status')==='success'){msg.textContent='Merci ! Abonnement activé.';msg.className='msg ok';}
  async function refresh(){
    const email=emailEl.value.trim();if(!email)return;
    const r=await fetch('/api/subscription-status?email='+encodeURIComponent(email));
    const d=await r.json();
    const st=document.getElementById('state');const act=document.getElementById('actions');
    if(d.active){
      const end=d.currentPeriodEnd?new Date(d.currentPeriodEnd*1000).toLocaleDateString('fr-FR'):'—';
      st.innerHTML='<p style=color:#16a34a;font-weight:600>● Abonnement actif</p>'+
        (d.cancelAtPeriodEnd?'<p>Résiliation programmée. Accès jusqu\\'au '+end+'.</p>':'<p>Prochain renouvellement: '+end+'.</p>');
      act.style.display=d.cancelAtPeriodEnd?'none':'block';
    }else{st.innerHTML='<p>Aucun abonnement actif pour cet email.</p>';act.style.display='none';}
  }
  document.getElementById('check').onclick=refresh;
  if(emailEl.value)refresh();
  document.getElementById('cancel').onclick=async()=>{
    const email=emailEl.value.trim();
    const r=await fetch('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})});
    const d=await r.json();
    msg.textContent=d.message||d.error||'';msg.className='msg '+(d.ok?'ok':'err');
    refresh();
  };
  document.getElementById('portal').onclick=async()=>{
    const email=emailEl.value.trim();
    const r=await fetch('/api/portal',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})});
    const d=await r.json();if(d.url)location.href=d.url;else{msg.textContent=d.error||'Erreur.';msg.className='msg err';}
  };
</script></html>`;
