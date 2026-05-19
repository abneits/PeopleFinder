# PeopleFinder

Carte web collaborative pour cartographier les zones déjà parcourues lors de la recherche d'une personne disparue.

**Statut : PoC.** Pas d'authentification, pas de rate limiting. L'URL est le seul "secret" — quiconque l'a peut lire, créer, supprimer.

Voir [`SPEC.md`](SPEC.md) pour la spec complète et [`AGENTS.md`](AGENTS.md) pour les notes destinées aux agents.

## Stack

- Backend : FastAPI (Python 3.12)
- DB : PostgreSQL 16 (externe), points en JSONB
- Front : vanilla JS + Leaflet, servi par FastAPI
- Docker : une seule image (backend + assets)

## Développement local

Prérequis : Python 3.12+, un Postgres accessible (local ou distant).

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export DATABASE_URL="postgres://user:pass@localhost:5432/peoplefinder"
uvicorn app.main:app --reload
```

Application : http://localhost:8000

Le schéma est appliqué automatiquement au démarrage (idempotent).

## Déploiement sur serveur remote

L'image Docker se build et tourne **sur le serveur remote géré par l'utilisateur**.
**Ne pas exécuter ces commandes localement** — elles sont à copier-coller sur le serveur.

### Build

```bash
docker build -t peoplefinder:latest .
```

### Run

```bash
docker run -d \
  --name peoplefinder \
  --restart unless-stopped \
  -p 8000:8000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/peoplefinder" \
  peoplefinder:latest
```

### Logs

```bash
docker logs -f peoplefinder
```

### Mise à jour

```bash
docker stop peoplefinder && docker rm peoplefinder
docker build -t peoplefinder:latest .
# puis relancer la commande `docker run` ci-dessus
```

## API

| Méthode | Endpoint                              | Description                                  |
|---------|---------------------------------------|----------------------------------------------|
| GET     | `/traces`                             | Liste les traces vivantes                    |
| GET     | `/traces?include_deleted=true`        | Liste toutes les traces (vivantes + supprimées) |
| POST    | `/traces`                             | Crée une trace (mode manuel, JSON)           |
| POST    | `/traces/gpx`                         | Crée une trace depuis un GPX (multipart)     |
| DELETE  | `/traces/{id}`                        | Soft-delete idempotent                       |
| GET     | `/healthz`                            | Health check                                 |

## Rollback d'une suppression

La suppression est **soft** (colonne `deleted_at`). Pour restaurer, opération DB manuelle :

```sql
UPDATE traces SET deleted_at = NULL WHERE id = '...';
```

Il n'y a volontairement **aucun endpoint** ni bouton UI pour ça.
