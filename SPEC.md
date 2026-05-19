# PeopleFinder — Spécification

## 1. Contexte et objectif

Outil web permettant à plusieurs personnes d'un voisinage de cartographier collectivement les zones déjà parcourues lors de la recherche d'une personne disparue. Chaque contributeur dépose une trace (GPX ou tracé manuel) avec un nom, une date et un degré de confiance. Toutes les traces sont visibles sur une carte unique partagée par un simple lien.

**Statut visé : Proof of Concept** — fonctionnel, hébergeable rapidement, pas de production-grade.

## 2. Périmètre fonctionnel (V1)

### Inclus

- Carte interactive (fond OSM) accessible via une URL unique.
- Ajout d'une trace par **upload de fichier GPX**.
- Ajout d'une trace en **mode manuel** (clics sur la carte pour poser les points).
- Métadonnées par trace : **nom**, **date** (par défaut : aujourd'hui), **niveau de confiance** (faible / moyen / fort), **auteur** (champ libre).
- Affichage des traces sous forme de polylignes colorées :
  - **Faible** → rouge `#e74c3c`
  - **Moyen** → orange `#f39c12`
  - **Fort** → jaune `#f1c40f`
- **Halo (overlay)** autour de chaque trace : polyligne secondaire plus large (en **pixels**), même couleur, opacité ~0.25, largeur variant selon la confiance (faible : étroit, fort : large). **Approximation visuelle**, pas un buffer géodésique (cf. §6).
- Liste latérale des traces : nom, auteur, date, confiance, bouton suppression.
- **Suppression** d'une trace : bouton avec modale de confirmation. Suppression **soft** (cf. §4.5).
- Persistance en base PostgreSQL.
- **Mobile-first**.

### Exclus de la V1 (volontairement)

- Authentification / comptes utilisateurs (tout détenteur de l'URL peut tout faire).
- Vraies zones de couverture (buffers géodésiques, grilles de tuiles, calcul d'aire balayée).
- Édition d'une trace existante (on supprime et on recrée).
- Endpoint ou UI de restauration d'une trace supprimée (volontaire — rollback en DB uniquement).

## 3. Stack technique

| Couche | Choix |
|---|---|
| Backend | **FastAPI** (Python) |
| DB | **PostgreSQL 16**, **externe** au conteneur. Points stockés en **JSONB**. Pas de PostGIS. |
| Front | **Vanilla JS + HTML** servis par FastAPI. Pas de build step, pas de SPA séparée. |
| Carto | **Leaflet** + fond OSM. |
| Docker | **Une seule image** contient backend + assets statiques. |

### Hébergement

- L'image Docker est **hostée sur un serveur remote** géré par l'utilisateur.
- Les commandes `docker build` / `docker run` ne sont **pas** exécutées localement par l'agent : l'agent fournit les commandes prêtes à copier-coller, l'utilisateur les exécute sur son serveur.

### Configuration

- Connexion DB via une **unique variable d'environnement `DATABASE_URL`** au format `postgres://user:pass@host:port/db`.
- Au boot du conteneur : exécution d'un **script Python d'init du schéma**, idempotent (`CREATE TABLE IF NOT EXISTS`, etc.). Pas d'Alembic ni d'autre outil de migration.

## 4. Modèle de données et API

### 4.1 Schéma SQL (cible)

Table `traces` :
- `id` — identifiant (uuid ou bigserial).
- `name` — texte, non null.
- `author` — texte, non null.
- `confidence` — enum / contrainte CHECK parmi `low | medium | high`.
- `recorded_at` — date.
- `source` — enum / texte (`gpx` | `manual`).
- `points` — **JSONB**, tableau ordonné de `[lon, lat]` (ou `{lat, lon}`).
- `bbox` — JSONB ou colonnes séparées (`min_lat`, `min_lon`, `max_lat`, `max_lon`) pour accélérer le `fitBounds`.
- `created_at` — `TIMESTAMPTZ DEFAULT NOW()`.
- `deleted_at` — `TIMESTAMPTZ NULL`.

Index recommandés :
- index partiel sur lectures vivantes : `CREATE INDEX ... ON traces (created_at) WHERE deleted_at IS NULL;`

### 4.2 Endpoints

- `GET /traces`
  - Par défaut : renvoie uniquement les traces avec `deleted_at IS NULL`.
  - Query param `?include_deleted=true` : renvoie aussi les traces soft-deleted.
  - Chaque trace expose `deleted_at` (null ou ISO 8601) pour permettre au front de distinguer.
- `POST /traces`
  - Création d'une trace (depuis le mode manuel : JSON ; depuis GPX : `multipart/form-data`).
- `POST /traces/gpx` (ou même endpoint avec content-type différent — au choix de l'implémentation)
  - Upload GPX. Limite **1 Mo**. Rejet si contenu non-GPX ou invalide → erreur HTTP claire.
- `DELETE /traces/{id}`
  - Soft-delete : `UPDATE traces SET deleted_at = NOW() WHERE id = ...`.
  - **Idempotent** : re-suppression d'une trace déjà supprimée = no-op (réponse 200/204).
- Servir les assets statiques du front (`/`, `/static/...`).

### 4.3 Parsing GPX

- **Côté serveur uniquement** (un seul parseur dans le projet, en Python).
- Validation : taille ≤ 1 Mo, structure GPX valide, au moins un point. Sinon → erreur 400.

### 4.4 Édition

- **Pas d'édition** d'une trace existante. Pour corriger une trace, l'utilisateur la supprime et la recrée.

### 4.5 Suppression et rollback

- Le `DELETE` API écrit `deleted_at = NOW()`, ne fait **pas** de `DELETE` SQL.
- Restauration : opération **manuelle** en base (`UPDATE traces SET deleted_at = NULL WHERE id = ...`).
- **Aucun endpoint ni bouton UI** de restauration n'est exposé (volontaire).

## 5. Frontend — comportement

### 5.1 Layout

- Carte plein écran à gauche.
- Panneau latéral droit (~320 px, repliable sur mobile) :
  - Bouton **« + Ajouter une trace »** → modale avec deux onglets : *Upload GPX* / *Tracer manuellement*.
  - Toggle **« Afficher les traces supprimées »** (cf. §5.4).
  - Liste des traces : pastille de couleur, nom, auteur, date, bouton suppression.
- Au chargement : `fitBounds` sur l'union des bbox des **traces non supprimées uniquement**.

### 5.2 Mode manuel

1. Clic sur « Tracer manuellement » → la carte passe en mode draw.
2. Chaque clic sur la carte = ajoute un point. Une polyligne en pointillés montre le tracé en cours.
3. **Double-clic sur un point existant** = annule le **dernier point posé**. Ce n'est **pas** la fin du tracé.
4. Bouton **« Terminer »** = ouvre la modale métadonnées (nom / auteur / confiance / date par défaut aujourd'hui), puis crée la trace.
5. Bouton **« Annuler »** = sort du mode sans rien créer.

### 5.3 Upload GPX

- Drag-and-drop dans la modale OU sélecteur de fichier.
- Envoi au serveur, parsing serveur, retour de la trace créée.

### 5.4 Filtre « Afficher les traces supprimées »

- Toggle dans le panneau latéral.
- **OFF par défaut.** Non persistant entre rechargements (pas de `localStorage`).
- Quand ON : refetch `GET /traces?include_deleted=true`.
- Rendu des traces supprimées :
  - polyligne en **pointillés** (`dashArray`),
  - opacité réduite (~0.4), **halo masqué**,
  - dans la liste latérale : nom **barré** + libellé `(supprimée le JJ/MM/AAAA)`,
  - **aucune** action UI (pas de bouton corbeille, pas de restore — opération DB).
- Les traces supprimées **ne participent pas** au `fitBounds` initial ni à un éventuel compteur « X traces / Y km ».

### 5.5 Suppression

- Bouton corbeille → modale `« Supprimer la trace "X" ? Cette action est irréversible. »` avec **Annuler** / **Supprimer**.
- Message « irréversible » assumé côté UX : le rollback existe mais c'est une opération DB hors application.

## 6. Approximation halo / buffer

Le halo autour de chaque trace est une polyligne Leaflet plus large en **pixels** (donc dépendante du zoom). Ce n'est **pas** un buffer géodésique :
- pas de turf.js,
- pas de `ST_Buffer`,
- pas de calcul d'aire couverte en m².

Conséquence : la largeur visuelle ne correspond pas à une distance terrain constante. C'est assumé pour le PoC.

## 7. Sécurité et limites du PoC

- **Pas d'auth.** Quiconque dispose de l'URL peut lire, créer et supprimer.
- **Pas de rate limiting.**
- **CORS** : même origine, pas de configuration nécessaire.
- **GPX** : taille ≤ 1 Mo, structure valide. Rejet propre sinon.

## 8. Features bonus (optionnelles, ne pas implémenter sans demande)

1. **Filtre par date** : range picker pour n'afficher que les traces d'une période.
2. **Filtre par confiance** : checkboxes faible/moyen/fort.
3. **Marqueur de départ** : point vert au début de chaque trace.
4. **Popup au survol/clic** : nom, auteur, date, longueur estimée en km.
5. **Compteur global** : « X traces, Y km parcourus au total ».
6. **Zones « à explorer »** : tracé suggéré (non parcouru) dans une couleur distincte (bleu/violet).

## 9. Workflow de build et déploiement

L'image Docker est buildée et déployée **sur un serveur remote géré par l'utilisateur**. L'agent ne lance pas de commande Docker localement ; il fournit les commandes à exécuter.

Commandes types à fournir (à adapter quand le `Dockerfile` existera) :

```bash
# Sur le serveur remote, à la racine du projet :
docker build -t peoplefinder:latest .

docker run -d \
  --name peoplefinder \
  --restart unless-stopped \
  -p 8000:8000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/peoplefinder" \
  peoplefinder:latest

# Logs / suivi :
docker logs -f peoplefinder

# Mise à jour :
docker pull peoplefinder:latest   # si registry, sinon rebuild
docker stop peoplefinder && docker rm peoplefinder
# puis relancer le docker run ci-dessus
```

La DB PostgreSQL 16 tourne **hors** du conteneur applicatif (managée ou conteneur séparé), accessible via `DATABASE_URL`.
