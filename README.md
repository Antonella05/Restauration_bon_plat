# Le Bon Plat — MVP Web (Gestion des commandes & livraisons)

Application **web** de gestion des commandes et livraisons pour un restaurant.
Ce dépôt correspond au **MVP (Phase 1)** du cahier des charges, en **version web
uniquement**, avec **tous les acteurs** connectables et une **interface dédiée par rôle**.

> Stack : **HTML/CSS/JavaScript**, **Node.js + Express**, et **SQLite en local** ou
> **Neon PostgreSQL sur Vercel**. Le suivi des commandes utilise une synchronisation
> périodique compatible avec les serveurs locaux et les fonctions serverless.

## Acteurs & interfaces

| Acteur | Connexion | Interface |
|---|---|---|
| **Client** | Nom + téléphone (simplifié, conforme MVP) | Accueil, menu dynamique par catégories, fiches produits, panier + commentaire, formulaire de commande, choix du mode de paiement (Cash / Mobile Money affiché), **suivi de commande en temps réel** |
| **Gestionnaire de commandes / Call center** | Identifiant + mot de passe | Réception des commandes en **temps réel** (notification), détail, boutons **Accepter / Annuler**, compteurs par statut |
| **Gérant** | Identifiant + mot de passe | Liste des commandes + **mise à jour du statut** (en attente → préparation → livraison → livrée), tableau de bord (compteurs, recettes livrées, produits les plus commandés) |
| **Administrateur** | Identifiant + mot de passe | Accès complet : commandes, tableau de bord **et** gestion du catalogue |
| **Développeur** | Identifiant + mot de passe | **Gestion du catalogue produits** (catégories + produits : ajout / modification / suppression / disponibilité) |

## Périmètre couvert (MVP du cahier des charges)

Côté client : page d'accueil, authentification simplifiée, menu dynamique chargé depuis
la base, fiches produits, panier, formulaire de commande, suivi de commande temps réel,
affichage du mode de paiement (Cash / Mobile Money — enregistré en « paiement à la
livraison », **sans** transaction automatisée, comme prévu pour le MVP).

Côté back-office : liste des commandes, mise à jour du statut.

Côté call center : notification périodique de nouvelle commande,
consultation et validation (Accepter / Annuler), suivi temps réel partagé entre tous les rôles.

Côté développeur : mise à jour du catalogue produits.

> Les fonctionnalités marquées « Phase 2 » dans le cahier des charges (paiement Mobile
> Money réel, billetterie/réservation, offres spéciales, avis, publication sur les stores…)
> ne sont volontairement pas incluses dans ce MVP.

## Démarrage

```bash
npm install      # installe les dépendances
npm start        # démarre le serveur (port 3000 par défaut)
```

Puis ouvrir :

- **Espace client** : http://localhost:3000/
- **Espace staff** : http://localhost:3000/staff.html

En local, la base SQLite (`data/restaurant.db`) et le menu et comptes de démonstration
sont créés automatiquement au premier appel à l'API.

## Déploiement Vercel

Le dépôt contient `vercel.json`, un build statique et une fonction Express pour l'API.
Sur Vercel, les données sont stockées dans Neon PostgreSQL ; elles ne sont pas écrites
dans le système de fichiers temporaire de la fonction.
La connexion Neon est ouverte pour chaque requête API puis fermée avec sa réponse,
conformément au fonctionnement des connexions WebSocket en environnement serverless.

