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
// Résolution depuis Stripe (source de vérité — pas de base locale).
// Un email peut correspondre à plusieurs clients ; on cherche celui qui a
// un abonnement actif, sinon on renvoie le 1er client trouvé (pour le portail).
// ---------------------------------------------------------------------------
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

async function customersByEmail(email) {
  const res = await stripe.customers.list({ email, limit: 10 });
  return res.data;
}

async function activeSubscriptionFor(customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  return subs.data.find((s) => ACTIVE_STATUSES.includes(s.status)) || null;
}

// -> { customer, sub } ; customer/sub peuvent être null.
async function resolveByEmail(email) {
  const customers = await customersByEmail(email);
  for (const c of customers) {
    const sub = await activeSubscriptionFor(c.id);
    if (sub) return { customer: c, sub };
  }
  return { customer: customers[0] || null, sub: null };
}

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

// L'état n'est plus persisté localement : Stripe est la source de vérité,
// /api/subscription-status l'interroge en direct. Le webhook sert au log/observabilité
// (et reste utile pour brancher e-mails, analytics, etc. plus tard).
async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const email = event.data.object?.customer_details?.email || event.data.object?.metadata?.email || '?';
      console.log(`✓ Abonnement souscrit: ${email}`);
      break;
    }
    case 'customer.subscription.updated':
      console.log(`↻ Abonnement mis à jour: client ${event.data.object?.customer} (${event.data.object?.status})`);
      break;
    case 'customer.subscription.deleted':
      console.log(`✗ Abonnement terminé: client ${event.data.object?.customer}`);
      break;
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

    // Réutilise le client Stripe existant (recherché directement chez Stripe).
    const existing = (await customersByEmail(email))[0];
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      ...(existing?.id
        ? { customer: existing.id }
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
    res.status(500).json({ error: 'Création de session impossible.' });
  }
});

// ---------------------------------------------------------------------------
// STATUS — l'extension interroge cet endpoint (REFRESH_SUBSCRIPTION).
// ---------------------------------------------------------------------------
app.get('/api/subscription-status', async (req, res) => {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) return res.json({ active: false, cancelAtPeriodEnd: false, currentPeriodEnd: null });
  try {
    const { sub } = await resolveByEmail(email);
    res.json({
      active: !!sub,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      currentPeriodEnd: sub?.current_period_end ?? null
    });
  } catch (e) {
    console.error('status:', e.message);
    res.status(500).json({ active: false, error: 'Vérification du statut impossible.' });
  }
});

// ---------------------------------------------------------------------------
// PORTAL — portail client Stripe (gérer carte, factures, résilier).
// ---------------------------------------------------------------------------
app.post('/api/portal', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const { customer } = await resolveByEmail(email);
    if (!customer?.id) return res.status(404).json({ error: 'Client introuvable.' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
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
    const { sub: current } = await resolveByEmail(email);
    if (!current?.id) return res.status(404).json({ error: 'Abonnement introuvable.' });

    const sub = immediate
      ? await stripe.subscriptions.cancel(current.id)
      : await stripe.subscriptions.update(current.id, { cancel_at_period_end: true });

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
