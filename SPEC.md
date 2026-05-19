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
- Affichage des traces de recherche sous forme de polylignes colorées (palette ordinale chaude, dégradé orange → rouge sombre) :
  - **Faible** → orange clair `#fb923c`
  - **Moyen** → rouge vif `#ef4444`
  - **Fort** → rouge sombre `#991b1b`
- **Liseré sombre** (`#1a1a1a`, weight 9) systématique sous la ligne couleur des traces vivantes pour garantir la lisibilité sur tout fond (OSM, topo, satellite).
- **Halo (overlay)** autour de chaque trace de recherche : polyligne secondaire plus large (en **pixels**), même couleur, opacité ~0.4, largeur variant selon la confiance (faible : étroit, fort : large). **Approximation visuelle**, pas un buffer géodésique (cf. §6).
- **Tracés "à explorer"** (`kind=todo`) : itinéraires suggérés non encore parcourus. Cyan `#06b6d4`, pointillés épais (`dashArray: "12, 10"`), **pas de halo**, **pas de niveau de confiance**. Mêmes mécaniques (mode manuel ou upload GPX, soft-delete).
- **Sélecteur de fond de carte** en haut-droite : OSM (défaut) / Topographique (OpenTopoMap) / Satellite (Esri World Imagery). Pas de persistance.
- **Spotlight au survol panneau (desktop)** : au `mouseenter` sur un item de la liste latérale, toutes les autres traces sont grisées (opacité ~0.18, couleur grise), la trace ciblée passe au-dessus et garde sa couleur. Désactivé sur tactile (`(hover: hover) and (pointer: fine)`).
- Liste latérale des traces : nom, auteur, date, confiance (si pertinent), bouton suppression. Les `todo` portent un tag visuel "à explorer".
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
- `id` — UUID généré côté serveur.
- `name` — texte, non null.
- `author` — texte, non null.
- `confidence` — texte **NULLABLE** avec CHECK `low | medium | high`. **NULL** pour `kind=todo` (qui n'a pas de niveau de confiance).
- `recorded_at` — date.
- `source` — texte avec CHECK `gpx | manual`.
- `kind` — texte NOT NULL DEFAULT `'search'` avec CHECK `search | todo`. `search` = trace d'une zone parcourue, `todo` = itinéraire à explorer.
- `points` — **JSONB**, tableau ordonné `[[lon, lat], ...]` (style GeoJSON).
- `bbox` — JSONB `{min_lon, min_lat, max_lon, max_lat}` pour accélérer le `fitBounds`.
- `created_at` — `TIMESTAMPTZ DEFAULT NOW()`.
- `deleted_at` — `TIMESTAMPTZ NULL`.

Index recommandés :
- index partiel sur lectures vivantes : `CREATE INDEX ... ON traces (created_at) WHERE deleted_at IS NULL;`

Migrations : `ALTER TABLE traces ADD COLUMN IF NOT EXISTS kind ...` + `ALTER COLUMN confidence DROP NOT NULL` + contraintes ajoutées via bloc `DO $$` idempotent (cf. `app/schema.py`).

### 4.2 Endpoints

- `GET /traces`
  - Par défaut : renvoie uniquement les traces avec `deleted_at IS NULL`.
  - Query param `?include_deleted=true` : renvoie aussi les traces soft-deleted.
  - Query param `?kind=search` ou `?kind=todo` pour filtrer par type ; absent = les deux.
  - Chaque trace expose `kind`, `confidence` (peut être null), `deleted_at`.
- `POST /traces`
  - Création d'une trace de recherche (`kind=search`, mode manuel, JSON).
- `POST /traces/gpx`
  - Upload GPX pour une trace de recherche (`kind=search`, `multipart/form-data`).
- `POST /traces/todo`
  - Création d'un tracé à explorer (`kind=todo`, mode manuel, JSON, sans `confidence`).
- `POST /traces/todo/gpx`
  - Upload GPX pour un tracé à explorer (`kind=todo`, sans `confidence`).
- Limite GPX : **1 Mo**. Rejet si contenu non-GPX ou invalide → erreur HTTP 400/413.
- `DELETE /traces/{id}`
  - Commun aux deux types. Soft-delete : `UPDATE traces SET deleted_at = NOW() WHERE id = ...`.
  - **Idempotent** : re-suppression d'une trace déjà supprimée = no-op (204).
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
- Panneau latéral droit (~320 px, repliable sur mobile) organisé en **deux sections symétriques** :
  - **Tracés déjà cherchés** : 2 boutons d'action directe (*Upload GPX* / *Tracer manuellement*) puis liste des **5 derniers tracés `search` vivants** (ordre `created_at DESC`).
  - **Tracés à chercher** : idem pour les tracés `kind=todo`.
  - Toggle **« Afficher les traces supprimées »** (cf. §5.4) en haut du panneau.
  - **Pas de bouton corbeille** dans la liste latérale (la suppression se fait via la carte, cf. §5.5).
- **Sélecteur de fond de carte** (contrôle Leaflet `L.control.layers`) en haut-droite : OSM (défaut) / Topographique / Satellite, non persistant.
- Au chargement : `fitBounds` sur l'union des bbox des **traces non supprimées uniquement** (`search` + `todo` confondus).

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

### 5.5 Sélection et suppression

- **Sélection sur la carte** : clic sur une polyligne vivante → ouvre un popup Leaflet ancré sur la trace, contenant nom + (auteur · date · confiance si `search`) + boutons **Supprimer** / **Fermer**.
- **Sélection persistante** : tant que la trace est sélectionnée, les autres traces sont atténuées (spotlight) et l'item correspondant dans le panneau latéral est mis en surbrillance.
- **Désélection** : clic sur la carte hors d'une trace, bouton **Fermer** du popup, ou touche **Échap**.
- **Traces supprimées** : `interactive: false` → impossible à sélectionner.
- **Confirmation** : le bouton **Supprimer** du popup ouvre la modale `« Supprimer la trace "X" ? Cette action est irréversible. »` (texte adapté `le tracé à explorer` si `kind=todo`).
- Message « irréversible » assumé côté UX : le rollback existe mais c'est une opération DB hors application.

### 5.6 Spotlight au survol panneau (desktop)

- En complément de la sélection persistante : au `mouseenter` sur un item de la liste latérale, toutes les autres traces sont visuellement atténuées (couleur grise, opacité ~0.18, halo ~0.08), la trace ciblée passe au-dessus (`bringToFront`) et son halo monte à ~0.65.
- Au `mouseleave` : restauration de l'état normal (sauf si une trace est sélectionnée, le spotlight de sélection reste prioritaire).
- Désactivé sur tactile via `matchMedia("(hover: hover) and (pointer: fine)")`.
- Le **clic sur l'item** zoome sur la bbox **ET** sélectionne la trace (équivalent à un clic sur la trace sur la carte).

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