1. Crée un projet PostgreSQL sur [Neon](https://neon.tech/) et copie l'URL de connexion
   **pooled** depuis son tableau de bord.
2. Dans Vercel, ouvre le projet **Restauration → Settings → Build and Deployment** :
   - **Root Directory** : laisse la racine du dépôt (`./`, valeur par défaut).
   - **Framework Preset** : `Other`.
   - **Build Command** : `npm run build`.
   - **Output Directory** : `dist`.
3. Dans **Settings → Environment Variables**, ajoute les variables suivantes pour
   **Production** (et Preview si tu souhaites utiliser les prévisualisations) :
   - `DATABASE_URL` : URL pooled Neon.
   - `JWT_SECRET` : secret aléatoire d'au moins 32 caractères.
   - `INITIAL_ADMIN_USERNAME` : identifiant de l'administrateur initial.
   - `INITIAL_ADMIN_PASSWORD` : mot de passe initial d'au moins 12 caractères.
4. Enregistre les variables, puis ouvre **Deployments** et relance un déploiement
   depuis la branche reliée au dépôt. Le schéma PostgreSQL, le menu de démonstration et
   l'administrateur sont initialisés au premier appel API. Vérifie le résultat sur
   `/api/health`.
5. Après la première connexion réussie à l'espace staff, retire
   `INITIAL_ADMIN_PASSWORD` des variables Vercel si tu n'en as plus besoin ; le compte
   déjà créé reste dans la base.

Les comptes staff de démonstration (`admin/admin123`, etc.) ne sont créés qu'en local.
Ne partage pas les valeurs de ces variables et ne les ajoute pas au dépôt. La base Neon
commence vide : les commandes, comptes et personnalisations déjà présents dans un
fichier SQLite local ne sont pas transférés automatiquement.

## Photos

En attendant les vraies photos du restaurant, le site affiche des **photos d'illustration
libres de droits (Unsplash)**, choisies automatiquement selon le nom du plat ou de la
catégorie (`public/js/common.js`, tables `DISH_PHOTOS` / `CATEGORY_PHOTOS`).
Dès qu'une adresse `https://` est saisie dans le champ « Image » d'un produit
(Staff → Catalogue), c'est elle qui est affichée. La photo d'accueil se change dans
Staff → Personnalisation.

## Comptes de démonstration (staff)

| Rôle | Identifiant | Mot de passe |
|---|---|---|
| Administrateur | `admin` | `admin123` |
| Gérant | `gerant` | `gerant123` |
| Call center | `callcenter` | `call123` |
| Développeur | `dev` | `dev123` |

Le **client** se connecte simplement avec un nom et un numéro de téléphone.

## Architecture

```
server/
  index.js          Application Express locale et API serverless
  db.js             Adaptateur SQLite local / Neon PostgreSQL
  schema.postgres.sql Schéma créé automatiquement dans Neon
  settings.js       Paramètres du restaurant (identité, accueil, règles de retrait)
  seed.js           Données de démonstration (comptes staff + menu) — idempotent
  auth.js           JWT, rôles et middlewares d'autorisation
  realtime.js       File d'événements persistée pour le polling
  routes/
    auth.js         Connexion client (nom+tél) et staff (login+mdp)
    menu.js         Menu public (catégories + produits disponibles)
    orders.js       Commandes : création, statuts, modification par le call center, statistiques
    products.js     Gestion du catalogue (développeur / admin)
    settings.js     Lecture publique / mise à jour (admin, développeur) de la personnalisation
public/
  index.html        Application client
  staff.html        Application staff (login + tableaux de bord par rôle)
  js/common.js      Auth (localStorage), appels API, polling, toasts
  js/client.js      Logique de l'interface client
  js/staff.js       Logique des interfaces staff
  css/styles.css    Styles
```

### Statuts de commande

- **Livraison** : `En attente` → `Acceptée` → `En préparation` → `En livraison` → `Livrée`
- **Retrait sur place** : `En attente` → `Acceptée` → `En préparation` → `Prête à retirer` → `Retirée`
  (ou `Non récupérée` si le client ne vient pas)
- À tout moment avant la clôture : `Annulée`.

- Le **call center** peut *accepter* ou *annuler* une commande en attente.
- Le **gérant / admin** fait *avancer* la commande jusqu'à la livraison, ou l'annule.
- Le **client** voit chaque changement en **temps réel** (frise de suivi).

### Sécurité

- Authentification par **JWT** ; mots de passe staff hachés avec **bcrypt**.
- **Autorisation par rôle** sur chaque route sensible (un client ne peut pas accéder au
  back-office, le call center ne peut pas passer une commande en préparation, etc.).
- Le **total** d'une commande est recalculé côté serveur à partir des prix en base
  (jamais fait confiance au montant envoyé par le client).

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `JWT_SECRET` | valeur de développement locale | Secret JWT ; obligatoire en production (32 caractères minimum) |
| `DB_PATH` | `data/restaurant.db` | Emplacement SQLite en local si `DATABASE_URL` n'est pas défini |
| `DATABASE_URL` | aucune en local | URL pooled Neon ; obligatoire sur Vercel et en production |
| `INITIAL_ADMIN_USERNAME` | aucun en production | Identifiant du compte administrateur initial |
| `INITIAL_ADMIN_PASSWORD` | aucun en production | Mot de passe initial (12 caractères minimum) |

## Évolutions suite à la démonstration du 3 septembre 2026

| Chantier | Où | Fonctionnement |
|---|---|---|
| Personnalisation (logo, nom, accueil) | Staff → **Personnalisation** (admin, développeur) | Nom, slogan, logo (import d'image ou URL), couleur principale, textes et photo de l'accueil, téléphone, adresse, horaires. Les plats affichés dans « Nos incontournables » se choisissent dans le **Catalogue** (case « Mettre en avant »). |
| Livraison ou retrait sur place | Tunnel de commande client | Choix du mode ; activation de chaque mode dans la personnalisation. |
| Adresse + géolocalisation | Tunnel de commande client | Adresse libre (quartier, repères) et/ou bouton « Utiliser ma position actuelle ». Le staff voit l'adresse et un lien « Voir sur la carte ». La géolocalisation exige **https** (ou localhost). |
| Commandes récurrentes | Profil client | Nom, téléphone, adresse, position et mode préféré sont mémorisés (case « Mémoriser ») et pré-remplis à la commande suivante. |
| Commandes à retirer | Client + gérant | Retrait « dès que possible » ou à une heure précise (commande à l'avance). Le client est prévenu quand la commande est **prête**, avec les consignes et le délai de conservation. Le gérant clôture en « Retirée » ou « Non récupérée » ; un badge signale le dépassement du délai. |
| Alertes nouvelles commandes | Staff (call center, gérant, admin) | Carillon sonore **répété toutes les 20 s** tant que la commande n'est pas prise en charge, bandeau rouge clignotant, carte surlignée, titre d'onglet clignotant, notification du navigateur (si autorisée). À la connexion, les commandes arrivées en votre absence déclenchent l'alerte. Bouton « Son activé / coupé ». |
| Modification d'une commande | Staff → bouton « Modifier la commande » | Remplacer un produit (ex. Coca-Cola → Panta), ajouter, retirer, changer les quantités. Le produit de remplacement est facturé à son prix ; le total est recalculé côté serveur. L'**accord du client** doit être coché. Historique conservé. |
| Information du client | Espace client « Mes commandes » | Notification temps réel + bandeau « Votre commande a été modifiée » (détail, ancien/nouveau total) avec bouton « J'ai pris connaissance ». Le staff voit si le client a lu la modification. |
| Statistiques quotidiennes | Staff → **Tableau de bord** (gérant, admin) | Pour une date choisie : commandes livrées, retirées sur place, non récupérées, annulées, recettes, commandes reçues par mode, top produits, et historique des 7 derniers jours. |

**Points restant à valider avec chaque restaurant** (paramétrables, non figés dans le code) :
délai de conservation et règle en cas de commande non récupérée (champs de la personnalisation),
étapes exactes du retrait, et comportement des alertes quand aucun membre du staff n'est connecté
(aujourd'hui : l'alerte se déclenche à la prochaine connexion ; une alerte hors ligne type SMS
nécessiterait un service externe).

> Note navigateur : le son ne peut être joué qu'après une première interaction avec la page
> (règle des navigateurs). Après une connexion, c'est automatique ; après un simple rechargement,
> un bandeau invite à cliquer une fois sur la page.
