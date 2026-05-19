# PeopleFinder — notes pour agents

Carte web collaborative pour cartographier les zones déjà parcourues lors de la recherche d'une personne disparue. Les traces (GPX ou tracé manuel) sont partagées via une URL unique.

## Statut

- **PoC, pas production.** Ne pas ajouter : auth, comptes utilisateurs, rate limiting, migrations versionnées (Alembic/Flyway), observabilité, suite de tests exhaustive.
- L'URL est le seul "secret" : tout détenteur peut lire, créer et supprimer.

## Stack

- Backend : **FastAPI** (Python).
- DB : **PostgreSQL 16**, **externe** au conteneur. Points stockés en **JSONB**. **Pas de PostGIS**.
- Schéma : table `traces` avec colonnes `deleted_at TIMESTAMPTZ NULL`, `kind TEXT NOT NULL DEFAULT 'search'` (`search`|`todo`), `confidence` **NULLABLE** (toujours NULL pour les `todo`). Index partiel `WHERE deleted_at IS NULL` recommandé. Migrations exprimées en `ALTER TABLE IF NOT EXISTS` + bloc `DO $$` idempotent dans `schema.py`.
- Front : **vanilla JS + HTML servis par FastAPI**. Pas de build step, pas de SPA séparée.
- Carto : **Leaflet** + fond OSM.
- Docker : **une seule image** contient backend + assets statiques.

## Démarrage

- Connexion DB via **`DATABASE_URL`** unique (format `postgres://user:pass@host/db`).
- Au boot du conteneur : **script Python d'init du schéma**, idempotent (`CREATE TABLE IF NOT EXISTS`). Pas d'outil de migration.

## Déploiement (important)

- L'image Docker est **hostée sur un serveur remote** de l'utilisateur.
- **Ne jamais exécuter `docker build` / `docker run` / `docker push` localement.** L'agent **fournit les commandes** prêtes à copier-coller, l'utilisateur les lance lui-même sur le serveur.
- Idem pour la DB : elle est externe, ne pas tenter de la provisionner localement.
- Tester l'app en local reste possible (lancer FastAPI directement contre une `DATABASE_URL` de dev), mais le workflow officiel est : code → l'utilisateur build/déploie sur son serveur.

## Règles de scope (faciles à enfreindre par défaut)

- **GPX parsé serveur uniquement** (un seul parseur). Rejeter si > 1 Mo ou contenu invalide.
- **Pas d'édition** d'une trace existante : on supprime et on recrée.
- **Soft-delete** : la suppression écrit `deleted_at = NOW()`, ne fait **pas** de `DELETE` SQL. But : rollback manuel en DB (`UPDATE traces SET deleted_at = NULL WHERE id = ...`). **Pas d'endpoint ni d'UI de restore** (volontaire).
- **Lectures filtrent `deleted_at IS NULL` par défaut**. Inclusion via query param `?include_deleted=true` sur `GET /traces`. La réponse expose `deleted_at` (null ou ISO 8601) pour que le front distingue.
- `DELETE /traces/{id}` est idempotent (re-suppression = no-op).
- Le **halo** autour d'une trace de recherche est une polyligne Leaflet plus large en **pixels**, opacité ~0.4, avec un **liseré sombre** (`#1a1a1a`, weight 9) posé sous la ligne couleur pour visibilité sur fond satellite. Ce n'est **pas** un buffer géodésique — pas de turf.js, pas de `ST_Buffer`.
- **Couleurs imposées** (palette ordinale chaude, dégradé orange → rouge sombre), ne pas réinventer :
  - faible `#fb923c` (orange clair), moyen `#ef4444` (rouge vif), fort `#991b1b` (rouge sombre).
- **Tracés "à explorer"** (kind=todo) : cyan `#06b6d4`, pointillés épais (`dashArray: "12, 10"`), **pas de halo**, pas de niveau de confiance.
- **Mobile-first** (pas juste responsive en bonus).
- Au chargement : `fitBounds` sur l'union des bbox des traces **non supprimées** uniquement.

## Mode manuel (comportement précis)

- Clic carte = ajoute un point.
- Double-clic **sur un point existant** = annule le dernier point posé (≠ terminer le tracé).
- Bouton **Terminer** = ouvre la modale métadonnées (nom / auteur / confiance / date par défaut aujourd'hui).
- Bouton **Annuler** = sort du mode sans rien créer.

## Filtres front

- Toggle **"Afficher les traces supprimées"** dans le panneau latéral.
  - **OFF par défaut**, **non persistant** entre rechargements (pas de `localStorage`).
  - Quand ON : refetch `GET /traces?include_deleted=true`.
- Rendu des traces supprimées :
  - polyligne en **pointillés** (`dashArray`),
  - opacité réduite (~0.4), **halo masqué**,
  - liste latérale : nom **barré** + libellé `(supprimée le JJ/MM/AAAA)`,
  - **pas** de bouton corbeille ni d'action UI (restore = DB uniquement).
- Les traces supprimées ne participent pas au `fitBounds` initial ni au compteur "X traces / Y km" si implémenté.

## Features bonus

Listées dans la spec §5 (filtre date, filtre confiance, marqueur de départ, popup, compteur, zones "à explorer"). **Optionnelles**, ne pas implémenter sans demande explicite.

## Décisions techniques figées

- **IDs** : UUID générés côté serveur.
- **Points JSONB** : tableau `[[lon, lat], ...]` style GeoJSON. Le front fait la conversion `[lat, lon]` pour Leaflet.
- **Driver Postgres** : `psycopg` v3 en mode sync via `psycopg_pool.ConnectionPool` (FastAPI gère via son threadpool).
- **Caps métier** : 10 000 points max par trace, 200 caractères max par champ texte.
- **Outillage** : `pip` + `requirements.txt`. Pas de `pyproject.toml`, pas de `uv`, pas de `poetry`.
- **Base image Docker** : `python:3.12-slim`. Serveur : `uvicorn` direct, port 8000.
- **Leaflet** : chargé depuis le CDN unpkg dans `index.html` (pas vendoré).

## Structure du repo

```
app/
  main.py            # FastAPI app, lifespan = init_pool + init_schema
  db.py              # ConnectionPool psycopg v3
  schema.py          # init_schema() — CREATE TABLE IF NOT EXISTS
  models.py          # Pydantic + caps métier
  gpx.py             # parsing GPX (gpxpy), limite 1 Mo
  routes/traces.py   # GET/POST/POST gpx/DELETE
static/
  index.html         # Layout, modales
  app.js             # Leaflet + UI + mode manuel + fetch
  style.css          # mobile-first
Dockerfile
requirements.txt
README.md            # commandes dev local + Docker remote
SPEC.md              # spec complète
```

## Commandes stables

Dev local :
```bash
pip install -r requirements.txt
export DATABASE_URL="postgres://user:pass@host:5432/db"
uvicorn app.main:app --reload
```

Docker (à exécuter par l'utilisateur sur son serveur remote, jamais localement par l'agent) :
```bash
docker build -t peoplefinder:latest .
docker run -d --name peoplefinder --restart unless-stopped -p 8000:8000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" peoplefinder:latest
```
