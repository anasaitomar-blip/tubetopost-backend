# Déploiement du backend sur Render

Objectif : obtenir une **vraie URL HTTPS publique** pour le webhook Stripe
(le réseau local casse les tunnels à cause de l'interception TLS).

URL finale du webhook : `https://<ton-service>.onrender.com/api/webhook`

---

## 1. Mettre le code sur GitHub

Le dossier `backend/` est déjà un repo git prêt (node_modules, .env, data/ ignorés).

Crée un repo vide sur https://github.com/new (ex: `tubetopost-backend`), puis :

```powershell
# Dans cette session Claude Code, préfixe par ! pour exécuter en local :
! cd C:\Users\djibr\Desktop\tubetopost\backend
! git remote add origin https://github.com/<TON_USER>/tubetopost-backend.git
! git branch -M main
! git push -u origin main
```

> Si `git push` échoue sur un certificat (interception TLS) :
> `! git -c http.sslVerify=false push -u origin main`
> (ou installe le certificat racine de ton AV dans git).

---

## 2. Créer le service sur Render

1. https://dashboard.render.com → **New** → **Web Service**
2. Connecte ton repo GitHub `tubetopost-backend`
3. Render détecte `render.yaml` (Blueprint). Sinon, réglages manuels :
   - Runtime: **Node**
   - Build: `npm install`
   - Start: `npm start`
   - Health check: `/health`
   - Plan: **Free**

---

## 3. Variables d'environnement (dans Render, onglet Environment)

| Clé | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | ta **nouvelle** clé `sk_live_...` ou `rk_live_...` (après rotation !) |
| `STRIPE_PRICE_ID` | `price_1TiGbfQfwGpnUACeJWqybF37` |
| `STRIPE_WEBHOOK_SECRET` | (rempli à l'étape 5) |

> `PUBLIC_URL` inutile : Render fournit `RENDER_EXTERNAL_URL`, déjà géré dans `server.js`.

Déploie. Vérifie : `https://<service>.onrender.com/health` → `{"ok":true}`.

---

## 4. Déclarer le webhook dans Stripe

Dashboard Stripe → **Developers → Webhooks → Add endpoint** :

- Endpoint URL : `https://<service>.onrender.com/api/webhook`
- Events à écouter :
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

---

## 5. Récupérer le signing secret

Après création de l'endpoint, Stripe affiche un **Signing secret** `whsec_...`.
Copie-le dans Render → `STRIPE_WEBHOOK_SECRET` → re-déploie (ou "Save, rebuild").

---

## 6. Lier l'extension

Dans `../config.js`, section `STRIPE`, remplace le domaine par ton URL Render :

```js
checkoutUrl: 'https://<service>.onrender.com/api/checkout',
portalUrl:   'https://<service>.onrender.com/api/portal',
statusUrl:   'https://<service>.onrender.com/api/subscription-status',
```

Et dans `popup.js` / `options.js`, les liens `tubetopost.com/upgrade` et
`/account` → `https://<service>.onrender.com/upgrade` et `/account`.

---

## ⚠️ Limite du plan Free

- Disque **éphémère** : `store.js` (fichier JSON) est réinitialisé à chaque
  redéploiement / mise en veille. Les abonnements enregistrés peuvent être perdus.
- Pour la prod : remplace `store.js` par une vraie base (Render Postgres,
  Upstash Redis…). Stripe reste la source de vérité — un `GET /api/subscription-status`
  peut être réécrit pour interroger Stripe directement.
- Le service Free se met en veille après inactivité : le 1er webhook peut être
  lent, mais **Stripe réessaie automatiquement**.
