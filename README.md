# TubeToPost — Backend Stripe

Express + Stripe. Gère l'abonnement Pro (15€/mois), le webhook, et la résiliation en 1 clic.
**Aucune clé secrète ne vit dans l'extension** — tout passe par ce backend.

## Démarrage

```bash
cd backend
npm install
cp .env.example .env     # puis remplir les clés
npm start                # http://localhost:4242
```

> Si `npm install` reste bloqué (machine avec inspection HTTPS / antivirus) :
> `npm install --strict-ssl=false` (ou `npm config set strict-ssl false`).

## Configuration Stripe

1. Dashboard Stripe → **Products** → créer un prix récurrent **15€/mois** → copier `price_...` dans `STRIPE_PRICE_ID`.
2. **Developers → API keys** → copier `sk_...` dans `STRIPE_SECRET_KEY`.
3. Webhook (voir ci-dessous) → copier `whsec_...` dans `STRIPE_WEBHOOK_SECRET`.

## Webhook (essentiel)

Le webhook reçoit le **corps brut** (raw) ; la signature est vérifiée. En local :

```bash
stripe login
stripe listen --forward-to localhost:4242/api/webhook
# copier le whsec_... affiché dans .env
```

Événements traités :
- `checkout.session.completed` → abonnement marqué **actif**
- `customer.subscription.updated` → statut + résiliation programmée synchronisés
- `customer.subscription.deleted` → abonnement **terminé**

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/checkout` | `{email}` → `{url}` session Checkout |
| POST | `/api/webhook` | événements Stripe (raw body) |
| GET  | `/api/subscription-status?email=` | `{active, cancelAtPeriodEnd, currentPeriodEnd}` |
| POST | `/api/portal` | `{email}` → `{url}` portail client |
| POST | `/api/cancel` | `{email, immediate?}` → résiliation 1 clic |
| GET  | `/upgrade` | page d'abonnement (ouverte par l'extension) |
| GET  | `/account` | page gestion + résiliation |
| GET  | `/health` | sonde |

## Résiliation éthique

`/api/cancel` utilise par défaut `cancel_at_period_end: true` : l'utilisateur
**garde l'accès jusqu'à la fin de la période déjà payée**, sans nouveau prélèvement.
`immediate: true` pour couper tout de suite si demandé.

## Lier l'extension

Dans `../config.js`, section `STRIPE`, pointer vers ton domaine déployé :
```js
checkoutUrl: 'https://tubetopost.com/api/checkout',
portalUrl:   'https://tubetopost.com/api/portal',
statusUrl:   'https://tubetopost.com/api/subscription-status',
```
Et l'`statusUrl` doit recevoir l'email — l'extension envoie l'email stocké dans ses réglages.

## Production

- **Pas de base de données** : Stripe est la source de vérité (statut/portail/résiliation
  résolus par email en direct). Le disque éphémère de l'hébergeur n'a aucun impact.
- Servir en HTTPS (Render le fait nativement).
- L'identification se fait par email ; pour un vrai SaaS, ajouter une authentification.
- Volume élevé : mettre un cache court devant `resolveByEmail` pour limiter les appels Stripe.
